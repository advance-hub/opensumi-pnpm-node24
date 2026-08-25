# OpenSumi Node 24 单运行时改造方案

> 评审目标：确认 OpenSumi 以 pnpm 11 + Node.js 24 作为唯一生产 JavaScript 运行时，产品入口收口为 `client/` 与 `server/`，保持 VS Code Node 扩展兼容，并通过 WebSocket 资源边界和协同生命周期治理降低内存失控与整机崩溃风险。

## 1. 背景与现状问题

本仓库原有框架能力分布在大量 `packages/*` 中，产品启动入口与开发工具耦合。迁移过程中曾验证 GoFrame 网关与 Node worker 双栈，但扩展宿主、PTY、文件监听、OpenSumi RPC 和 Yjs 协同仍依赖 Node；双栈没有消除 Node 内存，只增加了代理、端口和排障成本。因此当前实现已删除 Go 服务，保留一个 Node 24 服务入口。

已确认的稳定性问题不是单纯由语言造成：

1. 连接层曾用一个共享定时器维护心跳，新连接会取消旧连接的心跳。
2. RPC WebSocket 缺少明确的连接数、消息大小和慢消费者边界。
3. 协同文件初始化缺少引用计数、文档体积和空闲回收边界；读取失败时浏览器还可能永久等待未创建的 Y.Map。
4. `y-websocket` 可从 URL 创建任意房间；若公网入口不限制房间名，攻击者可制造无界文档状态。
5. 扩展宿主和终端属于高内存能力，必须限制进程数并及时回收空闲资源。

| 选项 | 扩展兼容 | 运维复杂度 | 当前仓库实测风险 | 结论 |
| --- | --- | --- | --- | --- |
| Node 24 单运行时 | 完整复用现有扩展链路 | 一套运行时、一个服务入口 | 需要主动治理内存和 WebSocket | 采用 |
| Go + Node worker | 扩展仍需 Node | 两套构建、代理和回滚链路 | Node RSS 仍存在 | 删除 |
| Bun 全量替换 | Node API 仅部分兼容 | 需同时维护兼容补丁 | Bun 1.3.14 加载本仓库 `spdlog` 时发生原生崩溃 | 不采用 |

## 2. 目标、边界与不变项

### 2.1 目标

- 使用 Node.js 24 和 pnpm 11 完成安装、构建、开发和生产启动。
- 产品目录固定为 `client/`、`server/`；`packages/*` 继续作为可复用框架包。
- 浏览器继续通过 `ws://<host>:8000/service` 使用既有 OpenSumi RPC。
- AI、Notebook 和协同均从默认产品入口拆出，通过环境开关按需装配；默认服务不加载这些重模块。
- 单个失活连接、超大消息、慢消费者或异常房间请求不能无限占用服务端资源。

### 2.2 不变项

- OpenSumi RPC 序列化、通道路径和客户端协议保持兼容。
- 传统 VS Code Node 扩展继续由 Node 扩展宿主执行。
- Yjs 文档内容和 awareness 协议保持由 `y-websocket`/Yjs 实现，不改数据格式。
- npm 包发布边界仍是 `packages/*`，不把全部框架包物理搬入 `client` 或 `server`。

### 2.3 非目标

- 本次不承诺把所有框架包合并成少量大包；包数量与运行时内存不是同一指标。
- 本次不把 Yjs、PTY 或扩展 API 重写为另一种语言。
- 本次不声称已经完成多租户级的协同进程隔离；当前先完成单进程资源上限，独立 worker 可作为后续容量工程。
- 本次不把 Bun 加入生产锁文件、CI 或运行链路。

## 3. 总体架构设计

```mermaid
flowchart LR
  B["Browser client"] -->|"HTTP + RPC WebSocket :8000"| S["Node 24 server"]
  B -. "ENABLE_AI=1" .-> A["AI modules"]
  B -. "ENABLE_NOTEBOOK=1" .-> N["Notebook modules"]
  B -. "optional Yjs WebSocket :12345" .-> C["Collaboration module"]
  S --> R["OpenSumi RPC / filesystem / search"]
  S --> T["PTY manager"]
  S --> W["Watcher child process"]
  S --> E["Node 24 extension hosts, max 2 by default"]
  S -. "ENABLE_COLLABORATION=1" .-> C
```

