window.__ModuleLoader__.load({
	id: "dsh-codex-reasoning-router",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/agent-flow.tsx
		const AGENT_ROLE_CHAT_KIND = "agent-role/chat-run";
		const AGENT_FLOW_TARGET = "agent-flow";
		const AGENT_ROLE_RUN_KIND = "agent-role/run";
		const AGENT_ROLE_STARTED = "agent-role/run-started";
		const AGENT_ROLE_FINISHED = "agent-role/run-finished";
		const EMPTY_AGENT_FLOW_SNAPSHOT = { nodes: [] };
		function recordOf(value) {
			if (value === null || typeof value !== "object" || Array.isArray(value)) return void 0;
			return value;
		}
		function stringOf(value) {
			return typeof value === "string" && value !== "" ? value : void 0;
		}
		function nullableStringOf(value) {
			return typeof value === "string" && value !== "" ? value : null;
		}
		function stringArrayOf(value) {
			if (!Array.isArray(value)) return [];
			return value.filter((item) => typeof item === "string" && item !== "");
		}
		function eventType(event) {
			return String(event.type);
		}
		function runIdOf(event) {
			return stringOf(recordOf(event.data)?.runId);
		}
		function startPayload(value) {
			const data = recordOf(value);
			const runId = stringOf(data?.runId);
			const role = stringOf(data?.role);
			const kind = data?.kind === "advisory" || data?.kind === "subagent" ? data.kind : void 0;
			const provider = stringOf(data?.provider);
			const model = stringOf(data?.model);
			const triggerReason = stringOf(data?.triggerReason);
			const task = stringOf(data?.task);
			if (data?.version !== 1 || runId === void 0 || role === void 0 || kind === void 0 || provider === void 0 || model === void 0 || triggerReason === void 0 || task === void 0) return void 0;
			const reasoningEffort = stringOf(data?.reasoningEffort);
			return {
				runId,
				role,
				kind,
				provider,
				model,
				...reasoningEffort === void 0 ? {} : { reasoningEffort },
				triggerReason,
				parentRunId: nullableStringOf(data?.parentRunId),
				childSessionId: nullableStringOf(data?.childSessionId),
				references: stringArrayOf(data?.references),
				task
			};
		}
		function finishPayload(value) {
			const data = recordOf(value);
			const status = data?.status === "succeeded" || data?.status === "failed" ? data.status : void 0;
			const durationMs = typeof data?.durationMs === "number" && Number.isFinite(data.durationMs) ? data.durationMs : void 0;
			if (data?.version !== 1 || status === void 0 || durationMs === void 0) return void 0;
			const output = stringOf(data?.output);
			const stopReason = stringOf(data?.stopReason);
			const error = stringOf(data?.error);
			return {
				status,
				durationMs,
				...data?.childSessionId === void 0 ? {} : { childSessionId: nullableStringOf(data.childSessionId) },
				...output === void 0 ? {} : { output },
				...stopReason === void 0 ? {} : { stopReason },
				...error === void 0 ? {} : { error }
			};
		}
		function agentRoleRunDefinition() {
			return {
				kind: AGENT_ROLE_RUN_KIND,
				target: AGENT_FLOW_TARGET,
				match(event) {
					const type = eventType(event);
					if (type !== AGENT_ROLE_STARTED && type !== AGENT_ROLE_FINISHED) return null;
					const id = runIdOf(event);
					if (id === void 0) return null;
					return {
						id,
						role: type === AGENT_ROLE_STARTED ? "start" : "update"
					};
				},
				start(_context, match, _reader) {
					const payload = startPayload(match.event.data);
					if (payload === void 0) throw new Error("agent-flow: matched start event has an invalid payload");
					return {
						...payload,
						startSeq: match.event.seq,
						startedAt: match.event.time,
						status: "running"
					};
				},
				update(context, match) {
					const payload = finishPayload(match.event.data);
					if (payload === void 0) return context.state;
					return {
						...context.state,
						...payload,
						...payload.childSessionId === void 0 ? {} : { childSessionId: payload.childSessionId },
						completedAt: match.event.time
					};
				},
				publication: () => "immediate",
				buildViewNode(context) {
					const data = context.state;
					if (data === void 0) return null;
					return {
						key: context.key,
						kind: AGENT_ROLE_RUN_KIND,
						id: data.runId,
						target: AGENT_FLOW_TARGET,
						data
					};
				}
			};
		}
		function agentRoleChatDefinition() {
			return {
				kind: AGENT_ROLE_CHAT_KIND,
				target: "chat",
				match(event) {
					const type = eventType(event);
					if (type !== AGENT_ROLE_STARTED && type !== AGENT_ROLE_FINISHED) return null;
					const id = runIdOf(event);
					if (id === void 0) return null;
					return {
						id,
						role: type === AGENT_ROLE_STARTED ? "start" : "update"
					};
				},
				start(_context, match) {
					const payload = startPayload(match.event.data);
					if (payload === void 0) throw new Error("agent-role chat: invalid start event");
					return {
						...payload,
						startSeq: match.event.seq,
						startedAt: match.event.time,
						status: "running"
					};
				},
				update(context, match) {
					const payload = finishPayload(match.event.data);
					if (payload === void 0) return context.state;
					return {
						...context.state,
						...payload,
						...payload.childSessionId === void 0 ? {} : { childSessionId: payload.childSessionId },
						completedAt: match.event.time
					};
				},
				publication: () => "immediate",
				buildViewNode(context) {
					const data = context.state;
					if (data === void 0 || context.start === void 0) return null;
					return {
						key: context.key,
						kind: AGENT_ROLE_CHAT_KIND,
						id: data.runId,
						target: "chat",
						anchorSeq: context.start.event.seq,
						location: context.start.location,
						visibility: "visible",
						data
					};
				}
			};
		}
		var AgentFlowSnapshotBuilder = class {
			empty = EMPTY_AGENT_FLOW_SNAPSHOT;
			nodes = /* @__PURE__ */ new Map();
			replace(input) {
				this.nodes.clear();
				for (const node of input.nodes) this.nodes.set(node.key, node);
				return this.snapshot();
			}
			apply(input) {
				for (const node of input.upserts) this.nodes.set(node.key, node);
				return this.snapshot();
			}
			snapshot() {
				return { nodes: [...this.nodes.values()].sort((left, right) => left.data.startSeq - right.data.startSeq) };
			}
		};
		const agentFlowViewDefinition = {
			target: AGENT_FLOW_TARGET,
			create: () => new AgentFlowSnapshotBuilder()
		};
		function shortId(value) {
			if (value === null || value === void 0 || value === "") return "—";
			return value.length <= 18 ? value : "…" + value.slice(-17);
		}
		function timeOf(value) {
			try {
				return new Date(value).toLocaleTimeString([], {
					hour: "2-digit",
					minute: "2-digit",
					second: "2-digit"
				});
			} catch {
				return String(value);
			}
		}
		function statusLabel(status) {
			if (status === "running") return "运行中";
			if (status === "failed") return "失败";
			return "完成";
		}
		function kindLabel(kind) {
			return kind === "subagent" ? "子 Agent" : "顾问 Agent";
		}
		const STYLE$1 = `.agentFlow{box-sizing:border-box;height:100%;overflow:auto;padding:24px 28px 48px;color:var(--dsw-alias-label-primary);font-size:13px}.agentFlow *{box-sizing:border-box}.agentFlowHeader{display:flex;justify-content:space-between;gap:18px;align-items:flex-start;margin-bottom:18px}.agentFlowHeader h2{margin:0 0 6px;font-size:20px}.agentFlowHeader p{margin:0;color:var(--dsw-alias-label-secondary);line-height:20px}.agentFlowCount{border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:5px 10px;color:var(--dsw-alias-label-secondary);white-space:nowrap}.agentFlowEmpty{border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;padding:28px;color:var(--dsw-alias-label-secondary);text-align:center}.agentFlowList{display:flex;flex-direction:column;gap:10px}.agentFlowCard{border:1px solid var(--dsw-alias-border-l2);border-left:3px solid var(--dsw-alias-state-business-primary);border-radius:9px;background:var(--dsw-alias-bg-layer-1);padding:12px 14px;box-shadow:0 1px 2px rgba(0,0,0,.05)}.agentFlowCard[data-status=failed]{border-left-color:var(--dsw-alias-state-danger-primary)}.agentFlowCard[data-status=running]{border-left-color:var(--dsw-alias-state-warning-primary)}.agentFlowTop{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.agentFlowRole{font-weight:700;font-size:14px}.agentFlowBadge{border-radius:999px;padding:2px 7px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px}.agentFlowStatus{margin-left:auto}.agentFlowMeta{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:8px;color:var(--dsw-alias-label-secondary);font-size:11px}.agentFlowRelation{margin-top:8px;padding:7px 9px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);line-height:18px}.agentFlowRelation strong{color:var(--dsw-alias-label-primary);font-weight:600}.agentFlowConversation{display:grid;gap:8px;margin-top:10px}.agentFlowMessage{border-radius:7px;padding:9px 10px;line-height:19px;white-space:pre-wrap;overflow-wrap:anywhere}.agentFlowMessageUser{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent)}.agentFlowMessageAgent{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent)}.agentFlowMessageError{background:color-mix(in srgb,var(--dsw-alias-state-danger-primary) 10%,transparent)}.agentFlowMessageLabel{display:block;margin-bottom:3px;color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:650}.agentFlowDetails{margin-top:10px}.agentFlowDetails summary{cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:12px}.agentFlowFooter{margin-top:10px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:17px}.agentFlowFooter code{font-family:var(--dsw-alias-font-mono,monospace)}`;
		function depthOf(run, byId) {
			let depth = 0;
			let parent = run.parentRunId;
			const seen = /* @__PURE__ */ new Set();
			while (parent !== null && !seen.has(parent) && depth < 8) {
				seen.add(parent);
				const owner = byId.get(parent);
				if (owner === void 0) break;
				depth += 1;
				parent = owner.parentRunId;
			}
			return depth;
		}
		function AgentFlowView({ useSession }) {
			const snapshot = useSession((session) => session.views.get("agent-flow")) ?? EMPTY_AGENT_FLOW_SNAPSHOT;
			const runs = (0, react.useMemo)(() => snapshot.nodes.map((node) => node.data), [snapshot]);
			const byId = (0, react.useMemo)(() => new Map(runs.map((run) => [run.runId, run])), [runs]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "agentFlow",
				"data-testid": "agent-flow-view",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("style", { children: STYLE$1 }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
						className: "agentFlowHeader",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", { children: "Agent 激活关系" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: "查看本对话中何时调用了 Agent、谁激活了谁，以及任务与返回结果。" })] }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "agentFlowCount",
							children: [runs.length, " 次调用"]
						})]
					}),
					runs.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "agentFlowEmpty",
						children: "本对话还没有记录到 agent_role_run。"
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "agentFlowList",
						children: runs.map((run) => {
							const depth = depthOf(run, byId);
							return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("article", {
								className: "agentFlowCard",
								"data-status": run.status,
								style: { marginLeft: Math.min(depth, 6) * 20 },
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "agentFlowTop",
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "agentFlowRole",
												children: run.role
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "agentFlowBadge",
												children: kindLabel(run.kind)
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "agentFlowBadge",
												children: run.triggerReason
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "agentFlowBadge agentFlowStatus",
												children: statusLabel(run.status)
											})
										]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "agentFlowMeta",
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: timeOf(run.startedAt) }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
												run.provider,
												"/",
												run.model
											] }),
											run.reasoningEffort === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: ["effort: ", run.reasoningEffort] }),
											run.durationMs === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [run.durationMs, "ms"] })
										]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "agentFlowRelation",
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "激活：" }),
											run.parentRunId === null ? "当前对话 Agent" : shortId(run.parentRunId),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: " · " }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "引用：" }),
											run.references.length === 0 ? "无显式引用" : run.references.map(shortId).join(", "),
											run.childSessionId === null ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: " · " }),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "子会话：" }),
												shortId(run.childSessionId)
											] })
										]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("details", {
										className: "agentFlowDetails",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("summary", { children: "展开 Agent 对话" }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "agentFlowConversation",
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
													className: "agentFlowMessage agentFlowMessageUser",
													children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
														className: "agentFlowMessageLabel",
														children: ["→ 发送给 ", run.role]
													}), run.task]
												}),
												run.output === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
													className: "agentFlowMessage agentFlowMessageAgent",
													children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
														className: "agentFlowMessageLabel",
														children: [
															"← ",
															run.role,
															" 返回"
														]
													}), run.output]
												}),
												run.error === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
													className: "agentFlowMessage agentFlowMessageError",
													children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														className: "agentFlowMessageLabel",
														children: "错误"
													}), run.error]
												})
											]
										})]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "agentFlowFooter",
										children: [
											"run_id: ",
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: run.runId }),
											run.stopReason === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [" · stop: ", run.stopReason] })
										]
									})
								]
							}, run.runId);
						})
					})
				]
			});
		}
		function AgentRoleChatStatus({ node }) {
			const run = node.data;
			const label = run.status === "running" ? `正在运行 ${run.role}…` : `${run.role} ${statusLabel(run.status)}`;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				"data-testid": "agent-role-chat-status",
				"data-status": run.status,
				style: {
					margin: "8px 0",
					padding: "10px 12px",
					borderRadius: 8,
					border: "1px solid var(--dsw-alias-border-l2)",
					borderLeft: "3px solid var(--dsw-alias-state-warning-primary)",
					background: "var(--dsw-alias-bg-layer-1)",
					color: "var(--dsw-alias-label-secondary)",
					fontSize: 12
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", {
						style: { color: "var(--dsw-alias-label-primary)" },
						children: label
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
						" · ",
						run.provider,
						"/",
						run.model
					] }),
					run.reasoningEffort === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [" · effort: ", run.reasoningEffort] }),
					run.durationMs === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
						" · ",
						(run.durationMs / 1e3).toFixed(1),
						"s"
					] })
				]
			});
		}
		function registerAgentFlow(ctx) {
			const slots = ctx.slots;
			ctx.uiConversation.events.register(agentRoleRunDefinition());
			ctx.uiConversation.events.register(agentRoleChatDefinition());
			slots.inject("conversation.chat.node", () => slots.register({
				name: "conversation.chat.node",
				key: AGENT_ROLE_CHAT_KIND
			}, AgentRoleChatStatus));
			ctx.uiConversation.views.register(agentFlowViewDefinition);
			slots.inject("conversation.view", () => slots.register({
				name: "conversation.view",
				id: AGENT_FLOW_TARGET,
				order: 25,
				label: () => "Agent 关系",
				inject: () => ({})
			}, AgentFlowView));
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
		//#region src/client/settings-validation.ts
		function baseValid(settings) {
			if (settings.teamEnabled && settings.roles.length === 0) return false;
			const ids = /* @__PURE__ */ new Set();
			for (const role of settings.roles) {
				if (!/^[a-z][a-z0-9_-]*$/u.test(role.id) || ids.has(role.id)) return false;
				ids.add(role.id);
			}
			if (!settings.teamEnabled) return true;
			const byId = new Map(settings.roles.map((role) => [role.id, role]));
			const roleMatches = (id, kind) => id === "" || byId.get(id)?.kind === kind;
			const rules = settings.triggerRules;
			if (!roleMatches(rules.depthRoleId, "advisory") || !roleMatches(rules.coordinatorRoleId, "advisory") || !roleMatches(rules.workerRoleId, "subagent") || !roleMatches(rules.firstTurnRoleId, "advisory")) return false;
			if (rules.mode === "first-turn" && rules.firstTurnRoleId === "") return false;
			return [
				rules.coordinatorMinDeliverables,
				rules.coordinatorMinSubsystems,
				rules.repeatedFailureThreshold,
				rules.maxDepthCallsPerTurn,
				rules.maxCoordinatorCallsPerTurn,
				rules.maxConcurrentWorkers
			].every((value) => Number.isSafeInteger(value) && value >= 1);
		}
		function catalogValid(settings, options) {
			if (!baseValid(settings)) return false;
			if (!settings.teamEnabled) return true;
			const presets = new Set(options.presets.filter((preset) => preset.broken === void 0).map((preset) => preset.id));
			if (settings.presetIds.some((id) => !presets.has(id))) return false;
			return settings.roles.every((role) => {
				if (role.provider === void 0 && role.model === void 0) return role.reasoningEffort === void 0 || role.reasoningEffort === "";
				if (role.provider === void 0 || role.model === void 0) return false;
				const builtinMax = builtinMaxOutputTokens(role.provider, role.model);
				if (role.maxTokens !== void 0 && builtinMax !== void 0 && role.maxTokens > builtinMax) return false;
				const group = options.groups.find((candidate) => candidate.id === role.provider);
				const model = group?.models.find((candidate) => candidate.id === role.model);
				if (group === void 0 || model === void 0) return false;
				if (role.reasoningEffort === void 0 || role.reasoningEffort === "") return true;
				return model.reasoning?.efforts.some((effort) => effort.id === role.reasoningEffort) === true;
			});
		}
		//#endregion
		//#region src/client/index.tsx
		const css = {
			section: "rrSection",
			notice: "rrNotice",
			toggle: "rrToggle",
			wideField: "rrWideField",
			grid: "rrGrid",
			roles: "rrRoles",
			card: "rrCard",
			cardHeading: "rrCardHeading",
			full: "rrFull",
			actions: "rrActions",
			primary: "rrPrimary",
			error: "rrError",
			scope: "rrScope",
			scopeOptions: "rrScopeOptions",
			presetGrid: "rrPresetGrid",
			tabs: "rrTabs",
			tab: "rrTab",
			tabActive: "rrTabActive",
			ruleChecks: "rrRuleChecks",
			fieldHint: "rrFieldHint"
		};
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
`;
		const CLIENT_DEFAULT_TRIGGER_RULES = {
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
		const zh = {
			nav: "Agent 角色",
			title: "Agent 角色配置",
			description: "定义供根 Agent 调用的大脑、协调者和 Worker 角色。Provider、模型和推理等级均来自当前用户的实时 DSH 模型目录。",
			enabled: "启用 Agent 角色工具",
			scopeTitle: "角色生效范围",
			scopeExplanation: "这里决定哪些 Agent 预设会获得 agent_role_run 和 agent_role_catalog 工具。它不会修改预设内容，也不会切换当前会话的预设。",
			allPresets: "所有 Agent 预设",
			allPresetsHint: "每个根 Agent 都能看到并调用这些角色。",
			selectedPresets: "仅指定的 Agent 预设",
			selectedPresetsHint: "只有下方勾选的预设能看到并调用这些角色；其他预设不受影响。",
			loading: "正在读取角色配置…",
			catalogLoading: "正在读取当前用户可用的 Provider、模型和 Agent 预设…",
			catalogError: "无法读取实时目录，请先打开一个根会话后重试。",
			unavailable: "Host 尚未提供该设置命名空间。",
			save: "保存配置",
			saving: "正在保存…",
			saved: "已保存",
			saveError: "保存失败，Host 已拒绝该配置。",
			addRole: "添加角色",
			remove: "删除",
			roleId: "角色 ID",
			kind: "类型",
			advisory: "顾问 / 大脑",
			subagent: "Worker 子代理",
			maxTokensBuiltin: "该模型内置最大输出：",
			maxTokensExceeded: "当前值超过模型内置最大输出，不能保存。",
			roleDescription: "职责描述",
			provider: "服务提供商",
			model: "模型",
			effort: "推理等级",
			providerDefault: "使用模型 / Provider 默认值",
			inheritRoute: "继承调用方当前路由",
			maxTokens: "最大输出 tokens",
			maxDepth: "最大派生深度",
			invalid: "请修正无效或重复的角色 ID，并确保所有预设、Provider、模型和推理等级都来自当前可用目录。",
			unavailableOption: "当前不可用",
			noModels: "该 Provider 没有可用模型",
			rolesTab: "角色配置",
			rulesTab: "触发规则",
			rulesTitle: "Agent 角色触发规则",
			rulesDescription: "规则模式会把明确的 MUST 条件注入根 Agent；调用上限和 Worker 并发由运行时硬限制。首轮模式会在根 Agent 执行前自动调用所选顾问角色。",
			triggerMode: "触发模式",
			rulesMode: "按规则触发（推荐）",
			manualMode: "仅用户明确要求时调用",
			firstTurnMode: "首个用户回合自动调用",
			depthRole: "深度推理角色",
			coordRole: "协调角色",
			workerRole: "执行角色",
			firstTurnRole: "首轮自动角色",
			noneRole: "不配置",
			minDeliverables: "协调触发：最少交付物",
			minSubsystems: "协调触发：最少独立模块",
			failureThreshold: "深度推理触发：同一问题失败次数",
			highRisk: "高风险或不可逆决策时触发深度推理",
			conflicting: "确认的证据互相矛盾时触发深度推理",
			architecture: "高影响架构决策时触发深度推理",
			maxDepthCalls: "每轮最多深度推理调用",
			maxCoordCalls: "每轮最多协调调用",
			maxWorkers: "最多并发 Worker",
			priorEvaluation: "重复调用深度推理前必须说明上次建议的验证结果",
			showReason: "在调用结果中显示触发原因",
			failOpen: "首轮自动角色失败时让根 Agent 继续",
			customRules: "补充自定义规则（自由文本，不用于严格字段匹配）"
		};
		const en = {
			nav: "Agent Roles",
			title: "Agent role configuration",
			description: "Define brain, coordinator, and worker roles callable by root agents. Providers, models, and reasoning efforts come from the user's live DSH catalog.",
			enabled: "Enable agent role tools",
			scopeTitle: "Where roles are available",
			scopeExplanation: "This controls which Agent presets receive agent_role_run and agent_role_catalog. It does not edit presets or switch the current session preset.",
			allPresets: "All Agent presets",
			allPresetsHint: "Every root agent can see and call these roles.",
			selectedPresets: "Only selected Agent presets",
			selectedPresetsHint: "Only the checked presets receive these roles; other presets are unaffected.",
			loading: "Loading role settings…",
			catalogLoading: "Loading the user's available providers, models, and Agent presets…",
			catalogError: "Could not load the live catalog. Open a root session and retry.",
			unavailable: "The Host does not currently expose this settings namespace.",
			maxTokensBuiltin: "Built-in maximum output for this model: ",
			maxTokensExceeded: "The current value exceeds the model built-in maximum and cannot be saved.",
			save: "Save configuration",
			saving: "Saving…",
			saved: "Saved",
			saveError: "Save failed because the Host rejected this configuration.",
			addRole: "Add role",
			remove: "Remove",
			roleId: "Role ID",
			kind: "Kind",
			advisory: "Advisory / brain",
			subagent: "Worker subagent",
			roleDescription: "Responsibility",
			provider: "Provider",
			model: "Model",
			effort: "Reasoning effort",
			providerDefault: "Use model / provider default",
			inheritRoute: "Inherit the caller route",
			maxTokens: "Max output tokens",
			maxDepth: "Max spawn depth",
			invalid: "Fix invalid or duplicate role IDs and select only currently available presets, providers, models, and reasoning efforts.",
			unavailableOption: "currently unavailable",
			noModels: "No available models for this provider",
			rolesTab: "Role configuration",
			rulesTab: "Trigger rules",
			rulesTitle: "Agent role trigger rules",
			rulesDescription: "Rule mode injects explicit MUST conditions into the root agent; call limits and worker concurrency are enforced by the runtime. First-turn mode automatically runs the selected advisory role before root execution.",
			triggerMode: "Trigger mode",
			rulesMode: "Rules-based (recommended)",
			manualMode: "Only when explicitly requested",
			firstTurnMode: "Automatically on the first user turn",
			depthRole: "Deep reasoning role",
			coordRole: "Coordination role",
			workerRole: "Execution role",
			firstTurnRole: "First-turn role",
			noneRole: "Not configured",
			minDeliverables: "Coordinate at this many deliverables",
			minSubsystems: "Coordinate at this many subsystems",
			failureThreshold: "Deep reasoning after failed approaches",
			highRisk: "Trigger deep reasoning for high-risk or irreversible decisions",
			conflicting: "Trigger deep reasoning for conflicting confirmed evidence",
			architecture: "Trigger deep reasoning for high-impact architecture decisions",
			maxDepthCalls: "Max deep-reasoning calls per turn",
			maxCoordCalls: "Max coordination calls per turn",
			maxWorkers: "Max concurrent workers",
			priorEvaluation: "Require evaluation of prior advice before repeating deep reasoning",
			showReason: "Show the trigger reason in role results",
			failOpen: "Continue root execution when the first-turn role fails",
			customRules: "Additional custom rules (free text; not used for strict identifiers)"
		};
		function safeNumber(value, fallback) {
			const parsed = Number(value);
			return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
		}
		function routedRole(role, group, model) {
			const next = {
				...role,
				provider: group.id,
				model: model.id
			};
			const effort = model.reasoning?.defaultEffort;
			if (effort === void 0) delete next.reasoningEffort;
			else next.reasoningEffort = effort;
			return next;
		}
		function newRole(roles, options) {
			const ids = new Set(roles.map((role) => role.id));
			let sequence = 1;
			while (ids.has(`role-${sequence}`)) sequence += 1;
			const group = options.groups[0];
			const model = group?.models[0];
			const role = {
				id: `role-${sequence}`,
				kind: "subagent",
				description: "Tool-capable delegated worker.",
				maxDepth: 2,
				subagentProvider: "spawn"
			};
			return group === void 0 || model === void 0 ? role : routedRole(role, group, model);
		}
		function TriggerRulesEditor({ t, draft, writable, update }) {
			const rules = draft.triggerRules;
			const advisoryRoles = draft.roles.filter((role) => role.kind === "advisory");
			const workerRoles = draft.roles.filter((role) => role.kind === "subagent");
			const choices = Array.from({ length: 10 }, (_, index) => index + 1);
			const patch = (next) => update({
				...rules,
				...next
			});
			const roleOptions = (roles) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
				value: "",
				children: t("noneRole")
			}), roles.map((role) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
				value: role.id,
				children: [
					role.id,
					" — ",
					role.description
				]
			}, role.id))] });
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: css.roles,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("article", {
						className: css.card,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: css.cardHeading,
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: t("rulesTitle") })
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								className: css.notice,
								children: t("rulesDescription")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: css.grid,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
										className: css.full,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("triggerMode") }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
											value: rules.mode,
											disabled: !writable,
											onChange: (event) => patch({ mode: event.currentTarget.value }),
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
													value: "rules",
													children: t("rulesMode")
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
													value: "manual",
													children: t("manualMode")
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
													value: "first-turn",
													children: t("firstTurnMode")
												})
											]
										})]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("depthRole") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
										value: rules.depthRoleId,
										disabled: !writable,
										onChange: (event) => patch({ depthRoleId: event.currentTarget.value }),
										children: roleOptions(advisoryRoles)
									})] }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("coordRole") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
										value: rules.coordinatorRoleId,
										disabled: !writable,
										onChange: (event) => patch({ coordinatorRoleId: event.currentTarget.value }),
										children: roleOptions(advisoryRoles)
									})] }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("workerRole") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
										value: rules.workerRoleId,
										disabled: !writable,
										onChange: (event) => patch({ workerRoleId: event.currentTarget.value }),
										children: roleOptions(workerRoles)
									})] }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("firstTurnRole") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
										value: rules.firstTurnRoleId,
										disabled: !writable || rules.mode !== "first-turn",
										onChange: (event) => patch({ firstTurnRoleId: event.currentTarget.value }),
										children: roleOptions(advisoryRoles)
									})] }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("minDeliverables") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
										value: rules.coordinatorMinDeliverables,
										disabled: !writable || rules.mode === "manual",
										onChange: (event) => patch({ coordinatorMinDeliverables: Number(event.currentTarget.value) }),
										children: choices.map((value) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value,
											children: value
										}, value))
									})] }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("minSubsystems") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
										value: rules.coordinatorMinSubsystems,
										disabled: !writable || rules.mode === "manual",
										onChange: (event) => patch({ coordinatorMinSubsystems: Number(event.currentTarget.value) }),
										children: choices.map((value) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value,
											children: value
										}, value))
									})] }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("failureThreshold") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
										value: rules.repeatedFailureThreshold,
										disabled: !writable || rules.mode === "manual",
										onChange: (event) => patch({ repeatedFailureThreshold: Number(event.currentTarget.value) }),
										children: choices.map((value) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value,
											children: value
										}, value))
									})] }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("maxDepthCalls") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
										value: rules.maxDepthCallsPerTurn,
										disabled: !writable,
										onChange: (event) => patch({ maxDepthCallsPerTurn: Number(event.currentTarget.value) }),
										children: choices.map((value) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value,
											children: value
										}, value))
									})] }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("maxCoordCalls") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
										value: rules.maxCoordinatorCallsPerTurn,
										disabled: !writable,
										onChange: (event) => patch({ maxCoordinatorCallsPerTurn: Number(event.currentTarget.value) }),
										children: choices.map((value) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value,
											children: value
										}, value))
									})] }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("maxWorkers") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
										value: rules.maxConcurrentWorkers,
										disabled: !writable,
										onChange: (event) => patch({ maxConcurrentWorkers: Number(event.currentTarget.value) }),
										children: choices.map((value) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value,
											children: value
										}, value))
									})] })
								]
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("fieldset", {
						className: css.scope,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("legend", { children: t("rulesTab") }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: css.ruleChecks,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									type: "checkbox",
									checked: rules.triggerOnHighRisk,
									disabled: !writable || rules.mode === "manual",
									onChange: (event) => patch({ triggerOnHighRisk: event.currentTarget.checked })
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("highRisk") })] }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									type: "checkbox",
									checked: rules.triggerOnConflictingEvidence,
									disabled: !writable || rules.mode === "manual",
									onChange: (event) => patch({ triggerOnConflictingEvidence: event.currentTarget.checked })
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("conflicting") })] }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									type: "checkbox",
									checked: rules.triggerOnArchitectureDecision,
									disabled: !writable || rules.mode === "manual",
									onChange: (event) => patch({ triggerOnArchitectureDecision: event.currentTarget.checked })
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("architecture") })] }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									type: "checkbox",
									checked: rules.requirePriorAdviceEvaluation,
									disabled: !writable,
									onChange: (event) => patch({ requirePriorAdviceEvaluation: event.currentTarget.checked })
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("priorEvaluation") })] }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									type: "checkbox",
									checked: rules.showTriggerReason,
									disabled: !writable,
									onChange: (event) => patch({ showTriggerReason: event.currentTarget.checked })
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("showReason") })] }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									type: "checkbox",
									checked: rules.firstTurnFailOpen,
									disabled: !writable || rules.mode !== "first-turn",
									onChange: (event) => patch({ firstTurnFailOpen: event.currentTarget.checked })
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("failOpen") })] })
							]
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
						className: css.wideField,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("customRules") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
							rows: 5,
							value: rules.customInstructions,
							disabled: !writable,
							onChange: (event) => patch({ customInstructions: event.currentTarget.value })
						})]
					})
				]
			});
		}
		function RoleSettingsSection({ t, useRoleSettings, save, loadOptions }) {
			const snapshot = useRoleSettings((value) => value);
			const [draft, setDraft] = (0, react.useState)(null);
			const [options, setOptions] = (0, react.useState)(null);
			const [catalogError, setCatalogError] = (0, react.useState)(false);
			const [status, setStatus] = (0, react.useState)("idle");
			const [activeTab, setActiveTab] = (0, react.useState)("roles");
			(0, react.useEffect)(() => {
				if (snapshot.value !== void 0) {
					const value = structuredClone(snapshot.value);
					setDraft({
						...value,
						triggerRules: {
							...CLIENT_DEFAULT_TRIGGER_RULES,
							...value.triggerRules
						}
					});
				}
			}, [snapshot.value]);
			(0, react.useEffect)(() => {
				let current = true;
				loadOptions().then((value) => {
					if (current) {
						setOptions(value);
						setCatalogError(false);
					}
				}, () => {
					if (current) setCatalogError(true);
				});
				return () => {
					current = false;
				};
			}, [loadOptions]);
			if (snapshot.status === "loading") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: css.notice,
				children: t("loading")
			});
			if (draft === null) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: css.notice,
				children: t("unavailable")
			});
			if (catalogError) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: css.error,
				role: "alert",
				children: t("catalogError")
			});
			if (options === null) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: css.notice,
				children: t("catalogLoading")
			});
			const replaceRole = (index, role) => {
				setStatus("idle");
				setDraft((current) => current === null ? current : {
					...current,
					roles: current.roles.map((candidate, roleIndex) => roleIndex === index ? role : candidate)
				});
			};
			const patchRole = (index, patch) => {
				const role = draft.roles[index];
				if (role !== void 0) replaceRole(index, {
					...role,
					...patch
				});
			};
			const isValid = catalogValid(draft, options);
			const selectedScope = draft.presetIds.length > 0;
			const selectablePresets = options.presets.filter((preset) => preset.broken === void 0);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: css.section,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("style", { children: STYLE }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", { children: t("title") }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("description") }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: css.tabs,
							role: "tablist",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								className: activeTab === "roles" ? css.tab + " " + css.tabActive : css.tab,
								type: "button",
								role: "tab",
								"aria-selected": activeTab === "roles",
								onClick: () => setActiveTab("roles"),
								children: t("rolesTab")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								className: activeTab === "rules" ? css.tab + " " + css.tabActive : css.tab,
								type: "button",
								role: "tab",
								"aria-selected": activeTab === "rules",
								onClick: () => setActiveTab("rules"),
								children: t("rulesTab")
							})]
						})
					] }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						hidden: activeTab !== "roles",
						className: css.roles,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								className: css.toggle,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									type: "checkbox",
									checked: draft.teamEnabled,
									disabled: !snapshot.writable,
									onChange: (event) => {
										setStatus("idle");
										setDraft({
											...draft,
											teamEnabled: event.currentTarget.checked
										});
									}
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("enabled") })]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("fieldset", {
								className: css.scope,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("legend", { children: t("scopeTitle") }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: t("scopeExplanation") }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: css.scopeOptions,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											type: "radio",
											name: "role-scope",
											checked: !selectedScope,
											disabled: !snapshot.writable,
											onChange: () => {
												setStatus("idle");
												setDraft({
													...draft,
													presetIds: []
												});
											}
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: t("allPresets") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", { children: t("allPresetsHint") })] })] }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											type: "radio",
											name: "role-scope",
											checked: selectedScope,
											disabled: !snapshot.writable || selectablePresets.length === 0,
											onChange: () => {
												const first = selectablePresets[0];
												if (first !== void 0) {
													setStatus("idle");
													setDraft({
														...draft,
														presetIds: [first.id]
													});
												}
											}
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: t("selectedPresets") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("small", { children: t("selectedPresetsHint") })] })] })]
									}),
									selectedScope ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: css.presetGrid,
										children: options.presets.map((preset) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
											type: "checkbox",
											checked: draft.presetIds.includes(preset.id),
											disabled: !snapshot.writable || preset.broken !== void 0,
											onChange: (event) => {
												setStatus("idle");
												const next = event.currentTarget.checked ? [...draft.presetIds, preset.id] : draft.presetIds.filter((id) => id !== preset.id);
												setDraft({
													...draft,
													presetIds: next.length === 0 ? [] : next
												});
											}
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
											preset.name ?? preset.id,
											preset.isDefault ? " · default" : "",
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("small", { children: [preset.description ?? preset.id, preset.broken === void 0 ? "" : ` · ${preset.broken}`] })
										] })] }, preset.id))
									}) : null
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: css.roles,
								children: draft.roles.map((role, index) => {
									const group = options.groups.find((candidate) => candidate.id === role.provider);
									const models = group?.models ?? [];
									const model = models.find((candidate) => candidate.id === role.model);
									const efforts = model?.reasoning?.efforts ?? [];
									const staleProvider = role.provider !== void 0 && group === void 0;
									const staleModel = role.model !== void 0 && model === void 0;
									const staleEffort = role.reasoningEffort !== void 0 && role.reasoningEffort !== "" && !efforts.some((effort) => effort.id === role.reasoningEffort);
									const builtinMax = builtinMaxOutputTokens(role.provider, role.model);
									const maxTokensExceeded = role.maxTokens !== void 0 && builtinMax !== void 0 && role.maxTokens > builtinMax;
									return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("article", {
										className: css.card,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: css.cardHeading,
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: role.id || t("roleId") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												disabled: !snapshot.writable,
												onClick: () => {
													setStatus("idle");
													setDraft({
														...draft,
														roles: draft.roles.filter((_, i) => i !== index)
													});
												},
												children: t("remove")
											})]
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: css.grid,
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("roleId") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
													value: role.id,
													disabled: !snapshot.writable,
													onChange: (event) => patchRole(index, { id: event.currentTarget.value })
												})] }),
												/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("kind") }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
													value: role.kind,
													disabled: !snapshot.writable,
													onChange: (event) => patchRole(index, { kind: event.currentTarget.value }),
													children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
														value: "advisory",
														children: t("advisory")
													}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
														value: "subagent",
														children: t("subagent")
													})]
												})] }),
												/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
													className: css.full,
													children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("roleDescription") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
														value: role.description,
														disabled: !snapshot.writable,
														onChange: (event) => patchRole(index, { description: event.currentTarget.value })
													})]
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("provider") }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
													value: role.provider ?? "",
													disabled: !snapshot.writable || options.groups.length === 0,
													onChange: (event) => {
														if (event.currentTarget.value === "") {
															const inherited = { ...role };
															delete inherited.provider;
															delete inherited.model;
															delete inherited.reasoningEffort;
															replaceRole(index, inherited);
															return;
														}
														const nextGroup = options.groups.find((candidate) => candidate.id === event.currentTarget.value);
														const nextModel = nextGroup?.models[0];
														if (nextGroup !== void 0 && nextModel !== void 0) replaceRole(index, routedRole(role, nextGroup, nextModel));
													},
													children: [
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
															value: "",
															children: t("inheritRoute")
														}),
														staleProvider ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
															value: role.provider,
															children: [
																role.provider,
																" · ",
																t("unavailableOption")
															]
														}) : null,
														options.groups.map((candidate) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
															value: candidate.id,
															children: [
																candidate.name,
																" (",
																candidate.id,
																")"
															]
														}, candidate.id))
													]
												})] }),
												/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("model") }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
													value: role.model ?? "",
													disabled: !snapshot.writable || group === void 0 || models.length === 0,
													onChange: (event) => {
														const nextModel = models.find((candidate) => candidate.id === event.currentTarget.value);
														if (group !== void 0 && nextModel !== void 0) replaceRole(index, routedRole(role, group, nextModel));
													},
													children: [
														group === void 0 && role.provider === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
															value: "",
															children: t("inheritRoute")
														}) : null,
														group !== void 0 && models.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
															value: "",
															children: t("noModels")
														}) : null,
														staleModel ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
															value: role.model,
															children: [
																role.model,
																" · ",
																t("unavailableOption")
															]
														}) : null,
														models.map((candidate) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
															value: candidate.id,
															children: [
																candidate.name,
																" (",
																candidate.id,
																")"
															]
														}, candidate.id))
													]
												})] }),
												/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("effort") }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
													value: role.reasoningEffort ?? "",
													disabled: !snapshot.writable || model === void 0,
													onChange: (event) => {
														const next = { ...role };
														if (event.currentTarget.value === "") delete next.reasoningEffort;
														else next.reasoningEffort = event.currentTarget.value;
														replaceRole(index, next);
													},
													children: [
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
															value: "",
															children: t("providerDefault")
														}),
														staleEffort ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
															value: role.reasoningEffort,
															children: [
																role.reasoningEffort,
																" · ",
																t("unavailableOption")
															]
														}) : null,
														efforts.map((effort) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
															value: effort.id,
															children: [
																effort.name,
																" (",
																effort.id,
																")"
															]
														}, effort.id))
													]
												})] }),
												role.kind === "advisory" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("maxTokens") }),
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
														type: "number",
														min: "1",
														max: builtinMax,
														value: role.maxTokens ?? "",
														disabled: !snapshot.writable,
														"aria-invalid": maxTokensExceeded,
														onChange: (event) => patchRole(index, { maxTokens: safeNumber(event.currentTarget.value, 1) })
													}),
													builtinMax === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("small", {
														className: css.fieldHint,
														"data-error": maxTokensExceeded,
														children: [
															t("maxTokensBuiltin"),
															builtinMax.toLocaleString(),
															" tokens",
															maxTokensExceeded ? ` · ${t("maxTokensExceeded")}` : ""
														]
													})
												] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("maxDepth") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
													type: "number",
													min: "0",
													value: role.maxDepth ?? "",
													disabled: !snapshot.writable,
													onChange: (event) => patchRole(index, { maxDepth: safeNumber(event.currentTarget.value, 0) })
												})] })
											]
										})]
									}, index);
								})
							})
						]
					}),
					activeTab === "rules" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TriggerRulesEditor, {
						t,
						draft,
						writable: snapshot.writable,
						update: (triggerRules) => {
							setStatus("idle");
							setDraft({
								...draft,
								triggerRules
							});
						}
					}) : null,
					!isValid ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: css.error,
						role: "alert",
						children: t("invalid")
					}) : null,
					status === "error" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: css.error,
						role: "alert",
						children: t("saveError")
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: css.actions,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							hidden: activeTab !== "roles",
							disabled: !snapshot.writable || options.groups.length === 0,
							onClick: () => {
								setStatus("idle");
								setDraft({
									...draft,
									roles: [...draft.roles, newRole(draft.roles, options)]
								});
							},
							children: t("addRole")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							className: css.primary,
							type: "button",
							disabled: !snapshot.writable || !isValid || status === "saving",
							onClick: () => {
								setStatus("saving");
								save(draft).then(() => {
									setStatus("saved");
								}, () => {
									setStatus("error");
								});
							},
							children: status === "saving" ? t("saving") : status === "saved" ? t("saved") : t("save")
						})]
					})
				]
			});
		}
		const name = "dsh-codex-reasoning-router-client";
		const inject = [
			"slots",
			"locale",
			"settingsScope",
			"remote",
			"remote.session",
			"remote.agentPresets",
			"uiConversation"
		];
		function apply(ctx) {
			registerAgentFlow(ctx);
			const namespace = "settings.codex-reasoning-router";
			ctx.effect(() => ctx.locale.register(namespace, {
				zh,
				en
			}), "reasoning-router: settings copy");
			const t = ctx.locale.bind(namespace);
			const scope = ctx.settingsScope.bind({ namespace: "codex-reasoning-router" });
			const loadOptions = async () => {
				const [modelsReply, presetsReply] = await Promise.all([ctx.remote.session.modelCatalog(), ctx.remote.agentPresets.list()]);
				if (!modelsReply.ok) throw new Error(modelsReply.error.message);
				if (!presetsReply.ok) throw new Error(presetsReply.error.message);
				return {
					groups: modelsReply.value.groups.map((group) => ({
						...group,
						models: [...group.models]
					})),
					presets: [...presetsReply.value.presets]
				};
			};
			const save = async (next) => {
				await scope.mutate([
					{
						op: "set",
						path: ["teamEnabled"],
						value: next.teamEnabled
					},
					{
						op: "set",
						path: ["presetIds"],
						value: next.presetIds
					},
					{
						op: "set",
						path: ["roles"],
						value: next.roles.map((role) => ({ ...role }))
					},
					{
						op: "set",
						path: ["triggerRules"],
						value: { ...next.triggerRules }
					}
				], scope.getSnapshot().revision);
			};
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "agent-roles",
				order: 17,
				label: () => t("nav"),
				locale: namespace,
				inject: () => ({
					t,
					save,
					loadOptions,
					hooks: { roleSettings: scope }
				})
			}, RoleSettingsSection));
		}
		//#endregion
		exports.apply = apply;
		exports.catalogValid = catalogValid;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
