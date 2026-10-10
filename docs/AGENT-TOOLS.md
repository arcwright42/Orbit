# 常驻 Agent 平台工具

模板是可复用的角色/流程配方；团队是持久成员与经验的实例；任务是一次具体工作；执行步骤是后台队列义务。Pi 文本和 Qwen 语音调用同一个 application/platform-tools.ts，不分别实现业务规则。

## 长期对话历史

| 工具 | 输入 | 返回 / 行为 |
| --- | --- | --- |
| search_history | query、limit?、room_id?、include_tools? | 默认当前 Room 的用户/助手对话，跨语音和文本；返回 message_id、sequence、时间和摘录。include_tools=true 同时查询新保存的工具参数与结果 |
| read_history | message_id、before?、after?；或 cursor、limit?；room_id?、include_tools? | 读取原文与邻近记录，或按 sequence 向后分页。next_cursor / has_more 表示后续记录；context_truncated 表示本页因输出预算缩减了邻近范围 |

长消息返回 text_length / next_text_offset；同一 message_id 配合 before=0、after=0、text_offset 继续读取，直到不再返回 next_text_offset。原文仍完整保存，工具输出的截断不删除历史。Pi 原生压缩与 Qwen 短上下文都不影响该库；不需要模型管理内部 Session ID。Room 当前只有一个默认实例，不提供任意跨 Room 读取。

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

并行执行时先用 get_task_execution 获取 itemId，再对特定步骤操作。省略时选择首个待处理步骤。后台成员按声明的团队连线交接；显式工作流路由创建目标步骤，未映射委托保留当前义务；前台不直接操作底层队列表或进程。

## 默认调用顺序

1. list_teams → get_team：寻找适合复用的团队。
2. 需要新团队：list_team_templates → get_team_template → create_team。
3. save_request → dispatch_task：明确区分保存和执行。
4. get_task_execution：报告真实进度；有问题时 answer_task，有审批时等待用户明确批准。
5. 成果提交后，由用户选择 accept_task 或 revise_task。

创建新模板、批准步骤、验收、取消的意图边界写入工具说明和前台提示。业务层另外验证任务状态、版本、角色/连线、依赖与进程停止证据。不能把模型提示当作已经实现了外部权限系统。

## 配置语言

配置使用 members、edges、workflow（entry、steps、max_hops）。步骤支持 actor_role、objective、depends_on、review、allowed_exits、next_hop.on 的四种结果、require/forbid/suggested_roles、等待默认值、人工/角色 gate 与结构化 acceptance。仅 Codex；未知配置字段拒绝处理。

这是 Orbit 的有界工作流配置，不宣称可直接导入任意 OpenRig rigspec。四种结果均可显式映射；未映射 waiting 停放，未映射委托不得绕过审核隔离。运行时拓扑修改、任意上游模板转换仍属于待定产品范围。


## 后台 Codex 工具

后台成员通过原生命令工具调用随应用打包的 `orbit-agent.cjs`，使用当前执行代次专属的本机接口。无需再套一层 Agent harness。

| 工具 | 范围与行为 |
| --- | --- |
| list_work / get_work | 当前任务的执行义务、状态及最近事件 |
| read_context | 读取当前情境的 profile、席位记录及团队经验，供压缩后恢复 |
| startup_proof | 用本次 challengeId/answer/sessionId/generation 提交身份绑定的启动回执；未声明时无挑战。普通 READY 不等于已核验 |
| get_team | 本团队角色和经过审核隔离过滤的交接目标 |
| search_team_memory / read_team_memory | 本团队经验及来源 |
| report_progress | 写入当前义务的进度事件 |
| handoff_work / wait_work / request_help | 准备交接、等待或用户提问 |
| complete_work | 准备成果、审核结论、经验或异常恢复建议 |

结束类工具只准备意图；原生进程正常退出、成果核验通过后才提交。重复 requestId 幂等，冲突意图拒绝；凭证在进程结束时撤销。业务接口校验任务、团队、执行代次及取消状态。为了访问本机接口，Codex workspace-write 启用 network_access；这不是只允许回环网络的防火墙配置。

工作流可配置 `exception_routing: { orchestrator_role: "coordinator", default: "orchestrator", classes: { stuck_overdue: "human_only" } }`。协调者必须是声明的团队成员。缺省/类级路由支持 orchestrator、human_only；未声明协调者则留给用户处理。人工审批和认证阻塞不能交给模型代批。诊断完成不代表任务完成，只有已停止的执行才能 retry/rotate。


## 上下文选择与恢复入口

get_team 同时返回 contextCatalog.profiles/atoms。导入上下文包后，configure_team_context({teamId,role,profiles:{fresh,handover,"post-compaction"},contextAtoms:{project,mission,seat,slice}}) 选择目录中的 profile/atom ID。团队有未结束任务时拒绝配置或更换包，避免静默修改运行上下文。

answer_task 对普通问题保持回答并继续；对 human:exception 仅记录处理意见。明确恢复时再 retry_task（新 packet 续跑），或 rotate_task_session（先验证新会话再提交接替）。桌面提供同样的记录意见、重试、接替按钮。新建内置模板 revision 2 默认包含协调者；旧实例配置不被模板升级覆盖。

complete_work/handoff_work 可携带 acceptance:{candidate,verdict,evidence_ref}，必须满足步骤契约。后台完成仍需原生进程退出和真实成果核验。get_work 提供 watchdog 等事件；read_context 复用原生压缩事实，不实现另一个压缩器。

## 本地启动与成果策略配置

config.startup 支持 source_root（已有本机绝对目录，省略为任务目录）、agent/profile/team/pod/operator 启动块和 culture_file。成员可提供 startup 块。有效顺序为 agent→profile→culture→team→pod→member→operator，不去重。每个块：

```json
{
  "files": [
    { "path": "guidance.md", "delivery_hint": "guidance_merge" },
    { "path": "skills/review/SKILL.md", "delivery_hint": "skill_install" },
    { "path": "startup.md", "delivery_hint": "send_text", "required": true }
  ],
  "actions": [
    { "type": "send_text", "value": "先检查任务约束与资料", "idempotent": true },
    { "type": "startup_proof", "value": "authenticated", "idempotent": true }
  ]
}
```

applies_on 默认 fresh_start 和 restore；非幂等动作只能 fresh_start。phase 支持 after_files / after_ready，在 exec 启动 stdin 中按该顺序交付。默认 auto 根据 AGENTS.md / SKILL.md / 普通文件选择指导合并、完整技能安装、文本交付。只操作任务目录内所属的资源，不覆盖用户修改。authenticated 为可选声明，默认 none；证明用于区分内容回执和进程 READY，不声称证明理解。

artifact-pool-ready 声明 context.pools；edge-artifact-required 声明 context.source 和 context.target。每个池用 path 或 paths 指定任务目录内相对路径，可设置 extensions（默认 .md）、include_statuses、key_field（默认 entry）、ignore_names、recursive、include_malformed_frontmatter。README.md 和 .DS_Store 忽略。下游任一文件原文包含某个源 key 才满足该源的引用关系；下游 include_statuses 不会隐藏已有引用。旧 edge 策略的 paths 不再当作足够的配置。
