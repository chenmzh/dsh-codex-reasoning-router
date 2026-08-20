import { resolveSessionPreset } from "@deepseek-ai/dsh-agent-presets";
import { BlockAssembler, ReasoningEffortId, createUserMessage, isAgentLoopRequest } from "@deepseek-ai/dsh-llm";
import z from "@deepseek-ai/schemastery";
import { AsyncLocalStorage } from "node:async_hooks";
import { KNOWN_SESSION_EVENT_TYPES } from "@deepseek-ai/dsh-session";
import { createHash } from "node:crypto";
import { defineTool } from "@deepseek-ai/dsh-tools";
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
			const stream = this.ctx.llm.stream({
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
				signal
			});
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
	return session.header.seedLength ?? 0;
}
/** Fold plugin-owned durable events. Process-local maps are never authoritative. */
function restoreIssueStates(session) {
	const states = /* @__PURE__ */ new Map();
	const start = localStart(session);
	for (const event of session.events) {
		if (event.seq < start) continue;
		if (event.type !== "reasoning-router/consult-medium" && event.type !== "reasoning-router/consult-high") continue;
		states.set(event.data.fingerprint, { ...event.data.state });
	}
	return states;
}
function hasInitialConsultRecord(session) {
	const start = localStart(session);
	return session.events.some((event) => event.seq >= start && event.type === "reasoning-router/initial-consult");
}
function hasExhaustedRecord(session, fingerprint) {
	const start = localStart(session);
	return session.events.some((event) => event.seq >= start && event.type === "reasoning-router/escalation-exhausted" && event.data.fingerprint === fingerprint);
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
				signal
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
				signal
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
//#region src/index.ts
const name = "codex-reasoning-router";
const inject = [
	"llm",
	"tools",
	"systemPrompt",
	"agents",
	"openAICodex"
];
const Config = z.object({
	requiredPresetId: z.string().default("luna-sol-reasoning-router"),
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
function isRouterPresetAgent(agent, roots, requiredPresetId) {
	return roots.includes(agent) && resolveSessionPreset(agent.session) === requiredPresetId;
}
function apply(ctx, config) {
	installRouterEvents();
	const advisor = new SolAdvisor(ctx, config);
	const installed = /* @__PURE__ */ new Map();
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
	});
	ctx.on("agent/disposed", ({ agent }) => {
		detach(agent);
	});
	ctx.on("session/event", (session, event) => {
		if (event.type !== "agent-preset/selected") return;
		const agent = ctx.agents.roots().find((candidate) => candidate.id === session.id);
		if (agent !== void 0) syncAgent(agent);
	});
	ctx.on("agent/pre-step", async (payload, next) => {
		const installation = syncAgent(payload.agent);
		if (installation === void 0) return next();
		const decision = await next();
		if (decision.kind === "reject") return decision;
		await validateRouterModels();
		return {
			kind: "enter",
			messages: await installation.router.beforeFirstStep(payload.agent, decision.messages, payload.signal)
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
	for (const agent of ctx.agents.roots()) attach(agent);
	ctx.effect(() => () => {
		for (const agent of [...installed.keys()]) detach(agent);
	}, `${PACKAGE_NAME}: root agent integrations`);
}
//#endregion
export { Config, INITIAL_ADVISORY_FORMAT, LUNA_ROUTER_INSTRUCTION, PACKAGE_NAME, ROUTER_EVENT_TYPES, ReasoningRouter, SOL_ADVISOR_SYSTEM_PROMPT, SOL_CONSULT_TOOL, SolAdvisor, SolProtocolError, advisorScope, apply, blockerPrompt, hasExhaustedRecord, hasInitialConsultRecord, initialPrompt, inject, installRouterEvents, isRouterPresetAgent, issueFingerprint, name, restoreIssueStates, safeError, solConsultTool };