浏览器只有一个主服务入口；协同端口只在显式启用模块时监听。扩展宿主继续是独立子进程，既保持插件兼容，也避免把第三方插件代码直接执行在 HTTP/WebSocket 主进程中。

产品组合分为以下档位：

| 档位     | 命令                          | 启用模块                        |
| -------- | ----------------------------- | ------------------------------- |
| 默认轻量 | `pnpm dev`                    | IDE 核心、文件、终端、扩展宿主  |
| AI       | `pnpm dev:ai`                 | 默认轻量 + AI Native            |
| 完整     | `pnpm dev:full`               | 默认轻量 + AI Native + Notebook |
| 完整协同 | `pnpm dev:full:collaboration` | 完整 + Yjs 协同                 |

这些开关影响模块是否装配，不牺牲框架包或 VS Code 扩展 API。旧的 `packages/startup/entry/web/*` 入口仍显式装配完整模块，供已有集成方兼容使用。

目录职责如下：

```text
client/        浏览器产品组合、Rspack 构建和开发服务器
server/        Node 24 产品服务入口、运行参数和生产构建
packages/      OpenSumi 可复用浏览器端、Node 端与公共框架包
configs/       TypeScript、Jest、ESLint 等集中工程配置
tools/         构建、测试、Electron 和开发辅助工具
```

## 4. 核心实现与资源模型

### 4.1 RPC WebSocket 生命周期

`BaseCommonChannelHandler` 使用一个调度器遍历所有活动连接，而不是为最后一个连接保存共享递归定时器。连接建立时加入集合，关闭时删除；集合为空时停止定时器。这样连接数量增加不会使旧连接失去心跳，也不会为每个连接创建独立定时器。

Node WebSocket 每次心跳按以下顺序检查：

1. socket 已关闭时跳过。
2. `bufferedAmount` 超过上限时终止慢客户端。
3. 上一轮 ping 未收到 pong 时终止失活客户端。
4. 标记为待 pong 并发送下一次 ping。

服务端同时监听 WebSocket server 和单连接 `error`，避免未处理的 EventEmitter `error` 直接结束进程。

### 4.2 协同服务生命周期

协同服务强制所有连接使用 `ROOM_NAME`，升级请求的 URL 房间不匹配时返回 404。连接达到上限时返回 503；消息超过上限由 `ws` 拒绝；发送缓冲超过上限时由单一压力检查定时器终止慢客户端。

文件初始化请求以 `PendingContentRequest` 跟踪。请求完成后在 `finally` 中删除记录；文件在读取期间被删除时，服务会标记请求取消、拒绝等待方，并阻止迟到的磁盘读取结果把 Y.Text 重新写回文档。每个 URI 都按绑定数量引用计数，最后一个编辑器释放后才删除共享内容；全部客户端离开 60 秒后，服务销毁 Y.Doc、Y.Map、文件事件监听和 `@y/websocket-server` 的全局房间引用。读取失败会明确拒绝浏览器端等待，而不是让模型绑定永久挂起。

协同服务另设文档数量、单文档 UTF-8 字节数、房间 CRDT 编码状态和并发初始化数上限。累计更新量越过房间上限后才执行一次真实状态编码检查；确认超限时终止该房间连接并重建 Y.Doc，避免只删除 Y.Text 后仍保留 CRDT 历史。主服务 readiness 不健康时，协同升级请求与 RPC 一样拒绝新连接，避免内存压力期间继续创建 Yjs 状态。

### 4.3 默认资源边界

