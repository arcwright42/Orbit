# 执行调度与 Context Pack

参考 OpenRig 4b48ca21a9bd072aa05a08b3da6d9c0708e093c5（0.6.9）。按源码行为适配本地 TypeScript 领域模块，没有把上游仓库放进 third_party，也不宣称完整 rigspec/API 兼容。

## 已接入真实应用的行为

| 上游领域 | Orbit 行为 |
| --- | --- |
| workflow-types / projector / frontier | 可配置角色、步骤、静态依赖、并行与汇合、done/failed 路由、结构化审核返工、流转上限；双角色是默认模板，不是类型限制 |
| rig / role / topology | 持久成员与声明连线；后台 handoff 必须匹配同团队允许目标；审核角色不能把审核责任委托给作者 |
| queue-repository | 幂等请求、优先级、代际保护、事务交接、阻塞关系、定时唤醒和退避；阻塞项终态会重新唤醒依赖者核对结果 |
| queue-pickup | 三分钟无事件时提示停滞，不据此判死、重跑或宣布完成 |
| runtime-adapter / successor | 仅 Codex exec/resume；原生会话 ID 持久化；已停止的失败执行可显式切换新会话；完整 JSONL 事件与结果证据落盘 |
| runtime reconciliation | 按义务与代际核对持久结果；缺少结果时仅在记录的 PID 已不存在时确认停止，不把进程退出当作成功；无法核对的运行继续保留 unknown |
| human gates | 用户问题与审批分开；普通回答/重试不能绕过审批步骤 |
| seat recap / learned | 团队稳定席位的 RECAP、不可覆盖的来源版本与 LEARNED；结构化 lessons 存入带证据来源的团队 MemoryStore，在后续任务查询并注入 |
| context-packs | 文件 manifest、atoms/sections、依赖闭包、作者顺序、运行时/情境、来源及预算报告；RECAP 根目录绑定稳定席位 |

前台工具统一由 application/platform-tools.ts 执行，详见 [工具说明](AGENT-TOOLS.md)。文本与语音目前暴露同一完整工具集，不先限制语音或强制转文本。模板查询返回摘要，按需读取详情；模板更新不改变实例；创建团队不启动任务。

## 产品约定

- 后台初版只支持 Codex，其他 Runtime 明确延期。
- 关闭 Mac 窗口继续后台执行；彻底退出停止任务。再次启动先恢复记录，用户显式继续后才执行。
- 默认建立任务目录，可选择已有项目绝对目录；任务开始后不悄悄更换目录。
- 经验按团队积累，席位 ID 稳定；原生执行会话按 task×seat 隔离，跨任务通过有来源的经验衔接。
- Pi 用于前台文本 harness，256K 窗口，复用原生 compaction/Session；Qwen 用于短上下文语音。没有另写压缩器。

## 持久化与执行边界

TaskExecutionService 保存流程配置快照、步骤运行状态、执行义务 ID、返工次数和成果。默认全局四路并发，同一稳定席位串行，不再锁住整个团队。共享项目中的并行角色仍需按任务划分工作文件；目录不是独立操作系统沙箱。Codex 使用 workspace-write 与 never 审批设置。

每个 completed 回执需要进程正常退出、原生 ID、结构化结果和成果路径核验；审核必须有 pass/changes_requested，缺失结论不能进入待验收。用户任务只有明确验收后才 completed。

取消覆盖任务所有分支，等待进程 close；SIGTERM 不结束时再 SIGKILL。取消期间禁止继续交接。退出等待派发、投影、取消及数据库写入收尾，排队与等待任务保留恢复状态。未知旧进程仍占用其席位与容量，不能因时间超限重复执行。

团队经验是模型撰写的、有来源的记录，不是已被平台证明的事实。按团队 scope 隔离；自动收集仅来自后台 lessons/recap，不会把所有用户对话自动抽取成个人 Memory。版本记录与最新 RECAP 分开，旧结果重放不会覆盖更新的席位记录。

## 仍未对齐的范围

以下明确保留为缺口，不算已完成，也不归为用户确认的产品简化：

- 任意 OpenRig rigspec 的直接导入、全部工作流 schema、异常 orchestrator 路由、运行中增删/迁移成员与复杂 successor 协议。
- next_hop 当前只映射 done/failed。handoff 转移当前义务，waiting 停放；两者映射到新步骤的上游语义尚未移植，配置会拒绝而非忽略。
- tmux pane/mechanized pull、watchdog 多级提醒与升级策略。现有实现为 Codex 进程调度、持久等待/唤醒、停滞提示和有证据的恢复。
- 原生登录/信任/资源投影完整 readiness 流程；当前提供运行失败分类和原生进程/结果核对。
- 上下文 named profile 选择入口、原生压缩事件后的特定 profile 注入。上游手动 guided compaction 主要针对 Claude，不能把其实现当成 Codex 已有同等协议；Codex 压缩交给自身。
- RECAP 全部上游 Markdown 地址约束/作者质量检查、经验管理 UI、执行事件的完整分页 UI。
- Orbit 的 Room、search_history/read_history 属于另一个需求，未用团队 Memory 冒充完成。

不将上游声明但尚未落地的跨主机队列路由、动态 spawn budget 等计入已实现能力。

## 验证

npm run check：类型、离线测试、构建。新增集成覆盖结构化审核返工、并行汇合、交接环上限、审批不可绕过、模板版本与实例隔离、共用平台工具、经验来源与跨任务持久化、退出/重启恢复、定时退避、原生执行记录恢复和项目目录边界。

npm run test:desktop：Electron 离线保存、取消、重启、模板选择与创建三角色团队回归。

node scripts/voice-smoke.mjs：本轮完整工具集已被官方 Qwen 实时会话接受，使用合成麦克风完成连接/停止与本地唤醒初始化；不等于已验证语音模型对全部工具的选择质量。

npx tsx scripts/team-execution-smoke.ts：真实已登录 Codex，在隔离目录由执行者创建精确文本文件，独立审核返回结构化结论，记录两份团队经验，用户验收。会使用实际模型额度。本轮已通过。

node scripts/execution-smoke.mjs：另一个需要配置前台模型的全链路测试。本轮没有据后端 Codex 验证推断所有云端前台模型/语音组合都通过；Pi 的工具协议通过本地 SSE 与真实 Pi harness 测试验证。
