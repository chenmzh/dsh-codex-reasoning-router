import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import type { SolReasoningEffort } from './constants.ts'
import type { RoleTriggerReason, SolIssueState } from './types.ts'

export const ROUTER_EVENT_TYPES = [
  'agent-role/initial-run',
  'agent-role/run-started',
  'agent-role/run-finished',
  'reasoning-router/initial-consult',
  'reasoning-router/consult-medium',
  'reasoning-router/consult-high',
  'reasoning-router/consult-failed',
  'reasoning-router/escalation-exhausted',
] as const

interface InitialRoleRunEvent {
  status: 'succeeded' | 'failed'
  role: string
  triggerReason: 'first-turn-policy'
  error?: string
}

export interface AgentRoleRunStartedEvent {
  version: 1
  runId: string
  role: string
  kind: 'advisory' | 'subagent'
  provider: string
  model: string
  reasoningEffort?: string
  triggerReason: RoleTriggerReason
  parentRunId: string | null
  childSessionId: string | null
  references: string[]
  task: string
}

export interface AgentRoleRunFinishedEvent {
  version: 1
  runId: string
  status: 'succeeded' | 'failed'
  durationMs: number
  childSessionId?: string | null
  output?: string
  stopReason?: string
  error?: string
}

interface InitialConsultEvent {
  status: 'succeeded' | 'failed' | 'disabled'
  advisory?: string
  error?: string
}

interface ConsultEvent {
  fingerprint: string
  effort: SolReasoningEffort
  advisory: string
  state: SolIssueState
}

interface ConsultFailedEvent {
  phase: 'initial' | 'consult'
  fingerprint?: string
  effort: SolReasoningEffort
  error: string
}

interface EscalationExhaustedEvent {
  fingerprint: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'agent-role/initial-run': InitialRoleRunEvent
    'agent-role/run-started': AgentRoleRunStartedEvent
    'agent-role/run-finished': AgentRoleRunFinishedEvent
    'reasoning-router/initial-consult': InitialConsultEvent
    'reasoning-router/consult-medium': ConsultEvent
    'reasoning-router/consult-high': ConsultEvent
    'reasoning-router/consult-failed': ConsultFailedEvent
    'reasoning-router/escalation-exhausted': EscalationExhaustedEvent
  }
}

export function installRouterEvents(): void {
  if (!(KNOWN_SESSION_EVENT_TYPES instanceof Set)) {
    throw new Error('dsh-codex-reasoning-router: this DSH build does not expose the extensible session event vocabulary')
  }
  for (const event of ROUTER_EVENT_TYPES) KNOWN_SESSION_EVENT_TYPES.add(event)
}
