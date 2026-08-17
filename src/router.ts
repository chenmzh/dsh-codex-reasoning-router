import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { PACKAGE_NAME } from './constants.ts'
import { blockerPrompt, initialPrompt, safeError, SolAdvisor } from './advisor.ts'
import {
  hasExhaustedRecord,
  hasInitialConsultRecord,
  issueFingerprint,
  restoreIssueStates,
} from './state.ts'
import type { Config, ConsultValue, SolConsultInput, SolIssueState } from './types.ts'

function log(ctx: Agent['ctx'], level: 'info' | 'warn', message: string): void {
  ctx.logger?.[level]?.(`[${PACKAGE_NAME}] ${message}`)
}

function directUserText(messages: readonly UserMessage[]): string | undefined {
  const message = messages.find(candidate => candidate.source.kind === 'user')
  if (message === undefined) return undefined
  const text = message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim()
  return text.length === 0 ? '[User supplied non-text content; no text was available to the advisor.]' : text
}

function advisoryMessage(advice: string, effort: 'medium' | 'high'): UserMessage {
  return createUserMessage({
    source: {
      kind: 'plugin',
      plugin: PACKAGE_NAME,
      form: 'notice',
      summary: 'Sol ' + effort + ' initial advisory; Luna remains the executor',
    },
    content: [{
      type: 'text',
      text: `Reasoning Advisory Packet from Sol (advice only; verify before action):\n${advice}`,
    }],
  })
}

function nextState(current: SolIssueState | undefined, fingerprint: string, advice: string): SolIssueState {
  if (current === undefined || !current.mediumUsed) {
    return { fingerprint, mediumUsed: true, highUsed: false, mediumAdvice: advice, resolved: false }
  }
  return {
    ...current,
    highUsed: true,
    highAdvice: advice,
    resolved: false,
  }
}

export class ReasoningRouter {
  private readonly advisor: SolAdvisor

  constructor(private readonly config: Config, advisor: SolAdvisor) {
    this.advisor = advisor
  }

  assertConfiguredLuna(agent: Agent): void {
    const header = agent.session.requestHeader()?.config
    const provider = agent.options.provider ?? header?.provider
    const model = agent.options.model ?? header?.model
    if (provider !== this.config.lunaProvider || model !== this.config.lunaModel) {
      throw new Error(
        `${PACKAGE_NAME}: root agent route must be ${this.config.lunaProvider}/${this.config.lunaModel}; `
        + `observed ${provider ?? '<unset>'}/${model ?? '<unset>'}. The router did not change the route and paused before execution.`,
      )
    }
  }

  async beforeFirstStep(agent: Agent, messages: UserMessage[], signal: AbortSignal): Promise<UserMessage[]> {
    if (hasInitialConsultRecord(agent.session)) return messages
    const request = directUserText(messages)
    if (request === undefined) return messages
    this.assertConfiguredLuna(agent)

    if (!this.config.initialConsultEnabled) {
      agent.session.append('reasoning-router/initial-consult', { status: 'disabled' })
      return messages
    }

    try {
      const advice = await this.advisor.consult({
        effort: this.config.initialSolReasoning,
        prompt: initialPrompt(request, agent.session.header.cwd),
        signal,
      })
      agent.session.append('reasoning-router/initial-consult', { status: 'succeeded', advisory: advice })
      log(agent.ctx, 'info', 'reasoning-router/initial-consult: Sol ' + this.config.initialSolReasoning + ' consulted; Luna resumes execution')
      return [...messages, advisoryMessage(advice, this.config.initialSolReasoning)]
    } catch (error: unknown) {
      const detail = safeError(error)
      agent.session.append('reasoning-router/consult-failed', {
        phase: 'initial',
        effort: this.config.initialSolReasoning,
        error: detail,
      })
      agent.session.append('reasoning-router/initial-consult', { status: 'failed', error: detail })
      log(agent.ctx, 'warn', `reasoning-router/consult-failed: ${detail}; Luna continues`)
      if (!this.config.failOpen) throw error
      return messages
    }
  }

  async consult(agent: Agent, input: SolConsultInput, signal: AbortSignal): Promise<ConsultValue> {
    this.assertConfiguredLuna(agent)
    const fingerprint = issueFingerprint(input)
    const current = restoreIssueStates(agent.session).get(fingerprint)

    if (current?.highUsed) {
      if (!hasExhaustedRecord(agent.session, fingerprint)) {
        agent.session.append('reasoning-router/escalation-exhausted', { fingerprint })
      }
      log(agent.ctx, 'warn', `reasoning-router/escalation-exhausted: ${fingerprint}`)
      return {
        status: 'escalation-exhausted',
        fingerprint,
        message: 'This issue already used both configured Sol consultation stages. No further Sol call was made; Luna must continue independently or report the blocker.',
      }
    }

    if (current?.mediumUsed && (input.prior_advice_evaluation ?? input.medium_advice_evaluation)?.trim().length === 0) {
      return {
        status: 'evaluation-required',
        fingerprint,
        message: 'Before the second consultation stage, provide prior_advice_evaluation describing how Luna applied or evaluated the first-stage advice and why the same issue remains unresolved. No Sol call was made.',
      }
    }
    if (current?.mediumUsed && input.prior_advice_evaluation === undefined && input.medium_advice_evaluation === undefined) {
      return {
        status: 'evaluation-required',
        fingerprint,
        message: 'Before the second consultation stage, provide prior_advice_evaluation describing how Luna applied or evaluated the first-stage advice and why the same issue remains unresolved. No Sol call was made.',
      }
    }

    const effort = current?.mediumUsed
      ? this.config.escalatedSolReasoning
      : this.config.initialSolReasoning
    try {
      const advisory = await this.advisor.consult({
        effort,
        prompt: blockerPrompt(input, current?.mediumAdvice),
        signal,
      })
      const state = nextState(current, fingerprint, advisory)
      agent.session.append(
        effort === 'medium' ? 'reasoning-router/consult-medium' : 'reasoning-router/consult-high',
        { fingerprint, effort, advisory, state },
      )
      log(agent.ctx, 'info', `reasoning-router/consult-${effort}: ${fingerprint}; Luna resumes execution`)
      return { status: 'advised', fingerprint, effort, advisory }
    } catch (error: unknown) {
      const detail = safeError(error)
      agent.session.append('reasoning-router/consult-failed', {
        phase: 'consult',
        fingerprint,
        effort,
        error: detail,
      })
      log(agent.ctx, 'warn', `reasoning-router/consult-failed: ${fingerprint}: ${detail}`)
      return {
        status: 'unavailable',
        fingerprint,
        effort,
        message: `Sol consultation unavailable: ${detail}. The reasoning level was not consumed; Luna should continue independently.`,
      }
    }
  }
}
