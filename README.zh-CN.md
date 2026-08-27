# dsh-codex-reasoning-router

[English](./README.md) | 简体中文 | [AI / LLM 上下文](./llms.txt)

DeepSeek Harness（DSH）的可组合多模型 Agent 角色 插件。它不再要求切换到专用 preset，可以与 Standard、Code 或用户自定义 preset 一起使用。

默认团队：

- `brain`：无工具深度推理，默认 `openai-codex/gpt-5.6-sol` + `max`。
- `coordinator`：无工具任务拆解、分派与集成建议，默认 Sol + `high`。
- `worker`：拥有当前 preset 工具的真实 DSH 子代理，默认 `gpt-5.6-luna` + `max`，绝对深度上限为 2。
- `agent_role_catalog`：从当前用户已注册的 DSH provider 读取可用模型，以及每个模型真实支持的 reasoning effort。
- `agent_role_run`：按角色运行 advisory 或子代理。

旧版 `luna-sol-reasoning-router` preset 与 `sol_consult` 状态机仍然保留，但默认不启用路由锁定。

## 安装

先安装并认证所需模型 provider，例如 `dsh-codex`，然后安装本插件：

```bash
pnpm dsh plugin --profile web add dsh-codex
pnpm dsh plugin --profile web add link:/absolute/path/to/dsh-codex-reasoning-router
```

也可以从 GitHub 安装：

```bash
pnpm dsh plugin --profile web add github:chenmzh/dsh-codex-reasoning-router
```

重启 DSH 并新建会话。0.2 起无需复制或选择专用 preset；插件默认叠加到任何 preset。只有继续使用旧 Luna+Sol 路由模式时，才需要复制 [`preset/luna-sol-reasoning-router`](./preset/luna-sol-reasoning-router)。

## 配置

默认配置见 [`cordis.patch.yml`](./cordis.patch.yml)：

```yaml
teamEnabled: true
presetIds: []                 # 空数组 = 所有 preset；也可只写 standard/code/自定义 id
roles:
  - id: brain
    kind: advisory            # 无工具、一次性推理调用
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
    kind: subagent            # 真正的 DSH 子代理，继承当前 preset 的组合
    description: Implement and verify
    provider: openai-codex
    model: gpt-5.6-luna
    reasoningEffort: max
    subagentProvider: spawn
    maxDepth: 2               # 绝对深度：root=0，子代依次为 1、2……
    toolDeny: [web_search]     # 可选；也可用 toolAllow
```

角色数组可以任意增删，`id` 必须是小写字母开头的 kebab/snake 标识。字段说明：

| 字段 | 含义 |
|---|---|
| `kind` | `advisory` 为无工具推理；`subagent` 为有工具的真实子代理 |
| `provider` / `model` | 省略时继承调用者；填写时必须存在于用户的实时模型目录 |
| `reasoningEffort` | 省略时使用模型默认；填写时必须是该模型目录公开的 effort |
| `systemPrompt` | 可选角色 persona；省略时使用内置角色提示 |
| `subagentProvider` | `spawn`、`fork` 或宿主已注册的其他 provider |
| `maxDepth` | 子代理树的绝对深度上限，不是“还能递归几层” |
| `toolAllow` / `toolDeny` | DSH 原生子代理工具可见性过滤，仅用于 `subagent` |

模型名和 effort 不靠插件硬编码猜测。运行时先通过 `ctx.llm.listProviders()`、`listModels()` 与 `resolveModelInfo()`读取当前用户目录；无效组合在发起模型请求或创建子代理前报错。会话中的 Agent 也可以调用 `agent_role_catalog` 查看同一目录。

## 触发规则

WebUI 的“Agent 角色 → 触发规则”Tab 可以配置并持久化以下策略：

- rules（默认）：向根 Agent 注入明确的 MUST 条件；高风险、证据矛盾、架构决策、重复失败及任务宽度阈值均可调整。
- manual：只有用户明确要求时才允许调用角色。
- first-turn：首个用户回合在根 Agent 执行前自动运行所选 advisory 角色一次；失败时可选择 fail-open。

深度推理和协调角色的每轮调用上限、Worker 并发上限由运行时硬限制。每次 agent_role_run 必须选择 trigger_reason；重复深度咨询可要求提供 prior_advice_evaluation。角色映射使用已配置角色的下拉选择，只有 customInstructions 是自由文本。

## 与其他 preset 组合

默认 `presetIds: []`，所以只需选择原本想用的 preset：

```text
Standard preset + agent 角色
Code preset     + agent 角色
自定义 preset   + agent 角色
```

子代理由 DSH 的 in-process provider 创建，自动继承父 Agent 的 preset composition、工作区、策略与可见工具，再应用角色自己的模型、effort、persona、工具过滤和深度上限。

若只想让插件出现在指定 preset：

```yaml
presetIds: [standard, code, my-review-preset]
```

## 旧版 Luna + Sol 路由

要恢复 0.1 行为，在配置中设置：

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

然后复制并选择随包提供的 preset。旧模式继续保证：Sol 无工具、主 Luna 路由被校验、同一 blocker 最多两次咨询、状态写入 session event。`requiredPresetId: ''`（0.2 默认）表示完全关闭旧路由锁定，不影响 Agent 角色。

## 安全与边界

- Advisory 角色的请求不含工具；如果模型仍返回 tool-call，插件会报错并且绝不执行。
- Worker 使用 DSH 原生 subagent runtime；`maxDepth` 由 provider 在每次创建时强制检查。
- 工具过滤是组合可见性，不是新的安全沙箱；实际权限仍由 DSH sandbox/approval policy 决定。
- 角色模型和 effort 在调用前对实时目录做精确验证，不静默降级、不自动换模型。
- 子代理的 reasoning effort 通过 agent-scoped `installModelSelection` 在首次请求前安装，不依赖模型名猜测。

## 开发与验证

```bash
pnpm install --offline
pnpm run check
pnpm pack --dry-run
```

当前测试覆盖旧路由不变量以及目录读取、effort 校验、advisory 无工具、worker 模型/effort、工具过滤与绝对深度传递。

## 许可证

Apache-2.0，见 [`LICENSE`](./LICENSE)。
