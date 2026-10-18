# Orbit

面向个人用户的桌面 AI 工作空间。产品目标是通过常驻交互 Agent 接收文本、语音和多媒体输入，自动组织执行团队、派发任务并跟进结果。

常驻交互 Agent 负责理解与调度，具体工作由执行团队完成。

## 文档导航

| 文档 | 解决什么问题 |
| --- | --- |
| [Repository Map · 源码地图](docs/REPOSITORY_MAP.md) | 每个模块和代码文件负责什么，主要调用链是什么，修改某项功能从哪里开始。 |
| [架构与开发进度](docs/ARCHITECTURE.md) | 模块边界、状态归属、Pi SDK 接入方式、当前实现与下一步。 |
| [模型配置与 Provider 接入](docs/MODEL_PROVIDERS.md) | PR1 支持的模型来源、配置优先级、凭据边界和供 PR2 使用的接口。 |
| [Room 与共享历史](docs/ROOM_HISTORY.md) | Room / session 边界、文件存储、历史工具、上下文同步和两 PR 拆分。 |
| [产品需求](docs/PRODUCT.md) | 产品定位、职责边界、目标交互、团队编排与验收场景，包含尚未实现的规划。 |
| [业务链路 HTML · 历史快照](docs/orbit-business-flow.html) | 基于 `main@d3ee5e1` 的 Pi 接入前业务链路，可离线打开；当前实现以源码地图和架构文档为准。 |

初次读代码建议从源码地图开始，再按需要查看架构与产品文档。仓库当前是单个 `orbit-desktop` npm 包，内部按职责划分模块。

## 本地运行

需要 Node.js 22.19+。当前在 macOS 上开发和验证。

```sh
npm ci
npm run dev
```

开发模式支持界面热更新；修改 Electron 或领域代码后需重启开发进程。首次启动会下载 Electron 运行环境。

```sh
npm run build
npm start
```

生产构建当前用于本地启动，尚未提供签名安装包。

## 当前能力

- Electron + React 桌面主入口、任务、文件和语音设置页面。
- Pi Coding Agent SDK 1.3.0 驱动持续文字对话，支持流式回复、停止和重启恢复。
- 模型配置后端：多套 API 配置、本地 Codex 登录复用、连接测试和空闲时切换。模型设置界面留到 PR2。
- Orbit 业务层定义交互职责及 `list_tasks`、`save_request`、`read_history`、`search_history` 工具；普通聊天不创建任务。
- 需求和附件本地保存、任务查看与待派发任务取消、重启恢复。
- 附件通过系统文件选择器导入副本，支持 TXT、Markdown、PDF、图片、DOCX 和 CSV；每个最多 25 MB，每次需求最多 8 个。当前只接收和打开文件，不解析内容。
- Qwen 实时语音对话、本地关键词唤醒，与文字共用 Room 上下文及四个工具。统一时间线和语音切换 UI 在 Room PR2 接入。

**当前没有自动团队创建和任务执行能力**。交互 Agent 通过业务工具保存待派发需求，任务卡显示真实业务状态；“仅保存需求”保留直接保存入口。团队编排和执行将在 SDK 上层的业务层继续实现。

任务、系统回执和附件元信息使用 SQLite，默认位于 Electron 的 Orbit 用户数据目录（macOS 通常为 `~/Library/Application Support/Orbit`），附件保存在同目录。共享历史按 session 保存在 `rooms/main/history/`，Pi 原生记录保存在 `rooms/main/runtime/pi/sessions/`。旧 `agent/sessions/` 首次启动时复制迁移，原文件保留。可通过 `ORBIT_DATA_DIR` 指定隔离目录。关闭窗口后保留应用；通过应用菜单或 `⌘Q` 退出会停止回复并关闭 Agent 进程。

## 文字交互 Agent

依赖直接安装官方 `@earendil-works/pi-coding-agent` 与 `@earendil-works/pi-ai`，均锁定 1.3.0，不需要另外安装 Pi CLI。Pi 运行在 Electron 管理的独立进程中，界面只接收 Orbit 定义的消息和状态。

模型配置层支持 OpenAI、Anthropic、OpenRouter、自定义 Chat Completions 服务和本地 Codex ChatGPT 登录。可保存多套配置，显式激活其中一套；切换保留当前 Pi 会话及任务。PR1 提供 `window.orbit.models` 接口，模型设置页面将在 PR2 实现，接口示例见 [模型配置文档](docs/MODEL_PROVIDERS.md)。

API key 由主进程使用 Electron `safeStorage` 加密，随配置写入 `<userData>/models.json`，界面读取时只有 `hasApiKey`。本地 Codex 来源每次调用只读 `CODEX_HOME/auth.json`（默认 `~/.codex/auth.json`）中的有效 access token；不复制 refresh token，不代替 Codex 登录、刷新或回写文件。首版不支持系统凭据库中的 Codex 登录，也未接入 Claude Code。

尚未保存过模型配置时，可继续复制 `.env.example` 为 `.env`（已有文件时追加文字配置，不覆盖语音配置），选择以下一种方式，然后重启应用：

