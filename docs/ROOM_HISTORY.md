# Room、共享上下文与历史工具

更新日期：2026-10-18。

本轮拆为两个 PR：PR1 实现 Room 后端、上下文同步、文件历史和工具；PR2 接入统一时间线、历史翻页、麦克风暂停与恢复 UI。模型设置页面仍是独立的后续工作，不属于这两个 PR。

## 标识与职责

一个本机工作空间使用固定 `roomId=main`。Room 是用户持续交互的入口；Pi session、Qwen session 是可替换的运行上下文。文本继续使用 Pi SDK，语音继续使用 Qwen 官方实时 WebSocket。共享 room 不意味着让两种模型连接同一个供应商 session。

`RoomService` 负责串行化轮次、接收两个通道的可见消息、提供最近上下文、验证工具的 room / generation，并同步业务回执。`turnId` 标识用户的一次输入；文本使用请求 ID，语音使用本地 session ID 加 Qwen 输入 item ID。`save_request` 以 room + turn 生成稳定去重键，重复工具调用不会重复创建任务。不同输入仍是不同轮次，跨轮次语义去重不在本轮范围内。

**本轮不决定主动 session 轮换时机**。不实现定时、闲置或 token 阈值开新 session。Pi 继续原会话并使用原生压缩；Qwen 连接中断后由用户重新开启，文字回复后的语音恢复会建立新连接。它们都沿用相同 room，最近上下文自动注入，更早记录通过历史工具读取。自动重连退避、Qwen 主动摘要和完整的轮换策略留到后续商讨。

## 文件布局

```text
<userData>/rooms/main/
  room.json
  history/
    <ISO时间>--pi--<sessionId>.jsonl
    <ISO时间>--qwen--<localSessionId>.jsonl
    <ISO时间>--system--<sessionId>.jsonl
    <sessionId>.summary.md
  runtime/pi/sessions/
    <Pi 原生 session JSONL>
```

`history/` 是共享可见历史，记录 `id / roomId / sessionId / turnId / seq / channel / role / text / status / createdAt`，按需要包含附件和任务引用。保存文本、转写、业务回执和常驻 Agent 的工具事件，不保存录音。Qwen provider session ID 记录在 `room.json` 的 session 元信息中，本地 session ID 用于连接建立前的归档和轮次标识。

每条可见消息拥有稳定 ID 和顺序号。状态更新追加同 ID 的修订记录；UI 投影取最后一版，grep/read 保留原始修订，可看到中断前后的状态。收到的部分语音转写在停止时标为 interrupted；网络尚未送达的文本无法恢复。Pi 原生会话单独存放，历史工具不能检索其内部协议、思考或配置。Room 在公共工具执行入口记录文字 / 语音的工具名称、参数及结果摘录，每项最多 16,000 字符并明确标注截断；`running → complete / failed` 更新同一条记录。重启时未完成的工具标为 `interrupted`，不会重新执行。升级前未记录的工具事件不补写。

`room.json` 和内存索引可从 JSONL 重建。损坏的索引先备份为 `.corrupt`；损坏的 JSONL 保留原文件，恢复可读记录，后续写入新 segment。主进程单写者，JSONL 每次追加执行 fsync，manifest / 摘要通过临时文件原子替换。SQLite 仍是业务任务事实来源；文件历史与 SQLite 不做跨存储事务，重启会补录缺失回执。

首次启动迁移旧 `agent/sessions` 的可见 Pi 消息、SQLite 用户消息和回执。原文件保留；Pi 运行副本仅调整 header cwd 并保留 session ID、消息 ID、源文件时间，以继续原 session。损坏的旧 Pi 文件只迁移可读消息，不用作运行恢复文件。过去未持久化的语音转写无法补回。迁移是幂等的。

## 上下文与切换

最近上下文只取用户和助手消息，最多 20 个用户轮次、32 KiB，超长消息提供标注过的摘录。工具结果继续由原生运行时提供，Room 不重复注入展示用的工具事件与系统回执。Pi 在接受新输入前用隐藏 `custom_message` 导入自己原生会话之外的新记录，用同步水位避免重复注入。历史被明确标记为参考资料，不能重放工具操作。

