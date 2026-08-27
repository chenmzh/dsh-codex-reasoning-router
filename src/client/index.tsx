import { useEffect, useState, type ReactNode } from 'react'
import type { ClientContext, SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { registerAgentFlow } from './agent-flow.tsx'
import type { RoleTriggerMode, RoleTriggerRules, TeamRoleConfig } from '../types.ts'
import { builtinMaxOutputTokens } from '../model-limits.ts'
import { catalogValid, type CatalogGroup, type CatalogModel, type CatalogOptions, type CatalogPreset, type TeamSettings } from './settings-validation.ts'

export { catalogValid } from './settings-validation.ts'
export type { CatalogGroup, CatalogOptions, CatalogPreset, TeamSettings } from './settings-validation.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'settings.codex-reasoning-router': CopyKey }
}

const css = {
  section: 'rrSection', notice: 'rrNotice', toggle: 'rrToggle', wideField: 'rrWideField',
  grid: 'rrGrid', roles: 'rrRoles', card: 'rrCard', cardHeading: 'rrCardHeading',
  full: 'rrFull', actions: 'rrActions', primary: 'rrPrimary', error: 'rrError',
  scope: 'rrScope', scopeOptions: 'rrScopeOptions', presetGrid: 'rrPresetGrid',
  tabs: 'rrTabs', tab: 'rrTab', tabActive: 'rrTabActive', ruleChecks: 'rrRuleChecks', fieldHint: 'rrFieldHint',
} as const
const STYLE = `
.rrSection{display:flex;flex-direction:column;gap:18px;max-width:920px}
.rrSection header h2{margin:0 0 6px;font-size:20px}
.rrSection header p,.rrNotice{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.rrToggle{display:flex;align-items:center;gap:10px;font-weight:600}
.rrWideField,.rrGrid label{display:flex;flex-direction:column;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.rrGrid input,.rrGrid select,.rrWideField textarea{box-sizing:border-box;width:100%;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:8px 10px;font:inherit}
.rrTabs{display:flex;gap:4px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.rrTab{border:0;border-bottom:2px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);padding:9px 14px;cursor:pointer}
.rrTabActive{border-bottom-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary);font-weight:650}
.rrRuleChecks{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 18px}
.rrGrid select:disabled{opacity:.65}
.rrRoles{display:flex;flex-direction:column;gap:12px}
.rrRoles[hidden]{display:none!important}
.rrCard,.rrScope{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:14px;background:var(--dsw-alias-bg-layer-1)}
.rrCardHeading{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
.rrCardHeading button,.rrActions button{border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary);padding:7px 12px;cursor:pointer}
.rrGrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.rrFull{grid-column:1/-1}
.rrScope legend{font-weight:650;padding:0 5px}
.rrScope>p{margin:4px 0 12px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.rrScopeOptions{display:flex;gap:18px;flex-wrap:wrap;margin-bottom:10px}
.rrScopeOptions label,.rrPresetGrid label{display:flex;align-items:flex-start;gap:7px;font-size:13px}
.rrPresetGrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 16px;padding:10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2)}
.rrPresetGrid small{display:block;color:var(--dsw-alias-label-tertiary)}
.rrActions{display:flex;justify-content:flex-end;gap:10px}
.rrActions .rrPrimary{background:var(--dsw-alias-state-business-primary);border-color:transparent;color:white}
.rrActions button:disabled,.rrCardHeading button:disabled{opacity:.5;cursor:not-allowed}
.rrError{margin:0;color:var(--dsw-alias-state-error-primary);font-size:13px}
.rrFieldHint{font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary)}.rrFieldHint[data-error=true]{color:var(--dsw-alias-state-error-primary)}
@media(max-width:700px){.rrGrid,.rrPresetGrid{grid-template-columns:1fr}.rrFull{grid-column:auto}}
`

