import { agentPresetProjectionDefinition } from "@deepseek-ai/dsh-agent-presets";
import { BlockAssembler, ReasoningEffortId, createUserMessage, isAgentLoopRequest } from "@deepseek-ai/dsh-llm";
import z from "@deepseek-ai/schemastery";
import { AsyncLocalStorage } from "node:async_hooks";
import { KNOWN_SESSION_EVENT_TYPES } from "@deepseek-ai/dsh-session";
import { createHash } from "node:crypto";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
//#region src/constants.ts
const PACKAGE_NAME = "dsh-codex-reasoning-router";
const SOL_CONSULT_TOOL = "sol_consult";
const SOL_ADVISOR_SYSTEM_PROMPT = `You are the reasoning advisor for a coding agent.

You do not execute tasks. You have no tools and must not assume that you can inspect files, run commands, edit code, search the web, or delegate work.

Your job is to reason over the evidence supplied by the Luna execution agent.

Identify the most likely explanation, important uncertainties, constraints, decision points, and the minimum useful next investigation or strategy.

Do not invent repository facts that are not in the supplied evidence. Clearly separate confirmed facts from hypotheses.

Return a compact structured advisory for Luna. Do not produce a final user-facing answer. Do not write implementation patches unless a tiny illustrative fragment is necessary to explain a decision.

Prefer a decisive recommendation when evidence supports one. When evidence is insufficient, state exactly what Luna should verify next.`;
const LUNA_ROUTER_INSTRUCTION = `You are the execution agent. You own all tools, code changes, verification, subagents, and final delivery.

A reasoning-only Sol advisor is available through \`sol_consult\`.

Use it only for genuinely difficult blockers, architectural decisions, contradictory evidence, repeated failed approaches, or high-risk decisions. Do not use Sol for routine inspection, editing, testing, linting, formatting, or obvious failures.

Sol's output is advice, not authority. Verify its assumptions against the repository before acting. If consulting the same unresolved issue again, include a concise prior_advice_evaluation explaining how the first-stage advice was applied or evaluated.`;
const INITIAL_ADVISORY_FORMAT = `<sol_advisory>
goal:
...

success_criteria:
- ...

task_shape:
...

critical_constraints:
- ...

unknowns_to_resolve:
- ...

recommended_investigation:
1. ...

execution_strategy:
1. ...

risk_points:
- ...

verification:
- ...

escalation_conditions:
- ...
</sol_advisory>`;
//#endregion
//#region src/advisor.ts
const advisorScope = new AsyncLocalStorage();
var SolProtocolError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "SolProtocolError";
	}
};
function combinedSignal(caller, timeoutMs) {
	const timeout = AbortSignal.timeout(timeoutMs);
	return caller === void 0 ? timeout : AbortSignal.any([caller, timeout]);
}
function safeError(error) {
	return (error instanceof Error ? error.message : String(error)).replace(/bearer\s+[\w.+/=-]+/giu, "Bearer <redacted>").replace(/(?:access|refresh|oauth)[_-]?token\s*[:=]\s*[^\s,;]+/giu, "token=<redacted>").slice(0, 500);
}
var SolAdvisor = class {
	ctx;
	config;
	constructor(ctx, config) {
		this.ctx = ctx;
		this.config = config;
	}
	async consult(request) {
		if (request.effort !== "medium" && request.effort !== "high") throw new Error("Unsupported Sol reasoning effort: " + String(request.effort) + ". Only medium and high are permitted.");
		const assembler = new BlockAssembler();
		const signal = combinedSignal(request.signal, this.config.solTimeoutMs);
		await advisorScope.run({ purpose: "sol-advisory" }, async () => {
			const options = {
				provider: this.config.solProvider,
				model: this.config.solModel,
				reasoningEffort: ReasoningEffortId(request.effort),
				system: SOL_ADVISOR_SYSTEM_PROMPT,
				messages: [createUserMessage({
					source: {
						kind: "plugin",
						plugin: PACKAGE_NAME
					},
					content: [{
						type: "text",
						text: request.prompt
					}]
				})],
				maxTokens: this.config.solAdviceMaxTokens,
				signal,
				...request.usageSessionId === void 0 ? {} : {
					usageSessionId: request.usageSessionId,
					usagePurpose: "sol-advisory"
				}
			};
			const stream = this.ctx.llm.stream(options);
			for await (const chunk of stream) assembler.push(chunk);
		});
		const blocks = assembler.blocks();
		if (blocks.some((block) => block.type === "tool-call")) throw new SolProtocolError("Sol returned a tool call even though no tool catalog was supplied; the call was not executed");
		const advice = blocks.filter((block) => block.type === "text").map((block) => block.text).join("").trim();
		if (advice.length === 0) throw new SolProtocolError("Sol returned no advisory text");
		return advice;
	}
};
function initialPrompt(userRequest, cwd) {
	return `Prepare the first-turn reasoning advisory for Luna.

User request:
${userRequest}

Workspace metadata:
${cwd === void 0 ? "- working directory not supplied" : `- working directory: ${cwd}`}

You have not inspected the repository. Do not invent file names, code locations, dependencies, or implementation details. Focus on intent, success criteria, unknowns, investigation order, risk, execution shape, verification, and conditions that would justify later consultation.

Return exactly one compact packet in this shape:
${INITIAL_ADVISORY_FORMAT}`;
}
function blockerPrompt(input, priorMediumAdvice) {
	return JSON.stringify({
		task: "reason over supplied evidence and return one compact <sol_advisory> packet",
		current_goal: input.goal,
		blocker: input.problem,
		confirmed_evidence: input.evidence,
		attempts_and_results: input.attempts,
		constraints: input.constraints,
		question: input.question,
		...priorMediumAdvice === void 0 ? {} : {
			prior_medium_advice: priorMediumAdvice,
			luna_evaluation: input.prior_advice_evaluation ?? input.medium_advice_evaluation,
			escalation_instruction: "The first-stage advice was evaluated and the same issue remains unresolved. Reassess at the configured second-stage effort without assuming new repository access."
		},
		output_format: INITIAL_ADVISORY_FORMAT
	}, null, 2);
}
//#endregion
//#region src/events.ts
const ROUTER_EVENT_TYPES = [
	"agent-role/initial-run",
	"agent-role/run-started",
	"agent-role/run-finished",
	"reasoning-router/initial-consult",
	"reasoning-router/consult-medium",
	"reasoning-router/consult-high",
	"reasoning-router/consult-failed",
	"reasoning-router/escalation-exhausted"
];
function installRouterEvents() {
	if (!(KNOWN_SESSION_EVENT_TYPES instanceof Set)) throw new Error("dsh-codex-reasoning-router: this DSH build does not expose the extensible session event vocabulary");
	for (const event of ROUTER_EVENT_TYPES) KNOWN_SESSION_EVENT_TYPES.add(event);
}
//#endregion
//#region src/state.ts
function normalize(value) {
	return value.normalize("NFKC").toLowerCase().replace(/(?:[a-z]:)?[\\/][\w./\\-]+/giu, "<path>").replace(/\b0x[\da-f]+\b/giu, "<hex>").replace(/\b\d+\b/gu, "<n>").replace(/[^\p{L}\p{N}_<>]+/gu, " ").trim().replace(/\s+/gu, " ");
}
function evidenceAnchors(evidence) {
	const anchors = evidence.flatMap((item) => {
		const paths = item.match(/(?:[\w.-]+[\\/])+[\w.-]+/gu) ?? [];
		const tests = item.match(/(?:test|spec|error|exception|failed|failure)[:\s][^\n]{0,100}/giu) ?? [];
		return [...paths, ...tests].map(normalize);
	});
	return [...new Set(anchors)].sort().slice(0, 12);
}
/** Stable, deterministic blocker identity; attempts and wording of the question are intentionally excluded. */
function issueFingerprint(input) {
	const material = JSON.stringify({
		goal: normalize(input.goal),
		problem: normalize(input.problem),
		anchors: evidenceAnchors(input.evidence)
	});
	return createHash("sha256").update(material).digest("hex").slice(0, 24);
}
function localStart(session) {
	return session.inheritedEventCount;
}
function sessionEvents(session) {
	return session.ownEvents();
}
/** Fold plugin-owned durable events. Process-local maps are never authoritative. */
function restoreIssueStates(session) {
	const states = /* @__PURE__ */ new Map();
	const start = localStart(session);
	for (const event of sessionEvents(session)) {
		if (event.seq < start) continue;
		if (event.type !== "reasoning-router/consult-medium" && event.type !== "reasoning-router/consult-high") continue;
		states.set(event.data.fingerprint, { ...event.data.state });
	}
	return states;
}
function hasInitialConsultRecord(session) {
	const start = localStart(session);
	return sessionEvents(session).some((event) => event.seq >= start && event.type === "reasoning-router/initial-consult");
}
function hasExhaustedRecord(session, fingerprint) {
	const start = localStart(session);
	return sessionEvents(session).some((event) => event.seq >= start && event.type === "reasoning-router/escalation-exhausted" && event.data.fingerprint === fingerprint);
}
//#endregion
//#region src/router.ts
function log(ctx, level, message) {
	ctx.logger?.[level]?.(`[${PACKAGE_NAME}] ${message}`);
}
function directUserText(messages) {
	const message = messages.find((candidate) => candidate.source.kind === "user");
	if (message === void 0) return void 0;
	const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n").trim();
	return text.length === 0 ? "[User supplied non-text content; no text was available to the advisor.]" : text;
}
function advisoryMessage(advice, effort) {
	return createUserMessage({
		source: {
			kind: "plugin",
			plugin: PACKAGE_NAME,
			form: "notice",
			summary: "Sol " + effort + " initial advisory; Luna remains the executor"
		},
		content: [{
			type: "text",
			text: `Reasoning Advisory Packet from Sol (advice only; verify before action):\n${advice}`
		}]
	});
}
function nextState(current, fingerprint, advice) {
	if (current === void 0 || !current.mediumUsed) return {
		fingerprint,
		mediumUsed: true,
		highUsed: false,
		mediumAdvice: advice,
		resolved: false
	};
	return {
		...current,
		highUsed: true,
		highAdvice: advice,
		resolved: false
	};
}
var ReasoningRouter = class {
	config;
	advisor;
	constructor(config, advisor) {
		this.config = config;
		this.advisor = advisor;
	}
	assertConfiguredLuna(agent) {
		const header = agent.session.requestHeader()?.config;
		const provider = agent.options.provider ?? header?.provider;
		const model = agent.options.model ?? header?.model;
		if (provider !== this.config.lunaProvider || model !== this.config.lunaModel) throw new Error(`${PACKAGE_NAME}: root agent route must be ${this.config.lunaProvider}/${this.config.lunaModel}; observed ${provider ?? "<unset>"}/${model ?? "<unset>"}. The router did not change the route and paused before execution.`);
	}
	async beforeFirstStep(agent, messages, signal) {
		if (hasInitialConsultRecord(agent.session)) return messages;
		const request = directUserText(messages);
		if (request === void 0) return messages;
		this.assertConfiguredLuna(agent);
		if (!this.config.initialConsultEnabled) {
			agent.session.append("reasoning-router/initial-consult", { status: "disabled" });
			return messages;
		}
		try {
			const advice = await this.advisor.consult({
				effort: this.config.initialSolReasoning,
				prompt: initialPrompt(request, agent.session.header.cwd),
				signal,
				usageSessionId: String(agent.session.id)
			});
			agent.session.append("reasoning-router/initial-consult", {
				status: "succeeded",
				advisory: advice
			});
			log(agent.ctx, "info", "reasoning-router/initial-consult: Sol " + this.config.initialSolReasoning + " consulted; Luna resumes execution");
			return [...messages, advisoryMessage(advice, this.config.initialSolReasoning)];
		} catch (error) {
			const detail = safeError(error);
			agent.session.append("reasoning-router/consult-failed", {
				phase: "initial",
				effort: this.config.initialSolReasoning,
				error: detail
			});
			agent.session.append("reasoning-router/initial-consult", {
				status: "failed",
				error: detail
			});
			log(agent.ctx, "warn", `reasoning-router/consult-failed: ${detail}; Luna continues`);
			if (!this.config.failOpen) throw error;
			return messages;
		}
	}
	async consult(agent, input, signal) {
		this.assertConfiguredLuna(agent);
		const fingerprint = issueFingerprint(input);
		const current = restoreIssueStates(agent.session).get(fingerprint);
		if (current?.highUsed) {
			if (!hasExhaustedRecord(agent.session, fingerprint)) agent.session.append("reasoning-router/escalation-exhausted", { fingerprint });
			log(agent.ctx, "warn", `reasoning-router/escalation-exhausted: ${fingerprint}`);
			return {
				status: "escalation-exhausted",
				fingerprint,
				message: "This issue already used both configured Sol consultation stages. No further Sol call was made; Luna must continue independently or report the blocker."
			};
		}
		if (current?.mediumUsed && (input.prior_advice_evaluation ?? input.medium_advice_evaluation)?.trim().length === 0) return {
			status: "evaluation-required",
			fingerprint,
			message: "Before the second consultation stage, provide prior_advice_evaluation describing how Luna applied or evaluated the first-stage advice and why the same issue remains unresolved. No Sol call was made."
		};
		if (current?.mediumUsed && input.prior_advice_evaluation === void 0 && input.medium_advice_evaluation === void 0) return {
			status: "evaluation-required",
			fingerprint,
			message: "Before the second consultation stage, provide prior_advice_evaluation describing how Luna applied or evaluated the first-stage advice and why the same issue remains unresolved. No Sol call was made."
		};
		const effort = current?.mediumUsed ? this.config.escalatedSolReasoning : this.config.initialSolReasoning;
		try {
			const advisory = await this.advisor.consult({
				effort,
				prompt: blockerPrompt(input, current?.mediumAdvice),
				signal,
				usageSessionId: String(agent.session.id)
			});
			const state = nextState(current, fingerprint, advisory);
			agent.session.append(effort === "medium" ? "reasoning-router/consult-medium" : "reasoning-router/consult-high", {
				fingerprint,
				effort,
				advisory,
				state
			});
			log(agent.ctx, "info", `reasoning-router/consult-${effort}: ${fingerprint}; Luna resumes execution`);
			return {
				status: "advised",
				fingerprint,
				effort,
				advisory
			};
		} catch (error) {
			const detail = safeError(error);
			agent.session.append("reasoning-router/consult-failed", {
				phase: "consult",
				fingerprint,
				effort,
				error: detail
			});
			log(agent.ctx, "warn", `reasoning-router/consult-failed: ${fingerprint}: ${detail}`);
			return {
				status: "unavailable",
				fingerprint,
				effort,
				message: `Sol consultation unavailable: ${detail}. The reasoning level was not consumed; Luna should continue independently.`
			};
		}
	}
};
//#endregion
//#region src/role-policy.ts
const DEFAULT_TRIGGER_RULES = {
	mode: "rules",
	depthRoleId: "brain",
	coordinatorRoleId: "coordinator",
	workerRoleId: "worker",
	firstTurnRoleId: "coordinator",
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
	customInstructions: ""
};
/** Migrate only the legacy all-default mapping when custom role ids replaced the shipped roster. */
function migrateLegacyTriggerRules(rules, roles) {
	const byId = new Map(roles.map((role) => [role.id, role]));
	if (!(rules.depthRoleId === DEFAULT_TRIGGER_RULES.depthRoleId && rules.coordinatorRoleId === DEFAULT_TRIGGER_RULES.coordinatorRoleId && rules.workerRoleId === DEFAULT_TRIGGER_RULES.workerRoleId && rules.firstTurnRoleId === DEFAULT_TRIGGER_RULES.firstTurnRoleId) || [
		rules.depthRoleId,
		rules.coordinatorRoleId,
		rules.workerRoleId,
		rules.firstTurnRoleId
	].every((id) => byId.has(id))) return rules;
	const advisory = roles.filter((role) => role.kind === "advisory");
	const workers = roles.filter((role) => role.kind === "subagent");
	const depthRoleId = advisory[0]?.id ?? "";
	const coordinatorRoleId = advisory[1]?.id ?? depthRoleId;
	return {
		...rules,
		depthRoleId,
		coordinatorRoleId,
		workerRoleId: workers[0]?.id ?? "",
		firstTurnRoleId: coordinatorRoleId
	};
}
function selectedRole(id) {
	return id === "" ? "<not configured>" : "'" + id + "'";
}
function roleTriggerPrompt(rules) {
	const header = [
		"Agent role trigger policy:",
		"- Deep reasoning role: " + selectedRole(rules.depthRoleId) + ".",
		"- Coordination role: " + selectedRole(rules.coordinatorRoleId) + ".",
		"- Delegated execution role: " + selectedRole(rules.workerRoleId) + "."
	];
	if (rules.mode === "manual") return [
		...header,
		"- Manual-only mode is active. Call an Agent role only when the direct user explicitly requests that role or delegation.",
		"- trigger_reason is audit metadata, not an authorization boundary; preserve the direct user request in the task evidence."
	].join("\n");
	const policy = [
		"- MUST use " + selectedRole(rules.coordinatorRoleId) + " for broad work with at least " + rules.coordinatorMinDeliverables + " distinct deliverables or " + rules.coordinatorMinSubsystems + " independent subsystems, when that role is configured.",
		"- MUST use " + selectedRole(rules.depthRoleId) + " after " + rules.repeatedFailureThreshold + " failed approaches to the same blocker, when that role is configured.",
		...rules.triggerOnHighRisk ? ["- MUST use " + selectedRole(rules.depthRoleId) + " for security, permissions, data-loss, migration, concurrency, irreversible, or other high-risk decisions."] : [],
		...rules.triggerOnConflictingEvidence ? ["- MUST use " + selectedRole(rules.depthRoleId) + " when confirmed evidence materially conflicts."] : [],
		...rules.triggerOnArchitectureDecision ? ["- MUST use " + selectedRole(rules.depthRoleId) + " for high-impact architectural decisions with multiple credible options."] : [],
		"- Use " + selectedRole(rules.workerRoleId) + " only for bounded execution with sufficient context and explicit acceptance criteria.",
		"- Do not use an Agent role for routine inspection, a single obvious edit, ordinary testing, formatting, or a clear failure.",
		"- Before the first tool call, choose at most one advisory role: coordination for breadth, deep reasoning for depth or risk.",
		"- Every agent_role_run call MUST include the matching trigger_reason and a self-contained evidence packet.",
		...rules.requirePriorAdviceEvaluation ? ["- A repeated deep-reasoning call MUST include prior_advice_evaluation describing how the earlier advice was tested and what new evidence remains."] : [],
		...rules.customInstructions.trim() === "" ? [] : ["- User-defined trigger rules: " + rules.customInstructions.trim()]
	];
	if (rules.mode === "first-turn") policy.unshift("- On the first user turn, the plugin automatically runs " + selectedRole(rules.firstTurnRoleId) + " once before the root Agent executes. Do not repeat that call without new evidence.");
	return [...header, ...policy].join("\n");
}
function validateTriggerRules(rules, roles) {
	const byId = new Map(roles.map((role) => [role.id, role]));
	const requireRole = (field, id, kind) => {
		if (id === "") return;
		const role = byId.get(id);
		if (role === void 0) throw new Error("dsh-codex-reasoning-router: " + field + " references unknown role " + id);
		if (kind !== void 0 && role.kind !== kind) throw new Error("dsh-codex-reasoning-router: " + field + " must select an " + kind + " role");
	};
	requireRole("depthRoleId", rules.depthRoleId, "advisory");
	requireRole("coordinatorRoleId", rules.coordinatorRoleId, "advisory");
	requireRole("workerRoleId", rules.workerRoleId, "subagent");
	requireRole("firstTurnRoleId", rules.firstTurnRoleId, "advisory");
	if (rules.mode === "first-turn" && rules.firstTurnRoleId === "") throw new Error("dsh-codex-reasoning-router: first-turn mode requires an advisory firstTurnRoleId");
	for (const [field, value] of Object.entries({
		coordinatorMinDeliverables: rules.coordinatorMinDeliverables,
		coordinatorMinSubsystems: rules.coordinatorMinSubsystems,
		repeatedFailureThreshold: rules.repeatedFailureThreshold,
		maxDepthCallsPerTurn: rules.maxDepthCallsPerTurn,
		maxCoordinatorCallsPerTurn: rules.maxCoordinatorCallsPerTurn,
		maxConcurrentWorkers: rules.maxConcurrentWorkers
	})) if (!Number.isSafeInteger(value) || value < 1) throw new Error("dsh-codex-reasoning-router: " + field + " must be a positive integer");
}
function firstDirectUserText(messages) {
	const message = messages.find((candidate) => candidate.source.kind === "user");
	if (message === void 0) return void 0;
	const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n").trim();
	return text === "" ? "[The user supplied non-text content.]" : text;
}
function lightweightFirstTurn(request) {
	const normalized = request.trim().replace(/[!！。,.，?？~～\s]+/gu, "").toLowerCase();
	if (normalized.length > 24) return false;
	return /^(你好|您好|嗨|哈喽|hello|hi|hey|在吗|在不在|早上好|下午好|晚上好)$/u.test(normalized);
}
function hasInitialRoleRun(agent) {
	const session = agent.session;
	return (typeof session?.snapshotEvents === "function" ? session.snapshotEvents() : session?.events ?? []).some((event) => event?.type === "agent-role/initial-run");
}
async function beforeInitialRoleRun(agent, messages, team, rules, signal) {
	if (rules.mode !== "first-turn" || hasInitialRoleRun(agent)) return messages;
	const request = firstDirectUserText(messages);
	if (request === void 0) return messages;
	const lightweight = lightweightFirstTurn(request);
	try {
		const result = await team.run(agent, rules.firstTurnRoleId, [
			lightweight ? "Classify this lightweight first user message before the root Agent executes." : "Analyze the first user task before the root Agent executes.",
			"User task:\n" + request,
			"Workspace: " + agent.session.header.cwd,
			lightweight ? "This is likely a greeting or presence check. Return one concise sentence stating that no task decomposition is needed. Do not add sections or workspace claims." : "Return prioritized decisions, risks, decomposition, and acceptance checks. Do not claim to inspect the workspace."
		].join("\n\n"), signal, {
			triggerReason: "first-turn-policy",
			maxTokensCap: lightweight ? 512 : 4096
		});
		const text = result.output.filter((block) => block.type === "text").map((block) => block.text).join("\n").trim();
		agent.session.append("agent-role/initial-run", {
			status: "succeeded",
			role: result.role,
			triggerReason: "first-turn-policy"
		});
		return [...messages, createUserMessage({
			source: {
				kind: "plugin",
				plugin: "dsh-codex-reasoning-router",
				form: "notice",
				summary: "Initial Agent role " + result.role + " advisory"
			},
			content: [{
				type: "text",
				text: "Initial Agent role advisory from " + result.role + " (verify before action):\n" + text
			}]
		})];
	} catch (error) {
		const detail = safeError(error);
		agent.session.append("agent-role/initial-run", {
			status: "failed",
			role: rules.firstTurnRoleId,
			triggerReason: "first-turn-policy",
			error: detail
		});
		if (!rules.firstTurnFailOpen) throw error;
		return messages;
	}
}
//#endregion
//#region src/model-limits.ts
/**
* Provider-published maximum output capabilities that are not currently
* exposed by DSH's public exact-model metadata API.
*
* Keep these values aligned with pi-ai's installed provider catalog. Unknown
* routes deliberately return undefined instead of guessing from context size.
*/
const BUILTIN_MAX_OUTPUT_TOKENS = /* @__PURE__ */ new Map([
	["kimi-coding/k3", 131072],
	["kimi-coding/k3-256k", 131072],
	["kimi-coding/kimi-for-coding", 32768],
	["kimi-coding/kimi-for-coding-highspeed", 32768]
]);
function builtinMaxOutputTokens(provider, model) {
	if (provider === void 0 || model === void 0) return void 0;
	return BUILTIN_MAX_OUTPUT_TOKENS.get(`${provider}/${model}`);
}
//#endregion
//#region src/tool.ts
function content(value) {
	return [{
		type: "text",
		text: [
			`status: ${value.status}`,
			`issue_fingerprint: ${value.fingerprint}`,
			...value.effort === void 0 ? [] : [`sol_reasoning_effort: ${value.effort}`],
			...value.advisory === void 0 ? [] : [`\n${value.advisory}`],
			...value.message === void 0 ? [] : [`\n${value.message}`]
		].join("\n")
	}];
}
function solConsultTool(router) {
	return defineTool({
		name: SOL_CONSULT_TOOL,
		description: "Consult the tool-less Sol reasoning advisor for a genuinely difficult blocker, architectural decision, contradictory evidence, repeated failed approach, or high-risk decision. Sol cannot inspect or change the workspace. Do not use for routine work. The plugin chooses medium/high; never request a level.",
		parameters: {
			problem: {
				type: "string",
				required: true,
				description: "Stable summary of the unresolved problem."
			},
			goal: {
				type: "string",
				required: true,
				description: "The outcome Luna is trying to achieve."
			},
			evidence: {
				type: "array",
				items: { type: "string" },
				required: true,
				description: "Confirmed facts, exact errors, relevant snippets, and test results only."
			},
			attempts: {
				type: "array",
				items: { type: "string" },
				required: true,
				description: "Approaches already tried and their observed results."
			},
			constraints: {
				type: "array",
				items: { type: "string" },
				required: true,
				description: "Constraints that must not be violated."
			},
			question: {
				type: "string",
				required: true,
				description: "The specific decision or diagnosis requested from Sol."
			},
			prior_advice_evaluation: {
				type: "string",
				description: "Required when consulting the same unresolved issue a second time: how the first-stage advice was evaluated and why the issue remains."
			},
			medium_advice_evaluation: {
				type: "string",
				description: "Deprecated compatibility alias for prior_advice_evaluation."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					status: {
						type: "string",
						required: true,
						enum: [
							"advised",
							"unavailable",
							"evaluation-required",
							"escalation-exhausted"
						]
					},
					fingerprint: {
						type: "string",
						required: true
					},
					effort: {
						type: "string",
						enum: ["medium", "high"]
					},
					advisory: { type: "string" },
					message: { type: "string" }
				}
			},
			render: (_args, value) => content(value)
		},
		async execute(args, exec) {
			if (exec.agent === void 0) throw new Error("sol_consult requires an owning Luna agent");
			return router.consult(exec.agent, args, exec.signal);
		},
		presentCall: () => ({
			card: "generic",
			title: "Consult Sol reasoning advisor",
			kind: "execute"
		}),
		presentResult: (_args, result) => ({
			card: "generic",
			title: "Sol advisory returned to Luna",
			content: result.content
		})
	});
}
//#endregion
//#region src/team.ts
function inheritedRoute(agent) {
	const logged = agent.session.requestHeader()?.config;
	const provider = agent.options.provider ?? logged?.provider;
	const model = agent.options.model ?? logged?.model;
	return {
		...provider === void 0 ? {} : { provider },
		...model === void 0 ? {} : { model }
	};
}
function resolveRoleRoute(agent, role) {
	const inherited = inheritedRoute(agent);
	const provider = role.provider ?? inherited.provider;
	const model = role.model ?? inherited.model;
	if (provider === void 0 || model === void 0) throw new Error(`${PACKAGE_NAME}: role "${role.id}" inherits its route, but the calling agent has no provider/model`);
	return {
		provider,
		model,
		...role.reasoningEffort === void 0 ? {} : { reasoningEffort: role.reasoningEffort }
	};
}
async function validateRoleRoute(ctx, route) {
	if (!(await ctx.llm.listModels(route.provider)).some((model) => model.id === route.model)) throw new Error(`${PACKAGE_NAME}: ${route.provider}/${route.model} is not in the user's live model catalog`);
	const info = await ctx.llm.resolveModelInfo(route.provider, route.model);
	if (route.reasoningEffort === void 0) return;
	const supported = info.reasoning?.efforts.map((effort) => String(effort.id)) ?? [];
	if (!supported.includes(route.reasoningEffort)) throw new Error(`${PACKAGE_NAME}: ${route.provider}/${route.model} does not offer reasoning effort "${route.reasoningEffort}"; available: ${supported.length === 0 ? "<provider default only>" : supported.join(", ")}`);
}
async function modelCatalog(ctx) {
	return await Promise.all(ctx.llm.listProviders().map(async (provider) => ({
		provider: provider.id,
		name: provider.name,
		models: await Promise.all((await ctx.llm.listModels(provider.id)).map(async (model) => {
			const info = await ctx.llm.resolveModelInfo(provider.id, model.id);
			return {
				id: model.id,
				name: model.name,
				reasoningEfforts: info.reasoning?.efforts.map((effort) => String(effort.id)) ?? [],
				...info.reasoning?.defaultEffort === void 0 ? {} : { defaultReasoningEffort: String(info.reasoning.defaultEffort) }
			};
		}))
	})));
}
function roleSystemPrompt(role) {
	if (role.systemPrompt !== void 0) return role.systemPrompt;
	return role.kind === "advisory" ? `You are the ${role.id} reasoning role in a configurable agent-role system. You have no tools. Reason only over the supplied task and evidence. Return concise, actionable advice to the calling agent; do not pretend you inspected the workspace.` : `You are the ${role.id} worker in a configurable agent-role system. Complete the delegated task within the supplied scope, verify your work, and return a concise evidence-backed report to the parent agent.`;
}
function stringStopReason(value) {
	return typeof value === "string" ? value : value.kind ?? String(value);
}
const TRACE_TEXT_LIMIT = 4e3;
let nextTraceRunId = 0;
function traceText(value) {
	if (value.length <= TRACE_TEXT_LIMIT) return value;
	return value.slice(0, TRACE_TEXT_LIMIT) + "\n… [truncated]";
}
function outputText(blocks) {
	return blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
}
function appendRoleRunStarted(agent, event) {
	try {
		agent.session.append("agent-role/run-started", event);
	} catch {}
}
function appendRoleRunFinished(agent, event) {
	try {
		agent.session.append("agent-role/run-finished", event);
	} catch {}
}
var AgentTeam = class {
	ctx;
	roles;
	triggerRules;
	turnStates = /* @__PURE__ */ new WeakMap();
	constructor(ctx, roles, triggerRules) {
		this.ctx = ctx;
		this.roles = roles;
		this.triggerRules = triggerRules;
	}
	beginTurn(agent) {
		this.turnStates.set(agent, {
			depthCalls: 0,
			coordinatorCalls: 0,
			activeWorkers: 0,
			lastRunByRole: /* @__PURE__ */ new Map()
		});
	}
	state(agent) {
		let state = this.turnStates.get(agent);
		if (state === void 0) {
			state = {
				depthCalls: 0,
				coordinatorCalls: 0,
				activeWorkers: 0,
				lastRunByRole: /* @__PURE__ */ new Map()
			};
			this.turnStates.set(agent, state);
		}
		return state;
	}
	reserve(agent, role, meta) {
		const rules = this.triggerRules;
		if (rules === void 0) return () => void 0;
		const state = this.state(agent);
		if (role.id === rules.depthRoleId) {
			if (state.depthCalls >= rules.maxDepthCallsPerTurn) throw new Error("dsh-codex-reasoning-router: deep reasoning role limit reached for this turn");
			if (state.depthCalls > 0 && rules.requirePriorAdviceEvaluation && (meta.priorAdviceEvaluation ?? "").trim() === "") throw new Error("dsh-codex-reasoning-router: prior_advice_evaluation is required before repeating the deep reasoning role");
			state.depthCalls += 1;
		}
		if (role.id === rules.coordinatorRoleId) {
			if (state.coordinatorCalls >= rules.maxCoordinatorCallsPerTurn) throw new Error("dsh-codex-reasoning-router: coordinator role limit reached for this turn");
			state.coordinatorCalls += 1;
		}
		if (role.id !== rules.workerRoleId) return () => void 0;
		if (state.activeWorkers >= rules.maxConcurrentWorkers) throw new Error("dsh-codex-reasoning-router: concurrent worker role limit reached");
		state.activeWorkers += 1;
		return () => {
			state.activeWorkers -= 1;
		};
	}
	role(id) {
		const role = this.roles.find((candidate) => candidate.id === id);
		if (role === void 0) throw new Error(`${PACKAGE_NAME}: unknown role "${id}"`);
		return role;
	}
	installChildSelection(agent) {
		const effort = agent.options.reasoningRouterEffort;
		if (agent.options.reasoningRouterRole === void 0 || effort === void 0) return;
		const provider = agent.options.provider;
		const model = agent.options.model;
		if (provider === void 0 || model === void 0) return;
		installModelSelection(agent.ctx, {
			current: {
				provider,
				model,
				reasoningEffort: ReasoningEffortId(effort)
			},
			assembled: void 0
		});
	}
	async run(agent, roleId, task, signal, meta = {}) {
		const role = this.role(roleId);
		const release = this.reserve(agent, role, meta);
		const route = (() => {
			try {
				return resolveRoleRoute(agent, role);
			} catch (error) {
				release();
				throw error;
			}
		})();
		const state = this.state(agent);
		const runId = `${String(agent.id)}:role:${Date.now().toString(36)}:${nextTraceRunId++}`;
		const references = [...new Set(meta.references === void 0 ? meta.priorAdviceEvaluation?.trim() === "" || meta.priorAdviceEvaluation === void 0 ? [] : [state.lastRunByRole.get(role.id)].filter((value) => value !== void 0) : meta.references.filter((reference) => reference.trim() !== ""))];
		state.lastRunByRole.set(role.id, runId);
		const startedAt = Date.now();
		appendRoleRunStarted(agent, {
			version: 1,
			runId,
			role: role.id,
			kind: role.kind,
			provider: route.provider,
			model: route.model,
			...route.reasoningEffort === void 0 ? {} : { reasoningEffort: route.reasoningEffort },
			triggerReason: meta.triggerReason ?? "custom-rule",
			parentRunId: agent.options.reasoningRouterParentRunId ?? null,
			childSessionId: null,
			references,
			task: traceText(task)
		});
		try {
			await validateRoleRoute(this.ctx, route);
			const result = await (role.kind === "advisory" ? this.runAdvisory(agent, role, route, task, signal, meta.maxTokensCap) : this.runSubagent(agent, role, route, task, signal, runId));
			const completed = {
				runId,
				...result,
				...this.triggerRules?.showTriggerReason === false ? {} : { triggerReason: meta.triggerReason ?? "custom-rule" }
			};
			const text = outputText(result.output);
			appendRoleRunFinished(agent, {
				version: 1,
				runId,
				status: "succeeded",
				durationMs: Math.max(0, Date.now() - startedAt),
				...result.childSessionId === void 0 ? {} : { childSessionId: result.childSessionId },
				...text === "" ? {} : { output: traceText(text) },
				...result.stopReason === void 0 ? {} : { stopReason: result.stopReason }
			});
			return completed;
		} catch (error) {
			appendRoleRunFinished(agent, {
				version: 1,
				runId,
				status: "failed",
				durationMs: Math.max(0, Date.now() - startedAt),
				error: traceText(safeError(error))
			});
			throw error;
		} finally {
			release();
		}
	}
	async runAdvisory(agent, role, route, task, signal, maxTokensCap) {
		const assembler = new BlockAssembler();
		const options = {
			provider: route.provider,
			model: route.model,
			usageSessionId: String(agent.id),
			usagePurpose: `agent-team:${role.id}`,
			...route.reasoningEffort === void 0 ? {} : { reasoningEffort: ReasoningEffortId(route.reasoningEffort) },
			system: roleSystemPrompt(role),
			messages: [createUserMessage({
				source: {
					kind: "plugin",
					plugin: PACKAGE_NAME
				},
				content: [{
					type: "text",
					text: task
				}]
			})],
			...role.maxTokens === void 0 && maxTokensCap === void 0 ? {} : { maxTokens: Math.min(role.maxTokens ?? Number.MAX_SAFE_INTEGER, maxTokensCap ?? Number.MAX_SAFE_INTEGER) },
			signal
		};
		for await (const chunk of this.ctx.llm.stream(options)) assembler.push(chunk);
		const blocks = assembler.blocks();
		if (blocks.some((block) => block.type === "tool-call")) throw new Error(`${PACKAGE_NAME}: advisory role "${role.id}" returned a tool call; it was not executed`);
		const output = blocks;
		if (output.length === 0) throw new Error(`${PACKAGE_NAME}: advisory role "${role.id}" returned no output`);
		return {
			role: role.id,
			kind: role.kind,
			...route,
			output
		};
	}
	async runSubagent(parent, role, route, task, signal, parentRunId) {
		const runtime = this.ctx.subagents ?? this.ctx.get("subagents");
		if (runtime === void 0) throw new Error(`${PACKAGE_NAME}: subagent runtime is unavailable for role "${role.id}"`);
		const toolFilter = role.toolAllow === void 0 && role.toolDeny === void 0 ? void 0 : {
			...role.toolAllow === void 0 ? {} : { allow: role.toolAllow },
			...role.toolDeny === void 0 ? {} : { deny: role.toolDeny }
		};
		const run = await runtime.start(role.subagentProvider ?? "spawn", {
			label: role.id,
			prompt: [{
				type: "text",
				text: task
			}],
			parent,
			signal,
			agentOptions: {
				provider: route.provider,
				model: route.model,
				...role.maxTokens === void 0 ? {} : { maxTokens: role.maxTokens },
				reasoningRouterRole: role.id,
				reasoningRouterParentRunId: parentRunId,
				...route.reasoningEffort === void 0 ? {} : { reasoningRouterEffort: route.reasoningEffort }
			},
			...role.maxDepth === void 0 ? {} : { maxDepth: role.maxDepth },
			persona: roleSystemPrompt(role),
			...toolFilter === void 0 ? {} : { toolFilter }
		});
		let result;
		try {
			result = await run.result;
		} catch (error) {
			throw new Error(`${PACKAGE_NAME}: role "${role.id}" failed: ${safeError(error)}`);
		} finally {
			await run.dispose();
		}
		return {
			role: role.id,
			kind: role.kind,
			...route,
			childSessionId: String(run.id),
			output: result.output,
			stopReason: stringStopReason(result.stopReason),
			...result.diagnostic === void 0 ? {} : { diagnostic: result.diagnostic }
		};
	}
};
//#endregion
//#region src/team-tool.ts
function rendered(result) {
	const body = result.output.filter((block) => block.type === "text").map((block) => block.text).join("");
	return [
		`run_id: ${result.runId}`,
		`role: ${result.role}`,
		`kind: ${result.kind}`,
		`route: ${result.provider}/${result.model}`,
		`reasoning_effort: ${result.reasoningEffort ?? "<provider default>"}`,
		...result.triggerReason === void 0 ? [] : ["trigger_reason: " + result.triggerReason],
		...result.stopReason === void 0 ? [] : [`stop_reason: ${result.stopReason}`],
		...result.diagnostic === void 0 ? [] : [`diagnostic: ${result.diagnostic}`],
		"",
		body
	].join("\n");
}
function agentTeamRunTool(team) {
	return defineTool({
		name: "agent_role_run",
		description: "Run one configured agent role. Advisory roles are tool-less reasoning calls; subagent roles are real delegated agents with their configured model, tools, persona, and absolute depth cap.",
		parameters: {
			role: {
				type: "string",
				required: true,
				enum: team.roles.map((role) => role.id),
				description: "Configured role id."
			},
			task: {
				type: "string",
				required: true,
				description: "Self-contained task, evidence, constraints, and expected output for the role."
			},
			trigger_reason: {
				type: "string",
				required: true,
				enum: [
					"explicit-user-request",
					"first-turn-policy",
					"task-breadth",
					"high-risk",
					"repeated-failure",
					"conflicting-evidence",
					"architecture-decision",
					"delegated-execution",
					"custom-rule"
				],
				description: "Why the configured trigger policy requires this role."
			},
			prior_advice_evaluation: {
				type: "string",
				description: "Required when repeating the configured deep reasoning role in the same turn."
			},
			references: {
				type: "array",
				items: { type: "string" },
				description: "Optional prior role-run ids this task explicitly cites."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => [{
				type: "text",
				text: rendered(value)
			}]
		},
		isConcurrencySafe: () => true,
		async execute(args, exec) {
			if (exec.agent === void 0) throw new Error("agent_role_run requires an owning agent");
			return await team.run(exec.agent, args.role, args.task, exec.signal, {
				triggerReason: args.trigger_reason,
				...args.prior_advice_evaluation === void 0 ? {} : { priorAdviceEvaluation: args.prior_advice_evaluation },
				...args.references === void 0 ? {} : { references: args.references }
			});
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Run agent role: ${String(args.role)}`,
			kind: "execute"
		}),
		presentResult: (_args, result) => ({
			card: "generic",
			title: "Agent role completed",
			content: result.content
		})
	});
}
function agentTeamCatalogTool(load) {
	return defineTool({
		name: "agent_role_catalog",
		description: "List the providers, models, and reasoning efforts currently available in this user's live DSH model catalog. Use this before recommending role configuration changes.",
		parameters: {},
		output: {
			schema: {
				type: "array",
				items: { type: "json" }
			},
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify(value, null, 2)
			}]
		},
		async execute() {
			return load();
		},
		presentCall: () => ({
			card: "generic",
			title: "Read available agent models",
			kind: "read"
		}),
		presentResult: (_args, result) => ({
			card: "generic",
			title: "Available agent models",
			content: result.content
		})
	});
}
//#endregion
//#region src/index.ts
const name = "codex-reasoning-router";
const inject = [
	"llm",
	"tools",
	"systemPrompt",
	"agents",
	"subagents"
];
const TEAM_SETTINGS_NAMESPACE = "codex-reasoning-router";
const DEFAULT_TEAM_ROLES = [
	{
		id: "brain",
		kind: "advisory",
		description: "Deep tool-less reasoning and architecture advice.",
		provider: "openai-codex",
		model: "gpt-5.6-sol",
		reasoningEffort: "max",
		maxTokens: 3e3
	},
	{
		id: "coordinator",
		kind: "advisory",
		description: "Decomposition, assignment, integration, and risk control.",
		provider: "openai-codex",
		model: "gpt-5.6-sol",
		reasoningEffort: "high",
		maxTokens: 2200
	},
	{
		id: "worker",
		kind: "subagent",
		description: "Tool-capable implementation and verification worker.",
		provider: "openai-codex",
		model: "gpt-5.6-luna",
		reasoningEffort: "max",
		maxDepth: 2,
		subagentProvider: "spawn"
	}
];
const roleSchema = z.object({
	id: z.string().required(),
	kind: z.union(["advisory", "subagent"]).required(),
	description: z.string().required(),
	provider: z.string(),
	model: z.string(),
	reasoningEffort: z.string(),
	maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER),
	systemPrompt: z.string(),
	subagentProvider: z.string(),
	maxDepth: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER),
	toolAllow: z.array(z.string()).default(void 0),
	toolDeny: z.array(z.string()).default(void 0)
});
const triggerRulesSchema = z.object({
	mode: z.union([
		"manual",
		"rules",
		"first-turn"
	]).default("rules"),
	depthRoleId: z.string().default("brain"),
	coordinatorRoleId: z.string().default("coordinator"),
	workerRoleId: z.string().default("worker"),
	firstTurnRoleId: z.string().default("coordinator"),
	coordinatorMinDeliverables: z.number().step(1).min(1).max(20).default(3),
	coordinatorMinSubsystems: z.number().step(1).min(1).max(20).default(2),
	repeatedFailureThreshold: z.number().step(1).min(1).max(10).default(2),
	triggerOnHighRisk: z.boolean().default(true),
	triggerOnConflictingEvidence: z.boolean().default(true),
	triggerOnArchitectureDecision: z.boolean().default(true),
	maxDepthCallsPerTurn: z.number().step(1).min(1).max(10).default(1),
	maxCoordinatorCallsPerTurn: z.number().step(1).min(1).max(10).default(1),
	maxConcurrentWorkers: z.number().step(1).min(1).max(10).default(3),
	requirePriorAdviceEvaluation: z.boolean().default(true),
	showTriggerReason: z.boolean().default(true),
	firstTurnFailOpen: z.boolean().default(true),
	customInstructions: z.string().default("")
}).default(DEFAULT_TRIGGER_RULES);
const TeamSettings = z.object({
	teamEnabled: z.boolean().default(true),
	presetIds: z.array(z.string()).default([]),
	roles: z.array(roleSchema).default(DEFAULT_TEAM_ROLES),
	triggerRules: triggerRulesSchema
});
const Config = z.object({
	teamEnabled: z.boolean().default(true),
	presetIds: z.array(z.string()).default([]),
	roles: z.array(roleSchema).default(DEFAULT_TEAM_ROLES),
	requiredPresetId: z.string().default(""),
	triggerRules: triggerRulesSchema,
	lunaProvider: z.string().default("openai-codex"),
	lunaModel: z.string().default("gpt-5.6-luna"),
	solProvider: z.string().default("openai-codex"),
	solModel: z.string().default("gpt-5.6-sol"),
	initialSolReasoning: z.union(["medium", "high"]).default("medium"),
	escalatedSolReasoning: z.union(["medium", "high"]).default("high"),
	solAdviceMaxTokens: z.number().step(1).min(256).max(4096).default(2e3),
	solTimeoutMs: z.number().step(1).min(1e3).max(12e4).default(3e4),
	initialConsultEnabled: z.boolean().default(true),
	failOpen: z.boolean().default(true)
});
function validateTeamSettings(config) {
	const triggerRules = migrateLegacyTriggerRules(config.triggerRules, config.roles);
	const roleIds = /* @__PURE__ */ new Set();
	if (config.teamEnabled && config.roles.length === 0) throw new Error("dsh-codex-reasoning-router: teamEnabled requires at least one role");
	for (const role of config.roles) {
		if (!/^[a-z][a-z0-9_-]*$/u.test(role.id)) throw new Error("dsh-codex-reasoning-router: invalid role id " + role.id);
		if (roleIds.has(role.id)) throw new Error("dsh-codex-reasoning-router: duplicate role id " + role.id);
		roleIds.add(role.id);
		if (role.kind === "subagent" && role.maxDepth !== void 0 && !Number.isSafeInteger(role.maxDepth)) throw new Error("dsh-codex-reasoning-router: role " + role.id + " maxDepth must be a non-negative safe integer");
		const builtinMax = builtinMaxOutputTokens(role.provider, role.model);
		if (role.maxTokens !== void 0 && builtinMax !== void 0 && role.maxTokens > builtinMax) throw new Error("dsh-codex-reasoning-router: role " + role.id + " maxTokens " + role.maxTokens + " exceeds the built-in maximum output " + builtinMax + " for " + role.provider + "/" + role.model);
	}
	if (config.teamEnabled) validateTriggerRules(triggerRules, config.roles);
}
async function validateModels(ctx, config) {
	const routes = /* @__PURE__ */ new Map([[config.lunaProvider, [config.lunaModel]], [config.solProvider, [config.solModel]]]);
	if (config.lunaProvider === config.solProvider) routes.set(config.lunaProvider, [.../* @__PURE__ */ new Set([config.lunaModel, config.solModel])]);
	for (const [provider, expected] of routes) {
		const models = await ctx.llm.listModels(provider);
		const found = new Set(models.map((model) => model.id));
		for (const model of expected) {
			if (!found.has(model)) throw new Error(`${PACKAGE_NAME}: configured model ${provider}/${model} is absent from the provider catalog; no fallback was selected`);
			await ctx.llm.resolveModelInfo(provider, model);
		}
	}
}
/** Defense in depth: accidental global installation must not affect other presets. */
function resolveSessionPreset(session) {
	return session.snapshotEvents().reduce((state, event) => agentPresetProjectionDefinition.apply(state, event), agentPresetProjectionDefinition.init(session.header));
}
function isRouterPresetAgent(agent, roots, requiredPresetId) {
	if (requiredPresetId === "") return false;
	return roots.includes(agent) && resolveSessionPreset(agent.session) === requiredPresetId;
}
function apply(ctx, config) {
	installRouterEvents();
	const advisor = new SolAdvisor(ctx, config);
	const installed = /* @__PURE__ */ new Map();
	const baseTeam = {
		teamEnabled: config.teamEnabled,
		presetIds: config.presetIds,
		roles: config.roles,
		triggerRules: config.triggerRules
	};
	validateTeamSettings(baseTeam);
	let teamSource = () => baseTeam;
	const initialRules = migrateLegacyTriggerRules(baseTeam.triggerRules, baseTeam.roles);
	let team = new AgentTeam(ctx, baseTeam.roles, initialRules);
	const teamInstalled = /* @__PURE__ */ new Map();
	let modelValidation;
	const validateRouterModels = () => {
		return modelValidation ??= validateModels(ctx, config);
	};
	const attach = (agent) => {
		if (installed.has(agent) || !isRouterPresetAgent(agent, ctx.agents.roots(), config.requiredPresetId)) return;
		const router = new ReasoningRouter(config, advisor);
		const disposePrompt = agent.ctx.systemPrompt.section({
			name: "reasoning-router:luna-executor",
			order: 40,
			text: LUNA_ROUTER_INSTRUCTION
		});
		const disposeTool = agent.ctx.tools.register(solConsultTool(router));
		installed.set(agent, {
			router,
			disposeTool,
			disposePrompt
		});
	};
	const detach = (agent) => {
		const installation = installed.get(agent);
		if (installation === void 0) return;
		installed.delete(agent);
		installation.disposeTool();
		installation.disposePrompt();
	};
	const teamMatches = (agent) => {
		const active = teamSource();
		if (!active.teamEnabled) return false;
		if (active.presetIds.length === 0) return true;
		const preset = resolveSessionPreset(agent.session);
		return preset !== null && active.presetIds.includes(preset);
	};
	const attachTeam = (agent) => {
		team.installChildSelection(agent);
		if (teamInstalled.has(agent) || !teamMatches(agent)) return;
		const active = teamSource();
		const effectiveRules = migrateLegacyTriggerRules(active.triggerRules, active.roles);
		const disposers = [
			agent.ctx.tools.register(agentTeamRunTool(team)),
			agent.ctx.tools.register(agentTeamCatalogTool(() => modelCatalog(ctx))),
			agent.ctx.systemPrompt.section({
				name: "reasoning-router:agent-team",
				order: 41,
				text: roleTriggerPrompt(effectiveRules) + "\nUse agent_role_catalog before proposing model or reasoning-effort changes. Role outputs are delegated evidence, not authority; validate material claims before final delivery."
			})
		];
		teamInstalled.set(agent, disposers);
	};
	const detachTeam = (agent) => {
		const disposers = teamInstalled.get(agent);
		if (disposers === void 0) return;
		teamInstalled.delete(agent);
		for (const dispose of disposers.reverse()) dispose();
	};
	const reconfigureTeam = () => {
		const active = teamSource();
		validateTeamSettings(active);
		const effectiveRules = migrateLegacyTriggerRules(active.triggerRules, active.roles);
		const candidates = /* @__PURE__ */ new Set([...teamInstalled.keys(), ...ctx.agents.roots()]);
		for (const agent of candidates) detachTeam(agent);
		team = new AgentTeam(ctx, active.roles, effectiveRules);
		for (const agent of candidates) attachTeam(agent);
	};
	if (typeof ctx.inject === "function") ctx.inject(["settings"], (settingsCtx) => settingsCtx.settings.installSection(ctx, TEAM_SETTINGS_NAMESPACE, TeamSettings, baseTeam, {
		validate: validateTeamSettings,
		setSource: (source) => {
			teamSource = source;
		},
		onChange: reconfigureTeam
	}));
	/** Reconcile the installation after a blank session changes its preset. */
	const syncAgent = (agent) => {
		if (!isRouterPresetAgent(agent, ctx.agents.roots(), config.requiredPresetId)) {
			detach(agent);
			return;
		}
		attach(agent);
		return installed.get(agent);
	};
	ctx.on("agent/created", ({ agent }) => {
		syncAgent(agent);
		attachTeam(agent);
	});
	ctx.on("agent/disposed", ({ agent }) => {
		detach(agent);
		detachTeam(agent);
	});
	ctx.on("session/event", (session, event) => {
		const agent = ctx.agents.roots().find((candidate) => candidate.id === session.id);
		if (agent === void 0) return;
		if (event.type === "turn/start") team.beginTurn(agent);
		if (event.type === "agent-preset/selected") {
			syncAgent(agent);
			detachTeam(agent);
			attachTeam(agent);
		}
	});
	ctx.on("agent/pre-step", async (payload, next) => {
		const installation = syncAgent(payload.agent);
		const decision = await next();
		if (decision.kind === "reject") return decision;
		let messages = decision.messages;
		if (teamMatches(payload.agent)) {
			const active = teamSource();
			const effectiveRules = migrateLegacyTriggerRules(active.triggerRules, active.roles);
			messages = await beforeInitialRoleRun(payload.agent, messages, team, effectiveRules, payload.signal);
		}
		if (installation !== void 0) {
			await validateRouterModels();
			messages = await installation.router.beforeFirstStep(payload.agent, messages, payload.signal);
		}
		return {
			kind: "enter",
			messages
		};
	});
	ctx.on("agent/request", async (payload, next) => {
		const installation = syncAgent(payload.agent);
		const request = await next();
		if (installation === void 0) return request;
		if (request.provider !== config.lunaProvider || request.model !== config.lunaModel) throw new Error(`${PACKAGE_NAME}: root agent request route must remain ${config.lunaProvider}/${config.lunaModel}; observed ${request.provider}/${request.model}. The router did not rewrite it and blocked dispatch.`);
		return request;
	});
	ctx.on("llm/stream", (options, next) => {
		if (advisorScope.getStore()?.purpose === "sol-advisory") return next();
		if (isAgentLoopRequest(options) && options.sessionId !== void 0) {
			const root = ctx.agents.roots().find((agent) => agent.id === options.sessionId);
			if ((root === void 0 ? void 0 : syncAgent(root)) !== void 0 && (options.provider !== config.lunaProvider || options.model !== config.lunaModel)) throw new Error("dsh-codex-reasoning-router: root LLM stream must remain " + config.lunaProvider + "/" + config.lunaModel + "; observed " + options.provider + "/" + options.model + ". Dispatch was blocked without rewriting the request.");
		}
		return next();
	});
	for (const agent of ctx.agents.roots()) {
		attach(agent);
		attachTeam(agent);
	}
	ctx.effect(() => () => {
		for (const agent of [...installed.keys()]) detach(agent);
		for (const agent of [...teamInstalled.keys()]) detachTeam(agent);
	}, `${PACKAGE_NAME}: root agent integrations`);
}
//#endregion
export { AgentTeam, Config, DEFAULT_TEAM_ROLES, DEFAULT_TRIGGER_RULES, INITIAL_ADVISORY_FORMAT, LUNA_ROUTER_INSTRUCTION, PACKAGE_NAME, ROUTER_EVENT_TYPES, ReasoningRouter, SOL_ADVISOR_SYSTEM_PROMPT, SOL_CONSULT_TOOL, SolAdvisor, SolProtocolError, TEAM_SETTINGS_NAMESPACE, TeamSettings, advisorScope, agentTeamCatalogTool, agentTeamRunTool, apply, beforeInitialRoleRun, blockerPrompt, builtinMaxOutputTokens, hasExhaustedRecord, hasInitialConsultRecord, initialPrompt, inject, installRouterEvents, isRouterPresetAgent, issueFingerprint, migrateLegacyTriggerRules, modelCatalog, name, resolveRoleRoute, restoreIssueStates, roleTriggerPrompt, safeError, solConsultTool, validateRoleRoute, validateTeamSettings, validateTriggerRules };