Pi context window 使用 `min(262144, 模型声明容量)`，保留和压缩参数也按容量收缩。实际压缩由 Pi 处理，压缩摘要导出至所属 session 的 `.summary.md`；完整可见历史仍保留。Qwen 设置 `max_history_turns=20`，在 `session.updated` 后发送 `conversation.item.create` 注入最近历史，收到每个历史 item 的确认后才接受实时音频。

文字输入到达后，Room 停止当前 Qwen 连接、归档已收到的转写，并发出 paused 状态。Pi 完成后，如果用户没有关闭语音，就建立新的 Qwen session 并同步上下文。用户手动切回语音时先中断 Pi、等待它结束，再开启 Qwen。generation 校验阻止旧轮次的工具副作用；旧 socket 的事件和异步工具结果不会写到新 socket。已提交的业务任务不会因中断回滚。

PR1 后端在 Pi 回复期间丢弃语音帧；PR2 进一步暂停麦克风 track 和采集上传，并清空播放队列。唤醒模式使用相同暂停信号，文字完成后恢复等待唤醒。

## 常驻 Agent 的四个工具

文字和语音都从 `INTERACTION_TOOLS` 注册 `list_tasks`、`save_request`、`read_history`、`search_history`，通过同一个 `InteractionService` 执行。没有 shell、任意文件读取或任务执行权限。

| 工具 | 参数 | 结果 |
| --- | --- | --- |
| `search_history` | `mode: files / content`、`pattern`；可选 `glob / literal / ignoreCase / limit` | 文件列表或文件名、行号、片段；默认字面匹配，显式 `literal=false` 才使用正则。 |
| `read_history` | `file`；可选 `fromLine / limit` 或续读 `cursor` | 带行号的原文、截断标记和 `nextCursor`；游标可在超长行中继续。 |

files 模式使用 Node 的文件名 glob；content 模式使用安装包中的 `@vscode/ripgrep`，不依赖用户 PATH 或启动 shell。范围只限当前 room 的 JSONL 和摘要；拒绝路径跳转、符号链接以及外部文件。检索默认 20 条、最多 100 条，读取默认 50 行、最多 200 行；结果约束在 32 KiB 内，检索有 5 秒超时。检索结果过多时缩小 pattern / glob，再用 read 的游标分页。没有 SQLite FTS、embedding 或语义搜索。

## PR2 使用的接口

```ts
const page = await window.orbit.room.read({ limit: 100 });
const older = await window.orbit.room.read({ before: page.nextCursor, limit: 100 });
const unsubscribe = window.orbit.room.onChanged(state => { /* 按 id 合并，按 seq 排序 */ });
```

`messages` 是最近一页共享历史；`nextCursor` 是下一页的 exclusive before，`activeChannel` 表示当前通道，`status / draft / error` 是 Pi 回复状态。不要再拼接 `workspace.messages`，它们已经归档到 Room。实时事件只含最近一页，UI 应保留已加载的旧页并按 ID 更新。`conversation()` / `onConversation()` 在 PR1 保留旧 Pi 投影，供旧 UI 兼容；输入、停止和语音 IPC 继续复用现有接口。

## 会话事件展示

`SessionTimeline` 将时间线收敛为 User、Assistant、Tool 三类。用户输入靠右，助手正文靠左，以位置和轻底色区分，不将事件名和时间戳逐条排成标题。工具默认折叠成状态行，可用鼠标或键盘展开名称、时间、参数和结果。对应的任务回执与入口并入同轮工具事件；旧记录或“仅保存需求”产生的本地回执也收起为“已记录需求”，完整回执仍可展开读取。助手流式输出、语音标识、中断 / 失败状态、附件、任务入口以及历史翻页保持可用。输入框按 Enter 发送，Shift+Enter 换行，输入法选词期间不会触发发送。会话区域使用圆角输入框和直角用户消息块，无逐条横线、头像和卡片阴影。会话、输入框和工具详情隐藏滚动条，仍支持触控板、滚轮和键盘滚动。助手正文支持 Markdown 段落、列表、代码和 GFM 表格；不执行原始 HTML，也不自动加载远程图片。

