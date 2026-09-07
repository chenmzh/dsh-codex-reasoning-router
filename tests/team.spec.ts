import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { ToolCallId as CallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  AgentTeam,
  beforeInitialRoleRun,
  DEFAULT_TRIGGER_RULES,
  installRouterEvents,
  migrateLegacyTriggerRules,
  roleTriggerPrompt,
  validateTeamSettings,
  validateTriggerRules,

  inject,
  modelCatalog,
  resolveRoleRoute,
  validateRoleRoute,
  type TeamRoleConfig,
} from '../src/index.ts'

function agent(options: { provider?: string; model?: string } = {}): Agent {
  return {
    id: SessionId('parent'),
    options,
    session: Session.create(SessionId('parent')),
    ctx: {} as Context,
  } as Agent
}

function finishedText(text: string): StreamChunk[] {
  return [
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

const brain: TeamRoleConfig = {
  id: 'brain',
  kind: 'advisory',
  description: 'reason',
  provider: 'openai-codex',
  model: 'gpt-5.6-sol',
  reasoningEffort: 'max',
  maxTokens: 1234,
}

function modelContext(stream?: (options: GenerateOptions) => AsyncIterable<StreamChunk>): Context {
  return {
    llm: {
      listProviders: () => [{ id: 'openai-codex', name: 'OpenAI Codex' }],
      listModels: vi.fn(async () => [
        { provider: 'openai-codex', id: 'gpt-5.6-sol', name: 'Sol' },
        { provider: 'openai-codex', id: 'gpt-5.6-luna', name: 'Luna' },
      ]),
      resolveModelInfo: vi.fn(async (_provider: string, model: string) => ({
        provider: 'openai-codex',
        id: model,
        name: model,
        reasoning: {
          efforts: ['low', 'medium', 'high', 'max'].map(id => ({ id, name: id })),
          defaultEffort: 'medium',
        },
      })),
      stream: stream ?? (async function* () { yield* finishedText('ok') }),
    },
  } as unknown as Context
}

describe('composable agent team', () => {
  it('declares the subagent runtime injection required by worker roles', () => {
    expect(inject).toContain('subagents')
  })

  it('inherits an omitted provider/model from the calling agent', () => {
    expect(resolveRoleRoute(agent({ provider: 'p', model: 'm' }), {
      id: 'worker', kind: 'subagent', description: 'work', reasoningEffort: 'high',
    })).toEqual({ provider: 'p', model: 'm', reasoningEffort: 'high' })
  })

  it('reads models and reasoning efforts from the live user catalog', async () => {
    const catalog = await modelCatalog(modelContext())
    expect(catalog).toEqual([{
      provider: 'openai-codex',
      name: 'OpenAI Codex',
      models: [
        { id: 'gpt-5.6-sol', name: 'Sol', reasoningEfforts: ['low', 'medium', 'high', 'max'], defaultReasoningEffort: 'medium' },
        { id: 'gpt-5.6-luna', name: 'Luna', reasoningEfforts: ['low', 'medium', 'high', 'max'], defaultReasoningEffort: 'medium' },
      ],
    }])
  })

  it('rejects a role effort that the selected live model does not offer', async () => {
    await expect(validateRoleRoute(modelContext(), {
      provider: 'openai-codex', model: 'gpt-5.6-sol', reasoningEffort: 'ultra',
    })).rejects.toThrow('available: low, medium, high, max')
  })

  it('runs advisory roles without a tool catalog at their configured effort', async () => {
    let captured: GenerateOptions | undefined
    const ctx = modelContext(async function* (options) {
      captured = options
      yield* finishedText('architectural advice')
    })
    const owner = agent({ provider: 'openai-codex', model: 'gpt-5.6-luna' })
    const result = await new AgentTeam(ctx, [brain]).run(
      owner,
      'brain',
      'reason about this evidence',
      new AbortController().signal,
    )
    expect(captured).toMatchObject({
      provider: 'openai-codex', model: 'gpt-5.6-sol', reasoningEffort: 'max', maxTokens: 1234,
      usageSessionId: 'parent', usagePurpose: 'agent-team:brain',
    })
    expect(captured?.tools).toBeUndefined()
    expect(result.output).toEqual([{ type: 'text', text: 'architectural advice' }])
    const trace = owner.session.events.filter(event => event.type === 'agent-role/run-started' || event.type === 'agent-role/run-finished')
    expect(trace).toHaveLength(2)
    expect(trace[0]?.data).toMatchObject({ runId: result.runId, role: 'brain', kind: 'advisory', task: 'reason about this evidence' })
    expect(trace[1]?.data).toMatchObject({ runId: result.runId, status: 'succeeded', output: 'architectural advice' })
  })

  it('starts a real worker with configured route, effort marker, persona, and absolute depth', async () => {
    const start = vi.fn(async () => ({
      id: SessionId('worker-child'),
      result: Promise.resolve({
        output: [{ type: 'text' as const, text: 'implemented and tested' }],
        stopReason: { kind: 'completed' },
      }),
      dispose: vi.fn(async () => undefined),
    }))
    const ctx = {
      ...modelContext(),
      subagents: { start },
    } as unknown as Context
    const worker: TeamRoleConfig = {
      id: 'worker',
      kind: 'subagent',
      description: 'implement',
      provider: 'openai-codex',
      model: 'gpt-5.6-luna',
      reasoningEffort: 'high',
      subagentProvider: 'spawn',
      maxDepth: 3,
      toolDeny: ['web_search'],
      systemPrompt: 'You are a focused implementation worker.',
    }
    const parent = agent({ provider: 'openai-codex', model: 'gpt-5.6-sol' })
    const result = await new AgentTeam(ctx, [worker]).run(
      parent,
      'worker',
      'implement task',
      new AbortController().signal,
    )
    expect(start).toHaveBeenCalledWith('spawn', expect.objectContaining({
      parent,
      maxDepth: 3,
      persona: 'You are a focused implementation worker.',
      toolFilter: { deny: ['web_search'] },
      agentOptions: expect.objectContaining({
        provider: 'openai-codex',
        model: 'gpt-5.6-luna',
        reasoningRouterRole: 'worker',
        reasoningRouterEffort: 'high',
      }),
    }))
    expect(result).toMatchObject({ role: 'worker', kind: 'subagent', stopReason: 'completed', childSessionId: 'worker-child' })
    expect(parent.session.events.find(event => event.type === 'agent-role/run-started')?.data).toMatchObject({ childSessionId: null, kind: 'subagent' })
    expect(parent.session.events.find(event => event.type === 'agent-role/run-finished')?.data).toMatchObject({ childSessionId: 'worker-child', status: 'succeeded' })
  })

  it('links a repeated role run to the prior advice it evaluates', async () => {
    const owner = agent({ provider: 'openai-codex', model: 'gpt-5.6-luna' })
    const team = new AgentTeam(modelContext(async function* () { yield* finishedText('advice') }), [brain])
    const first = await team.run(owner, 'brain', 'first task', new AbortController().signal, { triggerReason: 'high-risk' })
    const second = await team.run(owner, 'brain', 'second task', new AbortController().signal, {
      triggerReason: 'repeated-failure',
      priorAdviceEvaluation: 'The first advice was tested and still leaves a gap.',
    })
    const starts = owner.session.events.filter(event => event.type === 'agent-role/run-started')
    expect(starts[0]?.data).toMatchObject({ runId: first.runId, references: [] })
    expect(starts[1]?.data).toMatchObject({ runId: second.runId, references: [first.runId] })
  })

  it('does not execute advisory tool calls returned by a role model', async () => {
    const ctx = modelContext(async function* () {
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId('x'), name: 'bash', arguments: '{}' } }
      yield { type: 'block-end', index: 1, block: { type: 'text', text: 'use the supplied evidence' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    await expect(new AgentTeam(ctx, [brain]).run(
      agent({ provider: 'openai-codex', model: 'gpt-5.6-luna' }),
      'brain',
      'reason',
      new AbortController().signal,
    )).rejects.toThrow('returned a tool call; it was not executed')
  })
  it('builds a configurable trigger contract from strict role mappings and thresholds', () => {
    const worker: TeamRoleConfig = { id: 'worker', kind: 'subagent', description: 'execute' }
    const coordinator: TeamRoleConfig = { ...brain, id: 'coordinator' }
    const rules = {
      ...DEFAULT_TRIGGER_RULES,
      coordinatorMinDeliverables: 4,
      repeatedFailureThreshold: 3,
      customInstructions: 'Consult the brain before changing a public protocol.',
    }
    expect(() => validateTriggerRules(rules, [brain, coordinator, worker])).not.toThrow()
    expect(roleTriggerPrompt(rules)).toContain('at least 4 distinct deliverables')
    expect(roleTriggerPrompt(rules)).toContain('after 3 failed approaches')
    expect(roleTriggerPrompt(rules)).toContain('public protocol')
  })

  it('migrates only the legacy default role mapping onto a custom roster', () => {
    const roles: TeamRoleConfig[] = [
      { id: 'architect', kind: 'advisory', description: 'reason' },
      { id: 'planner', kind: 'advisory', description: 'coordinate' },
      { id: 'builder', kind: 'subagent', description: 'execute' },
    ]
    expect(migrateLegacyTriggerRules(DEFAULT_TRIGGER_RULES, roles)).toMatchObject({
      depthRoleId: 'architect', coordinatorRoleId: 'planner', workerRoleId: 'builder', firstTurnRoleId: 'planner',
    })
    expect(() => validateTeamSettings({
      teamEnabled: true, presetIds: [], roles, triggerRules: { ...DEFAULT_TRIGGER_RULES },
    })).not.toThrow()
  })

  it('enforces per-turn deep reasoning limits and resets them on the next turn', async () => {
    const owner = agent({ provider: 'openai-codex', model: 'gpt-5.6-luna' })
    const team = new AgentTeam(modelContext(), [brain], { ...DEFAULT_TRIGGER_RULES, maxDepthCallsPerTurn: 1 })
    team.beginTurn(owner)
    await team.run(owner, 'brain', 'high-risk decision', new AbortController().signal, { triggerReason: 'high-risk' })
    await expect(team.run(owner, 'brain', 'repeat', new AbortController().signal, {
      triggerReason: 'repeated-failure',
      priorAdviceEvaluation: 'The first advice was tested.',
    })).rejects.toThrow('limit reached')
    team.beginTurn(owner)
    await expect(team.run(owner, 'brain', 'new turn', new AbortController().signal, { triggerReason: 'high-risk' })).resolves.toMatchObject({ role: 'brain' })
  })

  it('documents manual-only mode without treating model-supplied reason metadata as authorization', async () => {
    const rules = { ...DEFAULT_TRIGGER_RULES, mode: 'manual' as const }
    const team = new AgentTeam(modelContext(), [brain], rules)
    await expect(team.run(
      agent({ provider: 'openai-codex', model: 'gpt-5.6-luna' }),
      'brain',
      'routine',
      new AbortController().signal,
      { triggerReason: 'custom-rule' },
    )).resolves.toMatchObject({ role: 'brain' })
    expect(roleTriggerPrompt(rules)).toContain('audit metadata, not an authorization boundary')
  })

  it('automatically runs the selected advisory role once on the first user turn', async () => {
    installRouterEvents()
    let calls = 0
    let captured: GenerateOptions | undefined
    const ctx = modelContext(async function* (options) {
      calls += 1
      captured = options
      yield* finishedText('decompose and verify')
    })
    const coordinator: TeamRoleConfig = { ...brain, id: 'coordinator' }
    const rules = { ...DEFAULT_TRIGGER_RULES, mode: 'first-turn' as const }
    const owner = agent({ provider: 'openai-codex', model: 'gpt-5.6-luna' })
    const team = new AgentTeam(ctx, [brain, coordinator], rules)
    team.beginTurn(owner)
    const input = [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'build three components' }] })]
    const first = await beforeInitialRoleRun(owner, input, team, rules, new AbortController().signal)
    const second = await beforeInitialRoleRun(owner, first, team, rules, new AbortController().signal)
    expect(first).toHaveLength(2)
    expect(second).toHaveLength(2)
    expect(calls).toBe(1)
    expect(captured?.maxTokens).toBe(1234)
    expect(owner.session.events.some(event => event.type === 'agent-role/initial-run')).toBe(true)
  })

  it('keeps a max-effort greeting first turn concise', async () => {
    installRouterEvents()
    let captured: GenerateOptions | undefined
    const ctx = modelContext(async function* (options) {
      captured = options
      yield* finishedText('No decomposition is needed.')
    })
    const greetingBrain: TeamRoleConfig = { ...brain, maxTokens: 131_072 }
    const rules = { ...DEFAULT_TRIGGER_RULES, mode: 'first-turn' as const, firstTurnRoleId: 'brain' }
    const owner = agent({ provider: 'openai-codex', model: 'gpt-5.6-luna' })
    const team = new AgentTeam(ctx, [greetingBrain], rules)
    team.beginTurn(owner)
    const input = [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] })]
    await beforeInitialRoleRun(owner, input, team, rules, new AbortController().signal)
    expect(captured?.reasoningEffort).toBe('max')
    expect(captured?.maxTokens).toBe(512)
  })

  it('rejects max output above a Kimi model built-in limit', () => {
    expect(() => validateTeamSettings({
      teamEnabled: true,
      presetIds: [],
      roles: [{ ...brain, provider: 'kimi-coding', model: 'k3-256k', maxTokens: 131_073 }],
      triggerRules: { ...DEFAULT_TRIGGER_RULES, firstTurnRoleId: 'brain' },
    })).toThrow('built-in maximum output 131072')
  })

})
