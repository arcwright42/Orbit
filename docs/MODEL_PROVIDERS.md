# 模型配置与 Provider 接入（PR1）

PR1 实现文字模型配置后端和 IPC 接口；PR2 再接设置页面。Pi 继续负责 Agent 循环、流式协议、工具调用和上下文，Orbit 负责配置选择、凭据及业务规则。Qwen 实时语音配置独立。

## 支持范围

| 来源 / providerId | 协议 | 模型选择 | 凭据 |
| --- | --- | --- | --- |
| API / `openai` | OpenAI Responses | Pi SDK 内置目录 | API key |
| API / `anthropic` | Anthropic Messages | Pi SDK 内置目录 | API key |
| API / `openrouter` | OpenAI Chat Completions | Pi SDK 内置目录 | API key |
| API / `custom` | OpenAI Chat Completions | 手填模型 ID、API 前缀、上下文与输出长度 | API key |
| 本地登录 / `openai-codex` | OpenAI Codex Responses（SSE） | Pi SDK 内置目录 | Codex ChatGPT access token |

预设 provider 使用固定官方端点，不接受 base URL 覆盖。OpenRouter 的目录中含 Anthropic 模型，适配时统一使用 OpenRouter 的 Chat Completions 协议。自定义服务使用文字、非推理模型描述，默认上下文 32,768、最大输出 4,096；地址不包含用户名、密码、查询参数、片段或 `/chat/completions`。

同一 provider 可以保存多套配置，最多 100 套。目录来自锁定的 Pi SDK 1.3.0，不通过联网发现，并排除已确认退役的 Codex 订阅模型；目录存在不代表账号有模型使用权限，显式连接测试用于验证实际访问。

