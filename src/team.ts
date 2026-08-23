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
import type { UsageCorrelationHint } from 'dsh-codex'
import { safeError } from './advisor.ts'
import { PACKAGE_NAME } from './constants.ts'
import type { TeamRoleConfig } from './types.ts'

declare module '@deepseek-ai/dsh-agent' {
  interface AgentOptions {
    /** Private markers used to install a team's effort before a child runs. */
    reasoningRouterRole?: string
    reasoningRouterEffort?: string
  }
}

interface SubagentResultLike {
  readonly output: ContentBlock[]
  readonly diagnostic?: string
  readonly stopReason: { readonly kind?: string } | string
}

interface SubagentRunLike {
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
  role: string
  kind: 'advisory' | 'subagent'
  output: ContentBlock[]
  stopReason?: string
  diagnostic?: string
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
    ? `You are the ${role.id} reasoning role in a coding-agent team. You have no tools. Reason only over the supplied task and evidence. Return concise, actionable advice to the calling agent; do not pretend you inspected the workspace.`
    : `You are the ${role.id} worker in a coding-agent team. Complete the delegated task within the supplied scope, verify your work, and return a concise evidence-backed report to the parent agent.`
}

function stringStopReason(value: SubagentResultLike['stopReason']): string {
  return typeof value === 'string' ? value : value.kind ?? String(value)
}

export class AgentTeam {
  constructor(private readonly ctx: Context, readonly roles: readonly TeamRoleConfig[]) {}

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

  async run(agent: Agent, roleId: string, task: string, signal: AbortSignal): Promise<TeamRunResult> {
    const role = this.role(roleId)
    const route = resolveRoleRoute(agent, role)
    await validateRoleRoute(this.ctx, route)
    return role.kind === 'advisory'
      ? this.runAdvisory(agent, role, route, task, signal)
      : this.runSubagent(agent, role, route, task, signal)
  }

  private async runAdvisory(
    agent: Agent,
    role: TeamRoleConfig,
    route: ResolvedRoleRoute,
    task: string,
    signal: AbortSignal,
  ): Promise<TeamRunResult> {
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
      ...(role.maxTokens === undefined ? {} : { maxTokens: role.maxTokens }),
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
  ): Promise<TeamRunResult> {
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
      output: result.output,
      stopReason: stringStopReason(result.stopReason),
      ...(result.diagnostic === undefined ? {} : { diagnostic: result.diagnostic }),
    }
  }
}