const CLIENT_DEFAULT_TRIGGER_RULES: RoleTriggerRules = {
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

type RpcResult<T> = { result: { ok: true; value: T } | { ok: false; error: { message: string } } }

type CopyKey =
  | 'nav' | 'title' | 'description' | 'enabled' | 'scopeTitle' | 'scopeExplanation'
  | 'allPresets' | 'allPresetsHint' | 'selectedPresets' | 'selectedPresetsHint'
  | 'loading' | 'catalogLoading' | 'catalogError' | 'unavailable' | 'save' | 'saving' | 'saved' | 'saveError' | 'addRole'
  | 'remove' | 'roleId' | 'kind' | 'advisory' | 'subagent' | 'roleDescription'
  | 'provider' | 'model' | 'effort' | 'providerDefault' | 'inheritRoute' | 'maxTokens' | 'maxDepth'
  | 'maxTokensBuiltin' | 'maxTokensExceeded' | 'invalid' | 'unavailableOption' | 'noModels'
  | 'rolesTab' | 'rulesTab' | 'rulesTitle' | 'rulesDescription' | 'triggerMode'
  | 'rulesMode' | 'manualMode' | 'firstTurnMode' | 'depthRole' | 'coordRole' | 'workerRole'
  | 'firstTurnRole' | 'noneRole' | 'minDeliverables' | 'minSubsystems' | 'failureThreshold'
  | 'highRisk' | 'conflicting' | 'architecture' | 'maxDepthCalls' | 'maxCoordCalls' | 'maxWorkers' | 'priorEvaluation' | 'showReason' | 'failOpen' | 'customRules'

const zh: Record<CopyKey, string> = {
  nav: 'Agent 角色',
  title: 'Agent 角色配置',
  description: '定义供根 Agent 调用的大脑、协调者和 Worker 角色。Provider、模型和推理等级均来自当前用户的实时 DSH 模型目录。',
  enabled: '启用 Agent 角色工具',
  scopeTitle: '角色生效范围',
  scopeExplanation: '这里决定哪些 Agent 预设会获得 agent_role_run 和 agent_role_catalog 工具。它不会修改预设内容，也不会切换当前会话的预设。',
  allPresets: '所有 Agent 预设',
  allPresetsHint: '每个根 Agent 都能看到并调用这些角色。',
  selectedPresets: '仅指定的 Agent 预设',
  selectedPresetsHint: '只有下方勾选的预设能看到并调用这些角色；其他预设不受影响。',
  loading: '正在读取角色配置…',
  catalogLoading: '正在读取当前用户可用的 Provider、模型和 Agent 预设…',
  catalogError: '无法读取实时目录，请先打开一个根会话后重试。',
  unavailable: 'Host 尚未提供该设置命名空间。',
  save: '保存配置', saving: '正在保存…', saved: '已保存', saveError: '保存失败，Host 已拒绝该配置。', addRole: '添加角色',
  remove: '删除', roleId: '角色 ID', kind: '类型', advisory: '顾问 / 大脑', subagent: 'Worker 子代理',
  maxTokensBuiltin: '该模型内置最大输出：',
  maxTokensExceeded: '当前值超过模型内置最大输出，不能保存。',
  roleDescription: '职责描述', provider: '服务提供商', model: '模型', effort: '推理等级',
  providerDefault: '使用模型 / Provider 默认值', inheritRoute: '继承调用方当前路由', maxTokens: '最大输出 tokens', maxDepth: '最大派生深度',
  invalid: '请修正无效或重复的角色 ID，并确保所有预设、Provider、模型和推理等级都来自当前可用目录。',
  unavailableOption: '当前不可用', noModels: '该 Provider 没有可用模型',
  rolesTab: '角色配置', rulesTab: '触发规则', rulesTitle: 'Agent 角色触发规则',
  rulesDescription: '规则模式会把明确的 MUST 条件注入根 Agent；调用上限和 Worker 并发由运行时硬限制。首轮模式会在根 Agent 执行前自动调用所选顾问角色。',
  triggerMode: '触发模式', rulesMode: '按规则触发（推荐）', manualMode: '仅用户明确要求时调用', firstTurnMode: '首个用户回合自动调用',
  depthRole: '深度推理角色', coordRole: '协调角色', workerRole: '执行角色', firstTurnRole: '首轮自动角色', noneRole: '不配置',
  minDeliverables: '协调触发：最少交付物', minSubsystems: '协调触发：最少独立模块', failureThreshold: '深度推理触发：同一问题失败次数',
  highRisk: '高风险或不可逆决策时触发深度推理', conflicting: '确认的证据互相矛盾时触发深度推理', architecture: '高影响架构决策时触发深度推理',
  maxDepthCalls: '每轮最多深度推理调用', maxCoordCalls: '每轮最多协调调用', maxWorkers: '最多并发 Worker',
  priorEvaluation: '重复调用深度推理前必须说明上次建议的验证结果', showReason: '在调用结果中显示触发原因',
  failOpen: '首轮自动角色失败时让根 Agent 继续', customRules: '补充自定义规则（自由文本，不用于严格字段匹配）',
}
const en: Record<CopyKey, string> = {
  nav: 'Agent Roles',
  title: 'Agent role configuration',
  description: 'Define brain, coordinator, and worker roles callable by root agents. Providers, models, and reasoning efforts come from the user\'s live DSH catalog.',
  enabled: 'Enable agent role tools',
  scopeTitle: 'Where roles are available',
  scopeExplanation: 'This controls which Agent presets receive agent_role_run and agent_role_catalog. It does not edit presets or switch the current session preset.',
  allPresets: 'All Agent presets',
  allPresetsHint: 'Every root agent can see and call these roles.',
  selectedPresets: 'Only selected Agent presets',
  selectedPresetsHint: 'Only the checked presets receive these roles; other presets are unaffected.',
  loading: 'Loading role settings…',
  catalogLoading: 'Loading the user\'s available providers, models, and Agent presets…',
  catalogError: 'Could not load the live catalog. Open a root session and retry.',
  unavailable: 'The Host does not currently expose this settings namespace.',
  maxTokensBuiltin: 'Built-in maximum output for this model: ',
  maxTokensExceeded: 'The current value exceeds the model built-in maximum and cannot be saved.',
  save: 'Save configuration', saving: 'Saving…', saved: 'Saved', saveError: 'Save failed because the Host rejected this configuration.', addRole: 'Add role',
  remove: 'Remove', roleId: 'Role ID', kind: 'Kind', advisory: 'Advisory / brain', subagent: 'Worker subagent',
  roleDescription: 'Responsibility', provider: 'Provider', model: 'Model', effort: 'Reasoning effort',
  providerDefault: 'Use model / provider default', inheritRoute: 'Inherit the caller route', maxTokens: 'Max output tokens', maxDepth: 'Max spawn depth',
  invalid: 'Fix invalid or duplicate role IDs and select only currently available presets, providers, models, and reasoning efforts.',
  unavailableOption: 'currently unavailable', noModels: 'No available models for this provider',
  rolesTab: 'Role configuration', rulesTab: 'Trigger rules', rulesTitle: 'Agent role trigger rules',
  rulesDescription: 'Rule mode injects explicit MUST conditions into the root agent; call limits and worker concurrency are enforced by the runtime. First-turn mode automatically runs the selected advisory role before root execution.',
  triggerMode: 'Trigger mode', rulesMode: 'Rules-based (recommended)', manualMode: 'Only when explicitly requested', firstTurnMode: 'Automatically on the first user turn',
  depthRole: 'Deep reasoning role', coordRole: 'Coordination role', workerRole: 'Execution role', firstTurnRole: 'First-turn role', noneRole: 'Not configured',
  minDeliverables: 'Coordinate at this many deliverables', minSubsystems: 'Coordinate at this many subsystems', failureThreshold: 'Deep reasoning after failed approaches',
  highRisk: 'Trigger deep reasoning for high-risk or irreversible decisions', conflicting: 'Trigger deep reasoning for conflicting confirmed evidence', architecture: 'Trigger deep reasoning for high-impact architecture decisions',
  maxDepthCalls: 'Max deep-reasoning calls per turn', maxCoordCalls: 'Max coordination calls per turn', maxWorkers: 'Max concurrent workers',
  priorEvaluation: 'Require evaluation of prior advice before repeating deep reasoning', showReason: 'Show the trigger reason in role results',
  failOpen: 'Continue root execution when the first-turn role fails', customRules: 'Additional custom rules (free text; not used for strict identifiers)',
}

interface Injected {
  t: (key: CopyKey) => string
  useRoleSettings: <S>(selector: (snapshot: SettingsScopeSnapshot<TeamSettings>) => S) => S
  save: (next: TeamSettings) => Promise<void>
  loadOptions: () => Promise<CatalogOptions>
}

function safeNumber(value: string, fallback: number): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback
}

