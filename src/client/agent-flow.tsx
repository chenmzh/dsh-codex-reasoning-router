import { useMemo } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { ChatNodeViewProps, ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type {
  ConversationContextReader,
  ConversationMatch,
  ConversationNodeContext,
  ConversationNodeDefinition,
  ConversationTimelineSnapshot,
  ConversationViewBuilder,
  ConversationViewDefinition,
  ConversationViewNode,
} from '@deepseek-ai/dsh-client-ui-conversation/client'

const AGENT_ROLE_CHAT_KIND = 'agent-role/chat-run'
export const AGENT_FLOW_TARGET = 'agent-flow'
const AGENT_ROLE_RUN_KIND = 'agent-role/run'
const AGENT_ROLE_STARTED = 'agent-role/run-started'
const AGENT_ROLE_FINISHED = 'agent-role/run-finished'

export interface AgentFlowRun {
  readonly runId: string
  readonly role: string
  readonly kind: 'advisory' | 'subagent'
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
  readonly triggerReason: string
  readonly parentRunId: string | null
  readonly childSessionId: string | null
  readonly references: readonly string[]
  readonly task: string
  readonly startSeq: number
  readonly startedAt: number
  readonly status: 'running' | 'succeeded' | 'failed'
  readonly completedAt?: number
  readonly durationMs?: number
  readonly output?: string
  readonly stopReason?: string
  readonly error?: string
}

export interface AgentFlowNode extends ConversationViewNode {
  readonly target: typeof AGENT_FLOW_TARGET
  readonly data: AgentFlowRun
}

export interface AgentFlowSnapshot {
  readonly nodes: readonly AgentFlowNode[]
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    'agent-role/chat-run': AgentFlowRun
  }
}

export const EMPTY_AGENT_FLOW_SNAPSHOT: AgentFlowSnapshot = { nodes: [] }