2026-10-17 真实调用发现 SDK 仍收录 `gpt-5.5`，但服务端已拒绝其 ChatGPT 登录请求。Orbit 按 [官方模型退役说明](https://learn.chatgpt.com/docs/models#deprecated-codex-models) 过滤 Codex 来源中的已退役条目，并在激活旧配置时明确提示重新选择。旧配置仍可读取和修改，不自动换模型；此限制不影响 API 来源。

Claude Code、本应用内 OAuth 登录、Codex keyring 读取、自动续期、自动挑选其他配置均不在 PR1 范围。

## 配置和凭据归属

`<userData>/models.json` 保存版本为 1 的配置文档：`activeProfileId` 与 `profiles`。每项含非敏感 `profile` 和可选 `encryptedApiKey`。主进程通过同目录临时文件和 rename 原子替换，文件权限为 `0600`。不得手动填入明文 key 或搬运 Codex token。

API key 使用 Electron `safeStorage` 加密。系统加密不可用或 Linux 退化为 `basic_text` 时拒绝保存和解密 API key；不会降级成明文。密文通常绑定本机系统存储，不能当作跨机器通用配置备份。配置更新不提供 `apiKey` 时保留原密钥；改 provider、凭据来源或 API 地址需要重新提供密钥。

Codex 只保存来源引用，不保存 token。主进程读取 `CODEX_HOME/auth.json`，未设置时读 `~/.codex/auth.json`；检测文件大小、登录类型、JWT 中的 account claim 和到期时间。检测只表示本机格式与有效期可用，不等同服务端验证。API-key 模式的 Codex 登录不会当成订阅登录使用。

worker 每次需要凭据时通过内部 RPC 请求主进程。Codex token 剩余不足 30 秒即拒绝；续期在 Codex 完成，下一次凭据读取使用更新后的文件。Pi 中注册的凭据解析器只返回当前 access token，没有 OAuth 刷新处理器，也不导入 refresh token。Orbit 不修改、迁移或刷新用户的 Codex 文件。启动时凭据不可用可在修复后再次激活同一配置。

渲染进程只有写入密钥的能力；读取、事件和错误不包含 key、密文、token、账户详情或登录文件路径。凭据仅在主进程和受控 worker 内存之间传递，配置对象不含凭据。Pi 会话、Orbit SQLite、语音配置的存储位置保持独立。

## 选择、切换与失败行为

1. 没有 `models.json` 时才读取旧 `ORBIT_AGENT_*` 环境配置，并显示为只读 `environment` 配置。原生 API provider 可继续使用标准密钥环境变量。
2. 第一次保存配置后以文件为准，初始选择为空，需要显式激活。之后即使删空、没有 active profile、凭据失效或文件损坏，也不会自动使用环境变量或另一套配置。
3. 回复中、配置更新中或连接测试中拒绝保存、删除、激活和测试。用户可先停止回复再切换。
4. 切换使用新的 Pi 模型运行时及凭据解析器，复用当前 `SessionManager`；保留 session ID、历史、轮次去重信息和业务任务。已存在的模型上下文会随下一轮发送到新选择的服务。
5. 初始化目标模型成功后持久化选择；失败保留原配置，并尝试恢复原运行时。原凭据也失效时解除运行时绑定，修复后重新激活，不继续使用尚未保存的目标配置。删除 active profile 后变为未配置，历史和“仅保存需求”仍可用。
6. 过期登录在接受新输入前拒绝，不追加用户消息或调用业务工具。连接测试发送一次简短提示，不挂载工具、不创建 Pi 会话、不写聊天或业务任务，不改变 active profile。显式调用连接测试会产生对应模型的少量用量。

## 给 PR2 的接口

类型定义在 [`domains/models/model.ts`](../src/domains/models/model.ts)，通过 `OrbitApi.models` 暴露。所有请求仍经过主进程可信窗口 / 主 frame 校验和输入验证。

| `window.orbit.models` 方法 | 行为 |
| --- | --- |
| `read()` | 返回 provider 定义、配置视图、`activeProfileId` 和配置文件错误；每项只有 `hasApiKey`，不返回凭据。 |
| `catalog(providerId)` | 返回经支持策略筛选的 SDK 目录 `{ id, name, contextWindow, maxTokens }[]`；custom 返回空列表。 |
| `save(input)` | 无 `id` 时新增；有 `id` 时编辑现有配置。返回配置状态，不自动激活。 |
| `remove(id)` | 删除配置；删除 active 项同时清空选择。 |
| `activate(id)` | 激活配置，或重新初始化同一配置。 |
| `detectCodex()` | 返回 `available / missing / expired / invalid / api-key`、说明及可选到期时间。 |
| `test(id)` | 测试已保存的配置，返回 `{ ok, message }`；不改变当前选择。 |
| `onChanged(listener)` | 订阅保存 / 删除 / 激活后的配置状态，返回取消订阅函数。 |

尚无模型设置页面，开发时可在应用开发者工具中调用接口，例如添加本机兼容服务：

```js
const state = await window.orbit.models.save({
  name: '本机模型', source: 'api', providerId: 'custom',
  modelId: 'your-model-id', baseUrl: 'http://127.0.0.1:8000/v1',
  contextWindow: 32768, maxTokens: 4096, apiKey: 'your-api-key',
});
const id = state.profiles.at(-1).id;
await window.orbit.models.test(id);
await window.orbit.models.activate(id);
```

Codex 配置选择 `source: 'codex-local'`、`providerId: 'openai-codex'`，从 `catalog('openai-codex')` 取得模型 ID，不传 `apiKey` 或地址。API key 在 PR2 表单中应使用密码输入，编辑时留空表示省略字段。

## 包边界与参考

保持单个 npm 包。领域层放 registry、配置契约和验证；应用层编排保存 / 激活 / 回滚；基础设施层提供文件、系统密钥保护、Codex 读取和 Pi 适配。新增 provider 先更新 registry 和所需适配，再补充协议测试；业务工具不用导入 provider 或 Pi 类型。

参考 Hermes 的 [provider runtime 分层](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/provider-runtime.md) 和 [Codex 凭据接入](https://github.com/NousResearch/hermes-agent/blob/main/hermes_cli/auth_codex.py)，复用 provider 注册、配置选择和凭据解析的分工，未复制其 Python 代码。Orbit 的 Codex 接入限定为只读文件，不导入刷新凭据；协议复用已安装的 Pi SDK。系统密钥保护使用 [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)。

## 验证

`npm run check` 包括配置和凭据测试，以及真实 Pi SDK 对本机 HTTP 模型桩的五种 provider 协议测试、跨 provider 会话切换、错误与凭据轮换。测试把固定官方端点重定向至本机，拒绝其他网络请求；不改生产端点，不使用真实账户。

`npm run test:desktop` 在已有桌面回归之外运行 `scripts/model-smoke.mjs`，通过真实 preload / IPC / utility worker 验证系统加密、多配置选择、测试无副作用、回复中拒绝切换、重启与 Codex 过期处理。使用临时 `CODEX_HOME` 和合成 token；不读取用户实际凭据。服务端真实订阅权限与模型可用性仍需用显式连接测试确认。

真实 Codex 订阅验证单独运行：

```sh
npm run build
node scripts/codex-live-smoke.mjs
```

该脚本使用本机 `CODEX_HOME/auth.json` 和真实订阅额度，默认模型为 `gpt-6.1-sol`，可用 `ORBIT_CODEX_SMOKE_MODEL` 指定当前目录中且账号可用的其他模型。它启动真实 Electron，通过 IPC 测试连接，通过聊天输入框验证流式回复、重启后上下文回忆和 `list_tasks` 工具结果。

测试创建并清理独立的临时 Orbit 数据目录，不使用现有任务或会话；Codex 凭据只读、不复制，结束时核对文件摘要未变，并检查 Orbit 配置和会话没有写入 token。安全结果和测试对话截图输出到已忽略的 `artifacts/orbit-codex-live-result.json`、`artifacts/orbit-codex-live-chat.png`。此脚本不纳入 `npm test`、`check` 或 CI；不要在没有真实凭据和用量授权时运行。