| 环境变量                              |   默认值 | 作用域                       |
| ------------------------------------- | -------: | ---------------------------- |
| `WS_HEARTBEAT_INTERVAL`               | 30000 ms | RPC 连接心跳                 |
| `WS_MAX_CONNECTIONS`                  |      512 | RPC 同时连接数               |
| `WS_MAX_PAYLOAD`                      |   32 MiB | 单条 RPC WebSocket 消息      |
| `WS_MAX_BUFFERED_AMOUNT`              |   16 MiB | RPC 单连接待发送缓冲         |
| `COLLABORATION_MAX_CONNECTIONS`       |       64 | 协同同时连接数               |
| `COLLABORATION_MAX_PAYLOAD`           |    2 MiB | 单条 Yjs 消息                |
| `COLLABORATION_MAX_BUFFERED_AMOUNT`   |    2 MiB | 协同单连接待发送缓冲         |
| `COLLABORATION_MAX_DOCUMENTS`         |      128 | 单进程已加载文档数           |
| `COLLABORATION_MAX_DOCUMENT_BYTES`    |    2 MiB | 单文档 UTF-8 内容上限        |
| `COLLABORATION_MAX_STATE_BYTES`       |   32 MiB | 协同房间 CRDT 状态上限       |
| `COLLABORATION_MAX_PENDING_DOCUMENTS` |       32 | 并发文档初始化数             |
| `COLLABORATION_IDLE_TIMEOUT`          | 60000 ms | 无客户端文档回收时间         |
| `MAX_EXTENSION_HOSTS`                 |        2 | 扩展宿主子进程数             |
| `EXTENSION_HOST_MAX_OLD_SPACE_SIZE`   |  512 MiB | 单扩展宿主 V8 堆上限         |
| `MAX_MANAGED_EXTENSION_PROCESSES`     |        8 | 单管理器跟踪的 Node 子进程数 |
| `EXTENSION_HOST_IDLE_TIMEOUT`         | 60000 ms | 断连扩展宿主回收时间         |
| `EXTENSION_HOST_SHUTDOWN_TIMEOUT`     |  2000 ms | 优雅关闭最长等待时间         |
| `WATCHER_HOST_MAX_OLD_SPACE_SIZE`     |  256 MiB | 文件监听子进程堆上限         |
| `TERMINAL_IDLE_TIMEOUT`               | 30000 ms | 断连终端回收时间             |
| `SERVER_MAX_HEAP_USED_MB`             |  448 MiB | 超过后 readiness 失败        |
| `SERVER_MAX_RSS_MB`                   |  768 MiB | 超过后拒绝新 RPC 连接        |
| `HTTP_MAX_CONNECTIONS`                |      512 | HTTP/TCP 同时连接数          |

生产 `start` 命令把主进程 V8 old-space 限制为 512 MiB；AI 档位为 768 MiB。开发 server 同样固定为 512 MiB，AI 档位为 768 MiB；扩展宿主和 watcher 子进程分别限制为 512 MiB 与 256 MiB，断开的扩展宿主即使是最后创建的实例也会在 60 秒后回收，重连则取消回收定时器。普通 client 的 Rspack 开发进程限制为 512 MiB，AI/Notebook 档位为 768 MiB；默认生产 client 构建为 768 MiB，完整档为 1024 MiB。默认关闭 source map，调试时用 `SOURCE_MAP=1` 显式启用，避免大型源码图长期占用 Rspack 常驻内存。`/healthz` 返回进程内存快照，`/readyz` 在 heap/RSS 超限时返回 503，同时 RPC 和协同 WebSocket 升级也返回 503，避免内存压力期间继续接纳新会话。HTTP 服务另设 15 秒 headers timeout、30 秒 request timeout、16 KiB header 和每 socket 1000 次请求上限，用来限制慢连接与无界 keep-alive。

两个 WebSocket server 默认关闭 `perMessageDeflate`，避免压缩上下文带来的额外常驻内存和压缩型拒绝服务面。生产部署可降低上限，但提升上限前必须用相同工作区和扩展集压测。

### 4.4 依赖与原生模块治理

- 包管理器统一为 pnpm workspace，并用一致性检查阻止同一个依赖在不同 workspace 漂移版本。
- 全仓 TypeScript 构建按 project reference 串行执行，普通项目使用 512 MiB 堆上限，AI Native、Extension、Notebook 三个大项目使用 768 MiB；macOS 可用内存低于 20%（Linux 默认低于 1 GiB）时在下一个项目开始前停止。失败时不再先删除全部 `lib`，可用 `OPENSUMI_BUILD_FROM=<tsconfig>` 从指定 project reference 续跑。全仓 ESLint 按文件数和源码体积分批，每个批次限制为 384 MiB；Jest 固定 `--runInBand`。构建、lint 与测试门禁不得在本机并行执行。
- 搜索原生包由弃用的 `@opensumi/vscode-ripgrep` 迁到 `@opensumi/ripgrep`。
- 日志原生包由 `spdlog` 迁到维护中的 `@vscode/spdlog`。
- 协同服务端由 `y-websocket/bin/utils` 迁到 `@y/websocket-server`，客户端继续使用兼容 Yjs 13 的协议。
- `glob`、`rimraf`、CSS 压缩器、Playwright 和评论提及组件已迁到支持 Node 24 的实现。
- AI SDK 的 `zod` 固定在兼容的 v3 范围，避免 pnpm 解析到不满足 AI SDK peer contract 的 v4。
- `core-common` 对 Electron、AI SDK 与 ACP SDK 只有类型引用，因此三者已从生产 dependencies 移到开发依赖与可选 peer；默认 Web IDE 的生产依赖图不再因为公共类型包携带 Electron/AI 运行时，AI Native 与 Electron 产品包仍显式声明自己的实际依赖。

