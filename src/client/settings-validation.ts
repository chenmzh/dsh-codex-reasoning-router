import type { RoleTriggerRules, TeamRoleConfig } from '../types.ts'
import { builtinMaxOutputTokens } from '../model-limits.ts'

export interface TeamSettings {
  teamEnabled: boolean
  presetIds: string[]
  roles: TeamRoleConfig[]
  triggerRules: RoleTriggerRules
}

export interface CatalogEffort { id: string; name: string; description?: string }
export interface CatalogModel {
  id: string
  name: string
  description?: string
  reasoning?: { efforts: CatalogEffort[]; defaultEffort?: string }
}
export interface CatalogGroup { id: string; name: string; models: CatalogModel[] }
export interface CatalogPreset {
  id: string
  name?: string
  description?: string
  isDefault: boolean
  broken?: string
}
export interface CatalogOptions {
  groups: CatalogGroup[]
  presets: CatalogPreset[]
}

function baseValid(settings: TeamSettings): boolean {
  if (settings.teamEnabled && settings.roles.length === 0) return false
  const ids = new Set<string>()
  for (const role of settings.roles) {
    if (!/^[a-z][a-z0-9_-]*$/u.test(role.id) || ids.has(role.id)) return false
    ids.add(role.id)
  }
  if (!settings.teamEnabled) return true
  const byId = new Map(settings.roles.map(role => [role.id, role]))
  const roleMatches = (id: string, kind: TeamRoleConfig['kind']): boolean => id === '' || byId.get(id)?.kind === kind
  const rules = settings.triggerRules
  if (!roleMatches(rules.depthRoleId, 'advisory')
    || !roleMatches(rules.coordinatorRoleId, 'advisory')
    || !roleMatches(rules.workerRoleId, 'subagent')
    || !roleMatches(rules.firstTurnRoleId, 'advisory')) return false
  if (rules.mode === 'first-turn' && rules.firstTurnRoleId === '') return false
  const positive = [rules.coordinatorMinDeliverables, rules.coordinatorMinSubsystems, rules.repeatedFailureThreshold,
    rules.maxDepthCallsPerTurn, rules.maxCoordinatorCallsPerTurn, rules.maxConcurrentWorkers]
  return positive.every(value => Number.isSafeInteger(value) && value >= 1)
}

export function catalogValid(settings: TeamSettings, options: CatalogOptions): boolean {
  if (!baseValid(settings)) return false
  if (!settings.teamEnabled) return true
  const presets = new Set(options.presets.filter(preset => preset.broken === undefined).map(preset => preset.id))
  if (settings.presetIds.some(id => !presets.has(id))) return false
  return settings.roles.every((role) => {
    if (role.provider === undefined && role.model === undefined) {
      return role.reasoningEffort === undefined || role.reasoningEffort === ''
    }
    if (role.provider === undefined || role.model === undefined) return false
    const builtinMax = builtinMaxOutputTokens(role.provider, role.model)
    if (role.maxTokens !== undefined && builtinMax !== undefined && role.maxTokens > builtinMax) return false
    const group = options.groups.find(candidate => candidate.id === role.provider)
    const model = group?.models.find(candidate => candidate.id === role.model)
    if (group === undefined || model === undefined) return false
    if (role.reasoningEffort === undefined || role.reasoningEffort === '') return true
    return model.reasoning?.efforts.some(effort => effort.id === role.reasoningEffort) === true
  })
}
