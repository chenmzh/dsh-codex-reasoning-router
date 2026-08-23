import type { SolReasoningEffort } from './constants.ts'

export type TeamRoleKind = 'advisory' | 'subagent'

export interface TeamRoleConfig {
  id: string
  kind: TeamRoleKind
  description: string
  /** Omit provider/model to inherit the calling agent's current route. */
  provider?: string
  model?: string
  /** Omit to use the selected model's configured/provider default. */
  reasoningEffort?: string
  maxTokens?: number
  systemPrompt?: string
  subagentProvider?: string
  maxDepth?: number
  toolAllow?: string[]
  toolDeny?: string[]
}

export interface Config {
  teamEnabled: boolean
  /** Empty means the team tools compose with every preset. */
  presetIds: string[]
  roles: TeamRoleConfig[]
  requiredPresetId: string
  lunaProvider: string
  lunaModel: string
  solProvider: string
  solModel: string
  initialSolReasoning: SolReasoningEffort
  escalatedSolReasoning: SolReasoningEffort
  solAdviceMaxTokens: number
  solTimeoutMs: number
  initialConsultEnabled: boolean
  failOpen: boolean
}

export interface SolConsultInput {
  problem: string
  goal: string
  evidence: string[]
  attempts: string[]
  constraints: string[]
  question: string
  prior_advice_evaluation?: string
  medium_advice_evaluation?: string
}

export interface SolIssueState {
  fingerprint: string
  mediumUsed: boolean
  highUsed: boolean
  mediumAdvice?: string
  highAdvice?: string
  resolved?: boolean
}

export interface AdvisoryRequest {
  effort: SolReasoningEffort
  prompt: string
  signal?: AbortSignal
  /** Usage-only correlation; never becomes the provider's session identity. */
  usageSessionId?: string
}

export interface AdvisoryResult {
  effort: SolReasoningEffort
  advice: string
}

export interface ConsultValue {
  status: 'advised' | 'unavailable' | 'evaluation-required' | 'escalation-exhausted'
  fingerprint: string
  effort?: SolReasoningEffort
  advisory?: string
  message?: string
}
