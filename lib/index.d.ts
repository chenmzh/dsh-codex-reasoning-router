import { ContentBlock } from "@deepseek-ai/dsh-llm";
import z from "@deepseek-ai/schemastery";
import { AsyncLocalStorage } from "node:async_hooks";
import { Session, UserMessage } from "@deepseek-ai/dsh-session";
import { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { Agent } from "@deepseek-ai/dsh-agent";
import { Context } from "@deepseek-ai/cordis";
import { SettingsNamespace } from "@deepseek-ai/dsh-settings";
//#region src/constants.d.ts
declare const PACKAGE_NAME = "dsh-codex-reasoning-router";
declare const SOL_CONSULT_TOOL = "sol_consult";
type SolReasoningEffort = 'medium' | 'high';
declare const SOL_ADVISOR_SYSTEM_PROMPT = "You are the reasoning advisor for a coding agent.\n\nYou do not execute tasks. You have no tools and must not assume that you can inspect files, run commands, edit code, search the web, or delegate work.\n\nYour job is to reason over the evidence supplied by the Luna execution agent.\n\nIdentify the most likely explanation, important uncertainties, constraints, decision points, and the minimum useful next investigation or strategy.\n\nDo not invent repository facts that are not in the supplied evidence. Clearly separate confirmed facts from hypotheses.\n\nReturn a compact structured advisory for Luna. Do not produce a final user-facing answer. Do not write implementation patches unless a tiny illustrative fragment is necessary to explain a decision.\n\nPrefer a decisive recommendation when evidence supports one. When evidence is insufficient, state exactly what Luna should verify next.";
declare const LUNA_ROUTER_INSTRUCTION = "You are the execution agent. You own all tools, code changes, verification, subagents, and final delivery.\n\nA reasoning-only Sol advisor is available through `sol_consult`.\n\nUse it only for genuinely difficult blockers, architectural decisions, contradictory evidence, repeated failed approaches, or high-risk decisions. Do not use Sol for routine inspection, editing, testing, linting, formatting, or obvious failures.\n\nSol's output is advice, not authority. Verify its assumptions against the repository before acting. If consulting the same unresolved issue again, include a concise prior_advice_evaluation explaining how the first-stage advice was applied or evaluated.";
declare const INITIAL_ADVISORY_FORMAT = "<sol_advisory>\ngoal:\n...\n\nsuccess_criteria:\n- ...\n\ntask_shape:\n...\n\ncritical_constraints:\n- ...\n\nunknowns_to_resolve:\n- ...\n\nrecommended_investigation:\n1. ...\n\nexecution_strategy:\n1. ...\n\nrisk_points:\n- ...\n\nverification:\n- ...\n\nescalation_conditions:\n- ...\n</sol_advisory>";
//#endregion
//#region src/types.d.ts
type TeamRoleKind = 'advisory' | 'subagent';
type RoleTriggerMode = 'manual' | 'rules' | 'first-turn';
type RoleTriggerReason = 'explicit-user-request' | 'first-turn-policy' | 'task-breadth' | 'high-risk' | 'repeated-failure' | 'conflicting-evidence' | 'architecture-decision' | 'delegated-execution' | 'custom-rule';
interface RoleTriggerRules {
  mode: RoleTriggerMode;
  depthRoleId: string;
  coordinatorRoleId: string;
  workerRoleId: string;
  firstTurnRoleId: string;
  coordinatorMinDeliverables: number;
  coordinatorMinSubsystems: number;
  repeatedFailureThreshold: number;
  triggerOnHighRisk: boolean;
  triggerOnConflictingEvidence: boolean;
  triggerOnArchitectureDecision: boolean;
  maxDepthCallsPerTurn: number;
  maxCoordinatorCallsPerTurn: number;
  maxConcurrentWorkers: number;
  requirePriorAdviceEvaluation: boolean;
  showTriggerReason: boolean;
  firstTurnFailOpen: boolean;
  customInstructions: string;
}
interface TeamRoleConfig {
  id: string;
  kind: TeamRoleKind;
  description: string;
  /** Omit provider/model to inherit the calling agent's current route. */
  provider?: string;
  model?: string;
  /** Omit to use the selected model's configured/provider default. */
  reasoningEffort?: string;
  maxTokens?: number;
  systemPrompt?: string;
  subagentProvider?: string;
  maxDepth?: number;
  toolAllow?: string[];
  toolDeny?: string[];
}
interface Config$1 {
  teamEnabled: boolean;
  /** Empty means the role tools compose with every preset. */
  presetIds: string[];
  roles: TeamRoleConfig[];
  triggerRules: RoleTriggerRules;
  requiredPresetId: string;
  lunaProvider: string;
  lunaModel: string;
  solProvider: string;
  solModel: string;
  initialSolReasoning: SolReasoningEffort;
  escalatedSolReasoning: SolReasoningEffort;
  solAdviceMaxTokens: number;
  solTimeoutMs: number;
  initialConsultEnabled: boolean;
  failOpen: boolean;
}
interface SolConsultInput {
  problem: string;
  goal: string;
  evidence: string[];
  attempts: string[];
  constraints: string[];
  question: string;
  prior_advice_evaluation?: string;
  medium_advice_evaluation?: string;
}
interface SolIssueState {
  fingerprint: string;
  mediumUsed: boolean;
  highUsed: boolean;
  mediumAdvice?: string;
  highAdvice?: string;
  resolved?: boolean;
}
interface AdvisoryRequest {
  effort: SolReasoningEffort;
  prompt: string;
  signal?: AbortSignal;
  /** Usage-only correlation; never becomes the provider's session identity. */
  usageSessionId?: string;
}
interface AdvisoryResult {
  effort: SolReasoningEffort;
  advice: string;
}
interface ConsultValue {
  status: 'advised' | 'unavailable' | 'evaluation-required' | 'escalation-exhausted';
  fingerprint: string;
  effort?: SolReasoningEffort;
  advisory?: string;
  message?: string;
}
//#endregion
//#region src/advisor.d.ts
interface AdvisorScope {
  readonly purpose: 'sol-advisory';
}
declare const advisorScope: AsyncLocalStorage<AdvisorScope>;
declare class SolProtocolError extends Error {
  constructor(message: string);
}
declare function safeError(error: unknown): string;
declare class SolAdvisor {
  private readonly ctx;
  private readonly config;
  constructor(ctx: Context, config: Config$1);
  consult(request: AdvisoryRequest): Promise<string>;
}
declare function initialPrompt(userRequest: string, cwd?: string): string;
declare function blockerPrompt(input: SolConsultInput, priorMediumAdvice?: string): string;
//#endregion
//#region src/events.d.ts
declare const ROUTER_EVENT_TYPES: readonly ["agent-role/initial-run", "agent-role/run-started", "agent-role/run-finished", "reasoning-router/initial-consult", "reasoning-router/consult-medium", "reasoning-router/consult-high", "reasoning-router/consult-failed", "reasoning-router/escalation-exhausted"];
interface InitialRoleRunEvent {
  status: 'succeeded' | 'failed';
  role: string;
  triggerReason: 'first-turn-policy';
  error?: string;
}
interface AgentRoleRunStartedEvent {
  version: 1;
  runId: string;
  role: string;
  kind: 'advisory' | 'subagent';
  provider: string;
  model: string;
  reasoningEffort?: string;
  triggerReason: RoleTriggerReason;
  parentRunId: string | null;
  childSessionId: string | null;
  references: string[];
  task: string;
}
interface AgentRoleRunFinishedEvent {
  version: 1;
  runId: string;
  status: 'succeeded' | 'failed';
  durationMs: number;
  childSessionId?: string | null;
  output?: string;
  stopReason?: string;
  error?: string;
}
interface InitialConsultEvent {
  status: 'succeeded' | 'failed' | 'disabled';
  advisory?: string;
  error?: string;
}
interface ConsultEvent {
  fingerprint: string;
  effort: SolReasoningEffort;
  advisory: string;
  state: SolIssueState;
}
interface ConsultFailedEvent {
  phase: 'initial' | 'consult';
  fingerprint?: string;
  effort: SolReasoningEffort;
  error: string;
}
interface EscalationExhaustedEvent {
  fingerprint: string;
}
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'agent-role/initial-run': InitialRoleRunEvent;
    'agent-role/run-started': AgentRoleRunStartedEvent;
    'agent-role/run-finished': AgentRoleRunFinishedEvent;
    'reasoning-router/initial-consult': InitialConsultEvent;
    'reasoning-router/consult-medium': ConsultEvent;
    'reasoning-router/consult-high': ConsultEvent;
    'reasoning-router/consult-failed': ConsultFailedEvent;
    'reasoning-router/escalation-exhausted': EscalationExhaustedEvent;
  }
}
declare function installRouterEvents(): void;
//#endregion
//#region src/router.d.ts
declare class ReasoningRouter {
  private readonly config;
  private readonly advisor;
  constructor(config: Config$1, advisor: SolAdvisor);
  assertConfiguredLuna(agent: Agent): void;
  beforeFirstStep(agent: Agent, messages: UserMessage[], signal: AbortSignal): Promise<UserMessage[]>;
  consult(agent: Agent, input: SolConsultInput, signal: AbortSignal): Promise<ConsultValue>;
}
//#endregion
//#region src/team.d.ts
declare module '@deepseek-ai/dsh-agent' {
  interface AgentOptions {
    /** Private markers used to install a team's effort before a child runs. */
    reasoningRouterRole?: string;
    reasoningRouterEffort?: string;
    /** Parent role-run id used to render nested activation edges. */
    reasoningRouterParentRunId?: string;
  }
}
interface ResolvedRoleRoute {
  provider: string;
  model: string;
  reasoningEffort?: string;
}
interface TeamRunResult extends ResolvedRoleRoute {
  runId: string;
  role: string;
  kind: 'advisory' | 'subagent';
  output: ContentBlock[];
  stopReason?: string;
  diagnostic?: string;
  childSessionId?: string;
  triggerReason?: RoleTriggerReason;
}
declare function resolveRoleRoute(agent: Agent, role: TeamRoleConfig): ResolvedRoleRoute;
declare function validateRoleRoute(ctx: Context, route: ResolvedRoleRoute): Promise<void>;
declare function modelCatalog(ctx: Context): Promise<{
  provider: string;
  name: string;
  models: {
    defaultReasoningEffort?: string;
    id: string;
    name: string;
    reasoningEfforts: string[];
  }[];
}[]>;
interface RoleRunMeta {
  triggerReason?: RoleTriggerReason;
  priorAdviceEvaluation?: string;
  references?: readonly string[];
  maxTokensCap?: number;
}
declare class AgentTeam {
  private readonly ctx;
  readonly roles: readonly TeamRoleConfig[];
  readonly triggerRules?: RoleTriggerRules | undefined;
  private readonly turnStates;
  constructor(ctx: Context, roles: readonly TeamRoleConfig[], triggerRules?: RoleTriggerRules | undefined);
  beginTurn(agent: Agent): void;
  private state;
  private reserve;
  role(id: string): TeamRoleConfig;
  installChildSelection(agent: Agent): void;
  run(agent: Agent, roleId: string, task: string, signal: AbortSignal, meta?: RoleRunMeta): Promise<TeamRunResult>;
  private runAdvisory;
  private runSubagent;
}
//#endregion
//#region src/role-policy.d.ts
declare const DEFAULT_TRIGGER_RULES: RoleTriggerRules;
/** Migrate only the legacy all-default mapping when custom role ids replaced the shipped roster. */
declare function migrateLegacyTriggerRules(rules: RoleTriggerRules, roles: readonly TeamRoleConfig[]): RoleTriggerRules;
declare function roleTriggerPrompt(rules: RoleTriggerRules): string;
declare function validateTriggerRules(rules: RoleTriggerRules, roles: readonly TeamRoleConfig[]): void;
declare function beforeInitialRoleRun(agent: Agent, messages: UserMessage[], team: AgentTeam, rules: RoleTriggerRules, signal: AbortSignal): Promise<UserMessage[]>;
//#endregion
//#region src/model-limits.d.ts
declare function builtinMaxOutputTokens(provider: string | undefined, model: string | undefined): number | undefined;
//#endregion
//#region src/state.d.ts
/** Stable, deterministic blocker identity; attempts and wording of the question are intentionally excluded. */
declare function issueFingerprint(input: SolConsultInput): string;
/** Fold plugin-owned durable events. Process-local maps are never authoritative. */
declare function restoreIssueStates(session: Session): Map<string, SolIssueState>;
declare function hasInitialConsultRecord(session: Session): boolean;
declare function hasExhaustedRecord(session: Session, fingerprint: string): boolean;
//#endregion
//#region src/tool.d.ts
declare function solConsultTool(router: ReasoningRouter): ToolDefinition;
//#endregion
//#region ../13_dsh_auto_update/staging/dsh-web-upgrade-20260905/packages/util/values/lib/types/index.d.ts
/** Duplicate-install-safe JSON and immutable-value helpers. @module @deepseek-ai/dsh-util-values */
/** A value that round-trips through JSON without loss. */
type JsonValue = null | boolean | number | string | JsonValue[] | {
  [key: string]: JsonValue;
};
//#endregion
//#region src/team-tool.d.ts
declare function agentTeamRunTool(team: AgentTeam): ToolDefinition;
declare function agentTeamCatalogTool(load: () => Promise<JsonValue[]>): ToolDefinition;
//#endregion
//#region src/index.d.ts
declare const name = "codex-reasoning-router";
declare const inject: string[];
interface Config extends Config$1 {}
interface TeamSettings {
  teamEnabled: boolean;
  presetIds: string[];
  roles: TeamRoleConfig[];
  triggerRules: RoleTriggerRules;
}
declare const TEAM_SETTINGS_NAMESPACE: SettingsNamespace;
declare const DEFAULT_TEAM_ROLES: TeamRoleConfig[];
declare const TeamSettings: z<TeamSettings>;
declare const Config: z<Config>;
declare function validateTeamSettings(config: TeamSettings): void;
declare function isRouterPresetAgent(agent: Agent, roots: readonly Agent[], requiredPresetId: string): boolean;
declare function apply(ctx: Context, config: Config): void;
//#endregion
export { AdvisorScope, type AdvisoryRequest, type AdvisoryResult, AgentRoleRunFinishedEvent, AgentRoleRunStartedEvent, AgentTeam, Config, type ConsultValue, DEFAULT_TEAM_ROLES, DEFAULT_TRIGGER_RULES, INITIAL_ADVISORY_FORMAT, LUNA_ROUTER_INSTRUCTION, PACKAGE_NAME, ROUTER_EVENT_TYPES, ReasoningRouter, ResolvedRoleRoute, type RoleTriggerMode, type RoleTriggerReason, type RoleTriggerRules, SOL_ADVISOR_SYSTEM_PROMPT, SOL_CONSULT_TOOL, SolAdvisor, type SolConsultInput, type SolIssueState, SolProtocolError, SolReasoningEffort, TEAM_SETTINGS_NAMESPACE, type TeamRoleConfig, type TeamRoleKind, TeamRunResult, TeamSettings, advisorScope, agentTeamCatalogTool, agentTeamRunTool, apply, beforeInitialRoleRun, blockerPrompt, builtinMaxOutputTokens, hasExhaustedRecord, hasInitialConsultRecord, initialPrompt, inject, installRouterEvents, isRouterPresetAgent, issueFingerprint, migrateLegacyTriggerRules, modelCatalog, name, resolveRoleRoute, restoreIssueStates, roleTriggerPrompt, safeError, solConsultTool, validateRoleRoute, validateTeamSettings, validateTriggerRules };