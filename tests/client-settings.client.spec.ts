import { describe, expect, it } from 'vitest'
import { catalogValid, type CatalogOptions, type TeamSettings } from '../src/client/settings-validation.ts'

const triggerRules: TeamSettings['triggerRules'] = {
  mode: 'rules', depthRoleId: 'brain', coordinatorRoleId: 'brain', workerRoleId: '', firstTurnRoleId: 'brain',
  coordinatorMinDeliverables: 3, coordinatorMinSubsystems: 2, repeatedFailureThreshold: 2,
  triggerOnHighRisk: true, triggerOnConflictingEvidence: true, triggerOnArchitectureDecision: true,
  maxDepthCallsPerTurn: 1, maxCoordinatorCallsPerTurn: 1, maxConcurrentWorkers: 3,
  requirePriorAdviceEvaluation: true, showTriggerReason: true, firstTurnFailOpen: true, customInstructions: '',
}

const options: CatalogOptions = {
  groups: [{ id: 'provider', name: 'Provider', models: [{ id: 'model', name: 'Model' }] }],
  presets: [{ id: 'standard', isDefault: true }],
}

function settings(overrides: Partial<TeamSettings> = {}): TeamSettings {
  return {
    teamEnabled: true,
    presetIds: [],
    roles: [{ id: 'brain', kind: 'advisory', description: 'reason' }],
    triggerRules: { ...triggerRules },
    ...overrides,
  }
}

describe('agent role settings validation', () => {
  it('accepts a role that inherits both provider and model from its caller', () => {
    expect(catalogValid(settings(), options)).toBe(true)
  })

  it('rejects a partially specified route and accepts a complete live route', () => {
    expect(catalogValid(settings({
      roles: [{ id: 'brain', kind: 'advisory', description: 'reason', provider: 'provider' }],
    }), options)).toBe(false)
    expect(catalogValid(settings({
      roles: [{ id: 'brain', kind: 'advisory', description: 'reason', provider: 'provider', model: 'model' }],
    }), options)).toBe(true)
  })

  it('allows disabling the team to recover from stale catalog routes', () => {
    expect(catalogValid(settings({
      teamEnabled: false,
      presetIds: ['missing'],
      roles: [{ id: 'brain', kind: 'advisory', description: 'reason', provider: 'missing', model: 'missing' }],
    }), options)).toBe(true)
  })
})
