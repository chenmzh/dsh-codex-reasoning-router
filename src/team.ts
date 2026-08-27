import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import {
  BlockAssembler,
  createUserMessage,
  ReasoningEffortId,
  type ContentBlock,
  type GenerateOptions,
} from '@deepseek-ai/dsh-llm'
import { safeError } from './advisor.ts'
import { PACKAGE_NAME } from './constants.ts'
import type { AgentRoleRunFinishedEvent, AgentRoleRunStartedEvent } from './events.ts'
import type { RoleTriggerReason, RoleTriggerRules, TeamRoleConfig } from './types.ts'

declare module '@deepseek-ai/dsh-agent' {
  interface AgentOptions {
    /** Private markers used to install a team's effort before a child runs. */
    reasoningRouterRole?: string
    reasoningRouterEffort?: string
    /** Parent role-run id used to render nested activation edges. */
    reasoningRouterParentRunId?: string
  }
}

/** Correlation fields consumed structurally by dsh-codex's usage middleware. */
interface UsageCorrelationHint {
  readonly usageSessionId?: string
  readonly usagePurpose?: string
}

interface SubagentResultLike {
  readonly output: ContentBlock[]
  readonly diagnostic?: string
  readonly stopReason: { readonly kind?: string } | string
}

interface SubagentRunLike {
  readonly id: string
  readonly result: Promise<SubagentResultLike>
  dispose(): Promise<void>
}

interface SubagentRuntimeLike {
  start(provider: string, request: {
    label?: string
    prompt: ContentBlock[]
    parent: Agent
    signal: AbortSignal
    agentOptions?: AgentOptions
    maxDepth?: number
    persona?: string
    toolFilter?: { allow?: string[]; deny?: string[] }
  }): Promise<SubagentRunLike>
}

export interface ResolvedRoleRoute {
  provider: string
  model: string
  reasoningEffort?: string
}

export interface TeamRunResult extends ResolvedRoleRoute {
  runId: string
  role: string
  kind: 'advisory' | 'subagent'
  output: ContentBlock[]
  stopReason?: string
  diagnostic?: string
  childSessionId?: string
  triggerReason?: RoleTriggerReason
}

function inheritedRoute(agent: Agent): { provider?: string; model?: string } {
  const logged = agent.session.requestHeader()?.config
  const provider = agent.options.provider ?? logged?.provider
  const model = agent.options.model ?? logged?.model
  return {
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
  }
}

export function resolveRoleRoute(agent: Agent, role: TeamRoleConfig): ResolvedRoleRoute {
  const inherited = inheritedRoute(agent)
  const provider = role.provider ?? inherited.provider
  const model = role.model ?? inherited.model
  if (provider === undefined || model === undefined) {
    throw new Error(`${PACKAGE_NAME}: role "${role.id}" inherits its route, but the calling agent has no provider/model`)
  }
  return {
    provider,
    model,
    ...(role.reasoningEffort === undefined ? {} : { reasoningEffort: role.reasoningEffort }),
  }
}

export async function validateRoleRoute(ctx: Context, route: ResolvedRoleRoute): Promise<void> {
  const catalog = await ctx.llm.listModels(route.provider)
  if (!catalog.some(model => model.id === route.model)) {
    throw new Error(`${PACKAGE_NAME}: ${route.provider}/${route.model} is not in the user's live model catalog`)
  }
  const info = await ctx.llm.resolveModelInfo(route.provider, route.model)
  if (route.reasoningEffort === undefined) return
  const supported = info.reasoning?.efforts.map(effort => String(effort.id)) ?? []
  if (!supported.includes(route.reasoningEffort)) {
    throw new Error(
      `${PACKAGE_NAME}: ${route.provider}/${route.model} does not offer reasoning effort "${route.reasoningEffort}"; `
      + `available: ${supported.length === 0 ? '<provider default only>' : supported.join(', ')}`,
    )
  }
}