### 4.5 前端构建链治理

- 默认产品构建器和浏览器扩展 worker 均从 Webpack 迁移到 Rspack 2，生产压缩、持久缓存、开发服务器、WASM 和资源模块均由 Rspack 接管；`client/` 与 `packages/extension` 不再保留产品 Webpack 配置或回退命令。Electron、CLI 和旧示例中仍存在的 Webpack 构建是后续独立迁移边界。
- 默认开发档从各 workspace 包的 `lib` 读取已编译 JavaScript，只让 Rspack 编译 `client/src` 与 startup 产品入口，避免 `tsconfig.resolve.json` 把整个 `packages/*/src` TypeScript 图常驻在前端构建进程中。修改框架源码后先串行执行 `pnpm init`；只有确实需要框架浏览器源码 HMR 时才用 `OPENSUMI_SOURCE_MODE=1 pnpm dev`。本机同一入口空载采样中，默认档 Rspack RSS 约 584 MiB，源码档约 866 MiB。
- 默认开发 server 运行 `server/dist/main.js`，避免常驻 `tsx watch` 监督器与 TypeScript loader；`pnpm init` 会同时生成该产物。修改 `server/src` 时使用 `OPENSUMI_SERVER_SOURCE_MODE=1 pnpm dev`，前后端都需要源码监听时直接使用 `pnpm dev:source`。
- `client/src` 的新产品入口使用内置 SWC；`packages/*` 暂时使用最新版 `ts-loader` 的 transpile-only 模式，以保持现有 NodeNext/CommonJS 装饰器元数据和循环依赖语义。
- 全仓升级到 Less 4、less-loader 13、css-loader 7 和 style-loader 4，并将旧式无括号 Less mixin 调用改为当前语法。
- 仓库自有运行脚本统一使用 `.ts`，由 `tsx` 或 Node 24 的原生 TypeScript 支持执行，并纳入 `typecheck:scripts`；`configs/` 下的可执行配置只使用 `.ts`，TypeScript 工程配置保留标准 `.json`，不提交 `.tsbuildinfo` 等生成缓存。产品 Rspack 配置也使用 `.ts`；`.cjs`/`.mjs` 只允许出现在尚未迁移的外部工具兼容边界。
- css-loader 7 的 CSS Modules 导出规则被显式固定为原始类名，保持现有 `styles.mod_selected` 等调用契约。
- React 与 ReactDOM 18.3 固定在 workspace 根并作为 workspace peer 的唯一解析来源；只支持 React 19 的 `react-mentions-ts@6` 已换回 React 18 兼容的 `react-mentions@4.4.10`，避免评论功能把第二套 React runtime 装入页面。
- 已停止维护的 `react-ctxmenu-trigger@1.0.1` 已由仓库内的 React 18 Portal 实现替代；仓库生产源码已移除 `childContextTypes`、`contextTypes`、`findDOMNode`、`unmountComponentAtNode` 和 `UNSAFE_componentWill*`，React 18 root 均保存并在销毁时显式 `unmount()`；资源树右键菜单已在真实浏览器中验证。
- 后续将框架包迁到 SWC 的门槛是：类型重导出改用 `export type`、装饰签名类型改用 `import type`，并通过 isolated-modules 校验；在此之前不以牺牲运行时稳定性换取单纯的编译数字。
- Unix watcher IPC 使用短 socket 文件名，避免 macOS 在深目录环境中因路径超过系统上限而触发 `listen EINVAL`。

## 5. 开发、构建与发布流程

