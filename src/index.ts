/** Composable multi-model agent roles plus a legacy Luna/Sol router for DeepSeek Harness. */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { agentPresetProjectionDefinition } from '@deepseek-ai/dsh-agent-presets'
import type { Session } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import { isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { advisorScope, SolAdvisor } from './advisor.ts'
import { LUNA_ROUTER_INSTRUCTION, PACKAGE_NAME } from './constants.ts'
import { installRouterEvents } from './events.ts'
import { ReasoningRouter } from './router.ts'
import { beforeInitialRoleRun, DEFAULT_TRIGGER_RULES, migrateLegacyTriggerRules, roleTriggerPrompt, validateTriggerRules } from './role-policy.ts'
import { builtinMaxOutputTokens } from './model-limits.ts'
import { solConsultTool } from './tool.ts'
import { AgentTeam, modelCatalog } from './team.ts'
import { agentTeamCatalogTool, agentTeamRunTool } from './team-tool.ts'
import type { Config as RouterConfig, RoleTriggerRules, TeamRoleConfig } from './types.ts'

export * from './advisor.ts'
export * from './constants.ts'
export * from './events.ts'
export * from './router.ts'
export * from './role-policy.ts'
export * from './model-limits.ts'
export * from './state.ts'
export * from './tool.ts'
export * from './team.ts'
export * from './team-tool.ts'
export type * from './types.ts'

export const name = 'codex-reasoning-router'
export const inject = ['llm', 'tools', 'systemPrompt', 'agents', 'subagents']

export interface Config extends RouterConfig {}

export interface TeamSettings {
  teamEnabled: boolean
  presetIds: string[]
  roles: TeamRoleConfig[]
  triggerRules: RoleTriggerRules
}

export const TEAM_SETTINGS_NAMESPACE = 'codex-reasoning-router' as SettingsNamespace

export const DEFAULT_TEAM_ROLES: TeamRoleConfig[] = [
  {
    id: 'brain',
    kind: 'advisory',
    description: 'Deep tool-less reasoning and architecture advice.',
    provider: 'openai-codex',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'max',
    maxTokens: 3000,
  },
  {
    id: 'coordinator',
    kind: 'advisory',
    description: 'Decomposition, assignment, integration, and risk control.',
    provider: 'openai-codex',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'high',
    maxTokens: 2200,
  },
  {
    id: 'worker',
    kind: 'subagent',
    description: 'Tool-capable implementation and verification worker.',
    provider: 'openai-codex',
    model: 'gpt-5.6-luna',
    reasoningEffort: 'max',
    maxDepth: 2,
    subagentProvider: 'spawn',
  },
]

const roleSchema = z.object({
  id: z.string().required(),
  kind: z.union(['advisory', 'subagent'] as const).required(),
  description: z.string().required(),
  provider: z.string(),
  model: z.string(),
  reasoningEffort: z.string(),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
  systemPrompt: z.string(),
  subagentProvider: z.string(),
  maxDepth: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER),
  toolAllow: z.array(z.string()).default(undefined as unknown as string[]),
  toolDeny: z.array(z.string()).default(undefined as unknown as string[]),
})
const triggerRulesSchema = z.object({
  mode: z.union(['manual', 'rules', 'first-turn'] as const).default('rules'),
  depthRoleId: z.string().default('brain'),
  coordinatorRoleId: z.string().default('coordinator'),
  workerRoleId: z.string().default('worker'),
  firstTurnRoleId: z.string().default('coordinator'),
  coordinatorMinDeliverables: z.number().step(1).min(1).max(20).default(3),
  coordinatorMinSubsystems: z.number().step(1).min(1).max(20).default(2),
  repeatedFailureThreshold: z.number().step(1).min(1).max(10).default(2),
  triggerOnHighRisk: z.boolean().default(true),
  triggerOnConflictingEvidence: z.boolean().default(true),
  triggerOnArchitectureDecision: z.boolean().default(true),
  maxDepthCallsPerTurn: z.number().step(1).min(1).max(10).default(1),
  maxCoordinatorCallsPerTurn: z.number().step(1).min(1).max(10).default(1),
  maxConcurrentWorkers: z.number().step(1).min(1).max(10).default(3),
  requirePriorAdviceEvaluation: z.boolean().default(true),
  showTriggerReason: z.boolean().default(true),
  firstTurnFailOpen: z.boolean().default(true),
  customInstructions: z.string().default(''),
}).default(DEFAULT_TRIGGER_RULES as never)
export const TeamSettings: z<TeamSettings> = z.object({
  teamEnabled: z.boolean().default(true),
  presetIds: z.array(z.string()).default([]),
  roles: z.array(roleSchema).default(DEFAULT_TEAM_ROLES as never),
  triggerRules: triggerRulesSchema,
})
export const Config: z<Config> = z.object({
  teamEnabled: z.boolean().default(true),
  presetIds: z.array(z.string()).default([]),
  roles: z.array(roleSchema).default(DEFAULT_TEAM_ROLES as never),
  requiredPresetId: z.string().default(''),
  triggerRules: triggerRulesSchema,
  lunaProvider: z.string().default('openai-codex'),
  lunaModel: z.string().default('gpt-5.6-luna'),
  solProvider: z.string().default('openai-codex'),
  solModel: z.string().default('gpt-5.6-sol'),
  initialSolReasoning: z.union(['medium', 'high'] as const).default('medium'),
  escalatedSolReasoning: z.union(['medium', 'high'] as const).default('high'),
  solAdviceMaxTokens: z.number().step(1).min(256).max(4096).default(2000),
  solTimeoutMs: z.number().step(1).min(1000).max(120000).default(30000),
  initialConsultEnabled: z.boolean().default(true),
  failOpen: z.boolean().default(true),
})