export async function modelCatalog(ctx: Context) {
  return await Promise.all(ctx.llm.listProviders().map(async provider => ({
    provider: provider.id,
    name: provider.name,
    models: await Promise.all((await ctx.llm.listModels(provider.id)).map(async model => {
      const info = await ctx.llm.resolveModelInfo(provider.id, model.id)
      return {
        id: model.id,
        name: model.name,
        reasoningEfforts: info.reasoning?.efforts.map(effort => String(effort.id)) ?? [],
        ...(info.reasoning?.defaultEffort === undefined
          ? {}
          : { defaultReasoningEffort: String(info.reasoning.defaultEffort) }),
      }
    })),
  })))
}

function roleSystemPrompt(role: TeamRoleConfig): string {
  if (role.systemPrompt !== undefined) return role.systemPrompt
  return role.kind === 'advisory'
    ? `You are the ${role.id} reasoning role in a configurable agent-role system. You have no tools. Reason only over the supplied task and evidence. Return concise, actionable advice to the calling agent; do not pretend you inspected the workspace.`
    : `You are the ${role.id} worker in a configurable agent-role system. Complete the delegated task within the supplied scope, verify your work, and return a concise evidence-backed report to the parent agent.`
}

function stringStopReason(value: SubagentResultLike['stopReason']): string {
  return typeof value === 'string' ? value : value.kind ?? String(value)
}

const TRACE_TEXT_LIMIT = 4000
let nextTraceRunId = 0

function traceText(value: string): string {
  if (value.length <= TRACE_TEXT_LIMIT) return value
  return value.slice(0, TRACE_TEXT_LIMIT) + '\n… [truncated]'
}

function outputText(blocks: ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
}

function appendRoleRunStarted(agent: Agent, event: AgentRoleRunStartedEvent): void {
  try {
    agent.session.append('agent-role/run-started', event)
  } catch {
    // Trace persistence is fail-open: observability must not break the role call.
  }
}

function appendRoleRunFinished(agent: Agent, event: AgentRoleRunFinishedEvent): void {
  try {
    agent.session.append('agent-role/run-finished', event)
  } catch {
    // Trace persistence is fail-open: observability must not break the role call.
  }
}

interface RoleRunMeta {
  triggerReason?: RoleTriggerReason
  priorAdviceEvaluation?: string
  references?: readonly string[]
  maxTokensCap?: number
}

interface TurnRoleState {
  depthCalls: number
  coordinatorCalls: number
  activeWorkers: number
  lastRunByRole: Map<string, string>
}

export class AgentTeam {
  private readonly turnStates = new WeakMap<Agent, TurnRoleState>()

  constructor(
    private readonly ctx: Context,
    readonly roles: readonly TeamRoleConfig[],
    readonly triggerRules?: RoleTriggerRules,
  ) {}

  beginTurn(agent: Agent): void {
    this.turnStates.set(agent, { depthCalls: 0, coordinatorCalls: 0, activeWorkers: 0, lastRunByRole: new Map() })
  }

  private state(agent: Agent): TurnRoleState {
    let state = this.turnStates.get(agent)
    if (state === undefined) {
      state = { depthCalls: 0, coordinatorCalls: 0, activeWorkers: 0, lastRunByRole: new Map() }
      this.turnStates.set(agent, state)
    }
    return state
  }

