import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { safeError } from './advisor.ts'
import type { AgentTeam } from './team.ts'
import type { RoleTriggerRules, TeamRoleConfig } from './types.ts'

export const DEFAULT_TRIGGER_RULES: RoleTriggerRules = {
  mode: 'rules',
  depthRoleId: 'brain',
  coordinatorRoleId: 'coordinator',
  workerRoleId: 'worker',
  firstTurnRoleId: 'coordinator',
  coordinatorMinDeliverables: 3,
  coordinatorMinSubsystems: 2,
  repeatedFailureThreshold: 2,
  triggerOnHighRisk: true,
  triggerOnConflictingEvidence: true,
  triggerOnArchitectureDecision: true,
  maxDepthCallsPerTurn: 1,
  maxCoordinatorCallsPerTurn: 1,
  maxConcurrentWorkers: 3,
  requirePriorAdviceEvaluation: true,
  showTriggerReason: true,
  firstTurnFailOpen: true,
  customInstructions: '',
}

/** Migrate only the legacy all-default mapping when custom role ids replaced the shipped roster. */
export function migrateLegacyTriggerRules(
  rules: RoleTriggerRules,
  roles: readonly TeamRoleConfig[],
): RoleTriggerRules {
  const byId = new Map(roles.map(role => [role.id, role]))
  const legacyMapping = rules.depthRoleId === DEFAULT_TRIGGER_RULES.depthRoleId
    && rules.coordinatorRoleId === DEFAULT_TRIGGER_RULES.coordinatorRoleId
    && rules.workerRoleId === DEFAULT_TRIGGER_RULES.workerRoleId
    && rules.firstTurnRoleId === DEFAULT_TRIGGER_RULES.firstTurnRoleId
  if (!legacyMapping || [rules.depthRoleId, rules.coordinatorRoleId, rules.workerRoleId, rules.firstTurnRoleId]
    .every(id => byId.has(id))) return rules
  const advisory = roles.filter(role => role.kind === 'advisory')
  const workers = roles.filter(role => role.kind === 'subagent')
  const depthRoleId = advisory[0]?.id ?? ''
  const coordinatorRoleId = advisory[1]?.id ?? depthRoleId
  return {
    ...rules,
    depthRoleId,
    coordinatorRoleId,
    workerRoleId: workers[0]?.id ?? '',
    firstTurnRoleId: coordinatorRoleId,
  }
}

function selectedRole(id: string): string {
  return id === '' ? '<not configured>' : "'" + id + "'"
}

export function roleTriggerPrompt(rules: RoleTriggerRules): string {
  const header = [
    'Agent role trigger policy:',
    '- Deep reasoning role: ' + selectedRole(rules.depthRoleId) + '.',
    '- Coordination role: ' + selectedRole(rules.coordinatorRoleId) + '.',
    '- Delegated execution role: ' + selectedRole(rules.workerRoleId) + '.',
  ]
  if (rules.mode === 'manual') {
    return [...header,
      '- Manual-only mode is active. Call an Agent role only when the direct user explicitly requests that role or delegation.',
      '- trigger_reason is audit metadata, not an authorization boundary; preserve the direct user request in the task evidence.',
    ].join('\n')
  }
  const policy = [
    '- MUST use ' + selectedRole(rules.coordinatorRoleId) + ' for broad work with at least ' + rules.coordinatorMinDeliverables + ' distinct deliverables or ' + rules.coordinatorMinSubsystems + ' independent subsystems, when that role is configured.',
    '- MUST use ' + selectedRole(rules.depthRoleId) + ' after ' + rules.repeatedFailureThreshold + ' failed approaches to the same blocker, when that role is configured.',
    ...(rules.triggerOnHighRisk ? ['- MUST use ' + selectedRole(rules.depthRoleId) + ' for security, permissions, data-loss, migration, concurrency, irreversible, or other high-risk decisions.'] : []),
    ...(rules.triggerOnConflictingEvidence ? ['- MUST use ' + selectedRole(rules.depthRoleId) + ' when confirmed evidence materially conflicts.'] : []),
    ...(rules.triggerOnArchitectureDecision ? ['- MUST use ' + selectedRole(rules.depthRoleId) + ' for high-impact architectural decisions with multiple credible options.'] : []),
    '- Use ' + selectedRole(rules.workerRoleId) + ' only for bounded execution with sufficient context and explicit acceptance criteria.',
    '- Do not use an Agent role for routine inspection, a single obvious edit, ordinary testing, formatting, or a clear failure.',
    '- Before the first tool call, choose at most one advisory role: coordination for breadth, deep reasoning for depth or risk.',
    '- Every agent_role_run call MUST include the matching trigger_reason and a self-contained evidence packet.',
    ...(rules.requirePriorAdviceEvaluation ? ['- A repeated deep-reasoning call MUST include prior_advice_evaluation describing how the earlier advice was tested and what new evidence remains.'] : []),
    ...(rules.customInstructions.trim() === '' ? [] : ['- User-defined trigger rules: ' + rules.customInstructions.trim()]),
  ]
  if (rules.mode === 'first-turn') {
    policy.unshift('- On the first user turn, the plugin automatically runs ' + selectedRole(rules.firstTurnRoleId) + ' once before the root Agent executes. Do not repeat that call without new evidence.')
  }
  return [...header, ...policy].join('\n')
}