export function validateTeamSettings(config: TeamSettings): void {
  const triggerRules = migrateLegacyTriggerRules(config.triggerRules, config.roles)
  const roleIds = new Set<string>()
  if (config.teamEnabled && config.roles.length === 0) throw new Error(PACKAGE_NAME + ': teamEnabled requires at least one role')
  for (const role of config.roles) {
    if (!/^[a-z][a-z0-9_-]*$/u.test(role.id)) throw new Error(PACKAGE_NAME + ': invalid role id ' + role.id)
    if (roleIds.has(role.id)) throw new Error(PACKAGE_NAME + ': duplicate role id ' + role.id)
    roleIds.add(role.id)
    if (role.kind === 'subagent' && role.maxDepth !== undefined && !Number.isSafeInteger(role.maxDepth)) throw new Error(PACKAGE_NAME + ': role ' + role.id + ' maxDepth must be a non-negative safe integer')
    const builtinMax = builtinMaxOutputTokens(role.provider, role.model)
    if (role.maxTokens !== undefined && builtinMax !== undefined && role.maxTokens > builtinMax) {
      throw new Error(PACKAGE_NAME + ': role ' + role.id + ' maxTokens ' + role.maxTokens + ' exceeds the built-in maximum output ' + builtinMax + ' for ' + role.provider + '/' + role.model)
    }
  }
  if (config.teamEnabled) validateTriggerRules(triggerRules, config.roles)
}

async function validateModels(ctx: Context, config: Config): Promise<void> {
  const routes = new Map<string, string[]>([
    [config.lunaProvider, [config.lunaModel]],
    [config.solProvider, [config.solModel]],
  ])
  if (config.lunaProvider === config.solProvider) {
    routes.set(config.lunaProvider, [...new Set([config.lunaModel, config.solModel])])
  }
  for (const [provider, expected] of routes) {
    const models = await ctx.llm.listModels(provider)
    const found = new Set(models.map(model => model.id))
    for (const model of expected) {
      if (!found.has(model)) {
        throw new Error(`${PACKAGE_NAME}: configured model ${provider}/${model} is absent from the provider catalog; no fallback was selected`)
      }
      await ctx.llm.resolveModelInfo(provider, model)
    }
  }
}