function recordOf(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function nullableStringOf(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function stringArrayOf(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item !== '')
}

function eventType(event: SessionEvent): string {
  return String(event.type)
}

function runIdOf(event: SessionEvent): string | undefined {
  return stringOf(recordOf(event.data)?.runId)
}

function startPayload(value: unknown): Omit<AgentFlowRun, 'startSeq' | 'startedAt' | 'status'> | undefined {
  const data = recordOf(value)
  const runId = stringOf(data?.runId)
  const role = stringOf(data?.role)
  const kind = data?.kind === 'advisory' || data?.kind === 'subagent' ? data.kind : undefined
  const provider = stringOf(data?.provider)
  const model = stringOf(data?.model)
  const triggerReason = stringOf(data?.triggerReason)
  const task = stringOf(data?.task)
  if (data?.version !== 1 || runId === undefined || role === undefined || kind === undefined
    || provider === undefined || model === undefined || triggerReason === undefined || task === undefined) return undefined
  const reasoningEffort = stringOf(data?.reasoningEffort)
  return {
    runId,
    role,
    kind,
    provider,
    model,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    triggerReason,
    parentRunId: nullableStringOf(data?.parentRunId),
    childSessionId: nullableStringOf(data?.childSessionId),
    references: stringArrayOf(data?.references),
    task,
  }
}

interface AgentFlowFinish {
  readonly status: 'succeeded' | 'failed'
  readonly durationMs: number
  readonly childSessionId?: string | null
  readonly output?: string
  readonly stopReason?: string
  readonly error?: string
}

function finishPayload(value: unknown): AgentFlowFinish | undefined {
  const data = recordOf(value)
  const status = data?.status === 'succeeded' || data?.status === 'failed' ? data.status : undefined
  const durationMs = typeof data?.durationMs === 'number' && Number.isFinite(data.durationMs) ? data.durationMs : undefined
  if (data?.version !== 1 || status === undefined || durationMs === undefined) return undefined
  const output = stringOf(data?.output)
  const stopReason = stringOf(data?.stopReason)
  const error = stringOf(data?.error)
  return {
    status,
    durationMs,
    ...(data?.childSessionId === undefined ? {} : { childSessionId: nullableStringOf(data.childSessionId) }),
    ...(output === undefined ? {} : { output }),
    ...(stopReason === undefined ? {} : { stopReason }),
    ...(error === undefined ? {} : { error }),
  }
}

function agentRoleRunDefinition(): ConversationNodeDefinition<AgentFlowRun> {
  return {
    kind: AGENT_ROLE_RUN_KIND,
    target: AGENT_FLOW_TARGET,
    match(event: SessionEvent) {
      const type = eventType(event)
      if (type !== AGENT_ROLE_STARTED && type !== AGENT_ROLE_FINISHED) return null
      const id = runIdOf(event)
      if (id === undefined) return null
      return { id, role: type === AGENT_ROLE_STARTED ? 'start' : 'update' }
    },
    start(_context, match, _reader): AgentFlowRun {
      const payload = startPayload(match.event.data)
      if (payload === undefined) throw new Error('agent-flow: matched start event has an invalid payload')
      return { ...payload, startSeq: match.event.seq, startedAt: match.event.time, status: 'running' }
    },
    update(context, match): AgentFlowRun {
      const payload = finishPayload(match.event.data)
      if (payload === undefined) return context.state
      return {
        ...context.state,
        ...payload,
        ...(payload.childSessionId === undefined ? {} : { childSessionId: payload.childSessionId }),
        completedAt: match.event.time,
      }
    },
    publication: () => 'immediate',
    buildViewNode(context): AgentFlowNode | null {
      const data = context.state
      if (data === undefined) return null
      return {
        key: context.key,
        kind: AGENT_ROLE_RUN_KIND,
        id: data.runId,
        target: AGENT_FLOW_TARGET,
        data,
      }
    },
  }
}

function agentRoleChatDefinition(): ConversationNodeDefinition<AgentFlowRun> {
  return {
    kind: AGENT_ROLE_CHAT_KIND,
    target: 'chat',
    match(event: SessionEvent) {
      const type = eventType(event)
      if (type !== AGENT_ROLE_STARTED && type !== AGENT_ROLE_FINISHED) return null
      const id = runIdOf(event)
      if (id === undefined) return null
      return { id, role: type === AGENT_ROLE_STARTED ? 'start' : 'update' }
    },
    start(_context, match): AgentFlowRun {
      const payload = startPayload(match.event.data)
      if (payload === undefined) throw new Error('agent-role chat: invalid start event')
      return { ...payload, startSeq: match.event.seq, startedAt: match.event.time, status: 'running' }
    },
    update(context, match): AgentFlowRun {
      const payload = finishPayload(match.event.data)
      if (payload === undefined) return context.state
      return {
        ...context.state,
        ...payload,
        ...(payload.childSessionId === undefined ? {} : { childSessionId: payload.childSessionId }),
        completedAt: match.event.time,
      }
    },
    publication: () => 'immediate',
    buildViewNode(context): ChatConversationViewNode | null {
      const data = context.state
      if (data === undefined || context.start === undefined) return null
      return {
        key: context.key,
        kind: AGENT_ROLE_CHAT_KIND,
        id: data.runId,
        target: 'chat',
        anchorSeq: context.start.event.seq,
        location: context.start.location,
        visibility: 'visible',
        data,
      }
    },
  }
}

class AgentFlowSnapshotBuilder implements ConversationViewBuilder<AgentFlowNode, AgentFlowSnapshot> {
  readonly empty = EMPTY_AGENT_FLOW_SNAPSHOT
  private readonly nodes = new Map<string, AgentFlowNode>()

  replace(input: { readonly nodes: readonly AgentFlowNode[]; readonly timeline: ConversationTimelineSnapshot }): AgentFlowSnapshot {
    this.nodes.clear()
    for (const node of input.nodes) this.nodes.set(node.key, node)
    return this.snapshot()
  }

  apply(input: { readonly upserts: readonly AgentFlowNode[]; readonly timeline: ConversationTimelineSnapshot }): AgentFlowSnapshot {
    for (const node of input.upserts) this.nodes.set(node.key, node)
    return this.snapshot()
  }

  private snapshot(): AgentFlowSnapshot {
    return { nodes: [...this.nodes.values()].sort((left, right) => left.data.startSeq - right.data.startSeq) }
  }
}

export const agentFlowViewDefinition: ConversationViewDefinition<AgentFlowNode, AgentFlowSnapshot> = {
  target: AGENT_FLOW_TARGET,
  create: () => new AgentFlowSnapshotBuilder(),
}

function shortId(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—'
  return value.length <= 18 ? value : '…' + value.slice(-17)
}

function timeOf(value: number): string {
  try {
    return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  } catch {
    return String(value)
  }
}

function statusLabel(status: AgentFlowRun['status']): string {
  if (status === 'running') return '运行中'
  if (status === 'failed') return '失败'
  return '完成'
}

function kindLabel(kind: AgentFlowRun['kind']): string {
  return kind === 'subagent' ? '子 Agent' : '顾问 Agent'
}

const STYLE = `.agentFlow{box-sizing:border-box;height:100%;overflow:auto;padding:24px 28px 48px;color:var(--dsw-alias-label-primary);font-size:13px}.agentFlow *{box-sizing:border-box}.agentFlowHeader{display:flex;justify-content:space-between;gap:18px;align-items:flex-start;margin-bottom:18px}.agentFlowHeader h2{margin:0 0 6px;font-size:20px}.agentFlowHeader p{margin:0;color:var(--dsw-alias-label-secondary);line-height:20px}.agentFlowCount{border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:5px 10px;color:var(--dsw-alias-label-secondary);white-space:nowrap}.agentFlowEmpty{border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;padding:28px;color:var(--dsw-alias-label-secondary);text-align:center}.agentFlowList{display:flex;flex-direction:column;gap:10px}.agentFlowCard{border:1px solid var(--dsw-alias-border-l2);border-left:3px solid var(--dsw-alias-state-business-primary);border-radius:9px;background:var(--dsw-alias-bg-layer-1);padding:12px 14px;box-shadow:0 1px 2px rgba(0,0,0,.05)}.agentFlowCard[data-status=failed]{border-left-color:var(--dsw-alias-state-danger-primary)}.agentFlowCard[data-status=running]{border-left-color:var(--dsw-alias-state-warning-primary)}.agentFlowTop{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.agentFlowRole{font-weight:700;font-size:14px}.agentFlowBadge{border-radius:999px;padding:2px 7px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px}.agentFlowStatus{margin-left:auto}.agentFlowMeta{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:8px;color:var(--dsw-alias-label-secondary);font-size:11px}.agentFlowRelation{margin-top:8px;padding:7px 9px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);line-height:18px}.agentFlowRelation strong{color:var(--dsw-alias-label-primary);font-weight:600}.agentFlowConversation{display:grid;gap:8px;margin-top:10px}.agentFlowMessage{border-radius:7px;padding:9px 10px;line-height:19px;white-space:pre-wrap;overflow-wrap:anywhere}.agentFlowMessageUser{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent)}.agentFlowMessageAgent{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent)}.agentFlowMessageError{background:color-mix(in srgb,var(--dsw-alias-state-danger-primary) 10%,transparent)}.agentFlowMessageLabel{display:block;margin-bottom:3px;color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:650}.agentFlowDetails{margin-top:10px}.agentFlowDetails summary{cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:12px}.agentFlowFooter{margin-top:10px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:17px}.agentFlowFooter code{font-family:var(--dsw-alias-font-mono,monospace)}`

function depthOf(run: AgentFlowRun, byId: ReadonlyMap<string, AgentFlowRun>): number {
  let depth = 0
  let parent = run.parentRunId
  const seen = new Set<string>()
  while (parent !== null && !seen.has(parent) && depth < 8) {
    seen.add(parent)
    const owner = byId.get(parent)
    if (owner === undefined) break
    depth += 1
    parent = owner.parentRunId
  }
  return depth
}

interface AgentFlowSessionSnapshot {
  readonly views: { get(target: string): unknown }
}

interface AgentFlowViewProps {
  readonly useSession: <Value>(selector: (session: AgentFlowSessionSnapshot) => Value) => Value
}

export function AgentFlowView({ useSession }: AgentFlowViewProps): JSX.Element {
  const snapshot = useSession(session =>
    session.views.get(AGENT_FLOW_TARGET) as AgentFlowSnapshot | undefined,
  ) ?? EMPTY_AGENT_FLOW_SNAPSHOT
  const runs = useMemo(() => snapshot.nodes.map(node => node.data), [snapshot])
  const byId = useMemo(() => new Map(runs.map(run => [run.runId, run])), [runs])

  return (
    <div className="agentFlow" data-testid="agent-flow-view">
      <style>{STYLE}</style>
      <header className="agentFlowHeader">
        <div>
          <h2>Agent 激活关系</h2>
          <p>查看本对话中何时调用了 Agent、谁激活了谁，以及任务与返回结果。</p>
        </div>
        <span className="agentFlowCount">{runs.length} 次调用</span>
      </header>
      {runs.length === 0 ? (
        <div className="agentFlowEmpty">本对话还没有记录到 agent_role_run。</div>
      ) : (
        <div className="agentFlowList">
          {runs.map(run => {
            const depth = depthOf(run, byId)
            return (
              <article
                className="agentFlowCard"
                data-status={run.status}
                key={run.runId}
                style={{ marginLeft: Math.min(depth, 6) * 20 }}
              >
                <div className="agentFlowTop">
                  <span className="agentFlowRole">{run.role}</span>
                  <span className="agentFlowBadge">{kindLabel(run.kind)}</span>
                  <span className="agentFlowBadge">{run.triggerReason}</span>
                  <span className="agentFlowBadge agentFlowStatus">{statusLabel(run.status)}</span>
                </div>
                <div className="agentFlowMeta">
                  <span>{timeOf(run.startedAt)}</span>
                  <span>{run.provider}/{run.model}</span>
                  {run.reasoningEffort === undefined ? null : <span>effort: {run.reasoningEffort}</span>}
                  {run.durationMs === undefined ? null : <span>{run.durationMs}ms</span>}
                </div>
                <div className="agentFlowRelation">
                  <strong>激活：</strong>{run.parentRunId === null ? '当前对话 Agent' : shortId(run.parentRunId)}
                  <span> · </span>
                  <strong>引用：</strong>{run.references.length === 0 ? '无显式引用' : run.references.map(shortId).join(', ')}
                  {run.childSessionId === null ? null : <><span> · </span><strong>子会话：</strong>{shortId(run.childSessionId)}</>}
                </div>
                <details className="agentFlowDetails">
                  <summary>展开 Agent 对话</summary>
                  <div className="agentFlowConversation">
                    <div className="agentFlowMessage agentFlowMessageUser">
                      <span className="agentFlowMessageLabel">→ 发送给 {run.role}</span>
                      {run.task}
                    </div>
                    {run.output === undefined ? null : (
                      <div className="agentFlowMessage agentFlowMessageAgent">
                        <span className="agentFlowMessageLabel">← {run.role} 返回</span>
                        {run.output}
                      </div>
                    )}
                    {run.error === undefined ? null : (
                      <div className="agentFlowMessage agentFlowMessageError">
                        <span className="agentFlowMessageLabel">错误</span>
                        {run.error}
                      </div>
                    )}
                  </div>
                </details>
                <div className="agentFlowFooter">run_id: <code>{run.runId}</code>{run.stopReason === undefined ? null : <> · stop: {run.stopReason}</>}</div>
              </article>
            )
          })}
        </div>
      )}
    </div>
  )
}

function AgentRoleChatStatus({ node }: ChatNodeViewProps<'agent-role/chat-run'>): JSX.Element {
  const run = node.data
  const label = run.status === 'running' ? `正在运行 ${run.role}…` : `${run.role} ${statusLabel(run.status)}`
  return (
    <div data-testid="agent-role-chat-status" data-status={run.status} style={{ margin: '8px 0', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)', borderLeft: '3px solid var(--dsw-alias-state-warning-primary)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-secondary)', fontSize: 12 }}>
      <strong style={{ color: 'var(--dsw-alias-label-primary)' }}>{label}</strong>
      <span> · {run.provider}/{run.model}</span>
      {run.reasoningEffort === undefined ? null : <span> · effort: {run.reasoningEffort}</span>}
      {run.durationMs === undefined ? null : <span> · {(run.durationMs / 1000).toFixed(1)}s</span>}
    </div>
  )
}

interface AgentFlowSlots {
  inject(name: string, factory: () => unknown): unknown
  register(options: { name: string; id?: string; key?: string; order?: number; label?: () => string; inject?: () => unknown }, component: unknown): () => void
}

export function registerAgentFlow(ctx: Context): void {
  const slots = ctx.slots as unknown as AgentFlowSlots
  ctx.uiConversation.events.register(agentRoleRunDefinition())
  ctx.uiConversation.events.register(agentRoleChatDefinition())
  slots.inject('conversation.chat.node', () => slots.register({
    name: 'conversation.chat.node', key: AGENT_ROLE_CHAT_KIND,
  }, AgentRoleChatStatus))
  ctx.uiConversation.views.register(agentFlowViewDefinition)
  slots.inject('conversation.view', () => slots.register({
    name: 'conversation.view',
    id: AGENT_FLOW_TARGET,
    order: 25,
    label: () => 'Agent 关系',
    inject: () => ({}),
  }, AgentFlowView))
}
