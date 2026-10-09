# 执行调度与 Memory 基础

更新日期：2026-10-09。此实现位于独立分支 `feat/openrig-core`，以 `f46699f` 为基础。

这次交付可运行、可测试的本地底层模块，尚未接到桌面任务页、语音工具或真实 Claude Code / Codex。原有 `save_request` 仍只保存待派发需求；不能把此模块的完成状态解释成用户任务已经验收。

## 来源与对齐范围

参考 OpenRig `4b48ca21a9bd072aa05a08b3da6d9c0708e093c5`，package 版本 `0.6.9`，Apache-2.0，Copyright 2026 Mike Schwarz。许可证和来源记录保留在 `third_party/openrig/`。本轮是参考行为重新实现，没有逐行复制整个 daemon，也没有宣称 API / SQLite schema 兼容。

| 上游源代码（`packages/daemon/src/domain/`） | 核实的行为 | Orbit 本轮实现与差异 |
| --- | --- | --- |
| `queue-repository.ts` | 执行义务独立于用户目标；来源、目的、优先级、claim、blocked、handoff 与状态迁移记录 | `ExecutionQueue` 持久化相同主要状态词；每项关联 `taskId`；请求幂等且拒绝不同 payload；handoff 原项关闭和后继创建在一个事务中 |
| `queue-owner.ts` | 会话与 node 是不同身份，不能通过字符串变换推导归属 | 目的执行者作为不透明标识，由可信应用显式注册到端口；尚未实现持久 node/session 拓扑 |
| `queue-repository.ts` 的 claim generation | 占位者换代后，旧代执行不能误改新代工作 | 每次 claim 生成 generation，迟到结果无法覆盖重试、已取消或已交接状态 |
| `queue-pickup.ts` | 已持久化、已领取、正在工作、阻塞、结束是不同事实 | enqueue 与 claim 分离；完成需适配器结果和成果引用，不用定时器伪造进度；尚未实现停滞诊断/唤醒阶梯 |
| `queue-recovery.ts` | 恢复建立在已记录状态和新证据上 | 简化为重启后未知执行停放，保留容量与执行者占用，必须核对实际运行时后显式 retry；不是上游 recovery 队列算法 |
| `runtime-adapter.ts` | 投影、启动、就绪、恢复属于执行适配边界 | 定义较窄的 `ExecutionPort.execute/cancel`，供应商协议留在适配器；没有复制 tmux 启动/资源投影 |
| `context-packs/context-pack-types.ts` | 文件系统 context packs，world/lore/skills/mission 分类；fresh/handover/post-compaction 组合 | `MemoryStore` 借鉴分类和来源可追溯。它是 Orbit 新增 SQLite scoped 记忆，不是上游 context pack 读取器或向量记忆移植 |

OpenRig 的队列还包含通知、人工决策、权限、watchdog、跨主机等大量逻辑，本轮未搬入。Orbit 的调度器主动调用端口执行，是本地首版的简化执行机制，并非完整复现 OpenRig 的 mechanized pull / wake / pane 协作流程。

## 领域与状态归属

- `src/domains/orchestration/queue.ts`：执行义务的唯一写入口，包括状态、来源、交接链、成果引用和追加事件。
- `src/domains/orchestration/scheduler.ts`：领取可执行项，按目的执行者串行、按全局上限并发；异步执行不阻塞前台。
- `src/domains/runtime/execution-port.ts`：运行时端口。`execute` 返回仅代表这轮执行结束，产品任务是否验收由任务领域决定。
- `src/domains/memory/store.ts`：scope 内的记忆 CRUD、来源、revision、启停、检索和受预算约束的上下文拼装。
- `src/infrastructure/core-database.ts`：独立 SQLite schema；不修改既有任务库。
- `src/application/execution-core.ts`：可信主进程组合入口；打开时不会隐式执行任务。

执行队列使用 `pending → in-progress → done / blocked / failed / canceled / handed-off`。`denied` 保留为来源状态词，当前没有权限拒绝流程。`done` 仅表示本条执行义务返回了成果，既不修改现有 `Task.status`，也不代表用户已验收。

队列完成与取消竞争时，以实际先落库的终态为准：完成先落库则保留成果；确认取消先落库则忽略迟到完成。AbortSignal 只表示请求停止，不能单凭它宣称取消成功。运行时连接异常会停放为 `runtime:unknown`，不会当作可安全重试的失败。