interface Installation {
  readonly router: ReasoningRouter
  readonly disposeTool: () => void
  readonly disposePrompt: () => void
}

/** Defense in depth: accidental global installation must not affect other presets. */
function resolveSessionPreset(session: Session): string | null {
  return session.snapshotEvents().reduce(
    (state, event) => agentPresetProjectionDefinition.apply(state, event),
    agentPresetProjectionDefinition.init(session.header),
  )
}

export function isRouterPresetAgent(agent: Agent, roots: readonly Agent[], requiredPresetId: string): boolean {
  if (requiredPresetId === '') return false
  return roots.includes(agent) && resolveSessionPreset(agent.session) === requiredPresetId
}

export function apply(ctx: Context, config: Config): void {
  installRouterEvents()
  const advisor = new SolAdvisor(ctx, config)
  const installed = new Map<Agent, Installation>()
  const baseTeam: TeamSettings = {
    teamEnabled: config.teamEnabled,
    presetIds: config.presetIds,
    roles: config.roles,
    triggerRules: config.triggerRules,
  }
  validateTeamSettings(baseTeam)
  let teamSource = (): TeamSettings => baseTeam
  const initialRules = migrateLegacyTriggerRules(baseTeam.triggerRules, baseTeam.roles)
  let team = new AgentTeam(ctx, baseTeam.roles, initialRules)
  const teamInstalled = new Map<Agent, Array<() => void>>()
  // Preset standing scopes are loaded even when no session uses this preset.
  // Do not query or constrain the model catalog until a matching root starts.
  let modelValidation: Promise<void> | undefined

  const validateRouterModels = (): Promise<void> => {
    return modelValidation ??= validateModels(ctx, config)
  }

  const attach = (agent: Agent): void => {
    if (installed.has(agent) || !isRouterPresetAgent(agent, ctx.agents.roots(), config.requiredPresetId)) return
    const router = new ReasoningRouter(config, advisor)
    const disposePrompt = agent.ctx.systemPrompt.section({
      name: 'reasoning-router:luna-executor',
      order: 40,
      text: LUNA_ROUTER_INSTRUCTION,
    })
    const disposeTool = agent.ctx.tools.register(solConsultTool(router))
    installed.set(agent, { router, disposeTool, disposePrompt })
  }

  const detach = (agent: Agent): void => {
    const installation = installed.get(agent)
    if (installation === undefined) return
    installed.delete(agent)
    installation.disposeTool()
    installation.disposePrompt()
  }

  const teamMatches = (agent: Agent): boolean => {
    const active = teamSource()
    if (!active.teamEnabled) return false
    if (active.presetIds.length === 0) return true
    const preset = resolveSessionPreset(agent.session)
    return preset !== null && active.presetIds.includes(preset)
  }

  const attachTeam = (agent: Agent): void => {
    team.installChildSelection(agent)
    if (teamInstalled.has(agent) || !teamMatches(agent)) return
    const active = teamSource()
    const effectiveRules = migrateLegacyTriggerRules(active.triggerRules, active.roles)
    const disposers = [
      agent.ctx.tools.register(agentTeamRunTool(team)),
      agent.ctx.tools.register(agentTeamCatalogTool(() => modelCatalog(ctx))),
      agent.ctx.systemPrompt.section({
        name: 'reasoning-router:agent-team',
        order: 41,
        text: roleTriggerPrompt(effectiveRules) + '\nUse agent_role_catalog before proposing model or reasoning-effort changes. Role outputs are delegated evidence, not authority; validate material claims before final delivery.',
      }),
    ]
    teamInstalled.set(agent, disposers)
  }

  const detachTeam = (agent: Agent): void => {
    const disposers = teamInstalled.get(agent)
    if (disposers === undefined) return
    teamInstalled.delete(agent)
    for (const dispose of disposers.reverse()) dispose()
  }

  const reconfigureTeam = (): void => {
    const active = teamSource()
    validateTeamSettings(active)
    const effectiveRules = migrateLegacyTriggerRules(active.triggerRules, active.roles)
    const candidates = new Set([...teamInstalled.keys(), ...ctx.agents.roots()])
    for (const agent of candidates) detachTeam(agent)
    team = new AgentTeam(ctx, active.roles, effectiveRules)
    for (const agent of candidates) attachTeam(agent)
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['settings'], settingsCtx => settingsCtx.settings.installSection(ctx, TEAM_SETTINGS_NAMESPACE, TeamSettings, baseTeam, {
      validate: validateTeamSettings,
      setSource: source => { teamSource = source },
      onChange: reconfigureTeam,
    }))
  }

  /** Reconcile the installation after a blank session changes its preset. */
  const syncAgent = (agent: Agent): Installation | undefined => {
    if (!isRouterPresetAgent(agent, ctx.agents.roots(), config.requiredPresetId)) {
      detach(agent)
      return undefined
    }
    attach(agent)
    return installed.get(agent)
  }

  ctx.on('agent/created', ({ agent }) => { syncAgent(agent); attachTeam(agent) })
  ctx.on('agent/disposed', ({ agent }) => { detach(agent); detachTeam(agent) })
  ctx.on('session/event', (session, event) => {
    const agent = ctx.agents.roots().find(candidate => candidate.id === session.id)
    if (agent === undefined) return
    if (event.type === 'turn/start') team.beginTurn(agent)
    if (event.type === 'agent-preset/selected') { syncAgent(agent); detachTeam(agent); attachTeam(agent) }
  })
  ctx.on('agent/pre-step', async (payload, next) => {
    const installation = syncAgent(payload.agent)
    const decision = await next()
    if (decision.kind === 'reject') return decision
    let messages = decision.messages
    if (teamMatches(payload.agent)) {
      const active = teamSource()
      const effectiveRules = migrateLegacyTriggerRules(active.triggerRules, active.roles)
      messages = await beforeInitialRoleRun(payload.agent, messages, team, effectiveRules, payload.signal)
    }
    if (installation !== undefined) {
      await validateRouterModels()
      messages = await installation.router.beforeFirstStep(payload.agent, messages, payload.signal)
    }
    return { kind: 'enter', messages }
  })
  ctx.on('agent/request', async (payload, next) => {
    const installation = syncAgent(payload.agent)
    const request = await next()
    if (installation === undefined) return request
    if (request.provider !== config.lunaProvider || request.model !== config.lunaModel) {
      throw new Error(
        `${PACKAGE_NAME}: root agent request route must remain ${config.lunaProvider}/${config.lunaModel}; `
        + `observed ${request.provider}/${request.model}. The router did not rewrite it and blocked dispatch.`,
      )
    }
    return request
  })
  ctx.on('llm/stream', (options, next) => {
    // Internal advisor requests carry an AsyncLocalStorage purpose marker. The
    // public GenerateOptions purpose union has no custom plugin tag in rc.6.
    if (advisorScope.getStore()?.purpose === 'sol-advisory') return next()
    if (isAgentLoopRequest(options) && options.sessionId !== undefined) {
      const root = ctx.agents.roots().find(agent => agent.id === options.sessionId)
      const installation = root === undefined ? undefined : syncAgent(root)
      if (installation !== undefined
        && (options.provider !== config.lunaProvider || options.model !== config.lunaModel)) {
        throw new Error(
          PACKAGE_NAME + ": root LLM stream must remain " + config.lunaProvider + "/" + config.lunaModel + "; "
          + "observed " + options.provider + "/" + options.model + ". Dispatch was blocked without rewriting the request.",
        )
      }
    }
    return next()
  })

  for (const agent of ctx.agents.roots()) { attach(agent); attachTeam(agent) }
  ctx.effect(() => () => {
    for (const agent of [...installed.keys()]) detach(agent)
    for (const agent of [...teamInstalled.keys()]) detachTeam(agent)
  }, `${PACKAGE_NAME}: root agent integrations`)
}
