import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import {
  CallId,
  createUserMessage,

  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  advisorScope,
  isRouterPresetAgent,
  installRouterEvents,
  issueFingerprint,
  ReasoningRouter,
  restoreIssueStates,
  SolAdvisor,
  SolProtocolError,
  solConsultTool,
  type Config,
  type SolConsultInput,
} from '../src/index.ts'

installRouterEvents()

const config: Config = {
  requiredPresetId: 'luna-sol-reasoning-router',
  lunaProvider: 'openai-codex',
  lunaModel: 'gpt-5.6-luna',
  solProvider: 'openai-codex',
  solModel: 'gpt-5.6-sol',
  initialSolReasoning: 'medium',
  escalatedSolReasoning: 'high',
  solAdviceMaxTokens: 2000,
  solTimeoutMs: 30000,
  initialConsultEnabled: true,
  failOpen: true,
}

function chunks(block: { type: 'text'; text: string } | { type: 'tool-call'; id: ReturnType<typeof CallId>; name: string; arguments: string }): StreamChunk[] {
  return [
    { type: 'block-end', index: 0, block },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function advisorWith(stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>): SolAdvisor {
  return new SolAdvisor({ llm: { stream } } as unknown as Context, config)
}

function fakeAgent(id: string, seed: readonly never[] = [], agentPreset?: string): Agent {
  const session = Session.create(SessionId(id), seed, agentPreset === undefined ? undefined : {
    id: SessionId(id),
    version: 0,
    createdAt: 0,
    delegationDepth: 0,
    agentPreset,
  })
  return {
    id: session.id,
    options: { provider: config.lunaProvider, model: config.lunaModel },
    session,
    ctx: { logger: undefined } as unknown as Context,
  } as Agent
}

function user(text: string) {
  return createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
}

function issue(problem = 'build fails in module alpha'): SolConsultInput {
  return {
    problem,
    goal: 'ship a verified build',
    evidence: ['tests/alpha.spec.ts: Error: expected true', 'module alpha is unchanged'],
    attempts: ['reproduced the exact failing test'],
    constraints: ['do not change public API'],
    question: 'What should Luna verify next?',
  }
}

function fakeAdvisor(implementation: (effort: 'medium' | 'high') => Promise<string>) {
  return { consult: vi.fn(({ effort }: { effort: 'medium' | 'high' }) => implementation(effort)) } as unknown as SolAdvisor
}

describe('reasoning router invariants', () => {
  it('Test 1: completes initial Sol medium before Luna can make its first request', async () => {
    const order: string[] = []
    const advisor = fakeAdvisor(async (effort) => {
      order.push(`sol-${effort}`)
      return '<sol_advisory>initial</sol_advisory>'
    })
    const router = new ReasoningRouter(config, advisor)
    const agent = fakeAgent('initial-order')
    const messages = await router.beforeFirstStep(agent, [user('implement this')], new AbortController().signal)
    order.push('luna-request')
    expect(order).toEqual(['sol-medium', 'luna-request'])
    expect(messages.at(-1)?.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('initial') })
  })

  it('Test 2: sends Sol no tools and no session continuation identity', async () => {
    let captured: GenerateOptions | undefined
    const advisor = advisorWith(async function* (options) {
      captured = options
      yield* chunks({ type: 'text', text: '<sol_advisory>ok</sol_advisory>' })
    })
    await advisor.consult({ effort: 'medium', prompt: 'evidence' })
    expect(captured?.tools).toBeUndefined()
    expect(captured?.sessionId).toBeUndefined()
    expect(captured?.provider).toBe('openai-codex')
    expect(captured?.model).toBe('gpt-5.6-sol')
  })

  it('rejects xhigh/max at runtime even from an untyped caller', async () => {
    let calls = 0
    const advisor = advisorWith(async function* () {
      calls += 1
      yield* chunks({ type: 'text', text: 'must not run' })
    })
    await expect(advisor.consult({ effort: 'max', prompt: 'evidence' } as never)).rejects.toThrow('Only medium and high')
    expect(calls).toBe(0)
  })

  it('Test 3 and 12: rejects a Sol tool call and never executes it', async () => {
    const execute = vi.fn()
    const advisor = new SolAdvisor({
      llm: {
        stream: async function* () {
          yield* chunks({ type: 'tool-call', id: CallId('sol-call'), name: 'shell', arguments: '{}' })
        },
      },
      tools: { execute },
    } as unknown as Context, config)
    await expect(advisor.consult({ effort: 'medium', prompt: 'evidence' })).rejects.toBeInstanceOf(SolProtocolError)
    expect(execute).not.toHaveBeenCalled()
  })

  it('Test 4: ordinary Luna activity does not auto-consult Sol', () => {
    const advisor = fakeAdvisor(async () => 'unused')
    new ReasoningRouter(config, advisor)
    expect(advisor.consult).not.toHaveBeenCalled()
  })

  it('Test 5: first consultation for issue X uses medium', async () => {
    const advisor = fakeAdvisor(async effort => `<sol_advisory>${effort}</sol_advisory>`)
    const router = new ReasoningRouter(config, advisor)
    const result = await router.consult(fakeAgent('medium'), issue(), new AbortController().signal)
    expect(result).toMatchObject({ status: 'advised', effort: 'medium' })
  })

  it('Test 6: same evaluated unresolved issue escalates exactly to high', async () => {
    const advisor = fakeAdvisor(async effort => `<sol_advisory>${effort}</sol_advisory>`)
    const router = new ReasoningRouter(config, advisor)
    const agent = fakeAgent('high')
    await router.consult(agent, issue(), new AbortController().signal)
    const result = await router.consult(agent, {
      ...issue(),
      attempts: [...issue().attempts, 'applied the medium investigation; failure persisted'],
      medium_advice_evaluation: 'Checked the proposed invariant against the failing test; it was false and the same error remains.',
    }, new AbortController().signal)
    expect(result).toMatchObject({ status: 'advised', effort: 'high' })
  })

  it('requires evidence that medium advice was evaluated before high', async () => {
    const advisor = fakeAdvisor(async effort => `<sol_advisory>${effort}</sol_advisory>`)
    const router = new ReasoningRouter(config, advisor)
    const agent = fakeAgent('evaluation')
    await router.consult(agent, issue(), new AbortController().signal)
    const result = await router.consult(agent, issue(), new AbortController().signal)
    expect(result.status).toBe('evaluation-required')
    expect(advisor.consult).toHaveBeenCalledTimes(1)
  })

  it('Test 7: third consultation is exhausted and never emits xhigh/max/high again', async () => {
    const advisor = fakeAdvisor(async effort => `<sol_advisory>${effort}</sol_advisory>`)
    const router = new ReasoningRouter(config, advisor)
    const agent = fakeAgent('exhausted')
    await router.consult(agent, issue(), new AbortController().signal)
    const escalated = { ...issue(), medium_advice_evaluation: 'Applied and disproved the medium hypothesis.' }
    await router.consult(agent, escalated, new AbortController().signal)
    const result = await router.consult(agent, escalated, new AbortController().signal)
    expect(result.status).toBe('escalation-exhausted')
    expect(advisor.consult).toHaveBeenCalledTimes(2)
    expect(vi.mocked(advisor.consult).mock.calls.map(call => call[0].effort)).toEqual(['medium', 'high'])
  })

  it('Test 8: a new issue Y starts again at medium', async () => {
    const advisor = fakeAdvisor(async effort => `<sol_advisory>${effort}</sol_advisory>`)
    const router = new ReasoningRouter(config, advisor)
    const agent = fakeAgent('new-issue')
    await router.consult(agent, issue('issue X in parser'), new AbortController().signal)
    const result = await router.consult(agent, issue('issue Y in database migration'), new AbortController().signal)
    expect(result).toMatchObject({ status: 'advised', effort: 'medium' })
  })

  it('Test 9: Sol failure is fail-open and does not consume medium', async () => {
    const advisor = fakeAdvisor(async () => { throw new Error('network unavailable') })
    const router = new ReasoningRouter(config, advisor)
    const agent = fakeAgent('failure')
    const initial = await router.beforeFirstStep(agent, [user('do work')], new AbortController().signal)
    expect(initial).toHaveLength(1)
    const first = await router.consult(agent, issue(), new AbortController().signal)
    const second = await router.consult(agent, issue(), new AbortController().signal)
    expect(first).toMatchObject({ status: 'unavailable', effort: 'medium' })
    expect(second).toMatchObject({ status: 'unavailable', effort: 'medium' })
  })

  it('Test 10: internal Sol stream is covered by the recursion guard', async () => {
    const observed: Array<string | undefined> = []
    const advisor = advisorWith(async function* () {
      observed.push(advisorScope.getStore()?.purpose)
      yield* chunks({ type: 'text', text: 'ok' })
    })
    await advisor.consult({ effort: 'medium', prompt: 'evidence' })
    expect(observed).toEqual(['sol-advisory'])
    expect(advisorScope.getStore()).toBeUndefined()
  })

  it('Test 11: rejects a non-Luna main route without rewriting it', () => {
    const router = new ReasoningRouter(config, fakeAdvisor(async () => 'unused'))
    const agent = fakeAgent('wrong-route')
    const wrong = { ...agent, options: { provider: 'openai-codex', model: 'gpt-5.6-sol' } } as Agent
    expect(() => router.assertConfiguredLuna(wrong)).toThrow('paused before execution')
    expect(wrong.options.model).toBe('gpt-5.6-sol')
  })

  it('Test 13: restores issue escalation state from durable session events', async () => {
    const router = new ReasoningRouter(config, fakeAdvisor(async effort => `<sol_advisory>${effort}</sol_advisory>`))
    const original = fakeAgent('before-restart')
    await router.consult(original, issue(), new AbortController().signal)
    const resumedSession = Session.create(SessionId('after-restart'), original.session.events)
    const states = restoreIssueStates(resumedSession)
    expect(states.get(issueFingerprint(issue()))).toMatchObject({ mediumUsed: true, highUsed: false })
  })

  it('Test 14: exposes a fixed schema with no level and does not mutate another catalog', () => {
    const existing = ['read_file', 'shell', 'edit_file']
    const before = [...existing]
    const definition = solConsultTool(new ReasoningRouter(config, fakeAdvisor(async () => 'unused')))
    expect(Object.keys(definition.parameters.properties ?? {})).not.toContain('level')
    expect(existing).toEqual(before)
    expect(definition.name).toBe('sol_consult')
  })

  it('attaches only to a root session using the configured Router preset', () => {
    const matching = fakeAgent('matching-preset', [], config.requiredPresetId)
    const standard = fakeAgent('standard-preset', [], 'standard')
    expect(isRouterPresetAgent(matching, [matching, standard], config.requiredPresetId)).toBe(true)
    expect(isRouterPresetAgent(standard, [matching, standard], config.requiredPresetId)).toBe(false)
    expect(isRouterPresetAgent(matching, [], config.requiredPresetId)).toBe(false)
  })

  it('allows both stages to be configured as medium or high while keeping the two-call ceiling', async () => {
    const custom: Config = { ...config, initialSolReasoning: 'high', escalatedSolReasoning: 'medium' }
    const advisor = fakeAdvisor(async effort => '<sol_advisory>' + effort + '</sol_advisory>')
    const router = new ReasoningRouter(custom, advisor)
    const agent = fakeAgent('custom-efforts')
    const first = await router.consult(agent, issue(), new AbortController().signal)
    const second = await router.consult(agent, {
      ...issue(),
      prior_advice_evaluation: 'Evaluated the first-stage advice; the same blocker remains.',
    }, new AbortController().signal)
    const third = await router.consult(agent, {
      ...issue(),
      prior_advice_evaluation: 'Both stages were evaluated; the blocker remains.',
    }, new AbortController().signal)
    expect([first.effort, second.effort]).toEqual(['high', 'medium'])
    expect(third.status).toBe('escalation-exhausted')
    expect(advisor.consult).toHaveBeenCalledTimes(2)
  })
})
