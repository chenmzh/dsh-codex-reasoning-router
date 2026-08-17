import { AsyncLocalStorage } from 'node:async_hooks'
import type { Context } from '@deepseek-ai/cordis'
import {
  BlockAssembler,
  createUserMessage,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import { INITIAL_ADVISORY_FORMAT, PACKAGE_NAME, SOL_ADVISOR_SYSTEM_PROMPT } from './constants.ts'
import type { AdvisoryRequest, Config, SolConsultInput } from './types.ts'

export interface AdvisorScope {
  readonly purpose: 'sol-advisory'
}

export const advisorScope = new AsyncLocalStorage<AdvisorScope>()

export class SolProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SolProtocolError'
  }
}

function combinedSignal(caller: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return caller === undefined ? timeout : AbortSignal.any([caller, timeout])
}

export function safeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw
    .replace(/bearer\s+[\w.+/=-]+/giu, 'Bearer <redacted>')
    .replace(/(?:access|refresh|oauth)[_-]?token\s*[:=]\s*[^\s,;]+/giu, 'token=<redacted>')
    .slice(0, 500)
}

export class SolAdvisor {
  constructor(private readonly ctx: Context, private readonly config: Config) {}

  async consult(request: AdvisoryRequest): Promise<string> {
    if (request.effort !== "medium" && request.effort !== "high") {
      throw new Error("Unsupported Sol reasoning effort: " + String(request.effort) + ". Only medium and high are permitted.")
    }
    const assembler = new BlockAssembler()
    const signal = combinedSignal(request.signal, this.config.solTimeoutMs)

    await advisorScope.run({ purpose: 'sol-advisory' }, async () => {
      const stream = this.ctx.llm.stream({
        provider: this.config.solProvider,
        model: this.config.solModel,
        reasoningEffort: ReasoningEffortId(request.effort),
        system: SOL_ADVISOR_SYSTEM_PROMPT,
        messages: [createUserMessage({
          source: { kind: 'plugin', plugin: PACKAGE_NAME },
          content: [{ type: 'text', text: request.prompt }],
        })],
        maxTokens: this.config.solAdviceMaxTokens,
        signal,
      })
      for await (const chunk of stream) assembler.push(chunk)
    })

    const blocks = assembler.blocks()
    if (blocks.some(block => block.type === 'tool-call')) {
      throw new SolProtocolError('Sol returned a tool call even though no tool catalog was supplied; the call was not executed')
    }
    const advice = blocks
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
      .trim()
    if (advice.length === 0) throw new SolProtocolError('Sol returned no advisory text')
    return advice
  }
}

export function initialPrompt(userRequest: string, cwd?: string): string {
  return `Prepare the first-turn reasoning advisory for Luna.

User request:
${userRequest}

Workspace metadata:
${cwd === undefined ? '- working directory not supplied' : `- working directory: ${cwd}`}

You have not inspected the repository. Do not invent file names, code locations, dependencies, or implementation details. Focus on intent, success criteria, unknowns, investigation order, risk, execution shape, verification, and conditions that would justify later consultation.

Return exactly one compact packet in this shape:
${INITIAL_ADVISORY_FORMAT}`
}

export function blockerPrompt(input: SolConsultInput, priorMediumAdvice?: string): string {
  return JSON.stringify({
    task: 'reason over supplied evidence and return one compact <sol_advisory> packet',
    current_goal: input.goal,
    blocker: input.problem,
    confirmed_evidence: input.evidence,
    attempts_and_results: input.attempts,
    constraints: input.constraints,
    question: input.question,
    ...(priorMediumAdvice === undefined ? {} : {
      prior_medium_advice: priorMediumAdvice,
      luna_evaluation: input.prior_advice_evaluation ?? input.medium_advice_evaluation,
      escalation_instruction: 'The first-stage advice was evaluated and the same issue remains unresolved. Reassess at the configured second-stage effort without assuming new repository access.',
    }),
    output_format: INITIAL_ADVISORY_FORMAT,
  }, null, 2)
}