```bash
# 安装；Node 版本不符合 >=24 <25 时立即失败
pnpm install --frozen-lockfile
pnpm setup:native # 首次安装或切换 Node 版本后执行一次

# 默认开发：浏览器 + Node 24 服务
pnpm dev

# 默认不生成 source map；需要调试映射时显式开启
SOURCE_MAP=1 pnpm dev

# 仅在联调 packages/* 浏览器源码且需要 HMR 时开启
OPENSUMI_SOURCE_MODE=1 pnpm dev

# 前后端都启用源码监听
pnpm dev:source

# 启用 AI；或启用 AI + Notebook 完整档
pnpm dev:ai
pnpm dev:full

# 显式启用 Yjs 协同
pnpm dev:collaboration
pnpm dev:full:collaboration

# 产品构建
pnpm build:client
pnpm build:client:full
pnpm build:server

# 运行编译后的服务
pnpm --dir server start

# 5 轮、每轮 100 个 WebSocket 的可重复内存回收冒烟
pnpm --dir server smoke:memory
```

`scripts/dev.ts` 是低内存启动监督器：两进程启动前要求 macOS 至少 30% 可用内存（Linux 至少 2 GiB），低内存 client 启动前检查必要的 `lib` 产物，先等待 server 健康再启动 client，并在退出或子进程异常时终止完整进程组，避免遗留 Rspack、watcher 或扩展宿主。常驻开发命令由 Node 24 直接启动监督器，不再让 `cross-env` 夹在 Ctrl-C 信号链中；可用 `--client-only` 或 `--server-only` 单独启动一侧。

CI 只安装 Node 24 与 pnpm，不再安装 Go。生产容器应为主服务设置可观测的内存限制；若通过 `NODE_OPTIONS=--max-old-space-size=<MiB>` 限制 V8 堆，容器内存上限还要为 native addon、Buffer、代码页和子进程预留空间，不能把堆上限等同于 RSS 上限。

## 6. 兼容、风险、回滚与可观测性

| 场景 | 预期行为 | 降级或回滚 | 验证方式 |
| --- | --- | --- | --- |
| 普通 IDE 会话 | 继续使用 `/service` RPC | 回退本次连接层提交，不改客户端协议 | 打开文件、终端、扩展激活冒烟 |
| 协同未启用 | 不监听 12345，不加载协同模块 | 使用默认 `pnpm dev` | 端口与进程检查 |
| 协同慢客户端 | 缓冲超限后只断开该连接 | 客户端按现有 provider 重连 | 人工制造不读 socket 的连接 |
| 超大消息 | 连接被拒绝，不进入业务处理 | 按业务证据调整环境变量 | 边界值与超限消息测试 |
| 扩展宿主过多 | 默认最多 2 个，先回收最旧实例再创建新实例 | 按容器预算提高 `MAX_EXTENSION_HOSTS` | 多客户端并发激活扩展 |
| Bun 试验 | 不影响生产 Node 入口 | 删除实验分支即可 | 原生模块与扩展协议全量回归后再评审 |

主要剩余风险是协同状态仍与主服务处于同一 Node 进程；资源上限能阻断常见无界增长，但不能隔离 Yjs 或 native addon 的进程级崩溃。若压测显示协同堆占用仍影响主服务，下一步应把相同 `YWebsocketServerImpl` 入口移动到独立 Node 24 worker/容器，而不是改变客户端协议。

至少采集以下指标：主进程与扩展宿主 RSS、V8 heap、外部 Buffer、事件循环延迟、RPC/协同连接数、升级失败数、关闭码、每连接 `bufferedAmount`、协同文档键数量、扩展宿主数量和空闲回收次数。告警应以持续增长率和容量比例为主，不能只看某个瞬时 RSS。

## 7. 改动文件清单

| 文件或模块 | 类型 | 职责变化 |
| --- | --- | --- |
| `server/` | 产品入口 | 取代 `server/node` 与 `server/go`，统一 Node 24 启动 |
| `client/src/main.tsx` | 产品组合 | 默认轻量装配，AI、Notebook、协同改为动态模块开关 |
| `packages/startup/src/*/ai-modules.ts` | 可选模块边界 | 将 AI 从浏览器端、Node 端公共模块集合中拆出 |
| `packages/connection/src/common/server-handler.ts` | 稳定性修复 | 用活动连接集合统一调度心跳 |
| `packages/connection/src/node/common-channel-handler.ts` | 资源治理 | pong 检测、背压、连接与消息上限、错误处理 |
| `packages/collaboration/src/node/y-websocket-server.ts` | 稳定性修复 | 固定房间、资源上限、待处理请求回收与取消 |
| `packages/core-node/src/types.ts` | 配置契约 | 暴露 RPC 与协同资源参数 |
| `package.json`、`pnpm-workspace.yaml` | 工具链 | 只保留 `client` 与 `server` 产品 workspace |
| `.github/workflows/check.yml` | CI | 删除 Go job，构建统一 Node server |

