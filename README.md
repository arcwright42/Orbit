# Orbit

面向个人用户的桌面 AI 工作空间。通过常驻交互 Agent 接收文本、语音和多媒体输入，自动组织执行团队、派发任务并跟进结果。

常驻交互 Agent 负责理解与调度，具体工作由执行团队完成。

## 产品文档

- [产品需求](docs/PRODUCT.md)：产品定位、职责边界、交互流程、团队编排、首版建议和验收场景。
- [常驻 Agent 工具](docs/AGENT-TOOLS.md)：模板、团队和执行工具边界。
- [架构与开发进度](docs/ARCHITECTURE.md)：模块边界、OpenRig 对齐点、当前实现与下一步。

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

- Electron + React 桌面主入口、任务、团队、文件和设置页面。
- 前台文本使用 Pi Session SDK＋本地配置的文本模型，实时语音独立使用 Qwen；共用平台工具，可查询、保存需求、创建团队、派发、回答执行问题和取消。
- 本地 Codex 执行者 → 独立检查者 → 用户验收；支持修改后再次执行、真实成果打开和持久事件查看。
- 每个任务独立工作目录，每个角色独立原生会话；重启遇到未知执行先停放，由用户核对停止后恢复。
- 导入文件式 OpenRig Context Pack，按 manifest、atoms、依赖、运行时和情境组装上下文。
- 附件通过系统选择器导入副本；派发仅复制所选附件到本任务目录，具体读取能力由执行器决定。
- OpenRig HTTP 连接设置保留为只读诊断；本机执行不依赖外部 OpenRig daemon。

执行需要已安装并登录 Codex CLI（默认 PATH 或 ~/.local/bin/codex，也可设置 ORBIT_CODEX_BIN）。配置前台模型后可直接发送需求；“保存需求”仍可离线记录，之后从任务详情派发。当前提供执行／检查、并行调研模板，支持自定义角色与流程，完整差异见 [执行机制](docs/EXECUTION-CORE.md)。

数据使用 SQLite，默认位于 Electron 的 Orbit 用户数据目录（macOS 通常为 `~/Library/Application Support/Orbit`），附件保存在同目录。可通过 `ORBIT_DATA_DIR` 指定隔离目录。关闭窗口后保留应用；通过应用菜单或 `⌘Q` 退出。

## 验证

```sh
npm run check
npm run test:desktop
```

桌面测试需要图形会话，使用临时数据目录，覆盖需求保存、取消、重启恢复和连接失败处理。截图输出到已忽略的 `artifacts/`。

首版使用 TypeScript 快速开发，团队编排尽可能对齐 OpenRig 实现。采用职责清晰的模块化设计，先完成可用版本，再逐步优化和创新。

## 实时语音与本地唤醒

复制 `.env.example` 为 `.env`，填写百炼密钥及对应业务空间的 WebSocket 地址。密钥仅由 Electron 主进程读取，不进入网页构建，`.env` 已忽略。修改配置后重启应用。

```sh
npm run setup:voice
npm run build
npm start
```

点击输入框旁的语音按钮开始连续对话；在设置里点“开启语音唤醒”，说“Hey Orbit”，等显示“正在聆听”后再说需求。待唤醒阶段仅本机识别；唤醒后上传音频至百炼。结束语音会断开连接并释放麦克风，再次唤醒需重新开启。应用隐藏后仍可监听，退出应用则停止。

文本和语音均支持真实平台编排工具；普通聊天不自动创建任务。对话及任务保存在 SQLite，新会话提供最近的对话资料。输入框主发送按钮连接交互 Agent，旁边的保存按钮直接记录需求。支持服务端 VAD 打断与播放队列清空，真人唤醒率、扬声器回声和弱网表现需继续实测。

实现参考 Relay 的本地关键词检测后开启云端会话的流程，使用 sherpa-onnx 1.13.8 和中英 3M 关键词模型；下载脚本校验固定 SHA-256。原生依赖及模型不打入网页。唤醒词定义在 `assets/voice/keywords.txt`，可独立调优。

`node scripts/voice-smoke.mjs` 是显式运行的联网测试，使用模拟麦克风与本地 `.env`，验证官方会话、停止和本地唤醒初始化，会产生少量 API 用量。普通 `npm run check` 不联网。

显式运行 node scripts/execution-smoke.mjs（设置 ORBIT_TEST_TEXT_URL、ORBIT_TEST_TEXT_MODEL，按需设置 ORBIT_TEST_TEXT_KEY）可验证前台模型工具派发、真实 Codex 执行与检查、文件内容和 UI 用户验收；使用隔离数据目录，需要有效模型配置及 Codex 登录，会产生模型用量。

## 文本模型设置

在“设置 → 文本交互模型”配置协议、服务地址、模型 ID 和 API Key。支持 Chat Completions、Responses 与 Anthropic Messages；兼容的本机服务可使用 HTTP，无鉴权服务可留空密钥。模型需要支持工具调用。

文本使用 Pi 1.1.0 的 Session SDK（@earendil-works/pi-coding-agent），复用原生会话与自动压缩。只启用 Orbit 平台工具，禁用内置 coding 工具、扩展、MCP、skills 和项目上下文发现，不启动 CLI。文本配置未完成时显示提示，不回退到 Qwen。语音仍使用 .env 中独立的 Qwen 配置。

密钥使用 Electron safeStorage 加密保存于本机，不通过读取接口返回。更换地址或协议会清除旧密钥，防止误发给新服务。修改模型在下次文本请求生效；回复期间先停止再修改。“停止回复”只停止前台推理，不撤销已经派发的后台任务。

Pi 工作窗口设为 256K（262,144 tokens），原生 compaction 开启：预留 16,384 tokens，超过 245,760 tokens 时压缩，保留约 20,000 tokens 的近期消息。Pi 原生 Session entries（包含工具结果、摘要和保留边界）持久化到本地 SQLite；原始条目不因压缩而删除。旧版 textTranscript 首次使用时迁移。

node scripts/text-smoke.mjs 使用本地 SSE 测试服务，验证真实 Pi 工具循环、模型配置、密钥状态、重启以及不使用 Qwen；不产生云端用量。

语音用户转写与 Qwen 回复都会作为 voice 消息写入同一份持久 History；文本消息标记为 text，任务通知标记为 platform。Pi 每轮读取最近的跨通道历史，Qwen 新连接读取同一历史；已有 Qwen 连接在空闲时更新历史，不额外触发播报。切换通道不会清空对话。

Qwen 的平台历史注入预算为估算 16K tokens（包含系统提示与工具定义预算），并设置官方 max_history_turns=8。该参数限制原生语音历史轮次，不是音频/文本合计 16K 的服务端硬 Token 上限。模型实际支持的窗口仍以服务商为准；Orbit 配置不会扩容服务端模型。

压缩由 Pi 在安全轮次边界执行，UI 显示“正在整理上下文”。SDK 原生处理超限恢复与工具配对；压缩失败不写入替代摘要，已保存原文仍可恢复。当前还没有 Room 级 search_history/read_history 工具，不能把保留原文说成已能主动检索。