function routedRole(role: TeamRoleConfig, group: CatalogGroup, model: CatalogModel): TeamRoleConfig {
  const next: TeamRoleConfig = { ...role, provider: group.id, model: model.id }
  const effort = model.reasoning?.defaultEffort
  if (effort === undefined) delete next.reasoningEffort
  else next.reasoningEffort = effort
  return next
}

function newRole(roles: TeamRoleConfig[], options: CatalogOptions): TeamRoleConfig {
  const ids = new Set(roles.map(role => role.id))
  let sequence = 1
  while (ids.has(`role-${sequence}`)) sequence += 1
  const group = options.groups[0]
  const model = group?.models[0]
  const role: TeamRoleConfig = {
    id: `role-${sequence}`,
    kind: 'subagent',
    description: 'Tool-capable delegated worker.',
    maxDepth: 2,
    subagentProvider: 'spawn',
  }
  return group === undefined || model === undefined ? role : routedRole(role, group, model)
}

interface TriggerRulesEditorProps {
  t: (key: CopyKey) => string
  draft: TeamSettings
  writable: boolean
  update: (rules: RoleTriggerRules) => void
}

function TriggerRulesEditor({ t, draft, writable, update }: TriggerRulesEditorProps): ReactNode {
  const rules = draft.triggerRules
  const advisoryRoles = draft.roles.filter(role => role.kind === 'advisory')
  const workerRoles = draft.roles.filter(role => role.kind === 'subagent')
  const choices = Array.from({ length: 10 }, (_, index) => index + 1)
  const patch = (next: Partial<RoleTriggerRules>): void => update({ ...rules, ...next })
  const roleOptions = (roles: TeamRoleConfig[]): ReactNode => (
    <>
      <option value="">{t('noneRole')}</option>
      {roles.map(role => <option value={role.id} key={role.id}>{role.id} — {role.description}</option>)}
    </>
  )
  return (
    <div className={css.roles}>
      <article className={css.card}>
        <div className={css.cardHeading}><strong>{t('rulesTitle')}</strong></div>
        <p className={css.notice}>{t('rulesDescription')}</p>
        <div className={css.grid}>
          <label className={css.full}><span>{t('triggerMode')}</span>
            <select value={rules.mode} disabled={!writable} onChange={event => patch({ mode: event.currentTarget.value as RoleTriggerMode })}>
              <option value="rules">{t('rulesMode')}</option>
              <option value="manual">{t('manualMode')}</option>
              <option value="first-turn">{t('firstTurnMode')}</option>
            </select>
          </label>
          <label><span>{t('depthRole')}</span><select value={rules.depthRoleId} disabled={!writable} onChange={event => patch({ depthRoleId: event.currentTarget.value })}>{roleOptions(advisoryRoles)}</select></label>
          <label><span>{t('coordRole')}</span><select value={rules.coordinatorRoleId} disabled={!writable} onChange={event => patch({ coordinatorRoleId: event.currentTarget.value })}>{roleOptions(advisoryRoles)}</select></label>
          <label><span>{t('workerRole')}</span><select value={rules.workerRoleId} disabled={!writable} onChange={event => patch({ workerRoleId: event.currentTarget.value })}>{roleOptions(workerRoles)}</select></label>
          <label><span>{t('firstTurnRole')}</span><select value={rules.firstTurnRoleId} disabled={!writable || rules.mode !== 'first-turn'} onChange={event => patch({ firstTurnRoleId: event.currentTarget.value })}>{roleOptions(advisoryRoles)}</select></label>
          <label><span>{t('minDeliverables')}</span><select value={rules.coordinatorMinDeliverables} disabled={!writable || rules.mode === 'manual'} onChange={event => patch({ coordinatorMinDeliverables: Number(event.currentTarget.value) })}>{choices.map(value => <option value={value} key={value}>{value}</option>)}</select></label>
          <label><span>{t('minSubsystems')}</span><select value={rules.coordinatorMinSubsystems} disabled={!writable || rules.mode === 'manual'} onChange={event => patch({ coordinatorMinSubsystems: Number(event.currentTarget.value) })}>{choices.map(value => <option value={value} key={value}>{value}</option>)}</select></label>
          <label><span>{t('failureThreshold')}</span><select value={rules.repeatedFailureThreshold} disabled={!writable || rules.mode === 'manual'} onChange={event => patch({ repeatedFailureThreshold: Number(event.currentTarget.value) })}>{choices.map(value => <option value={value} key={value}>{value}</option>)}</select></label>
          <label><span>{t('maxDepthCalls')}</span><select value={rules.maxDepthCallsPerTurn} disabled={!writable} onChange={event => patch({ maxDepthCallsPerTurn: Number(event.currentTarget.value) })}>{choices.map(value => <option value={value} key={value}>{value}</option>)}</select></label>
          <label><span>{t('maxCoordCalls')}</span><select value={rules.maxCoordinatorCallsPerTurn} disabled={!writable} onChange={event => patch({ maxCoordinatorCallsPerTurn: Number(event.currentTarget.value) })}>{choices.map(value => <option value={value} key={value}>{value}</option>)}</select></label>
          <label><span>{t('maxWorkers')}</span><select value={rules.maxConcurrentWorkers} disabled={!writable} onChange={event => patch({ maxConcurrentWorkers: Number(event.currentTarget.value) })}>{choices.map(value => <option value={value} key={value}>{value}</option>)}</select></label>
        </div>
      </article>
      <fieldset className={css.scope}>
        <legend>{t('rulesTab')}</legend>
        <div className={css.ruleChecks}>
          <label><input type="checkbox" checked={rules.triggerOnHighRisk} disabled={!writable || rules.mode === 'manual'} onChange={event => patch({ triggerOnHighRisk: event.currentTarget.checked })} /><span>{t('highRisk')}</span></label>
          <label><input type="checkbox" checked={rules.triggerOnConflictingEvidence} disabled={!writable || rules.mode === 'manual'} onChange={event => patch({ triggerOnConflictingEvidence: event.currentTarget.checked })} /><span>{t('conflicting')}</span></label>
          <label><input type="checkbox" checked={rules.triggerOnArchitectureDecision} disabled={!writable || rules.mode === 'manual'} onChange={event => patch({ triggerOnArchitectureDecision: event.currentTarget.checked })} /><span>{t('architecture')}</span></label>
          <label><input type="checkbox" checked={rules.requirePriorAdviceEvaluation} disabled={!writable} onChange={event => patch({ requirePriorAdviceEvaluation: event.currentTarget.checked })} /><span>{t('priorEvaluation')}</span></label>
          <label><input type="checkbox" checked={rules.showTriggerReason} disabled={!writable} onChange={event => patch({ showTriggerReason: event.currentTarget.checked })} /><span>{t('showReason')}</span></label>
          <label><input type="checkbox" checked={rules.firstTurnFailOpen} disabled={!writable || rules.mode !== 'first-turn'} onChange={event => patch({ firstTurnFailOpen: event.currentTarget.checked })} /><span>{t('failOpen')}</span></label>
        </div>
      </fieldset>
      <label className={css.wideField}><span>{t('customRules')}</span>
        <textarea rows={5} value={rules.customInstructions} disabled={!writable} onChange={event => patch({ customInstructions: event.currentTarget.value })} />
      </label>
    </div>
  )
}