export function validateTriggerRules(rules: RoleTriggerRules, roles: readonly TeamRoleConfig[]): void {
  const byId = new Map(roles.map(role => [role.id, role]))
  const requireRole = (field: string, id: string, kind?: TeamRoleConfig['kind']): void => {
    if (id === '') return
    const role = byId.get(id)
    if (role === undefined) throw new Error('dsh-codex-reasoning-router: ' + field + ' references unknown role ' + id)
    if (kind !== undefined && role.kind !== kind) throw new Error('dsh-codex-reasoning-router: ' + field + ' must select an ' + kind + ' role')
  }
  requireRole('depthRoleId', rules.depthRoleId, 'advisory')
  requireRole('coordinatorRoleId', rules.coordinatorRoleId, 'advisory')
  requireRole('workerRoleId', rules.workerRoleId, 'subagent')
  requireRole('firstTurnRoleId', rules.firstTurnRoleId, 'advisory')
  if (rules.mode === 'first-turn' && rules.firstTurnRoleId === '') throw new Error('dsh-codex-reasoning-router: first-turn mode requires an advisory firstTurnRoleId')
  for (const [field, value] of Object.entries({
    coordinatorMinDeliverables: rules.coordinatorMinDeliverables,
    coordinatorMinSubsystems: rules.coordinatorMinSubsystems,
    repeatedFailureThreshold: rules.repeatedFailureThreshold,
    maxDepthCallsPerTurn: rules.maxDepthCallsPerTurn,
    maxCoordinatorCallsPerTurn: rules.maxCoordinatorCallsPerTurn,
    maxConcurrentWorkers: rules.maxConcurrentWorkers,
  })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('dsh-codex-reasoning-router: ' + field + ' must be a positive integer')
  }
}

function firstDirectUserText(messages: readonly UserMessage[]): string | undefined {
  const message = messages.find(candidate => candidate.source.kind === 'user')
  if (message === undefined) return undefined
  const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n').trim()
  return text === '' ? '[The user supplied non-text content.]' : text
}

function lightweightFirstTurn(request: string): boolean {
  const normalized = request.trim().replace(/[!！。,.，?？~～\s]+/gu, '').toLowerCase()
  if (normalized.length > 24) return false
  return /^(你好|您好|嗨|哈喽|hello|hi|hey|在吗|在不在|早上好|下午好|晚上好)$/u.test(normalized)
}

function hasInitialRoleRun(agent: Agent): boolean {
  const session = agent.session as any
  const events: readonly any[] = typeof session?.snapshotEvents === 'function'
    ? session.snapshotEvents()
    : (session?.events ?? [])
  return events.some((event: any) => event?.type === 'agent-role/initial-run')
}

export async function beforeInitialRoleRun(
  agent: Agent,
  messages: UserMessage[],
  team: AgentTeam,
  rules: RoleTriggerRules,
  signal: AbortSignal,
): Promise<UserMessage[]> {
  if (rules.mode !== 'first-turn' || hasInitialRoleRun(agent)) return messages
  const request = firstDirectUserText(messages)
  if (request === undefined) return messages
  const lightweight = lightweightFirstTurn(request)
  try {
    const result = await team.run(agent, rules.firstTurnRoleId, [
      lightweight ? 'Classify this lightweight first user message before the root Agent executes.' : 'Analyze the first user task before the root Agent executes.',
      'User task:\n' + request,
      'Workspace: ' + agent.session.header.cwd,
      lightweight
        ? 'This is likely a greeting or presence check. Return one concise sentence stating that no task decomposition is needed. Do not add sections or workspace claims.'
        : 'Return prioritized decisions, risks, decomposition, and acceptance checks. Do not claim to inspect the workspace.',
    ].join('\n\n'), signal, {
      triggerReason: 'first-turn-policy',
      maxTokensCap: lightweight ? 512 : 4_096,
    })
    const text = result.output.filter(block => block.type === 'text').map(block => block.text).join('\n').trim()
    agent.session.append('agent-role/initial-run', { status: 'succeeded', role: result.role, triggerReason: 'first-turn-policy' })
    return [...messages, createUserMessage({
      source: { kind: 'plugin', plugin: 'dsh-codex-reasoning-router', form: 'notice', summary: 'Initial Agent role ' + result.role + ' advisory' },
      content: [{ type: 'text', text: 'Initial Agent role advisory from ' + result.role + ' (verify before action):\n' + text }],
    })]
  } catch (error: unknown) {
    const detail = safeError(error)
    agent.session.append('agent-role/initial-run', { status: 'failed', role: rules.firstTurnRoleId, triggerReason: 'first-turn-policy', error: detail })
    if (!rules.firstTurnFailOpen) throw error
    return messages
  }
}
