import type { SolReasoningEffort } from './constants.ts'

export interface Config {
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