  private reserve(agent: Agent, role: TeamRoleConfig, meta: RoleRunMeta): () => void {
    const rules = this.triggerRules
    if (rules === undefined) return () => undefined
    const state = this.state(agent)
    if (role.id === rules.depthRoleId) {
      if (state.depthCalls >= rules.maxDepthCallsPerTurn) {
        throw new Error(PACKAGE_NAME + ': deep reasoning role limit reached for this turn')
      }
      if (state.depthCalls > 0 && rules.requirePriorAdviceEvaluation && (meta.priorAdviceEvaluation ?? '').trim() === '') {
        throw new Error(PACKAGE_NAME + ': prior_advice_evaluation is required before repeating the deep reasoning role')
      }
      state.depthCalls += 1
    }
    if (role.id === rules.coordinatorRoleId) {
      if (state.coordinatorCalls >= rules.maxCoordinatorCallsPerTurn) {
        throw new Error(PACKAGE_NAME + ': coordinator role limit reached for this turn')
      }
      state.coordinatorCalls += 1
    }
    if (role.id !== rules.workerRoleId) return () => undefined
    if (state.activeWorkers >= rules.maxConcurrentWorkers) {
      throw new Error(PACKAGE_NAME + ': concurrent worker role limit reached')
    }
    state.activeWorkers += 1
    return () => { state.activeWorkers -= 1 }
  }

  role(id: string): TeamRoleConfig {
    const role = this.roles.find(candidate => candidate.id === id)
    if (role === undefined) throw new Error(`${PACKAGE_NAME}: unknown role "${id}"`)
    return role
  }

  installChildSelection(agent: Agent): void {
    const effort = agent.options.reasoningRouterEffort
    if (agent.options.reasoningRouterRole === undefined || effort === undefined) return
    const provider = agent.options.provider
    const model = agent.options.model
    if (provider === undefined || model === undefined) return
    installModelSelection(agent.ctx, {
      current: { provider, model, reasoningEffort: ReasoningEffortId(effort) },
      assembled: undefined,
    })
  }

  async run(agent: Agent, roleId: string, task: string, signal: AbortSignal, meta: RoleRunMeta = {}): Promise<TeamRunResult> {
    const role = this.role(roleId)
    const release = this.reserve(agent, role, meta)
    const route = (() => {
      try {
        return resolveRoleRoute(agent, role)
      } catch (error: unknown) {
        release()
        throw error
      }
    })()
    const state = this.state(agent)
    const runId = `${String(agent.id)}:role:${Date.now().toString(36)}:${nextTraceRunId++}`
    const references = [...new Set(
      meta.references === undefined
        ? (meta.priorAdviceEvaluation?.trim() === '' || meta.priorAdviceEvaluation === undefined
          ? []
          : [state.lastRunByRole.get(role.id)].filter((value): value is string => value !== undefined))
        : meta.references.filter(reference => reference.trim() !== ''),
    )]
    state.lastRunByRole.set(role.id, runId)
    const startedAt = Date.now()
    appendRoleRunStarted(agent, {
      version: 1,
      runId,
      role: role.id,
      kind: role.kind,
      provider: route.provider,
      model: route.model,
      ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
      triggerReason: meta.triggerReason ?? 'custom-rule',
      parentRunId: agent.options.reasoningRouterParentRunId ?? null,
      childSessionId: null,
      references,
      task: traceText(task),
    })
    try {
      await validateRoleRoute(this.ctx, route)
      const result = await (role.kind === 'advisory'
        ? this.runAdvisory(agent, role, route, task, signal, meta.maxTokensCap)
        : this.runSubagent(agent, role, route, task, signal, runId))
      const completed: TeamRunResult = {
        runId,
        ...result,
        ...(this.triggerRules?.showTriggerReason === false ? {} : { triggerReason: meta.triggerReason ?? 'custom-rule' }),
      }
      const text = outputText(result.output)
      appendRoleRunFinished(agent, {
        version: 1,
        runId,
        status: 'succeeded',
        durationMs: Math.max(0, Date.now() - startedAt),
        ...(result.childSessionId === undefined ? {} : { childSessionId: result.childSessionId }),
        ...(text === '' ? {} : { output: traceText(text) }),
        ...(result.stopReason === undefined ? {} : { stopReason: result.stopReason }),
      })
      return completed
    } catch (error: unknown) {
      appendRoleRunFinished(agent, {
        version: 1,
        runId,
        status: 'failed',
        durationMs: Math.max(0, Date.now() - startedAt),
        error: traceText(safeError(error)),
      })
      throw error
    } finally {
      release()
    }
  }

