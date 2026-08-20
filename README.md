# dsh-codex-reasoning-router

[简体中文](./README.zh-CN.md) | English | [AI / LLM context](./llms.txt)

> DeepSeek Harness (`dsh`) preset and plugin: GPT-5.6 Luna executes with the full Standard toolset; tool-less GPT-5.6 Sol supplies compact reasoning advice.

**Luna owns action. Sol owns advice.**

This DeepSeek Harness plugin keeps `openai-codex / gpt-5.6-luna` as the root execution agent and uses `openai-codex / gpt-5.6-sol` only for short, independent reasoning-advisor calls.

Sol is not a second coding agent. Sol never touches the workspace, never receives tools, never creates subagents, and never answers the user directly. Luna owns every tool, file change, test, skill, MCP call, subagent, permission decision, and final response.

## Requirements and preset installation

Requirements:

- a current DeepSeek Harness installation;
- `dsh-codex >= 0.2.3`, installed and authenticated;
- access to `openai-codex/gpt-5.6-luna` and `openai-codex/gpt-5.6-sol`;
- Node.js 22 and pnpm for source development (verified with Node 22.23 and pnpm 11.7).

Install and authenticate the current `dsh-codex` first. Install this package through the DSH plugin command so its host bundle is added to `dsh.profile.bundles`, then copy the shipped preset directory into DSH home:

```bash
pnpm dsh plugin --profile web add dsh-codex
pnpm dsh plugin --profile web add link:/absolute/path/to/dsh-codex-reasoning-router
cp -R /absolute/path/to/dsh-codex-reasoning-router/preset/luna-sol-reasoning-router /path/to/.dsh/.agent-presets/
```

Install directly from GitHub instead of a local checkout:

```bash
pnpm dsh plugin --profile web add github:chenmzh/dsh-codex-reasoning-router
cp -R /path/to/.dsh/profiles/web/node_modules/dsh-codex-reasoning-router/preset/luna-sol-reasoning-router /path/to/.dsh/.agent-presets/
```

For a published package, pass `dsh-codex-reasoning-router` to the same plugin command and copy the preset from its installed package. Restart DSH, then explicitly select **Luna + Sol Reasoning Router** for a new session. The existing default preset is not changed.

The preset is a complete copy of the official Standard composition, preserving its normal tools, Skills, MCP, compaction, and subagent surface. The profile bundle mounts the Router once on the host plane; the preset identity activates its agent integrations. The plugin also checks the effective durable session preset via the public `resolveSessionPreset` API and reconciles its attachment when a blank session switches presets; accidental global loading does not attach it to other presets. Model-catalog validation is deferred until a root using this preset starts a step, so another preset can use any available provider/model without being checked or blocked by this plugin.

DSH presets do not own the host model route. Select `openai-codex / gpt-5.6-luna` before using this preset. If a saved route differs, the plugin stops that session with a diagnostic and never silently switches the main model. Sessions using another preset do not receive this route guard.

## Configuration

Host configuration lives in [`cordis.patch.yml`](./cordis.patch.yml):

```yaml
- id: reasoning-router
  name: dsh-codex-reasoning-router
  inject: [openAICodex]
  config:
    requiredPresetId: luna-sol-reasoning-router
    lunaProvider: openai-codex
    lunaModel: gpt-5.6-luna
    solProvider: openai-codex
    solModel: gpt-5.6-sol
    initialSolReasoning: medium
    escalatedSolReasoning: high
    solAdviceMaxTokens: 2000
    solTimeoutMs: 30000
    initialConsultEnabled: true
    failOpen: true
```

Both effort fields accept only `medium` or `high` and default to `medium -> high`. The narrow domain type and runtime guard reject `xhigh` and `max`. When a root using this preset starts, the plugin checks the provider catalog and exact model metadata; a missing configured model is an error, not a fallback. That check is not performed for other presets.

Confirm current IDs with the DSH model picker (`/model`) or the public LLM registry used by a diagnostic plugin:

```ts
await ctx.llm.listModels('openai-codex')
await ctx.llm.resolveModelInfo('openai-codex', 'gpt-5.6-luna')
await ctx.llm.resolveModelInfo('openai-codex', 'gpt-5.6-sol')
```

At implementation time, the installed pi-ai catalog contains `gpt-5.6-luna` and `gpt-5.6-sol`.

## Request lifecycle

