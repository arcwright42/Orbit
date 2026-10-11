# Orbit 架构与开发进度

更新日期：2026-10-09。

Orbit 首版采用 TypeScript、Electron、React 和 Vite。当前交付桌面基础与本地需求收集，不代表产品需求中的完整首版已经完成。采用单体模块化，先保证领域边界和实际流程，随后接入 OpenRig 的编排能力。

## 模块职责

| 目录 | 职责 | 不承担的内容 |
| --- | --- | --- |
| `src/renderer` | 页面、用户输入、可见状态 | 不操作数据库、不直接连接 OpenRig |
| `src/desktop` | 窗口、菜单、文件选择、受限 IPC | 不实现任务状态规则 |
| `src/application` | 协调需求收集、持久化和连接用例 | 不承载供应商协议细节 |
| `src/domains/conversation` | 主对话的系统回执；后续接入交互 Agent | 不执行具体工作 |
| `src/domains/tasks` | 需求任务、校验、去重、待派发取消 | 不假定团队已开始执行 |
| `src/domains/teams` | 团队读取能力边界；后续编排用例入口 | 不直接依赖 Electron |
| `src/domains/runtime` | OpenRig HTTP 适配与连接地址约束 | 不独立维护一份团队状态 |
| `src/domains/materials` | 附件副本和元信息 | 不分析资料或编排执行者 |
| `src/infrastructure` | SQLite 初始化与事务 | 不决定业务状态 |
| `src/contracts.ts` | 可序列化的客户端应用接口 | 不暴露任意 IPC、文件路径或数据库操作 |

当前数据库访问放在领域仓储和基础设施中，不额外建立泛化 ORM 或多套抽象接口。同一数据库允许跨领域事务，以原子方式保存需求与会话回执。后续复杂度增长时再拆分应用服务。

## 当前数据与状态

- SQLite 保存需求任务、消息、附件元信息和连接设置。文件内容独立保存，数据库只记录平台管理的路径。
- 提交以请求标识去重。同一个标识提交不同内容会被拒绝。
- 任务和消息在同一事务提交；附件不存在时不会留下半条需求。
- 当前只有“待派发”和“已取消”两个真实状态。执行状态将在执行接入后增加，不能通过计时器或模拟回复推进。
- 本地需求是 Orbit 的用户目标记录。后续 OpenRig 队列项是执行义务记录，二者通过显式关联连接，不能把队列完成直接解释为用户目标通过验收。
- 首轮用户输入当前直接记录为需求。这是开发阶段收集入口，尚无意图识别能力；模型接入后才区分普通交流、追问和新任务。
- 团队列表按用户检查连接时读取，不持久化，不自动刷新；检查时间随结果展示。后续再接入事件流。

## OpenRig 对齐记录

参考仓库：`https://github.com/mvschwarz/openrig`。本次源码基线：`4b48ca2`，其 `package.json` 版本为 `0.6.9`。该基线是研究提交，不宣称与任意已发布版本完全兼容。

| OpenRig 源码 | 对齐内容 | Orbit 当前进度 |
| --- | --- | --- |
| `packages/daemon/src/routes/rigs.ts` | `GET /api/rigs/summary`，数组项包含团队标识、名称和生命周期 | 已实现只读适配；字段校验与异常测试覆盖 |
| `packages/daemon/src/index.ts` | 默认本机端口 `7433` | 已用于默认连接设置 |
| `packages/daemon/src/domain/queue-repository.ts`、`routes/queue.ts` | 持久队列、归属和交接 | 已阅读接口，尚未接入执行派发 |
| `packages/daemon/src/domain/runtime-adapter.ts` | 执行会话启动、就绪与恢复边界 | 作为后续接入依据，尚未搬入实现 |
| `packages/daemon/src/routes/events.ts` | SSE 事件与序号回放 | 尚未接入 |

当前选择先通过本地 HTTP 对接，保持适配器单独封装。未来是否嵌入服务或复用源码模块，按真实编排接入需要决定。未复制 OpenRig 源码，也未安装、启动或改写用户现有 OpenRig/Relay 环境。

## 桌面边界

Electron 渲染进程使用 context isolation 和 sandbox，禁用 Node integration。预加载只暴露逐项应用接口；主进程校验调用来源。界面不能传入任意文件路径，仅能通过系统选择器导入，再按平台附件标识打开副本。

OpenRig 适配器当前只接受 loopback HTTP 服务地址，不携带浏览器 Origin、不接受重定向，不把远端登录与授权支持隐含在“连接成功”中。五秒超时后展示失败；成功表示读取接口可用，不代表模型、执行会话或团队一定就绪。

当前没有麦克风访问、模型密钥、后台自动执行或个人记忆接入。使用内置 `node:sqlite` 避免 Electron 原生扩展重编译；该接口在本机 Node 22 中仍会输出实验性提示，依赖版本已锁定，发布前需继续验证运行时兼容性。

## 后续开发顺序

1. 接入常驻交互模型：定义仅包含平台编排能力的工具集合，支持真实会话和输入意图判断。
2. 对照 OpenRig 接入最小团队启动、任务派发、来源身份与幂等处理。先跑通一个真实执行任务，不另造调度引擎。
3. 接入状态事件、需要用户决定的问题、结果与验收；验证多个后台任务不占住主入口。
4. 接入语音和附件内容处理，复用 Relay 中已验证的产品流程。

每一阶段均区分真实运行验证与测试替身。当前 OpenRig 适配通过接口测试服务验证，真实 OpenRig 执行链路尚未验收。

## 基础版本验证

本地已完成 TypeScript 类型检查、生产构建，以及 5 项核心测试。桌面测试在独立临时数据目录运行，覆盖主入口保存需求、任务取消、退出后重启恢复、连接失败提示，并确认没有渲染进程异常。首页和设置页已通过截图检查。

GitHub 工作流执行类型检查、核心测试和构建；桌面测试依赖图形会话，目前在本机执行。

## 技术参考

- [Electron Context Isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation)
- [Electron Preload](https://www.electronjs.org/docs/latest/tutorial/tutorial-preload)
- [Vite 开发指南](https://vite.dev/guide/)