  private async runAdvisory(
    agent: Agent,
    role: TeamRoleConfig,
    route: ResolvedRoleRoute,
    task: string,
    signal: AbortSignal,
    maxTokensCap?: number,
  ): Promise<Omit<TeamRunResult, 'runId'>> {
    const assembler = new BlockAssembler()
    const options: GenerateOptions & UsageCorrelationHint = {
      provider: route.provider,
      model: route.model,
      usageSessionId: String(agent.id),
      usagePurpose: `agent-team:${role.id}`,
      ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(route.reasoningEffort) }),
      system: roleSystemPrompt(role),
      messages: [createUserMessage({
        source: { kind: 'plugin', plugin: PACKAGE_NAME },
        content: [{ type: 'text', text: task }],
      })],
      ...(role.maxTokens === undefined && maxTokensCap === undefined ? {} : {
        maxTokens: Math.min(role.maxTokens ?? Number.MAX_SAFE_INTEGER, maxTokensCap ?? Number.MAX_SAFE_INTEGER),
      }),
      signal,
    }
    for await (const chunk of this.ctx.llm.stream(options)) assembler.push(chunk)
    const blocks = assembler.blocks()
    if (blocks.some(block => block.type === 'tool-call')) {
      throw new Error(`${PACKAGE_NAME}: advisory role "${role.id}" returned a tool call; it was not executed`)
    }
    const output = blocks
    if (output.length === 0) throw new Error(`${PACKAGE_NAME}: advisory role "${role.id}" returned no output`)
    return { role: role.id, kind: role.kind, ...route, output }
  }

  private async runSubagent(
    parent: Agent,
    role: TeamRoleConfig,
    route: ResolvedRoleRoute,
    task: string,
    signal: AbortSignal,
    parentRunId: string,
  ): Promise<Omit<TeamRunResult, 'runId'>> {
    const runtime = (this.ctx as Context & { subagents?: SubagentRuntimeLike }).subagents
      ?? (this.ctx as unknown as { get(name: string): SubagentRuntimeLike | undefined }).get('subagents')
    if (runtime === undefined) throw new Error(`${PACKAGE_NAME}: subagent runtime is unavailable for role "${role.id}"`)
    const toolFilter = role.toolAllow === undefined && role.toolDeny === undefined
      ? undefined
      : {
          ...(role.toolAllow === undefined ? {} : { allow: role.toolAllow }),
          ...(role.toolDeny === undefined ? {} : { deny: role.toolDeny }),
        }
    const run = await runtime.start(role.subagentProvider ?? 'spawn', {
      label: role.id,
      prompt: [{ type: 'text', text: task }],
      parent,
      signal,
      agentOptions: {
        provider: route.provider,
        model: route.model,
        ...(role.maxTokens === undefined ? {} : { maxTokens: role.maxTokens }),
        reasoningRouterRole: role.id,
        reasoningRouterParentRunId: parentRunId,
        ...(route.reasoningEffort === undefined ? {} : { reasoningRouterEffort: route.reasoningEffort }),
      },
      ...(role.maxDepth === undefined ? {} : { maxDepth: role.maxDepth }),
      persona: roleSystemPrompt(role),
      ...(toolFilter === undefined ? {} : { toolFilter }),
    })
    let result: SubagentResultLike
    try {
      result = await run.result
    } catch (error: unknown) {
      throw new Error(`${PACKAGE_NAME}: role "${role.id}" failed: ${safeError(error)}`)
    } finally {
      await run.dispose()
    }
    return {
      role: role.id,
      kind: role.kind,
      ...route,
      childSessionId: String(run.id),
      output: result.output,
      stopReason: stringStopReason(result.stopReason),
      ...(result.diagnostic === undefined ? {} : { diagnostic: result.diagnostic }),
    }
  }
}
