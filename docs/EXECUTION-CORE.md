# 执行调度与 Context Pack

更新日期：2026-10-10。参考 OpenRig 提交 4b48ca21a9bd072aa05a08b3da6d9c0708e093c5，版本 0.6.9。Orbit 参考行为实现本地模块，不宣称 schema/API 兼容或已移植整个 daemon。

## 已接入的行为

| OpenRig 源码领域 | Orbit 实现 |
| --- | --- |
| queue-repository / claim generation | 执行义务与用户任务分离；来源、目的、优先级、请求幂等、claim 代际、事务 handoff、阻塞与追加事件 |
| queue-owner / sessions | 持久团队、节点、边；task×seat 会话与 Codex native ID 分开保存，拒绝跨任务复用原生会话 |
| queue-pickup | 根据状态和最新事件区分未领取、工作中、领取后停滞、停放和终态；不凭计时器宣布完成 |
| runtime-adapter | 实际 Codex exec/resume、JSON 事件、schema 回执、真实文件路径校验、证据落盘、进程退出确认 |
| human blockers | 执行者返回问题后进入 human:user；用户回答写入原义务并恢复同一会话 |
| workflow / handoff | 产品执行者→检查者两阶段流程；稳定阶段 requestId，重启投影；用户验收／返工独立于队列 done |
| context-packs | 文件 manifest.yaml、声明文件、world/lore/skills/mission、atoms/sections、requires 闭包、作者顺序、runtime/situation、来源与预算报告 |

前台文本通过 Pi Session SDK 调用本地配置的模型，Qwen 仅处理语音。两者均有查询、保存、创建团队、派发、回答和取消工具。工具返回真实平台状态，具体文件工作由 Codex 执行。桌面任务详情支持派发、问题回答、重试、取消、修改要求、成果打开和验收。

## 运行、持久化与取消

TaskExecutionService 将用户任务与队列义务关联，持久化当前 phase/cycle/itemId。每个任务有独立目录，每个角色独立原生会话；返工保留本任务会话。启动恢复不盲目重跑未知进程。runtime:unknown 同时保留容量与执行者占用，界面要求核对旧运行已停止后显式恢复。

调度按团队串行、全局两支团队并发。claim generation 阻止迟到回执改写新一代执行。completed 回执需要进程正常退出、有效 native ID、结构化结果及成果文件；检查者独立读取后任务进入 review，只有用户验收才 completed。退出码和文件存在不能证明成果语义正确，仍由检查与用户验收把关。

取消发 SIGTERM，必要时 SIGKILL，收到进程 close 才确认；不能把 AbortSignal 当作已停止。取消阶段切换窗口时阻止下一阶段入队。已验收任务不会被取消改写。准备上下文失败归类为可修复的 context:preparation，不误标为仍在运行。关闭应用等待派发、投影和执行收尾后再关闭数据库。

## Context Pack 与补充记忆

在团队页通过文件选择器导入 pack。导入只复制 manifest 声明的内容，拒绝路径/符号链接越界和超限文件；保存受管理副本后绑定团队。原生执行前组装 pack，注入带来源的上下文；超过预算明确阻塞，不静默裁断内容。

核心支持 fresh、handover、post-compaction 与 named profiles。应用目前使用默认 fresh/handover 组合；自动检测原生上下文压缩并触发 post-compaction、UI profile 选择尚未接通。细则见 src/domains/context/README.md。

MemoryStore 是 Orbit 补充能力：显式 personal/team/task scope、来源、版本冲突控制、启停删除、字面检索和字符预算。没有 embeddings，也没有自动将所有对话存入个人记忆；它不是 OpenRig Memory 的替代品。

## 尚未对齐，不能算作已完成

- 任意 rig spec、复杂角色拓扑、通用 workflow frontier、异常路由与动态 successor；当前产品只提供两角色模板。
- 完整 mechanized pull/wake/pane、watchdog 分级唤醒与恢复算法；当前为进程端口主动调度和证据停滞提示。
- Claude Code adapter、tmux readiness/harness、跨主机 agent 运维。
- 外部 daemon SSE 的持久消费游标与客户端回放；本地队列事件持久化，UI 使用本地状态更新及最近事件。
- 人工权限决策类型的完整自动 unpark 规则；当前重点接通用户问题和未知执行核对。
- 自动 post-compaction 注入、上下文 profile UI、个人记忆管理 UI。

这些是实现缺口，不作为“C 端产品取舍”自动划掉。确定的产品差异是常驻多模态交互入口，以及面向用户的结果验收。

## 验证

npm run check 覆盖类型、离线测试和构建。核心测试验证 claim 互斥、幂等冲突、优先级、handoff 回滚、代际保护、取消与恢复、scope/版本隔离和上下文预算。新增集成覆盖任务会话隔离、重复派发、执行/检查/验收、问题恢复、取消、关闭、损坏证据隔离和上下文准备错误；语音测试覆盖异步工具等待及旧会话隔离。

node scripts/execution-smoke.mjs 使用真实前台模型与已登录的本地 Codex，在临时数据目录创建 hello.txt，核验精确内容，经过独立检查，最后点击 UI 验收。原 Qwen 前台版本已在本机通过；切换 Pi 后需配置 ORBIT_TEST_TEXT_URL/MODEL/KEY 重新运行云端全链路。当前 Pi 路由通过真实 harness＋本地 SSE 服务及桌面测试验证，不宣称已经验证用户选择的云端模型。需要显式运行并会产生模型用量。npm run test:desktop 保持离线保存、取消和重启回归。

前台上下文：使用 Pi 自带阈值 compaction（256K 窗口、16K reserve、20K recent），不再由 Orbit 按固定轮数裁剪。原生摘要、保留边界与全部 Session entries 持久化；自动阈值压缩、成功恢复与失败保留原文经过本地 SSE 测试。Qwen 采用 max_history_turns=8，平台注入历史预算估算 16K。
