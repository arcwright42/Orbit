# 任务执行

Orbit 自己维护任务编排和业务状态，运行时通过端口接入。实现分为三个 PR：任务领域与调度、Pi/Codex/Claude 适配及应用入口、最小任务 UI。目前桌面主进程和常驻 Agent 已接通执行；任务详情和运行时设置界面由第三个 PR 补齐。

## 状态与目录

Task 表达用户目标；Step 表达固定步骤和依赖；Run 表达一次执行尝试。重试保留 Step 和已完成分支，创建新 Run。Planner 是规划模式的第一个步骤，调用 `submit_plan` 提交最多 16 个节点的 DAG；宿主拒绝重复标识、未知依赖和循环。直接模式只建立一个 `implement` 步骤。

任务使用 `<userData>/tasks/<task-id>/`，包含 `inputs/`、`inputs.json`、`plan.json`、`steps/<step-id>/` 和 `runs/<run-id>/`。步骤标识使用可读的小写英文路径名，展示名称可以使用中文。附件复制到任务输入目录；下游读取上游结果摘要和文件引用。每次执行有独立日志和原生会话关联。目录组织不等于操作系统沙箱。

SQLite 是业务事实来源：`tasks` 保留既有 JSON 记录；新增 `task_steps`、`task_runs`、`task_events`、`task_tool_receipts` 和 `execution_settings`。数据库升级到版本 2，原有待派发/已取消任务保持原状态，不自动执行。状态变更与事件在同一事务提交，事件使用单调序号，详情接口按游标读取历史；通知失败后可以重读持久记录。

## 调度与工具

默认全局并发 2，可设为 1–4；所有依赖完成且存在空闲容量时立即启动步骤。系统统一选择 `pi`、`codex-cli` 或 `claude-cli`；派发保存运行时快照，后续修改设置只影响新任务。首版不支持运行中修改拓扑、步骤选择不同运行时或 Agent 中途互相发消息。

执行工具是 `read_task`、`report_progress`、`request_input`，以及 Planner 专用 `submit_plan` / Worker 专用 `submit_result`。宿主绑定 Run 身份，模型不能指定其他任务或执行代次。工具回执按 Run 和调用 ID 去重。输入问题与原生运行时审批分别记录，审批只允许显式允许/拒绝。

`submit_result` 记录候选结果并核验成果路径、普通文件类型、大小和 SHA-256；不允许符号链接绕到任务外部。运行时正常结束后再次校验文件，才提交步骤完成并解锁后继。退出码为零、流式输出结束、低层 `agent_end` 都不能代替成果提交。全部步骤完成后任务进入待验收，用户验收后才完成；文本结论可以不带文件。

## 停止与恢复

关闭窗口保留后台工作；彻底退出停止当前执行，记录 interrupted。重开后先核对旧进程，确认停止后自动续跑未完成步骤；已完成分支不重跑。无法确认的旧进程保留占用和错误，不启动同一步骤的新尝试。Pi 原生 session 文件缺失时明确记录新建会话；CLI 原生会话恢复失败时保留失败供用户处理，不静默重新执行。

待用户补充的问题持久保存，收到答复后继续。退出前未处理的原生权限请求过期，重开时由运行时重新提出，旧授权不会被重放。运行失败要求显式重试；退出中断自动恢复。取消先封锁新工具和后继启动，再等待实际运行停止；取消不删除已有文件。停止主对话、切换文字/语音与后台任务生命周期独立。

## 运行时与应用入口

系统设置持久化在 SQLite；`window.orbit.execution.configuration / configure` 查询可用性并设置运行时和全局并发数。派发固定运行时及 Pi 模型配置快照，已有任务不受后续切换影响。Pi 凭据按调用读取，配置删除或端点改变时明确失败，避免把旧任务的凭据发往新地址。

| 运行时 | 接入方式 | 会话与工具 |
| --- | --- | --- |
| Pi | 已安装的 SDK 1.3.0，独立 Node worker | 每步原生 JSONL；宿主提供资源和业务工具，开放本地 read/write/edit/bash/grep/find/ls；不加载用户 Pi 扩展。 |
| Codex CLI | 本机 `codex app-server --listen stdio://`，要求 0.161.0+ | 持久 thread ID，dynamicTools 回传 Orbit；workspace-write、on-request，原生审批转为任务问题。CLI 自己管理登录和原生历史。 |
| Claude Code CLI | 本机 stream-json CLI，逐 Run 的本地 MCP 桥 | 持久 session ID；业务工具和 permission-prompt-tool 经带随机凭证的 loopback 桥回传。CLI 自己管理登录、原生历史与配置。 |

首版支持 macOS / Linux。CLI 从 PATH、`~/.local/bin`、Homebrew 常用目录发现；可用绝对路径 `ORBIT_CODEX_PATH` / `ORBIT_CLAUDE_PATH` 覆盖。检测只执行 version / login status，不安装 CLI、不导出登录。CLI 保留自己的用户配置、规则和 MCP；选择 CLI 也会使用其已配置能力。Pi 的终端与文件工具具备本机用户权限，步骤目录只是组织和成果校验边界，并非操作系统隔离。

每个执行 worker 有独立 POSIX 进程组。宿主持久化 PID、Run ID 和随机身份后才允许执行；停止时先请求中断，再回收进程组。身份不符、残留进程或无法确认停止时记录 unresolved，保留容量。单实例锁防止同一数据目录有两个桌面调度器。审批只作用于当前请求，常驻 Agent 无权代替用户批准。

常驻 Agent 新增 `dispatch_task / get_task / cancel_task / retry_task / answer_task / accept_task`。文字与 Qwen 共用这套入口；后台任务使用独立会话，不受主对话切换影响。业务重要事件写入 Room 系统回执；启动时补写已提交但未投影的回执。工具成功后须由运行时正常结束、宿主确认进程组退出，才能完成 Step。

## 核验

`tests/task-execution.test.ts` 使用真实 SQLite、任务文件和可控运行时验证 DAG 并发/汇合、派发去重、候选结果提交、工具去重、取消迟到事件、成果越界和变更、问题跨重启、旧进程核对及失败重试保留已完成分支。

`tests/execution-runtimes.test.ts` 构建并启动真实 worker，以本地可执行 CLI 协议桩验证 Codex JSON-RPC、Claude stream-json + 实际 MCP 桥、审批、问题、原生 session 恢复、非零退出及进程组清理；Pi 使用真实 SDK 和文件工具对接本地 HTTP 模型桩执行 DAG。离线验证不代表云端账号实测。

先构建，再显式运行 `node scripts/task-live-smoke.mjs codex-cli`（或 `pi` / `claude-cli`），会消耗真实模型额度。脚本通过 Electron IPC 在临时目录派发任务，核验进展工具、真实文件、成果路径、验收与重启不重放，并把报告写入 `artifacts/task-live-<runtime>.json`。Pi 模式复用本地 Codex 登录，模型由 `ORBIT_CODEX_SMOKE_MODEL` 选择。CLI 模式可能由客户端正常刷新其登录；Orbit 不自行读取或改写 CLI 凭据。

机制参考 OpenRig `6f2751a1f69b13c2663909864e811c5d0a681eb9` 的 runtime adapter、queue repository、activity store 与事件补读；未引入其编排包。

协议依据：[Codex App Server](https://learn.chatgpt.com/docs/app-server)、[Claude Code headless](https://code.claude.com/docs/en/headless)、[Claude CLI reference](https://code.claude.com/docs/en/cli-reference)。Codex 字段同时核对本机 0.161.0 的 experimental JSON schema；不从终端文本推断业务完成。
