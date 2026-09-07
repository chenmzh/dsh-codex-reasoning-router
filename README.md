# dsh-codex-reasoning-router

[简体中文](./README.zh-CN.md) | English | [AI / LLM context](./llms.txt)

A composable multi-model Agent Roles plugin for DeepSeek Harness (DSH). Version 0.2 no longer requires a dedicated preset: it layers onto Standard, Code, or a user-defined preset.

Default roles:

- `brain`: tool-less deep reasoning, using `openai-codex/gpt-5.6-sol` at `max`.
- `coordinator`: tool-less decomposition and integration advice, using Sol at `high`.
- `worker`: a real tool-capable DSH subagent, using `gpt-5.6-luna` at `max`, with absolute `maxDepth: 2`.
- `agent_role_catalog`: reads the current user's registered providers, models, and model-specific reasoning efforts.
- `agent_role_run`: runs any configured advisory or subagent role.

The legacy `luna-sol-reasoning-router` preset and durable `sol_consult` state machine remain available, but route locking is disabled by default.

## Install

Version 0.3.1 targets DSH 0.1.2-rc.1. It uses the split client domain services and Session projection API; rebuild against the same DSH checkout used by the profile.

Install and authenticate the model provider first, then add this plugin:

```bash
pnpm dsh plugin --profile web add dsh-codex
pnpm dsh plugin --profile web add link:/absolute/path/to/dsh-codex-reasoning-router
```

Or install from GitHub:

```bash
pnpm dsh plugin --profile web add github:chenmzh/dsh-codex-reasoning-router
```

Restart DSH and create a new session. Since 0.2, no preset copy or preset switch is needed. Copy [`preset/luna-sol-reasoning-router`](./preset/luna-sol-reasoning-router) only when enabling the legacy route-guard workflow.

## Configuration

See [`cordis.patch.yml`](./cordis.patch.yml) for the complete default:

```yaml
teamEnabled: true
presetIds: []                 # empty = all presets
roles:
  - id: brain
    kind: advisory            # tool-less one-shot reasoning
    description: Deep reasoning
    provider: openai-codex
    model: gpt-5.6-sol
    reasoningEffort: max
    maxTokens: 3000

  - id: coordinator
    kind: advisory
    description: Coordinate work
    provider: openai-codex
    model: gpt-5.6-sol
    reasoningEffort: high

  - id: worker
    kind: subagent            # real DSH child inheriting the current preset
    description: Implement and verify
    provider: openai-codex
    model: gpt-5.6-luna
    reasoningEffort: max
    subagentProvider: spawn
    maxDepth: 2               # absolute: root=0, descendants=1,2,...
    toolDeny: [web_search]     # optional; toolAllow is also supported
```

Roles may be added, removed, or renamed. Role ids must begin with a lowercase letter and contain lowercase letters, digits, `_`, or `-`.

| Field | Meaning |
|---|---|
| `kind` | `advisory` is tool-less; `subagent` starts a real delegated agent |
| `provider` / `model` | Omit both to inherit the caller; explicit values must exist in the live user catalog |
| `reasoningEffort` | Omit for model/provider default; explicit values must be offered by that exact model |
| `systemPrompt` | Optional role persona |
| `subagentProvider` | `spawn`, `fork`, or another provider registered by the host |
| `maxDepth` | Absolute delegation-tree cap, not a relative remaining-depth count |
| `toolAllow` / `toolDeny` | Native DSH child tool visibility filters for subagent roles |

The plugin does not guess model capabilities. It reads `ctx.llm.listProviders()`, `listModels()`, and `resolveModelInfo()` at runtime. Invalid model/effort combinations fail before provider dispatch. `agent_role_catalog` exposes the same live directory to the agent.

## Trigger rules

The WebUI “Agent Roles → Trigger rules” tab persists these policies:

- rules (default): inject explicit MUST conditions into the root agent; high risk, conflicting evidence, architecture decisions, repeated failures, and breadth thresholds are configurable.
- manual: role calls are permitted only when the user explicitly requests one.
- first-turn: run the selected advisory role once before root execution on the first user turn, with configurable fail-open behavior.

Per-turn deep-reasoning and coordination limits plus worker concurrency are enforced by the runtime. Every agent_role_run selects a trigger_reason; repeated deep consultation can require prior_advice_evaluation. Role mappings use strict choices from configured roles. Only customInstructions is free text.

## Preset composition

With the default `presetIds: []`, select whichever preset you already want:

```text
Standard preset + agent roles
Code preset     + agent roles
custom preset   + agent roles
```

In-process children inherit their parent's preset composition, workspace, delegated policy, and tools. The role then applies its own route, effort, persona, optional tool filter, and depth cap.

To limit the plugin to selected presets:

```yaml
presetIds: [standard, code, my-review-preset]
```

## Legacy Luna + Sol router

Restore the 0.1 behavior with:

```yaml
requiredPresetId: luna-sol-reasoning-router
lunaProvider: openai-codex
lunaModel: gpt-5.6-luna
solProvider: openai-codex
solModel: gpt-5.6-sol
initialSolReasoning: medium
escalatedSolReasoning: high
initialConsultEnabled: true
failOpen: true
```

Copy and select the shipped preset. The old mode still provides a tool-less Sol advisor, validates the Luna root route, limits one blocker to two successful consultations, and restores escalation from durable session events. The 0.2 default `requiredPresetId: ''` disables only the legacy guard, not Agent Roles.

## Safety and runtime boundaries

- Advisory requests have no tools. A returned tool call is rejected and never dispatched.
- Workers use the native DSH subagent runtime; the provider enforces `maxDepth` on every start.
- Tool filters are composition visibility, not a new security sandbox. DSH sandbox and approval policy remain authoritative.
- Explicit model and effort selections are validated exactly; there is no silent fallback or model rewrite.
- Child reasoning effort is installed with agent-scoped `installModelSelection` before the child request.

## Development

```bash
pnpm install --offline
pnpm run check
pnpm pack --dry-run
```

The test suite covers both the legacy router invariants and the new live catalog, effort validation, tool-less advisory, worker route/effort, tool filter, and absolute-depth behavior.

## License

Apache-2.0. See [`LICENSE`](./LICENSE).