```text
WAIT_FIRST_USER
  -> SOL_INITIAL_MEDIUM
  -> LUNA_EXECUTING
       -> new blocker: SOL_MEDIUM -> LUNA_EXECUTING
       -> same blocker, medium evaluated: SOL_HIGH -> LUNA_EXECUTING
       -> same blocker again: ESCALATION_EXHAUSTED (no model call)
```

`agent/pre-step` is an awaited public waterfall. On a root session's first direct user message, the listener awaits Sol medium, creates a plugin-sourced user context containing only the Advisory Packet, and then returns `kind: enter`. Only after that does the agent loop log the step, assemble the prompt/tools, and make Luna's first request. Failure appends a warning event and returns the original messages when `failOpen` is enabled.

The later `sol_consult` tool has a fixed schema and is registered once in the root agent scope. Its second call for the same fingerprint requires `medium_advice_evaluation`; this prevents transport failure or an untried suggestion from being treated as grounds for high escalation.

## Why Sol cannot act

Every Sol call is a hand-built `ctx.llm.stream` request with:

- the configured Sol provider/model;
- only the static advisor prompt and one compact evidence message;
- no `tools` property;
- no session continuation identity;
- no filesystem, shell, MCP, skill, web, or subagent interface.

The response is consumed directly with `BlockAssembler`. It never enters the DSH agent loop or tool dispatcher. A returned `tool-call` block is a `SolProtocolError`; it is never executed. Only visible text becomes an Advisory Packet for Luna.

## Recursion and durable state

Internal calls run under an `AsyncLocalStorage` marker whose purpose is `sol-advisory`. The `llm/stream` hook checks this marker and delegates immediately. It does not infer internal calls from the model name. DSH rc.6 exposes only `compaction | session-title` in `GenerateOptions.purpose`, so a custom purpose is not forged into that public field.

Consultation results are append-only session events:

- `reasoning-router/initial-consult`
- `reasoning-router/consult-medium`
- `reasoning-router/consult-high`
- `reasoning-router/consult-failed`
- `reasoning-router/escalation-exhausted`

The issue-state fold reads successful medium/high events from the durable log. A process-local map is not the source of truth. Failed network/provider calls log `consult-failed` but do not set `mediumUsed` or `highUsed`. Resume reconstructs the state; compaction may replace model-visible surface nodes but does not erase these log-only events. Only compact Advisory Packets—not private reasoning—are retained.

Fingerprints hash normalized goal, problem, and stable file/error/test anchors. Attempts, the question wording, timestamps, and random values are excluded.

## Compatibility

The plugin uses the existing `openai-codex` adapter and credential lifecycle. It does not read OAuth files or tokens and does not call private ChatGPT endpoints. Sol one-shots intentionally omit `sessionId`; normal Luna turns remain owned by dsh-codex and retain their standard WebSocket context reuse and native/basic compaction behavior.

The profile bundle mounts the Router during host boot so its durable event vocabulary is available before cold session-history reads. `requiredPresetId` still gates every agent integration: only the opt-in preset receives the scoped system section, tool, model validation, and routing checks. It does not replace system prompt sections, contexts, the normal tool catalog, skills, MCP, subagent orchestration, compaction, permissions, or the agent loop. Subagents do not receive `sol_consult` from this plugin.

## Observability and verification

The event names above are visible in the session log, and concise secret-free info/warning messages report consultations. To exercise escalation:

1. Start a new Luna root session and send one user message; confirm `initial-consult` precedes the first Luna assistant chunk.
2. Ask Luna to call `sol_consult` for a concrete blocker; confirm `consult-medium`.
3. Call again with the same goal/problem/evidence anchors and a non-empty `medium_advice_evaluation`; confirm `consult-high`.
4. Call a third time; confirm `escalation-exhausted` and no provider request.
5. Resume the session and repeat step 4; exhaustion must remain restored.

Development checks:

```bash
pnpm install --offline
pnpm run typecheck
pnpm run test
pnpm run build
```

## Public DSH APIs used

- `ctx.llm.listModels`, `resolveModelInfo`, and `stream`
- awaited `agent/pre-step` and `agent/request` waterfalls
- `agent/created` and `agent/disposed`
- `ctx.agents.roots()` and agent-scoped `agent.ctx`
- `resolveSessionPreset` from `@deepseek-ai/dsh-agent-presets`
- `agent.ctx.systemPrompt.section`
- `agent.ctx.tools.register` with `defineTool`
- `Session.append`, `Session.events`, and the extensible `KNOWN_SESSION_EVENT_TYPES`
- `createUserMessage`, `BlockAssembler`, and `ReasoningEffortId`

No DSH private source, private runtime object, credential file, or undocumented backend endpoint is used.
