# dsh-codex-reasoning-router

[English](./README.md) | 简体中文 | [AI / LLM 上下文](./llms.txt)

DeepSeek Harness（`dsh`）的 Luna + Sol 混合推理 preset：

- `openai-codex/gpt-5.6-luna` 是唯一执行 Agent，拥有 Standard preset 的工具、Skills、MCP、子 Agent、文件和终端能力。
- `openai-codex/gpt-5.6-sol` 是无工具 Advisor，只接收压缩后的证据并返回短建议。
- Sol 不接触工作区、不调用工具、不创建子 Agent、不直接回复用户。
- 新会话首轮默认咨询 Sol；困难阻塞点可由 Luna 调用 `sol_consult`。
- 同一问题最多两次咨询：默认 `medium -> high`；失败默认 fail-open，不阻塞 Luna。

一句话：**Luna 负责行动，Sol 负责建议。**

## 依赖

| 类型 | 要求 |
|---|---|
| 宿主 | 当前版 DeepSeek Harness |
| Codex 适配器 | `dsh-codex >= 0.2.3`，已安装并完成认证 |
| 模型 | 可访问 `openai-codex/gpt-5.6-luna` 与 `openai-codex/gpt-5.6-sol` |
| 源码开发 | Node.js 22、pnpm；本项目已在 Node 22.23 / pnpm 11.7 验证 |
| DSH peer APIs | 见 [`package.json`](./package.json) 的 `peerDependencies` |

插件复用 `dsh-codex` 的认证和 provider 生命周期，不读取 OAuth 文件或 token，也不调用私有 ChatGPT 接口。

## 部署

以下命令中的 `/path/to/.dsh` 改为 DSH home；默认通常是 `~/.dsh`。

1. 安装并认证 `dsh-codex`：

```bash
pnpm dsh plugin --profile web add dsh-codex
```

2. 通过 DSH plugin 命令从 GitHub 安装 Router；该命令会自动把 Host bundle 加入 `dsh.profile.bundles`：

```bash
pnpm dsh plugin --profile web add github:chenmzh/dsh-codex-reasoning-router
```

3. 复制 preset：

```bash
cp -R /path/to/.dsh/profiles/web/node_modules/dsh-codex-reasoning-router/preset/luna-sol-reasoning-router /path/to/.dsh/.agent-presets/
```

本地开发版本可改用：

```bash
pnpm dsh plugin --profile web add link:/absolute/path/to/dsh-codex-reasoning-router
cp -R /absolute/path/to/dsh-codex-reasoning-router/preset/luna-sol-reasoning-router /path/to/.dsh/.agent-presets/
```

4. 重启 DSH，新建会话并显式选择 **Luna + Sol Reasoning Router**；模型选择 `openai-codex / gpt-5.6-luna`。

这个 preset 不修改默认 preset，也不会静默切换主模型。Host bundle 会在冷读取历史会话前注册 Router 持久化事件；插件只会在实际使用 `luna-sol-reasoning-router` 的 root session 上挂提示词与工具、校验模型目录并限制主路由，其他 preset 可以自由尝试可用的 provider/model。修改配置后必须新建会话。

## 配置

Host 配置文件：[`cordis.patch.yml`](./cordis.patch.yml)

```yaml
initialSolReasoning: medium   # medium | high
escalatedSolReasoning: high  # medium | high
solAdviceMaxTokens: 2000     # 256..4096
solTimeoutMs: 30000          # 1000..120000
initialConsultEnabled: true
failOpen: true
```

建议保留 `medium -> high`、`initialConsultEnabled: true`、`failOpen: true`。当使用该 preset 的 root session 开始工作时，插件才会校验配置的 provider/model；缺失模型会报错且不会回退。Provider、模型和 `requiredPresetId` 是该 preset 的架构边界，除非你同步修改并验证插件，否则不要更改。

## 工作流

```text
首条用户消息 -> Sol medium 建议 -> Luna 执行
阻塞问题 X   -> Sol medium -> Luna 验证
同一问题 X   -> 提供上次建议评估 -> Sol high -> Luna 验证
同一问题 X   -> consultation exhausted；不再调用模型
```

咨询结果写入 session event，恢复会话后仍保留升级状态。只保存短 Advisory Packet，不保存 Sol 的私有推理。

## 开发与验证

开发依赖中的 `dsh-codex` 使用相邻目录 `../dsh-codex`。准备该 checkout 后运行：

```bash
pnpm install --offline
pnpm run check
pnpm pack --dry-run
```

`pnpm run check` 依次执行 TypeScript 类型检查、Vitest 和构建。

## 安全边界

- Sol 请求不含 `tools` 和 `sessionId`。
- Sol 返回 tool-call 时会报协议错误，绝不执行。
- Router 由 Profile bundle 在 Host 启动时加载，以便冷读取历史会话前注册持久化事件类型；`requiredPresetId` 仍保证只有 `luna-sol-reasoning-router` 获得提示词、工具、模型校验和路由约束。
- 在该 preset 中，非 Luna 主路由会被阻止，不会被插件偷偷改写。
- 网络或 provider 失败在默认 `failOpen: true` 下只记录警告，Luna 继续执行。

完整实现细节、事件名、公开 DSH API 清单见 [English README](./README.md)。AI 应优先读取 [`llms.txt`](./llms.txt)。

## 许可证

Apache-2.0，见 [`LICENSE`](./LICENSE)。
