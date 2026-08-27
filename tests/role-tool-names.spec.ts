import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  AgentTeam,
  agentTeamCatalogTool,
  agentTeamRunTool,
  type TeamRoleConfig,
} from '../src/index.ts'

const role: TeamRoleConfig = {
  id: 'brain',
  kind: 'advisory',
  description: 'Reason over the supplied task.',
  provider: 'openai-codex',
  model: 'gpt-5.6-sol',
}

describe('agent role tool names', () => {
  it('reserves the Agent Team terminology for a separate feature', () => {
    const registry = new AgentTeam({} as Context, [role])
    expect(agentTeamRunTool(registry).name).toBe('agent_role_run')
    expect(agentTeamCatalogTool(async () => []).name).toBe('agent_role_catalog')
  })
})
