# 执行调度与 Context Pack

参考 OpenRig 4b48ca21a9bd072aa05a08b3da6d9c0708e093c5（0.6.9）。按源码行为适配本地 TypeScript 领域模块，没有把上游仓库放进 third_party，也不宣称完整 rigspec/API 兼容。

## 已接入真实应用的行为

| 上游领域 | Orbit 行为 |
| --- | --- |
| workflow-types / projector / frontier | 可配置角色、步骤、静态依赖、并行与汇合、四类结果的显式路由、角色 gate/验收契约、结构化审核返工、流转上限；双角色是默认模板，不是类型限制 |
| rig / role / topology | 持久成员与声明连线；后台 handoff 必须匹配同团队允许目标；审核角色不能把审核责任委托给作者 |
| queue-repository | 幂等请求、优先级、代际保护、事务交接、阻塞关系、定时唤醒和退避；阻塞项终态会重新唤醒依赖者核对结果 |
| queue-pickup | 持久 watchdog 检测未领取和停滞，支持分步骤策略；不据此判死、重跑或宣布完成 |
| runtime-adapter / successor | 仅 Codex exec/resume；原生会话 ID 持久化；已停止的失败执行先准备新会话、验证 READY，再提交绑定与续跑；完整 JSONL 事件与结果证据落盘 |
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

## 本轮范围与保留的产品决定

本轮补齐工作流结果路由、验收契约、失败续跑、人工异常处理、启动检查、会话接替、watchdog、上下文生命周期与 RECAP 校验。以下是尚待产品决定的独立范围，不混入已实现声明：同角色多个成员及负载选择、后台成员自主创建任意义务和 inbox/outbox、运行中调整团队、任意 OpenRig rigspec/资源包导入导出、团队快照迁移。现有 Orbit 配置仍不是上游所有 YAML 的兼容解析器。

只支持 Codex、完全退出停止工作、默认任务目录属于已确认的产品约定。没有复制 tmux 界面、TUI 输入注入或另写压缩器。上游自身延期的跨主机队列路由、动态 spawn budget、声明但未执行的 invariant 不计入已实现能力。

## 验证

npm run check：类型、离线测试、构建。新增集成覆盖结构化审核返工、并行汇合、交接环上限、审批不可绕过、模板版本与实例隔离、共用平台工具、经验来源与跨任务持久化、退出/重启恢复、定时退避、原生执行记录恢复和项目目录边界。

npm run test:desktop：Electron 离线保存、取消、重启、模板选择与创建三角色团队回归。

node scripts/voice-smoke.mjs：前一轮前台完整工具集已被官方 Qwen 实时会话接受，使用合成麦克风完成连接/停止与本地唤醒初始化；不等于已验证语音模型对全部工具的选择质量。

npx tsx scripts/team-execution-smoke.ts：真实已登录 Codex，在隔离目录由执行者创建精确文本文件，独立审核返回结构化结论，记录两份团队经验，用户验收。会使用实际模型额度。已通过；另有 scripts/successor-smoke.ts 验证真实新会话 READY 与绑定提交。

node scripts/execution-smoke.mjs：另一个需要配置前台模型的全链路测试。本轮没有据后端 Codex 验证推断所有云端前台模型/语音组合都通过；Pi 的工具协议通过本地 SSE 与真实 Pi harness 测试验证。


## 本轮一致性与异常对齐

执行队列关闭、后继入队、工作流前沿、hop 计数与 workflow_transitions 在 execution-core.sqlite 的同一事务提交，嵌套调用使用 SAVEPOINT。失败注入覆盖后继插入异常：旧义务不会残留 done。产品任务列表位于另一数据库，属于可重建的展示投影，不宣称跨库事务。文件经验投影在核心提交后执行，记录成功标记并在后续同步重试。

并行路由到汇合点时等待依赖；交接次数每次实际提交只计一次。工作流保留的审核席位不能接手制作，同一个稳定席位也不能审核自己在该任务中做过的成果。

