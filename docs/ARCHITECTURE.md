# Orbit 架构与开发进度

更新日期：2026-10-17。

逐目录、逐文件的职责与修改入口见 [Repository Map](REPOSITORY_MAP.md)；启动与配置见 [README](../README.md)，产品目标见 [PRODUCT.md](PRODUCT.md)。

Orbit 使用 TypeScript、Electron、React、Vite 和 Pi Coding Agent SDK 1.3.0。当前提供持续文字交互、需求管理、附件、任务看板、Qwen 实时语音与本地唤醒。自动团队编排与任务执行尚未接入。

## 模块职责

| 目录 | 职责 | 边界 |
| --- | --- | --- |
| `src/renderer` | 页面、输入、流式回复、语音采集播放 | 只通过预加载接口访问应用能力 |
| `src/desktop` | 窗口、菜单、文件选择、权限、受限 IPC、Agent 子进程入口 | 主进程持有业务服务，独立进程运行 Pi |
| `src/application/interaction.ts` | 交互身份、业务工具定义、附件范围和输入校验 | 不依赖 Pi 的类型或内部实现 |
| `src/application/workspace.ts` | 需求保存、附件与工作空间视图 | 业务事务和任务回执 |
| `src/domains/conversation` | Agent 运行接口、输入和工具契约、系统回执 | 不绑定具体 SDK 或模型供应商 |
| `src/domains/tasks` | 任务、校验、请求去重、待派发取消 | 当前支持本地需求管理 |
| `src/domains/materials` | 附件副本和元信息 | 内容解析尚未接入 |
| `src/domains/voice` | Qwen WebSocket 会话、本地关键词检测 | 查询任务和保存需求两个工具 |
| `src/infrastructure/pi` | SDK 适配、进程协议、会话恢复、模型配置与事件投影 | 消费官方 SDK，不复制或修改 Pi 内核 |
| `src/infrastructure/database.ts` | SQLite 初始化与事务 | 业务状态规则由领域负责 |
| `src/contracts.ts` | 可序列化的客户端应用接口 | 不向界面传递密钥、Pi 对象或本机文件路径 |

## 文字业务链路

1. 界面发送文本、请求标识和附件标识，经受限 IPC 进入应用层。
2. `InteractionService.prepare` 验证文本、附件数量及本机附件记录。
3. `PiAgentHost` 管理 Electron utility process，将输入转交 Pi SDK。
4. `PiSession` 调用 `createAgentSession`、`prompt` 和事件订阅，使用明确的提示词与业务工具白名单。
5. Pi 调用业务工具时，子进程把调用转给主进程；`InteractionService` 调用 `WorkspaceService`，数据库写入仍在主进程完成。
6. Pi 的文字事件投影为 Orbit 对话状态，界面显示流式回复；业务任务以 SQLite 中的实际记录为准。

问候与澄清不创建任务。`list_tasks` 读取真实任务，`save_request` 保存一项待派发需求；常驻交互 Agent 不执行编程、研究和成果制作。工具成功与模型回复结束都不能把任务标记为已执行。

## 状态归属与恢复

- **Pi 原生 JSONL**：`agent/sessions/` 保存模型消息、工具结果、会话树和压缩记录。Orbit 读取 Pi 会话生成界面视图，不在 SQLite 维护第二份模型历史。
- **Pi 自定义条目**：保存 Orbit 请求标识、输入及附件关联、轮次状态。相同标识的不同内容会拒绝；已接收轮次不会在网络重试或重启后自动重放。
- **SQLite**：保存业务任务、系统回执和附件元信息。业务工具以会话标识和请求标识生成稳定的去重键，每轮最多创建一项需求。任务与回执在一个事务提交。
- **文件副本**：由资料领域管理。模型目前只接收附件名称、大小和标识，不能读取内容；工具只能关联这段对话已经提供的附件。
- **异常恢复**：进程崩溃会结束界面的运行状态，下一次访问重建进程并恢复原会话。未确认结束的轮次标记中断，保留已提交任务，不自动重新执行。
- **停止与退出**：停止按钮中断当前回复，不取消已保存的业务任务。应用退出先中断并关闭 Agent，再关闭数据库。关闭 macOS 窗口仍保留应用。

旧版任务、系统回执和附件保持可读。“仅保存需求”继续提供直接保存入口。旧输入和语音对话不自动导入新的 Pi 模型上下文；任务可以通过查询工具读取。

## SDK 与桌面边界

`@earendil-works/pi-coding-agent` 和 `@earendil-works/pi-ai` 固定为 1.3.0。Pi SDK 作为 ESM 依赖运行在独立 worker，构建脚本保留包自身的运行资源；不把 Pi 打入网页，也不另装 CLI。最低 Node.js 版本为 22.19。

通过 `ResourceLoader` 明确提供资源，不读取外部扩展、技能、MCP 或项目规则。当前工具白名单只有 `list_tasks` 和 `save_request`。资源配置、凭据与会话目录独立于用户的 `~/.pi`；凭据来自环境变量，仅在进程内使用。

会话启用 Pi 自带压缩和有限重试，关闭空闲缓存预热。界面使用最终消息覆盖流式草稿；不把低层 `agent_end` 当成整个回复或业务任务已经完成。模型调用和上下文管理归 Pi，业务工具与任务状态机归 Orbit。

Electron 渲染进程使用 context isolation 和 sandbox，禁用 Node integration。主进程校验 IPC 来源，预加载只暴露具体应用接口；文件通过系统选择器导入，再按附件标识打开副本。

## 语音通道

现有 Qwen 实时语音和本地唤醒继续独立运行。语音与文字共享任务业务数据，暂不共享模型历史；语音转写只保留当前界面会话。语音配置与文字模型配置分开，详见 README 和 `.env.example`。

## 下一步业务层

1. 选定最小执行场景，增加任务绑定的独立 Pi 执行会话、工作目录和执行工具集。
2. 在应用层实现团队编排、派发、进度与执行取消，保持常驻交互职责独立。
3. 接入需要用户决定的问题、成果及验收，按实际回执更新业务状态。
4. 增加附件处理与语音/文字会话桥接。

本次引入 SDK 不代表这些执行能力已经完成。

## 验证

`npm run check`：类型检查、离线测试、网页与 Electron 构建。新增测试使用真实 Pi SDK 和本机 HTTP 模型桩，覆盖流式输出、工具白名单、业务去重、附件范围、上下文恢复、中断、服务错误和子进程崩溃。

`npm run test:desktop`：在临时目录中启动真实 Electron 和 Pi worker，通过本机模型桩验证聊天、业务工具、任务取消、重启会话恢复、停止回复和语音设置。截图输出到已忽略的 `artifacts/`。这些测试不产生真实模型用量，也不证明某个云端模型的实际推理质量。

`node scripts/voice-smoke.mjs` 是单独运行的 Qwen 联网验证，使用本地 `.env` 和模拟麦克风，会产生少量 API 用量。