本次界面参考（2026-10-19）：

- [Open WebUI UserMessage](https://github.com/open-webui/open-webui/blob/91ea4e3421d1d8069f13d4a463fcb5986d94ea60/src/lib/components/chat/Messages/UserMessage.svelte)：用户消息靠右、宽度受限，正文与输入区域保持一致阅读宽度。Orbit 按要求使用直角。
- [Open WebUI ToolCallDisplay](https://github.com/open-webui/open-webui/blob/91ea4e3421d1d8069f13d4a463fcb5986d94ea60/src/lib/components/common/ToolCallDisplay.svelte) 与 [LibreChat ToolCallGroup](https://github.com/LibreChat-AI/LibreChat/blob/e081b566a42d3a83b8102157bd7806cf4ff63b17/client/src/components/Chat/Messages/Content/ToolCallGroup.tsx)：工具采用紧凑状态与按需展开。Orbit 保留每次实际调用，不引入其调度机制。
- [LobeHub ChatItem](https://github.com/lobehub/lobehub/blob/0e6d403e859b59a0a5cfda37849b804cadf84523/src/features/Conversation/ChatItem/ChatItem.tsx)：区分用户消息块与助手正文；次要信息不占据正文层级。这里只参考布局和交互，自行实现 Orbit 组件。

## 调研取舍

- [ChatGPT Dots channels](https://learn.chatgpt.com/docs/dots/channels) 描述同一 dot 跨文字 / 语音交互；[Tasks and memory](https://learn.chatgpt.com/docs/dots/tasks-and-memory) 描述选择性上下文和长期笔记。这里借鉴入口连续性；公开资料没有披露其内部 room/session schema，本实现不是对其内部机制的断言。
- [OpenClaw session schema](https://docs.openclaw.ai/reference/session-management-compaction/schema) 区分稳定 session key 和运行 session ID；[session search](https://docs.openclaw.ai/concepts/session-search) 把定位与原文读取分开。Orbit 采用标识分层与工具模式，按本项目要求使用文件，不复用其数据库搜索后端。
- [Hermes session_search](https://github.com/NousResearch/hermes-agent/blob/main/tools/session_search_tool.py) 提供历史查找和分段阅读；[compression and caching](https://hermes-agent.nousresearch.com/docs/developer-guide/context-compression-and-caching) 保留压缩前历史。Orbit 保留完整文件并复用 Pi 摘要，不复制 Hermes runtime。
- [Qwen realtime 指南](https://help.aliyun.com/en/model-studio/qwen-audio-realtime-user-guides) 给出 `max_history_turns` 默认 20、范围 1–50；[客户端事件](https://help.aliyun.com/en/model-studio/fun-audiochat-client-events) 支持历史 item 注入；[服务端事件](https://help.aliyun.com/en/model-studio/qwen-audio-realtime-server-events) 提供 item / response ID，用于转写、工具和中断的关联。

## 验证

`npm run check` 覆盖文件查找、行分页及字节限制、损坏恢复、跨 room 隔离、路径拒绝、迁移幂等、真实 Pi SDK 上下文桥接、保存去重、停止后的工具拒绝、语音历史确认与迟到事件隔离。`npm run test:desktop` 回归原界面和模型配置 IPC。

`node scripts/room-live-smoke.mjs` 显式调用真实本地 Codex 登录和 Qwen 配置，在临时 Orbit 目录中验证双向上下文、语音恢复、Pi 调用历史工具、重启和凭据不入历史。macOS `say` / `afconvert` 生成中性测试音频，不采集真实麦克风；会产生真实模型用量。真人打断、回声、弱网和长期运行需后续实测，不能由合成音频测试替代。