function RoleSettingsSection({ t, useRoleSettings, save, loadOptions }: Injected): ReactNode {
  const snapshot = useRoleSettings(value => value)
  const [draft, setDraft] = useState<TeamSettings | null>(null)
  const [options, setOptions] = useState<CatalogOptions | null>(null)
  const [catalogError, setCatalogError] = useState(false)
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [activeTab, setActiveTab] = useState<'roles' | 'rules'>('roles')

  useEffect(() => {
    if (snapshot.value !== undefined) {
      const value = structuredClone(snapshot.value) as TeamSettings & { triggerRules?: Partial<RoleTriggerRules> }
      setDraft({ ...value, triggerRules: { ...CLIENT_DEFAULT_TRIGGER_RULES, ...value.triggerRules } })
    }
  }, [snapshot.value])
  useEffect(() => {
    let current = true
    void loadOptions().then(
      value => { if (current) { setOptions(value); setCatalogError(false) } },
      () => { if (current) setCatalogError(true) },
    )
    return () => { current = false }
  }, [loadOptions])

  if (snapshot.status === 'loading') return <p className={css.notice}>{t('loading')}</p>
  if (draft === null) return <p className={css.notice}>{t('unavailable')}</p>
  if (catalogError) return <p className={css.error} role="alert">{t('catalogError')}</p>
  if (options === null) return <p className={css.notice}>{t('catalogLoading')}</p>

  const replaceRole = (index: number, role: TeamRoleConfig): void => {
    setStatus('idle')
    setDraft(current => current === null ? current : {
      ...current,
      roles: current.roles.map((candidate, roleIndex) => roleIndex === index ? role : candidate),
    })
  }
  const patchRole = (index: number, patch: Partial<TeamRoleConfig>): void => {
    const role = draft.roles[index]
    if (role !== undefined) replaceRole(index, { ...role, ...patch })
  }
  const isValid = catalogValid(draft, options)
  const selectedScope = draft.presetIds.length > 0
  const selectablePresets = options.presets.filter(preset => preset.broken === undefined)

  return (
    <section className={css.section}>
      <style>{STYLE}</style>
      <header>
        <h2>{t('title')}</h2>
        <p>{t('description')}</p>
      <div className={css.tabs} role="tablist">
        <button className={activeTab === 'roles' ? css.tab + ' ' + css.tabActive : css.tab} type="button" role="tab" aria-selected={activeTab === 'roles'} onClick={() => setActiveTab('roles')}>{t('rolesTab')}</button>
        <button className={activeTab === 'rules' ? css.tab + ' ' + css.tabActive : css.tab} type="button" role="tab" aria-selected={activeTab === 'rules'} onClick={() => setActiveTab('rules')}>{t('rulesTab')}</button>
      </div>
      </header>

      <div hidden={activeTab !== 'roles'} className={css.roles}>
      <label className={css.toggle}>
        <input type="checkbox" checked={draft.teamEnabled} disabled={!snapshot.writable}
          onChange={event => { setStatus('idle'); setDraft({ ...draft, teamEnabled: event.currentTarget.checked }) }} />
        <span>{t('enabled')}</span>
      </label>

      <fieldset className={css.scope}>
        <legend>{t('scopeTitle')}</legend>
        <p>{t('scopeExplanation')}</p>
        <div className={css.scopeOptions}>
          <label>
            <input type="radio" name="role-scope" checked={!selectedScope} disabled={!snapshot.writable}
              onChange={() => { setStatus('idle'); setDraft({ ...draft, presetIds: [] }) }} />
            <span><strong>{t('allPresets')}</strong><small>{t('allPresetsHint')}</small></span>
          </label>
          <label>
            <input type="radio" name="role-scope" checked={selectedScope} disabled={!snapshot.writable || selectablePresets.length === 0}
              onChange={() => {
                const first = selectablePresets[0]
                if (first !== undefined) { setStatus('idle'); setDraft({ ...draft, presetIds: [first.id] }) }
              }} />
            <span><strong>{t('selectedPresets')}</strong><small>{t('selectedPresetsHint')}</small></span>
          </label>
        </div>
        {selectedScope ? (
          <div className={css.presetGrid}>
            {options.presets.map(preset => (
              <label key={preset.id}>
                <input type="checkbox" checked={draft.presetIds.includes(preset.id)}
                  disabled={!snapshot.writable || preset.broken !== undefined}
                  onChange={event => {
                    setStatus('idle')
                    const next = event.currentTarget.checked
                      ? [...draft.presetIds, preset.id]
                      : draft.presetIds.filter(id => id !== preset.id)
                    setDraft({ ...draft, presetIds: next.length === 0 ? [] : next })
                  }} />
                <span>{preset.name ?? preset.id}{preset.isDefault ? ' · default' : ''}<small>{preset.description ?? preset.id}{preset.broken === undefined ? '' : ` · ${preset.broken}`}</small></span>
              </label>
            ))}
          </div>
        ) : null}
      </fieldset>

      <div className={css.roles}>
        {draft.roles.map((role, index) => {
          const group = options.groups.find(candidate => candidate.id === role.provider)
          const models = group?.models ?? []
          const model = models.find(candidate => candidate.id === role.model)
          const efforts = model?.reasoning?.efforts ?? []
          const staleProvider = role.provider !== undefined && group === undefined
          const staleModel = role.model !== undefined && model === undefined
          const staleEffort = role.reasoningEffort !== undefined && role.reasoningEffort !== ''
            && !efforts.some(effort => effort.id === role.reasoningEffort)
          const builtinMax = builtinMaxOutputTokens(role.provider, role.model)
          const maxTokensExceeded = role.maxTokens !== undefined && builtinMax !== undefined && role.maxTokens > builtinMax
          return (
            <article className={css.card} key={index}>
              <div className={css.cardHeading}>
                <strong>{role.id || t('roleId')}</strong>
                <button type="button" disabled={!snapshot.writable}
                  onClick={() => { setStatus('idle'); setDraft({ ...draft, roles: draft.roles.filter((_, i) => i !== index) }) }}>
                  {t('remove')}
                </button>
              </div>
              <div className={css.grid}>
                <label><span>{t('roleId')}</span><input value={role.id} disabled={!snapshot.writable} onChange={event => patchRole(index, { id: event.currentTarget.value })} /></label>
                <label><span>{t('kind')}</span><select value={role.kind} disabled={!snapshot.writable} onChange={event => patchRole(index, { kind: event.currentTarget.value as TeamRoleConfig['kind'] })}><option value="advisory">{t('advisory')}</option><option value="subagent">{t('subagent')}</option></select></label>
                <label className={css.full}><span>{t('roleDescription')}</span><input value={role.description} disabled={!snapshot.writable} onChange={event => patchRole(index, { description: event.currentTarget.value })} /></label>
                <label>
                  <span>{t('provider')}</span>
                  <select value={role.provider ?? ''} disabled={!snapshot.writable || options.groups.length === 0}
                    onChange={event => {
                      if (event.currentTarget.value === '') {
                        const inherited = { ...role }
                        delete inherited.provider
                        delete inherited.model
                        delete inherited.reasoningEffort
                        replaceRole(index, inherited)
                        return
                      }
                      const nextGroup = options.groups.find(candidate => candidate.id === event.currentTarget.value)
                      const nextModel = nextGroup?.models[0]
                      if (nextGroup !== undefined && nextModel !== undefined) replaceRole(index, routedRole(role, nextGroup, nextModel))
                    }}>
                    <option value="">{t('inheritRoute')}</option>
                    {staleProvider ? <option value={role.provider}>{role.provider} · {t('unavailableOption')}</option> : null}
                    {options.groups.map(candidate => <option value={candidate.id} key={candidate.id}>{candidate.name} ({candidate.id})</option>)}
                  </select>
                </label>
                <label>
                  <span>{t('model')}</span>
                  <select value={role.model ?? ''} disabled={!snapshot.writable || group === undefined || models.length === 0}
                    onChange={event => {
                      const nextModel = models.find(candidate => candidate.id === event.currentTarget.value)
                      if (group !== undefined && nextModel !== undefined) replaceRole(index, routedRole(role, group, nextModel))
                    }}>
                    {group === undefined && role.provider === undefined ? <option value="">{t('inheritRoute')}</option> : null}
                    {group !== undefined && models.length === 0 ? <option value="">{t('noModels')}</option> : null}
                    {staleModel ? <option value={role.model}>{role.model} · {t('unavailableOption')}</option> : null}
                    {models.map(candidate => <option value={candidate.id} key={candidate.id}>{candidate.name} ({candidate.id})</option>)}
                  </select>
                </label>
                <label>
                  <span>{t('effort')}</span>
                  <select value={role.reasoningEffort ?? ''} disabled={!snapshot.writable || model === undefined}
                    onChange={event => {
                      const next = { ...role }
                      if (event.currentTarget.value === '') delete next.reasoningEffort
                      else next.reasoningEffort = event.currentTarget.value
                      replaceRole(index, next)
                    }}>
                    <option value="">{t('providerDefault')}</option>
                    {staleEffort ? <option value={role.reasoningEffort}>{role.reasoningEffort} · {t('unavailableOption')}</option> : null}
                    {efforts.map(effort => <option value={effort.id} key={effort.id}>{effort.name} ({effort.id})</option>)}
                  </select>
                </label>
                {role.kind === 'advisory'
                  ? <label>
                      <span>{t('maxTokens')}</span>
                      <input type="number" min="1" max={builtinMax} value={role.maxTokens ?? ''} disabled={!snapshot.writable}
                        aria-invalid={maxTokensExceeded}
                        onChange={event => patchRole(index, { maxTokens: safeNumber(event.currentTarget.value, 1) })} />
                      {builtinMax === undefined ? null : (
                        <small className={css.fieldHint} data-error={maxTokensExceeded}>
                          {t('maxTokensBuiltin')}{builtinMax.toLocaleString()} tokens{maxTokensExceeded ? ` · ${t('maxTokensExceeded')}` : ''}
                        </small>
                      )}
                    </label>
                  : <label><span>{t('maxDepth')}</span><input type="number" min="0" value={role.maxDepth ?? ''} disabled={!snapshot.writable} onChange={event => patchRole(index, { maxDepth: safeNumber(event.currentTarget.value, 0) })} /></label>}
              </div>
            </article>
          )
        })}
      </div>
      </div>
      {activeTab === 'rules' ? <TriggerRulesEditor t={t} draft={draft} writable={snapshot.writable}
        update={triggerRules => { setStatus('idle'); setDraft({ ...draft, triggerRules }) }} /> : null}

      {!isValid ? <p className={css.error} role="alert">{t('invalid')}</p> : null}
      {status === 'error' ? <p className={css.error} role="alert">{t('saveError')}</p> : null}
      <div className={css.actions}>
        <button type="button" hidden={activeTab !== 'roles'} disabled={!snapshot.writable || options.groups.length === 0}
          onClick={() => { setStatus('idle'); setDraft({ ...draft, roles: [...draft.roles, newRole(draft.roles, options)] }) }}>
          {t('addRole')}
        </button>
        <button className={css.primary} type="button" disabled={!snapshot.writable || !isValid || status === 'saving'}
          onClick={() => {
            setStatus('saving')
            void save(draft).then(() => { setStatus('saved') }, () => { setStatus('error') })
          }}>
          {status === 'saving' ? t('saving') : status === 'saved' ? t('saved') : t('save')}
        </button>
      </div>
    </section>
  )
}

