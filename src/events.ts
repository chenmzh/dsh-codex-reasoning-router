import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import type { SolReasoningEffort } from './constants.ts'
import type { SolIssueState } from './types.ts'

export const ROUTER_EVENT_TYPES = [
  'reasoning-router/initial-consult',
  'reasoning-router/consult-medium',
  'reasoning-router/consult-high',
  'reasoning-router/consult-failed',
  'reasoning-router/escalation-exhausted',
] as const

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