- **Pi 内置服务商**：设置 `ORBIT_AGENT_PROVIDER` 和对应的 `ORBIT_AGENT_MODEL`；使用该服务商标准的密钥环境变量，或设置 `ORBIT_AGENT_API_KEY`。
- **Chat Completions 兼容服务**：设置 `ORBIT_AGENT_BASE_URL`、`ORBIT_AGENT_MODEL`、`ORBIT_AGENT_API_KEY`。地址包含 API 前缀，例如 `https://your-provider.example/v1`，不要包含 `/chat/completions`。配置了此地址时优先使用它。
- **本地 Codex 登录**：设置 `ORBIT_AGENT_PROVIDER=openai-codex` 和该 provider 目录中的 `ORBIT_AGENT_MODEL`，不填写 API key；先在 Codex 完成 ChatGPT 文件式登录。

兼容服务的上下文窗口默认 32,768 token、最大输出 4,096 token，可通过 `ORBIT_AGENT_CONTEXT_WINDOW` / `ORBIT_AGENT_MAX_TOKENS` 按实际模型调整。当前兼容服务按文字、非推理模型配置；需要特定推理协议的模型应使用内置服务商。密钥只在主进程和 Agent 子进程使用，不发送给界面，也不写入会话配置。

`models.json` 一旦存在便成为唯一配置来源。第一次保存配置后需显式激活；删除当前配置、凭据失效或文件损坏都不会自动使用环境变量或另一套配置。配置文件损坏时保留原文件并报告错误。

未配置模型时仍可查看历史、管理任务和附件，并使用“仅保存需求”。文字模型配置与 Qwen 实时语音配置独立，不会把语音 WebSocket 地址当作文字接口。

交互 Agent 开放查询任务、保存需求和两个只读历史工具，不加载用户目录或项目中的 Pi 扩展、技能、MCP、规则文件，也不开放终端和文件修改。附件只传递元信息；每轮最多创建一项待派发需求。业务任务以 SQLite 为准，Room 文件保存两个通道的可见历史和回执。最近上下文自动同步，更早内容通过历史工具读取；Pi 默认上下文上限 256k，受实际模型容量约束。主动 session 轮换策略留到后续讨论，详见 [Room 文档](docs/ROOM_HISTORY.md)。

SDK 资料：[官方 SDK](https://pi.dev/docs/latest/sdk) · [官方定制示例](https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/examples/sdk/12-full-control.ts)。

## 验证

```sh
npm run check
npm run test:desktop
```

桌面测试需要图形会话，使用临时数据目录和本机 HTTP 模型桩，运行真实 Pi SDK 与独立进程，覆盖聊天、业务工具、任务取消、会话恢复、停止回复、语音设置，以及模型配置 IPC、系统密钥加密、模型切换、重启和 Codex 只读凭据。不调用真实云端模型，不读取用户实际 Codex 凭据。截图输出到已忽略的 `artifacts/`。

显式运行 `node scripts/codex-live-smoke.mjs` 可用本机 Codex 登录做真实端到端验证（需先构建）。它使用隔离的 Orbit 数据目录，验证连接、流式回复、重启续聊和任务查询工具，会消耗少量订阅额度。默认 `gpt-6.1-sol`，可通过 `ORBIT_CODEX_SMOKE_MODEL` 指定账号可用模型；不会修改 Codex 登录文件。详见 [模型配置文档](docs/MODEL_PROVIDERS.md#验证)。

首版使用 TypeScript 快速开发。采用职责清晰的模块化设计，按实际用例接入所需能力，再逐步优化和迭代。

## 实时语音与本地唤醒

复制 `.env.example` 为 `.env`，填写百炼密钥及对应业务空间的 WebSocket 地址。密钥仅由 Electron 主进程读取，不进入网页构建，`.env` 已忽略。修改配置后重启应用。

```sh
npm run setup:voice
npm run build
npm start
```

点击输入框旁的语音按钮开始连续对话；在设置里点“开启语音唤醒”，说“Hey Orbit”，等显示“正在聆听”后再说需求。待唤醒阶段仅本机识别；唤醒后上传音频至百炼。结束语音会断开连接并释放麦克风，再次唤醒需重新开启。应用隐藏后仍可监听，退出应用则停止。

当前语音支持查询真实本机任务、保存待派发需求；普通聊天不自动创建任务。语音转写按 session 写入 Room 文件，保存的需求进入 SQLite。文字输入通过 Pi 处理，两种通道共享最近上下文和历史工具；Qwen 采用官方 `max_history_turns=20`。支持服务端 VAD 打断与播放队列清空，真人唤醒率、扬声器回声和弱网表现需继续实测。

实现参考 Relay 的本地关键词检测后开启云端会话的流程，使用 sherpa-onnx 1.13.8 和中英 3M 关键词模型；下载脚本校验固定 SHA-256。原生依赖及模型不打入网页。唤醒词定义在 `assets/voice/keywords.txt`，可独立调优。

`node scripts/voice-smoke.mjs` 是显式运行的联网测试，使用模拟麦克风与本地 `.env`，验证官方会话、停止和本地唤醒初始化，会产生少量 API 用量。普通 `npm run check` 不联网。

`node scripts/room-live-smoke.mjs` 使用真实 Codex 与 Qwen、合成语音和临时数据目录验证文字 → 语音 → 文字上下文、历史工具、重启以及凭据隔离；需要 macOS 的 `say` / `afconvert`，会产生真实用量。