export const name = 'dsh-codex-reasoning-router-client'
export const inject = ['slots', 'locale', 'settingsScope', 'connection', 'conversationEvents', 'conversationViews']

export function apply(ctx: ClientContext): void {
  registerAgentFlow(ctx)
  const namespace = 'settings.codex-reasoning-router'
  ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'reasoning-router: settings copy')
  const t = ctx.locale.bind(namespace) as Injected['t']
  const scope = ctx.settingsScope.bind<TeamSettings>({ namespace: 'codex-reasoning-router' })
  const connection = ctx.get('connection') as {
    api: {
      llm: { models: (request: {}) => Promise<RpcResult<{ groups: CatalogGroup[] }>> }
      agentPresets: { list: (request: {}) => Promise<RpcResult<{ presets: CatalogPreset[] }>> }
      settings: { mutate: (request: {
        ns: string
        ops: Array<{ op: 'set'; path: string[]; value: unknown }>
        expectedRevision?: number
      }) => Promise<RpcResult<unknown>> }
    }
  }
  const loadOptions = async (): Promise<CatalogOptions> => {
    const [modelsReply, presetsReply] = await Promise.all([
      connection.api.llm.models({}),
      connection.api.agentPresets.list({}),
    ])
    if (!modelsReply.result.ok) throw new Error(modelsReply.result.error.message)
    if (!presetsReply.result.ok) throw new Error(presetsReply.result.error.message)
    return { groups: modelsReply.result.value.groups, presets: [...presetsReply.result.value.presets] }
  }
  const save = async (next: TeamSettings): Promise<void> => {
    const revision = scope.getSnapshot().revision
    const response = await connection.api.settings.mutate({
      ns: 'codex-reasoning-router',
      ops: [
        { op: 'set', path: ['teamEnabled'], value: next.teamEnabled },
        { op: 'set', path: ['presetIds'], value: next.presetIds },
        { op: 'set', path: ['roles'], value: next.roles },
        { op: 'set', path: ['triggerRules'], value: next.triggerRules },
      ],
      ...(revision === undefined ? {} : { expectedRevision: revision }),
    })
    if (!response.result.ok) throw new Error(response.result.error.message)
  }
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'agent-roles',
    order: 17,
    label: () => t('nav'),
    locale: namespace,
    inject: (): Omit<Injected, 'useRoleSettings'> & { hooks: { roleSettings: SettingsScope<TeamSettings> } } => ({
      t,
      save,
      loadOptions,
      hooks: { roleSettings: scope },
    }),
  }, RoleSettingsSection))
}
