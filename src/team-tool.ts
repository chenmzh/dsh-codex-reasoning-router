import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { AgentTeam, TeamRunResult } from './team.ts'

function rendered(result: TeamRunResult): string {
  const body = result.output
    .filter((block): block is Extract<(typeof result.output)[number], { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
  return [
    `run_id: ${result.runId}`,
    `role: ${result.role}`,
    `kind: ${result.kind}`,
    `route: ${result.provider}/${result.model}`,
    `reasoning_effort: ${result.reasoningEffort ?? '<provider default>'}`,
    ...(result.triggerReason === undefined ? [] : ['trigger_reason: ' + result.triggerReason]),
    ...(result.stopReason === undefined ? [] : [`stop_reason: ${result.stopReason}`]),
    ...(result.diagnostic === undefined ? [] : [`diagnostic: ${result.diagnostic}`]),
    '',
    body,
  ].join('\n')
}

export function agentTeamRunTool(team: AgentTeam): ToolDefinition {
  return defineTool({
    name: 'agent_role_run',
    description: 'Run one configured agent role. Advisory roles are tool-less reasoning calls; subagent roles are real delegated agents with their configured model, tools, persona, and absolute depth cap.',
    parameters: {
      role: { type: 'string', required: true, enum: team.roles.map(role => role.id), description: 'Configured role id.' },
      task: { type: 'string', required: true, description: 'Self-contained task, evidence, constraints, and expected output for the role.' },
      trigger_reason: { type: 'string', required: true, enum: ['explicit-user-request', 'first-turn-policy', 'task-breadth', 'high-risk', 'repeated-failure', 'conflicting-evidence', 'architecture-decision', 'delegated-execution', 'custom-rule'], description: 'Why the configured trigger policy requires this role.' },
      prior_advice_evaluation: { type: 'string', description: 'Required when repeating the configured deep reasoning role in the same turn.' },
      references: { type: 'array', items: { type: 'string' }, description: 'Optional prior role-run ids this task explicitly cites.' },

    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: rendered(value as unknown as TeamRunResult) }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('agent_role_run requires an owning agent')
      return await team.run(exec.agent, args.role, args.task, exec.signal, {
        triggerReason: args.trigger_reason,
        ...(args.prior_advice_evaluation === undefined ? {} : { priorAdviceEvaluation: args.prior_advice_evaluation }),
        ...(args.references === undefined ? {} : { references: args.references }),
      }) as unknown as Record<string, JsonValue>
    },
    presentCall: args => ({ card: 'generic', title: `Run agent role: ${String(args.role)}`, kind: 'execute' }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'Agent role completed', content: result.content }),
  })
}

export function agentTeamCatalogTool(load: () => Promise<JsonValue[]>): ToolDefinition {
  return defineTool({
    name: 'agent_role_catalog',
    description: 'List the providers, models, and reasoning efforts currently available in this user\'s live DSH model catalog. Use this before recommending role configuration changes.',
    parameters: {},
    output: {
      schema: { type: 'array', items: { type: 'json' } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute() { return load() },
    presentCall: () => ({ card: 'generic', title: 'Read available agent models', kind: 'read' }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'Available agent models', content: result.content }),
  })
}
