import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { SOL_CONSULT_TOOL } from './constants.ts'
import type { ReasoningRouter } from './router.ts'
import type { ConsultValue, SolConsultInput } from './types.ts'

function content(value: ConsultValue) {
  const lines = [
    `status: ${value.status}`,
    `issue_fingerprint: ${value.fingerprint}`,
    ...(value.effort === undefined ? [] : [`sol_reasoning_effort: ${value.effort}`]),
    ...(value.advisory === undefined ? [] : [`\n${value.advisory}`]),
    ...(value.message === undefined ? [] : [`\n${value.message}`]),
  ]
  return [{ type: 'text' as const, text: lines.join('\n') }]
}

export function solConsultTool(router: ReasoningRouter): ToolDefinition {
  return defineTool({
    name: SOL_CONSULT_TOOL,
    description: 'Consult the tool-less Sol reasoning advisor for a genuinely difficult blocker, architectural decision, contradictory evidence, repeated failed approach, or high-risk decision. Sol cannot inspect or change the workspace. Do not use for routine work. The plugin chooses medium/high; never request a level.',
    parameters: {
      problem: { type: 'string', required: true, description: 'Stable summary of the unresolved problem.' },
      goal: { type: 'string', required: true, description: 'The outcome Luna is trying to achieve.' },
      evidence: { type: 'array', items: { type: 'string' }, required: true, description: 'Confirmed facts, exact errors, relevant snippets, and test results only.' },
      attempts: { type: 'array', items: { type: 'string' }, required: true, description: 'Approaches already tried and their observed results.' },
      constraints: { type: 'array', items: { type: 'string' }, required: true, description: 'Constraints that must not be violated.' },
      question: { type: 'string', required: true, description: 'The specific decision or diagnosis requested from Sol.' },
      prior_advice_evaluation: { type: 'string', description: 'Required when consulting the same unresolved issue a second time: how the first-stage advice was evaluated and why the issue remains.' },
      medium_advice_evaluation: { type: 'string', description: 'Deprecated compatibility alias for prior_advice_evaluation.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true, enum: ['advised', 'unavailable', 'evaluation-required', 'escalation-exhausted'] },
          fingerprint: { type: 'string', required: true },
          effort: { type: 'string', enum: ['medium', 'high'] },
          advisory: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => content(value as ConsultValue),
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('sol_consult requires an owning Luna agent')
      return router.consult(exec.agent, args as SolConsultInput, exec.signal)
    },
    presentCall: () => ({ card: 'generic', title: 'Consult Sol reasoning advisor', kind: 'execute' }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'Sol advisory returned to Luna', content: result.content }),
  })
}
