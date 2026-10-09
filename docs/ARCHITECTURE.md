# Orbit 架构与开发进度

更新日期：2026-10-10。

采用 TypeScript、Electron、React 和 Vite 的模块化单体。前台 Agent 只沟通和调用平台工具，真实工作由后台原生 Codex 会话执行。当前可运行执行／检查两角色流程，不代表已复现完整 OpenRig。

## 领域边界

| 模块 | 职责 |
| --- | --- |
| renderer / desktop / contracts | 页面、媒体采集、受限 IPC、系统窗口与文件选择 |
| application/workspace | 需求、附件引用和对话持久化 |
| application/task-execution | 产品任务与执行义务之间的流程投影、派发、返工和验收 |
| domains/teams | 团队、角色节点、边、任务会话与原生会话身份 |
| domains/orchestration | 持久队列、claim generation、优先级、阻塞、取消、交接和事件 |
| domains/runtime | Codex 进程启动、恢复、停止与成果证据；外部 OpenRig 只读适配 |
| domains/context | 文件式 context packs、manifest/atoms/依赖与情境组装 |
| domains/memory | Orbit 补充的 SQLite scoped 记忆；不代替 context packs |
| domains/voice | Qwen 文本／语音会话、平台工具、本地关键词唤醒 |
| domains/tasks / materials / infrastructure | 用户任务、资料副本及 SQLite 初始化 |

## 执行链路

前台保存需求并调用派发用例；应用创建任务×角色会话，复制所选资料，持久化 flow，再用稳定 requestId 入队。调度器运行真实 Codex 子进程，读取原生 session ID、结构化回执和真实文件证据。执行者完成后才产生检查者义务；检查完成进入待验收，用户确认后才 completed。返工恢复同任务的原生会话，不串用另一任务上下文。

产品任务保存在 orbit.sqlite，队列、团队、会话和 flow 保存在 execution-core.sqlite。跨库通过稳定标识和可重放投影恢复，不伪装成单事务。启动时未确认退出的执行停放为 runtime:unknown，不能直接重试；用户明确核对旧执行已停止后才解除。

同团队保守串行，全局最多两支团队并发。每个任务隔离工作目录，builder/reviewer 在同一任务目录交换成果。取消等待进程退出；关闭应用等待执行停止与持久化完成。目录隔离并非 OS 安全沙箱，原生 Codex 使用 workspace-write 与 never 审批配置。

## 桌面与模型边界

Renderer 禁用 Node integration，开启 context isolation/sandbox，只暴露命名应用接口。文件通过系统选择器进入受管理目录；成果由运行适配器校验真实路径归属。密钥仅主进程从忽略的 .env 读取，不传给执行器或 renderer。

文本和语音共用前台会话；异步工具结果回写完成前不生成下一轮响应。麦克风音频通过 AudioWorklet 上传，服务端 VAD 打断播放。本地唤醒阶段仅在本机识别，唤醒后连接云端。真人唤醒率与扬声器回声尚未验收。

## 对齐与验证

OpenRig 参考提交为 4b48ca21a9bd072aa05a08b3da6d9c0708e093c5（0.6.9）。逐项行为、当前差异及验证方法见 [执行机制](EXECUTION-CORE.md)。

普通 CI 执行类型检查、离线单元/集成测试和构建。桌面 smoke 使用隔离数据库；execution-smoke 是显式联网测试，覆盖前台工具到真实原生执行与 UI 验收。不能用替身测试代替真实运行证据。
