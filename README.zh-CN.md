# dsh-file-download

[English](README.md) | [简体中文](README.zh-CN.md)

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）Web GUI 加上文件浏览器、下载面与按模式放行的上传：浏览运行 agent 的那台机器（**包括会话工作区之外的一切**）、下载单个文件、把文件夹打包成 ZIP、把多选条目一次性打包下载，并上传文件（覆盖前会询问）。它通过官方页签注册接口扩展官方侧边栏，而不是改 DSH。

[![license](https://img.shields.io/badge/license-MIT-4c6ef5?style=flat-square&labelColor=454a54)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-%3E%3D0.1.5--rc.1-4c6ef5?style=flat-square&labelColor=454a54)](#兼容性)

---

## 为什么需要它

DSH 的原生文件动作是宿主侧的：「用默认程序打开」「在文件管理器中显示」都需要运行 agent 的那台机器上有桌面环境。可当 Web GUI 是从另一台设备打开的——手机、平板、局域网里的笔记本，或者反代后面的无头云主机——那个桌面要么不存在，要么根本不是正在看页面的这台设备。文件在服务器上，浏览器却存不下来。

官方侧边栏的文件树还被限制在会话工作区内，而且完全没法把文件夹交出来。本插件补上缺失的"读"这一面：一个从工作区出发、但能沿任意绝对路径走遍该文件系统可读范围的浏览器，外加文件下载与文件夹归档。

## 它加了什么

| 界面 | 入口 |
|---|---|
| 官方右侧栏 | 通过 `ctx.sidebarRightTabs` 注册的 **文件** 页签：从项目根一路走到 `/`、筛选当前目录、显示隐藏项、在官方预览里打开文件、复制路径、把路径插入输入框、下载文件、把文件夹打包成 ZIP、勾选多项一起打包，以及上传文件（覆盖已有文件前会询问） |
| 每个有交付或改动的收尾回合 | 一个「下载本轮文件」下拉，外加一个打开服务端渲染浏览页的入口。原有的「打开」行为完全不变 |
| 每张交付文件卡片 | 在卡片原有的分体「打开」控件旁多一个下载段。左侧按钮依旧默认走打开 |
| 侧边栏文件树每一行 | 悬停时出现的下载按钮：文件本身，或目录的流式 ZIP |
| 任意设备、无需客户端 JS | 服务端渲染的浏览页（`/api/workspace.download/browse`），带面包屑、逐文件下载与逐目录 ZIP。页面不带任何脚本，所以从不打开完整 GUI 的手机也能取到文件 |

单个下载的字节不经过 JavaScript：每个动作都是把一个同源 URL 交给浏览器自己的下载管理器。多选则用隐藏表单 POST，让浏览器把一个 ZIP 直接流到磁盘，而不是先在页面内存里缓冲。

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

打开右侧栏，在页签引导里选 **文件**。

- **项目** 跳到会话工作区根目录，**根目录** 跳到 `/`。路径框接受任意绝对路径：输入后回车即可。
- **显示隐藏项** 打开点开头的文件（默认隐藏）。筛选框在当前目录内收窄结果，不会跳走。
- 点文件夹进入；点文件在官方预览页签里打开。
- 行内动作：预览、下载、压缩下载（目录）、复制路径、插入路径到输入框。工作区内的路径插入为 `@相对路径` 引用，工作区外插入绝对路径。
- 勾选多行后，底栏提供 **打包下载所选**，把选中的文件与整个文件夹打成同一个 ZIP 流。

## 工作原理

整个插件是一条双面 Cordis 行，没有构建步骤，也没有运行时依赖。

### 宿主路由

所有路由都注册在 Connection 的精确 Fetch 表上，因此都继承与其他 `/api` 完全相同的 Host/Origin 与浏览器会话检查；没有一条是无认证侧门。

| 路由 | 作用 |
|---|---|
| `GET /api/workspace.download/list?sessionId=&path=` | 任意可读目录的 JSON 列表：`{ path, parent, workspaceRoot, entries, truncated }` |
| `GET\|HEAD /api/workspace.download?sessionId=&path=` | 单个普通文件，按 256 KiB 窗口流式返回，带 `Content-Disposition: attachment` |
| `GET /api/workspace.download/browse?sessionId=&path=` | 无脚本的 HTML 列表页，带面包屑与逐条目的下载/ZIP 链接 |
| `GET\|HEAD /api/workspace.download/archive?sessionId=&path=` | 一个目录子树，流式打包为 ZIP |
| `POST /api/workspace.download/archive` | 多选内容打包成一个 ZIP；接受 JSON，或名为 `payload` 的表单字段 |
| `POST /api/workspace.download/upload?sessionId=&path=<dir>&name=<file>&mode=&overwrite=` | 把一个文件上传进指定目录；请求体就是文件字节 |

`path` 缺失或为空表示会话工作区根目录。相对路径以它为基准解析；绝对路径可以离开它。

### 访问模式

**读取永远不受限**：任何模式下，浏览、预览、下载、打包都能到达服务账号可读的每个文件夹。模式只约束**上传**；默认取会话自身的沙箱策略，并可在浏览器自己的选择器里更改。

| 模式 | 浏览 / 预览 / 下载 / ZIP | 上传 |
|---|---|---|
| `read-only` 只读 | 全部文件夹 | 拒绝 |
| `workspace-write` 工作区写入 | 全部文件夹 | 仅会话工作区 |
| `danger-full-access` 完全访问 | 全部文件夹 | 账号可写的任意位置 |

浏览器以会话解析出的模式为起点，并把每个会话的覆盖选择记在 `localStorage`；两者不一致时工具栏会标出来。模式绝不只由客户端把关——宿主在每次上传时重新解析模式并重新做包含性检查。

上传体积上限 64 MiB。文本请求体走组合文件系统的原子 `writeText`，因此后端会再施加一次它自己的沙箱策略；二进制请求体在该契约里没有字节写入口，会在目标旁边经临时文件 + rename 落盘，这对"后端执行世界就是本机"（本地 provider）是成立的。不带 `overwrite=1` 时，已存在的文件会以 `409` 拒绝，交给浏览器询问。

### 浏览器界面

文件页签是通过 `ctx.sidebarRightTabs` 注册的真实页签类型，页签体注册在 keyed 的 `sidebar.right.pane.tab` slot 上——和官方「文件」页签用的是同一套扩展点，因此没有改动任何官方代码。它是页面类型，所以不会与预览争抢文件地址。

回合下拉是官方 `conversation.chat.turnTail` 链式 slot 的占用者，读取的是官方交付行读取的同一份 Turn 数据，因此两份列表不可能不一致。

交付卡片与文件树按钮是对官方已发布钩子（`data-presented-file`、`data-files-entry`、`data-files-path`）的 DOM 装饰。每个注入节点都追加在容器末尾，而不是插进 React 管理的兄弟节点之间；`MutationObserver` 会在重渲染后重新施加装饰。卸载插件会移除全部注入节点。

### 归档

ZIP 是直接基于 Node 的 `zlib` 手写的：每条目一个 local record，然后是中央目录与结束记录。同一时刻只缓冲一个文件，因此归档内存受单文件上限约束，而不是受整棵树大小约束。

## 安全

本插件能读 **运行 dsh 的操作系统账号可读的任意文件**，而不只是会话工作区。这是有意为之——无头主机必须能把工作区旁边的文件交出来——但它比官方文件树的能力更宽，应当是一个自觉的选择。

- **需要认证，不是匿名。** 包括上传在内的每条路由都在 Connection 的栅栏之后，和 `/api/remote.mux` 一样。未认证的访问者无法列举、抓取或写入任何内容。
- **写操作受模式约束且有边界。** 唯一的写动作是把一个文件上传进一个已存在的目录。没有重命名、删除、移动、原地编辑、改权限，也没有 shell。`read-only` 拒绝一切写入；`workspace-write` 把写入限制在工作区内；`danger-full-access` 允许任意可写位置。宿主每次请求都重新检查，客户端从不作为唯一防线。
- **不回显路径。** 错误体是固定的短字符串；解析后的路径或堆栈永不离开进程。
- **不带脚本。** 浏览页不含 JavaScript 与任何外部资源；响应带 `default-src 'none'`、`frame-ancestors 'none'` 与 `Referrer-Policy: no-referrer`。所有插值的名称都做 HTML 转义。
- **有上限。** 列表 5000 条、归档 20000 条 / 2 GiB / 单文件 64 MiB、多选 200 条、单次上传 64 MiB；超限直接拒绝而不是静默截断。
- **仍需要会话。** 请求必须指名一个真实会话；它的工作区根目录是默认目录。

如果这个读取范围对某个部署来说太宽，就不要在那里安装本插件，或者把 `dsh web` 绑在回环地址并放在带认证的反向代理之后。卸载插件即移除该能力。

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
| `lib/index.js` | 宿主半区：会话作用域解析、`ctx.fs` 读取、JSON 列表、流式下载、HTML 浏览页、ZIP 写入器、失败映射 |
| `lib/client.js` | 浏览器半区：侧边栏页签类型与页签体、回合下拉、DOM 装饰 |
| `cordis.patch.yml` | 本 bundle 挂载的唯一一条双面行 |
| `tests/host.test.mjs` | 用假 `ctx.fs` 验证路由行为，含 ZIP 结构解析 |
| `tests/client.test.mjs` | 浏览器半区：模块加载注册、页签注册、URL 与地址构造、装饰过程 |
| `tests/validate.mjs` | 静态接线检查 |
| `tests/contract.mjs` | 上游钩子检查 |
| `tests/hygiene.test.mjs` | 对已跟踪文件的泄漏防护 |

浏览器半区是手写的 `window.__ModuleLoader__.load({ id, factory })` 形态，只依赖平台种子 `react` 与 `react/jsx-runtime`。没有打包器、没有 `prepare` 脚本、没有需要安装的依赖。

## 已知边界

- **写入口刻意很窄。** 上传只能往已存在的目录里加文件；不能建目录、重命名、移动、删除或原地编辑。建目录请交给 agent 或 shell 里的 `mkdir`。
- **没有 Range 与断点续传。** 下载中断就得重来，超大文件需要稳定连接。
- **归档上限是硬限制。** 超过 20000 条、2 GiB，或单文件超过 64 MiB 的目录会被拒绝，而不是流式输出。
- **符号链接与特殊文件会被跳过**，列举与归档都不跟随。
- **二进制上传假定本地执行世界。** 文本上传始终走组合文件系统；二进制上传由宿主进程写盘，因此如果后端执行世界不是本机（远程工作区），文本上传仍正确、二进制会上传到错误的位置。
- **全部下载是一串并发下载。** 一轮文件很多时浏览器可能询问权限或拦掉多余的下载；逐个下载始终可靠。
- **回合文件列表受官方行约束。** 只有官方交付行会显示的文件才会被列出：成功的首方变更工具与显式 `present` 声明。

## 许可证

[MIT](LICENSE) © 2026 KaguraSayuki
