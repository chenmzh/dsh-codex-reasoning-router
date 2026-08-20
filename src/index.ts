/** Luna executor / tool-less Sol reasoning advisor plugin for DeepSeek Harness. */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets'
import type { Context } from '@deepseek-ai/cordis'
import { isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from 'dsh-codex'
import { advisorScope, SolAdvisor } from './advisor.ts'
import { LUNA_ROUTER_INSTRUCTION, PACKAGE_NAME } from './constants.ts'
import { installRouterEvents } from './events.ts'
import { ReasoningRouter } from './router.ts'
import { solConsultTool } from './tool.ts'
import type { Config as RouterConfig } from './types.ts'

export * from './advisor.ts'
export * from './constants.ts'
export * from './events.ts'
export * from './router.ts'
export * from './state.ts'
export * from './tool.ts'
export type * from './types.ts'

export const name = 'codex-reasoning-router'
export const inject = ['llm', 'tools', 'systemPrompt', 'agents', 'openAICodex']

export interface Config extends RouterConfig {}

export const Config: z<Config> = z.object({
  requiredPresetId: z.string().default('luna-sol-reasoning-router'),
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
export function isRouterPresetAgent(agent: Agent, roots: readonly Agent[], requiredPresetId: string): boolean {
  return roots.includes(agent) && resolveSessionPreset(agent.session) === requiredPresetId
}

export function apply(ctx: Context, config: Config): void {
  installRouterEvents()
  const advisor = new SolAdvisor(ctx, config)
  const installed = new Map<Agent, Installation>()
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

  /** Reconcile the installation after a blank session changes its preset. */
  const syncAgent = (agent: Agent): Installation | undefined => {
    if (!isRouterPresetAgent(agent, ctx.agents.roots(), config.requiredPresetId)) {
      detach(agent)
      return undefined
    }
    attach(agent)
    return installed.get(agent)
  }

  ctx.on('agent/created', ({ agent }) => { syncAgent(agent) })
  ctx.on('agent/disposed', ({ agent }) => { detach(agent) })
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'agent-preset/selected') return
    const agent = ctx.agents.roots().find(candidate => candidate.id === session.id)
    if (agent !== undefined) syncAgent(agent)
  })
  ctx.on('agent/pre-step', async (payload, next) => {
    const installation = syncAgent(payload.agent)
    if (installation === undefined) return next()
    const decision = await next()
    if (decision.kind === 'reject') return decision
    await validateRouterModels()
    const messages = await installation.router.beforeFirstStep(payload.agent, decision.messages, payload.signal)
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

  for (const agent of ctx.agents.roots()) attach(agent)
  ctx.effect(() => () => {
    for (const agent of [...installed.keys()]) detach(agent)
  }, `${PACKAGE_NAME}: root agent integrations`)
}
