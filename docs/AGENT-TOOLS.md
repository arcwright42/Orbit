# 常驻 Agent 平台工具

模板是可复用的角色/流程配方；团队是持久成员与经验的实例；任务是一次具体工作；执行步骤是后台队列义务。Pi 文本和 Qwen 语音调用同一个 application/platform-tools.ts，不分别实现业务规则。

## 模板与团队

| 工具 | 输入 | 返回 / 行为 |
| --- | --- | --- |
| list_team_templates | query? | 模板 ID、名称、说明、版本、角色摘要；不返回全部配置，减少语音上下文占用 |
| get_team_template | templateId | 完整成员、连线、步骤、依赖、审核规则与版本 |
| save_team_template | templateId、name、description、config、expectedRevision | 保存可复用配置；新建版本传 0，修改必须匹配当前版本；禁止覆盖内置模板 |
| list_teams | 无 | 已创建团队摘要；先判断能否复用 |
| get_team | teamId | 团队实例的实际配置、成员、工作区与上下文包 |
| create_team | name、templateId? 或 config? | 从模板快照创建独立团队；均省略时使用 build-review；创建不派发任务；同工具调用 ID 重放不重复创建 |
| search_team_memory | teamId、query | 团队经验、原始执行证据来源；不跨团队读取 |

内置 build-review（执行→审核→不通过返工）和 parallel-research（两路并行→汇总）。模板更新不修改已有团队，也不改变正在运行的流程。自定义模板仅在用户希望复用方案时保存；一次性编排可以直接传 config。

不提供任意 update_team 或 write_memory 万能接口。运行中的成员/角色变更涉及队列所有权、原生会话和知识来源，不能靠修改 JSON 悄悄替换。经验目前来自后台执行的 lessons/recap，有证据来源；常驻 Agent 负责查询，不假装亲自完成工作。

## 任务生命周期

| 工具 | 输入 | 行为 / 约束 |
| --- | --- | --- |
| list_tasks | 无 | 查询真实任务状态 |
| save_request | text、attachmentIds? | 幂等保存需求，不执行 |
| dispatch_task | taskId、teamId、directory? | 默认建立任务目录；显式指定时使用已有绝对目录；启动已保存的任务 |
| get_task_execution | taskId | 步骤、角色、执行义务 ID、阻塞、成果、工作目录及事件 |
| answer_task | taskId、answer、itemId? | 回答等待用户信息的步骤；不能绕过审批 |
| approve_task_step | taskId、answer、itemId? | 用户明确批准审批步骤后才调用 |
| retry_task | taskId、itemId? | 恢复退出时暂停的任务，或重试已确认停止的失败执行；未知进程不可重跑 |
| rotate_task_session | taskId、itemId? | 对已停止的失败执行启用新 Codex 会话，继承任务与团队知识；不改变任务 ID |
| revise_task | taskId、feedback | 待验收任务返工，保留任务内会话与先前成果 |
| accept_task | taskId | 用户明确验收后才完成任务；后台 completed 不代表用户接受 |
| cancel_task | taskId | 用户明确要求取消；覆盖全部分支；确认进程退出后才结束 |

并行执行时先用 get_task_execution 获取 itemId，再对特定步骤操作。省略时选择首个待处理步骤。后台成员按声明的团队连线交接当前义务；前台不直接操作底层队列表或进程。

## 默认调用顺序

1. list_teams → get_team：寻找适合复用的团队。
2. 需要新团队：list_team_templates → get_team_template → create_team。
3. save_request → dispatch_task：明确区分保存和执行。
4. get_task_execution：报告真实进度；有问题时 answer_task，有审批时等待用户明确批准。
5. 成果提交后，由用户选择 accept_task 或 revise_task。

创建新模板、批准步骤、验收、取消的意图边界写入工具说明和前台提示。业务层另外验证任务状态、版本、角色/连线、依赖与进程停止证据。不能把模型提示当作已经实现了外部权限系统。

## 配置语言

配置使用 members、edges、workflow（entry、steps、max_hops）。步骤支持 actor_role、objective、depends_on、review、allowed_exits、next_hop.on.done/failed、human:user gate。仅 Codex；未知配置字段拒绝处理。

这是 Orbit 的有界工作流配置，不宣称可直接导入任意 OpenRig rigspec。handoff 转移当前义务、waiting 停放当前义务；这两个结果目前不能用 next_hop 映射成新步骤。完整上游异常策略、运行时拓扑修改、任意上游模板转换仍需独立实现，不能靠工具名称宣称已支持。


## 后台 Codex 工具

后台成员通过原生命令工具调用随应用打包的 `orbit-agent.cjs`，使用当前执行代次专属的本机接口。无需再套一层 Agent harness。

| 工具 | 范围与行为 |
| --- | --- |
| list_work / get_work | 当前任务的执行义务与状态 |
| get_team | 本团队角色和经过审核隔离过滤的交接目标 |
| search_team_memory / read_team_memory | 本团队经验及来源 |
| report_progress | 写入当前义务的进度事件 |
| handoff_work / wait_work / request_help | 准备交接、等待或用户提问 |
| complete_work | 准备成果、审核结论、经验或异常恢复建议 |

结束类工具只准备意图；原生进程正常退出、成果核验通过后才提交。重复 requestId 幂等，冲突意图拒绝；凭证在进程结束时撤销。业务接口校验任务、团队、执行代次及取消状态。为了访问本机接口，Codex workspace-write 启用 network_access；这不是只允许回环网络的防火墙配置。

工作流可配置 `exception_routing: { orchestrator_role: "coordinator", default: "orchestrator", classes: { stuck_overdue: "human_only" } }`。协调者必须是声明的团队成员。缺省/类级路由支持 orchestrator、human_only；未声明协调者则留给用户处理。人工审批和认证阻塞不能交给模型代批。诊断完成不代表任务完成，只有已停止的执行才能 retry/rotate。