未映射失败与领取后停滞可路由至配置的协调者，按原义务/代次/异常类型去重。诊断本身是可查询、可取消、可恢复的队列义务，消耗 hop 预算。恢复动作支持 retry、rotate、ask_user、abort；自动重试/轮换要求旧执行已经停止，未知进程和人工授权不会被越过。rotate 保存旧原生会话 lineage，并在新会话就绪后原子提交；准备失败保留旧绑定。新建内置模板默认带协调者，既有团队配置快照不被改写。

后台平台工具实际走短期本机 capability，查询限定任务或团队；结束意图直到 Codex 退出才核验提交。真实 Codex smoke 额外要求执行者和审核者均报告指定进度事件，避免只验证 JSON 最终回执而没有调用工具。


## 生命周期对齐（2026-10-10）

- 工作流：显式 next_hop.on 支持 done/failed/handoff/waiting；映射优先于结构提示。handoff 支持 suggested_roles 与串行声明顺序。保留旧版未映射的当前义务委托，但不得委托给保留的审核席位；要转入审核步骤必须声明路由。静态依赖图的 handoff 完成前置条件。mode=require 要求交接有明确目标；forbid 阻止未映射结构交接。步骤可声明默认等待/退避时间。
- 验收：角色 gate 的接收者由 gate.target 决定，acceptance 必须精确匹配 candidate、允许的 verdict 与 evidence_ref。waiting 不假装提交验收。旧人工前置审批仍兼容；新契约可以携带证据引用。审核与制作席位保持隔离。
- 续跑：workflow_failures 保留失败发生记录，显式恢复重新解析步骤角色并创建新 packet，链接旧 packet，保留已完成分支。每个分支记录 driveHops/resumeCount；用户显式恢复得到新的有界预算，自动协调重试不重置预算，避免无限自恢复。
- 人工异常：human_only、无可用协调者、ask_user、诊断失败都会建立 human:exception 义务。回答记录处理意见；重试/新会话接替是独立显式动作。普通回答不会执行原失败工作或代批 gate。源工作完成、被接替或换代后，旧异常与问题关闭。类级策略优先于工作流，再取 ORBIT_EXCEPTION_POLICY 主机默认（human_only/orchestrator）。
- 启动：执行前检查工作目录读写、Codex 可执行版本和 login status；状态失败明确阻塞，不启动任务。启动上下文作为按执行代次保存的 startup.md 交付记录，实际同内容通过 stdin 传递；不覆盖用户 AGENTS.md，不修改全局配置。资源包安装属于上表待定产品范围。
- 接替：同一稳定席位先取得准备锁，读取交接上下文，以 read-only 新建原生会话并要求 READY；退出正常且新 ID 独立后，旧 lineage、换绑和 redrive 同事务提交。准备失败、代际变化、应用退出均不换绑；中断的准备在重启时废弃。后台 exec 在后续工作时 resume 新 ID，不依赖常驻终端 pane。
- Watchdog：SQLite 保存策略任务、代际、下一次评估、条件回执和交付历史。默认 unclaimed/stalled；可配置 periodic-reminder、context-usage-threshold、artifact-pool-ready、edge-artifact-required，并限定 step_ids。重复条件不重复交付，失败交付回滚后重试；未知进程/暂停工作不自动启动。外部等待有成果/到期证据时重新检查，运行中提醒进入事件与异常协调队列，不向正在执行的进程强塞输入；后台 get_work 可读事件。
- 上下文：成员可配置 context_profiles 与 context_atoms；get_team 返回导入包的目录，configure_team_context 提供无未结束任务时的配置入口。缺省选兼容 profile。原生 rollout 的 compacted/token_count 事实用于 post-compaction 与上下文阈值，不用累计计费量冒充上下文使用率。原生压缩仍由 Codex 自己完成；后台 read_context 可在工具边界重新读取 profile，下一次执行也重新注入。不会声称闭合 stdin 的 exec 支持任意时刻的中途注入。
- RECAP：写入前拒绝重复 Markdown 地址与未闭合代码围栏；作者结构提示写入 RECAP.advisories.json，不据此否定成果语义。已归档版本与来源仍保留。

平台工具：前台 19 个（文本/语音共享），后台 11 个。新增能力通过真实入口调用，生命周期测试覆盖回滚、代际、重启、退出与独立审核。真实模型测试不替代所有失败分支的确定性测试。
