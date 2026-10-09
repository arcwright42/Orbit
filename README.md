# Orbit

面向个人用户的桌面 AI 工作空间。通过常驻交互 Agent 接收文本、语音和多媒体输入，自动组织执行团队、派发任务并跟进结果。

常驻交互 Agent 负责理解与调度，具体工作由执行团队完成。

## 产品文档

- [产品需求](docs/PRODUCT.md)：产品定位、职责边界、交互流程、团队编排、首版建议和验收场景。
- [架构与开发进度](docs/ARCHITECTURE.md)：模块边界、OpenRig 对齐点、当前实现与下一步。

## 本地运行

需要 Node.js 22.13+。当前在 macOS 上开发和验证。

```sh
npm ci
npm run dev
```

开发模式支持界面热更新；修改 Electron 或领域代码后需重启开发进程。首次启动会下载 Electron 运行环境。

```sh
npm run build
npm start
```

生产构建当前用于本地启动，尚未提供签名安装包。

## 当前能力

- Electron + React 桌面主入口、任务、团队、文件和设置页面。
- 需求和附件本地保存、任务查看与待派发任务取消、重启恢复。
- 附件通过系统文件选择器导入副本，支持 TXT、Markdown、PDF、图片、DOCX 和 CSV；每个最多 25 MB，每次需求最多 8 个。当前只接收和打开文件，不解析内容。
- OpenRig 本地连接设置与只读团队查询，默认地址 `http://127.0.0.1:7433`。

当前是基础版本：**尚未接入交互模型、语音、自动团队创建和任务执行**。主入口保存的是待派发需求，系统回执不是 AI 回复。连接检查不会自动安装或启动 OpenRig。

数据使用 SQLite，默认位于 Electron 的 Orbit 用户数据目录（macOS 通常为 `~/Library/Application Support/Orbit`），附件保存在同目录。可通过 `ORBIT_DATA_DIR` 指定隔离目录。关闭窗口后保留应用；通过应用菜单或 `⌘Q` 退出。

## 验证

```sh
npm run check
npm run test:desktop
```

桌面测试需要图形会话，使用临时数据目录，覆盖需求保存、取消、重启恢复和连接失败处理。截图输出到已忽略的 `artifacts/`。

首版使用 TypeScript 快速开发，团队编排尽可能对齐 OpenRig 实现。采用职责清晰的模块化设计，先完成可用版本，再逐步优化和创新。