不明执行同时占住执行者和全局容量，避免断线后在同一工作区重复运行。`recoverInterrupted()` 只能由确认旧调度器已经退出的应用 owner 在启动恢复时调用；它不是多实例分布式租约。SQLite 领取事务和唯一运行索引能阻止重复领取，但本轮未实现跨进程 owner 选举。

## 与现有入口集成

在 Electron 主进程／应用层使用以下 API；不要把 queue、generation 或 MemoryStore 原始写接口暴露给 renderer 或模型。

```ts
import { openExecutionCore } from './execution-core';

const core = openExecutionCore({
  databasePath: join(userDataPath, 'execution-core.sqlite'),
  agents: new Map([
    // 这里注册真正实现 ExecutionPort 的适配器；没有内置假执行者。
    ['builder@team-one', builderAdapter],
    ['reviewer@team-one', reviewerAdapter],
  ]),
  maxConcurrent: 2,
});

// 应用已确认没有旧调度 owner；未知工作仅停放，不会自动重跑。
core.queue.recoverInterrupted();
core.scheduler.tick();

// 前台调用的是受约束的派发用例；身份、taskId 与目的执行者由应用校验。
const obligation = core.scheduler.enqueue({
  requestId: dispatchRequestId,
  taskId: existingTask.id,
  source: 'foreground',
  destination: 'builder@team-one',
  body: approvedBrief,
});
// enqueue 返回持久标识，不等待执行结果。
// core.queue.events(cursor) 可以供应用层投影进度；需要保存消费游标并幂等处理。

await core.scheduler.cancel(obligation.id, 'user');
// 退出：close 停止继续派发并等待当前适配器调用结束，不会强行伪造停止。
await core.close();
```

现有用户需求保存在原任务库；执行队列以 `taskId` 关联。首次集成使用独立 `execution-core.sqlite` 文件，不要把现有 `orbit.sqlite` 路径传进来。打开已有非 core 数据库会被拒绝，没有自动迁移或修改旧库。跨库的需求创建／派发不是一个事务：应先持久化需求，再用稳定 `requestId` 派发，以幂等重试补齐；不能把“已收集”显示为“已开始执行”。

本模块中的 `source`、`destination`、scope 与成果引用是可信应用输入，端口仍需落实真实运行时的认证、就绪、授权和输出证据。队列只检查成果引用非空，不自行验证文件存在或远端结果真伪。调用方不能把模型编造的 completed 响应直接作为执行结果。

## Memory 行为与边界

记录字段：`scope(kind,id)`、稳定 key、taxonomy、content、sourceRef、revision、enabled 和时间。personal / team / task scope 均显式指定；不会默认把所有个人资料或其他团队记忆注入执行者。

- `put(input, expectedRevision)`：创建使用 revision 0，修改必须匹配当前版本，防止执行 Agent 覆盖用户较新的纠正；更新不会把已禁用记录自动启用。
- `list(scope)`、`setEnabled(scope,id,enabled)`、`delete(scope,id)`：可查看、禁用、删除；此层不保留已删文本的修订副本。
- `search(allowedScopes,query)`：只检索调用方已授权的 scopes，字面词项匹配，中文补充相邻双字；返回排序和分数。不使用 embeddings、不请求远端模型，不宣称语义检索。
- `context(allowedScopes,query,maxCharacters)`：选择完整记录，返回 JSON 行及原始 records，保留 scope、来源与分类，限制的是字符数而非模型 token 数。

调用方必须从真实任务／团队绑定推导 allowedScopes，不能照收模型传来的任意 scope。`context.text` 是带来源的资料，不是系统指令；供应商适配器需要将它放到明确的数据段，不能提升记忆文本的执行权限。

没有自动抽取、自动总结、embedding、文件 context pack 导入、过期清理、无限上下文恢复或个人记忆管理 UI。这些都应后续独立接入，不把普通对话自动保存成个人记忆。

## 验证

`npm run check`：类型检查、15 项核心测试与生产构建通过（其中本轮新增 10 项）。

新增测试覆盖：跨 DB 连接领取互斥、请求幂等与冲突、优先级、事务交接回滚、并发执行与目的执行者串行、取消确认与迟到结果、重启停放与 generation、断线占用容量、记忆 scope 隔离/中文检索/版本冲突/禁用删除、上下文预算、重开持久化与不自动执行。

执行适配器在测试中是可控替身，没有调用真实 Agent、没有后台修改用户项目、没有读取 `.env` 或复制凭据。此分支没有 renderer / desktop / contracts 改动，因此无需为它启动新桌面进程；真实端到端执行验收属于后续适配器接入。
