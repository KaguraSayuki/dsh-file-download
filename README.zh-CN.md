# dsh-file-download

[English](README.md) | [简体中文](README.zh-CN.md)

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）Web GUI 补上浏览器下载：直接挂在你已经在用的官方界面上——每轮交付行、交付文件卡片、侧边栏文件树。

[![license](https://img.shields.io/badge/license-MIT-4c6ef5?style=flat-square&labelColor=454a54)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-%3E%3D0.1.5--rc.1-4c6ef5?style=flat-square&labelColor=454a54)](#兼容性)

---

## 为什么需要它

DSH 的原生文件动作是宿主侧的：「用默认程序打开」「在文件管理器中显示」都需要运行 agent 的那台机器上有桌面环境。可当 Web GUI 是从另一台设备打开的——手机、平板、局域网里的笔记本，或者反代后面的无头云主机——那个桌面要么不存在，要么根本不是正在看页面的这台设备。文件在服务器上，浏览器却存不下来。

会话日志已经能导出 ZIP，但普通的产物文件不能。本插件不修改 DSH，只补上这缺失的一环：一条带认证的下载路由，加上官方文件界面上的下载入口。

## 它加了什么

| 界面 | 入口 |
|---|---|
| 每个有交付或改动的收尾回合 | 一个「下载本轮文件」下拉，列出本轮文件，并提供全部下载。原有的「打开」行为完全不变 |
| 每张交付文件卡片 | 在卡片原有的分体「打开」控件旁多一个下载段。左侧按钮依旧默认走打开 |
| 侧边栏文件树每一行 | 悬停时出现的下载按钮 |

字节不经过 JavaScript：每次点击都是把一个同源 URL 交给浏览器自己的下载管理器，所以进度、取消、「另存为」都和普通下载完全一致。

## 安装

要求：DSH `0.1.5` 线的 `0.1.5-rc.1` 或更高、Node 20+、`web` profile。

```sh
# 本地检出
dsh plugin --profile web add /path/to/dsh-file-download

# 或直接从 GitHub 安装
dsh plugin --profile web add github:KaguraSayuki/dsh-file-download
```

`dsh plugin add` 会把包装进 profile 并追加到 `dsh.profile.bundles`。之后重启 `dsh web`：客户端 roster 是启动时扫描的。

卸载：

```sh
dsh plugin --profile web remove dsh-file-download
```

## 使用

无需配置。打开会话，让 agent 产出或修改文件，然后用上面三个入口中的任意一个。手机或平板上最快的路径是侧边栏文件树：点开侧边栏的文件页，找到文件，用行上的下载按钮。

## 工作原理

整个插件是一条双面 Cordis 行，没有构建步骤，也没有运行时依赖。

### 宿主路由

```
GET  /api/workspace.download?sessionId=<id>&path=<path>
HEAD /api/workspace.download?sessionId=<id>&path=<path>
```

路由注册在 Connection 的精确 Fetch 表上，因此继承与其他 `/api` 调用完全相同的 Host/Origin 与浏览器会话检查，不会变成一条无认证的侧门。读取走组合后的 `workspaceFiles` 服务，文件身份、普通文件校验、相对工作区根解析都与官方侧边栏预览一致。

| 方面 | 行为 |
|---|---|
| 响应 | `Content-Disposition: attachment`，文件名按 RFC 5987 编码，媒体类型按扩展名推断，后端报告大小时带 `Content-Length` |
| 响应体 | 分页流：每次 pull 一个 256 KiB 的窗口，大文件只占一个窗口的内存 |
| `HEAD` | 同样的状态与响应头，不读取内容 |
| 错误 | `400` 请求非法、`403` 越出工作区、`404` 文件或会话不存在、`413` 超过整文件上限、`500` 其它 |

### 浏览器界面

回合下拉是官方 `conversation.chat.turnTail` 链式 slot 的真实占用者。它读取的是官方交付行读取的同一份 Turn 数据，所以两份列表不可能不一致；它不注册任何新数据。

交付卡片与文件树按钮是对官方已发布的 DOM 钩子（`data-presented-file`、`data-files-entry`、`data-files-path`）做的装饰。每个注入节点都追加在容器的末尾，而不是插进 React 管理的兄弟节点之间；`MutationObserver` 会在重渲染后重新施加装饰。卸载插件会移除全部注入节点。

## 安全

- **带认证**：路由位于 Connection 的栅栏之后，和 `/api/remote.mux` 一样，未认证的访问者无法枚举或抓取文件。
- **只读**：没有写操作、没有上传、没有目录列举。
- **与预览同一权限**：只有该会话自己的组合文件系统能读到的文件才可下载，不扩大工作区包含范围。
- **不缓存**：响应带 `cache-control: no-store`。
- **不回显路径**：错误体是固定的短字符串，不含解析后的路径或堆栈。

如果你把 Web GUI 暴露到网络，请照旧在网络层做防护；本插件不改变这一态势。

## 兼容性

DSH 是移动靶，所以本插件组合的每个钩子都由 contract 测试针对 profile 实际运行的 DSH 安装重新核对：

```sh
DSH_MODULES=/path/to/node_modules npm run contract
```

当前对 DSH `0.1.5-rc.1` 全部通过。升级 DSH 后跑一次 `npm test`；变红的那一项会直接点出移动了的上游钩子。

## 开发

```sh
npm test          # 静态校验 + 单元测试 + 上游 contract
npm run validate  # 只查 manifest、patch 与 bundle 接线
npm run unit      # 只跑单元测试（宿主路由 + 浏览器半区）
npm run contract  # 只跑上游钩子 contract
```

目录：

| 路径 | 作用 |
|---|---|
| `lib/index.js` | 宿主半区：认证路由、会话作用域解析、分页流、失败映射 |
| `lib/client.js` | 浏览器半区：回合链式 slot 条目与 DOM 装饰 |
| `cordis.patch.yml` | 本 bundle 挂载的唯一一条双面行 |
| `tests/host.test.mjs` | 用假 context 验证路由：流式、响应头、`HEAD`、失败分支 |
| `tests/client.test.mjs` | 浏览器半区：模块加载注册、回合文件选择、装饰过程 |
| `tests/validate.mjs` | 对 manifest、patch、两个 bundle 的静态接线检查 |
| `tests/contract.mjs` | 针对已安装 DSH 的上游钩子检查 |
| `tests/hygiene.test.mjs` | 对已跟踪文件的泄漏防护 |

浏览器半区是手写的 `window.__ModuleLoader__.load({ id, factory })` 形态，只依赖平台种子 `react` 与 `react/jsx-runtime`。没有打包器、没有 `prepare` 脚本、没有需要安装的依赖。

## 已知边界

- **没有 Range 与断点续传。** 下载中断就得重来，超大文件需要稳定连接。落盘是浏览器的事，但 `Range` 尚未实现。
- **全部下载是一串并发下载。** 一轮文件很多时浏览器可能询问权限或拦掉多余的下载；逐个下载始终可靠。
- **只支持普通文件。** 目录、符号链接与特殊文件会被预览所用的同一套服务拒绝；没有打包归档。
- **回合文件列表受官方行约束。** 只有官方交付行会显示的文件才会被列出：成功的首方变更工具与显式 `present` 声明。

## 相关项目

生态里已有若干通过自带面板提供文件浏览或下载的插件。本插件刻意不再加一个面板：它扩展官方界面，因此能与你已在用的任何侧边栏或面板插件共存。

## 许可证

[MIT](LICENSE) © 2026 KaguraSayuki