## 8. 验收与测试计划

| 验收项         | 如何验证                                                                                      |
| -------------- | --------------------------------------------------------------------------------------------- |
| 工具链门禁     | Node 24 下执行 frozen install、版本一致性检查；Node 22 安装应被 `engineStrict` 拒绝           |
| 产品构建       | `pnpm build:client` 与 `pnpm build:server` 均生成产物，服务由 `node server/dist/main.js` 启动 |
| 多连接心跳     | 同时注册两个连接，推进定时器后两者都收到心跳；关闭其一后只剩活动连接继续                      |
| RPC 路由       | 真实 WebSocket 连接 `/service` 并完成 OpenSumi channel open/server-ready 往返                 |
| 协同请求回收   | 文件初始化成功后 pending map 为空；最后引用释放或空闲超时后 Y.Doc/Y.Map 与监听均被销毁        |
| 协同房间限制   | 连接合法 `ROOM_NAME` 成功，任意其他 URL 房间收到 404                                          |
| 背压与消息上限 | 构造超限 payload 和不消费输出的客户端，只关闭违规连接，主服务继续响应                         |
| 原生模块兼容   | Node 24 加载 `node-pty`、`nsfw`、`@parcel/watcher`、`keytar`、`@vscode/spdlog`                |
| 功能档位       | 默认与完整 client 均成功打包；默认 server 不装配 AI/协同，开关开启时模块可加载                |
| 目录收口       | 全仓搜索不存在 `server/go`、`server/node`、`dev:go` 或 `server-node` 有效引用                 |

发布前先在单机同一工作区执行 1、10、50 个会话阶梯压测，记录稳定后的主进程 RSS、每个扩展宿主 RSS 和连接缓冲峰值。只有持续增长曲线趋稳且异常连接不影响健康会话，才进入生产灰度。

当前 Node 24 本机验证中，服务长时间空闲后的主进程 RSS 采样约 49 MiB。2026-08-25 连续两次执行 `smoke:memory`：冷启动基线为 99.5–101.6 MiB，连续 5 轮、每轮 100 个 RPC WebSocket 后，采样峰值为 107.0–114.9 MiB，全部关闭 2 秒后相对基线保留 7.6–13.2 MiB，低于 32 MiB 门禁。最终默认低内存档在真实浏览器加载、一个预编译 watcher 和一个 Node 扩展宿主激活后，整棵 OpenSumi 产品进程树一次采样约 611 MiB；同场景使用 server/框架源码监听时一次采样约 1.03 GiB。清空本轮 Rspack 缓存后，协同档建立真实 Yjs WebSocket 并空闲约 76 秒时整棵产品进程树采样约 285 MiB，页面控制台无 error；冷编译和 macOS 回收会让瞬时 RSS 明显波动，因此这些点样本不能当作峰值承诺。生产服务不携带 Rspack。这个结果只证明本机默认开发链和连接生命周期已明显收紧，不代表真实编辑、搜索、终端、协同编辑和多扩展负载的容量结论；后者仍必须按上一段的阶梯压测执行。

## 9. Go 的适用边界

当前证据不支持把 IDE 核心后端重写成 Go：OpenSumi RPC、VS Code 扩展宿主、PTY、文件监听和 Yjs 状态仍要保留 Node，重写只会形成 Go + Node 双进程并增加协议、部署与排障面。若后续出现多租户公网入口，Go 适合做无状态边缘层，例如 TLS、鉴权、租户路由、限流、静态资源和健康聚合；Node 24 IDE worker 仍按工作区隔离，并由容器或进程管理器设置总 RSS/CPU 限额。只有边缘层本身成为已测量的 Node 瓶颈时才引入 Go，而不是以语言印象替代剖析数据。
