import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { CallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  AgentTeam,
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
    const result = await new AgentTeam(ctx, [brain]).run(
      agent({ provider: 'openai-codex', model: 'gpt-5.6-luna' }),
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
    expect(result).toMatchObject({ role: 'worker', kind: 'subagent', stopReason: 'completed' })
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
})
