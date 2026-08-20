```
 ██████╗ ██████╗
██╔════╝ ██╔══██╗
██║  ███╗██████╔╝
██║   ██║██╔══██╗
╚██████╔╝██║  ██║
 ╚═════╝ ╚═╝  ╚═╝
 ·  g r o k   r e m o t e  ·  v0.2.0  ·  mobile
```

# grok-remote

手机端远程控制台，用来驱动本机已经登录的 **官方 Grok TUI 会话**。浏览器 / PWA 通过 REST + SSE 连到本机（或 Tailscale 尾巴网上）的 `grok-remote` 服务；服务再按写锁决定是走 ACP 真正发消息，还是只读尾巴 `updates.jsonl`。

**一句话：这是官方会话的遥控器，不是第二套会话库。**

对话真相只存在 `~/.grok/sessions`。侧栏每一行只是一个 overlay UUID，指向某个 grok `sessionId`。overlay 目录里真正需要的只有 `meta.json`（星标、归档、改名、文件夹、`wantedConnected`、每聊设置）。没有隔离沙箱 `cwd/`，overlay `history.jsonl` 也不是持久记录。

当前前端是 **phone-first PWA**：会话列表、连接状态、历史回放、文件夹、斜杠命令、模型切换。桌面时代的 Settings / Files / Flow / Trace / MCP / LSP 等独立页面已经拆掉。

> 与 xAI、grok、Tailscale 均无官方关系。
>
> **Work in progress.** 核心路径（侧栏、聊天、工具调用、TUI 历史、写锁）可用；细节会继续改。

上游是 [daniel-farina/grok-remote](https://github.com/daniel-farina/grok-remote)。本仓库是手机改版。

---

## 设计原则

1. **TUI-first。** 会话文件由官方 `grok` 写。remote 只提供 UI 和写锁之外的只读尾巴。
2. **Overlay 是指针，不是副本。** `~/.grok-remote/agents/<uuid>/` 不复制聊天，不创建沙箱目录。
3. **同一时刻只有一个写者。** `~/.grok/active_sessions.json` 决定谁握着会话。TUI pager 在线时，prompt / connect / model 一律 **409** `{ heldBy: "tui" }`。
4. **浏览器是一次性的。** 关掉手机标签不会停掉 turn，也不会杀 ACP。只有 `wantedConnected === true` 且未归档时，服务端才会在重启后把 ACP 拉回来。
5. **手机是一等公民。** 交互走抽屉、底栏 sheet、44px 热区、`safe-area-inset`、动态视口，避免 iOS Safari 键盘把 composer 顶飞。

---

## 它做什么

- **远程 UI 覆盖官方 TUI 会话。** 本机 `grok` 聊过的对话会出现在侧栏。点 `+ New` 会在 Settings 的 `defaultCwd`（真实项目目录）里开一个新的官方 session。第一轮回复会自动起名。
- **写锁 + 409。** TUI pager 占用 → 状态 `observed`（“watching TUI” / “TUI · 只读”），输入框只读。remote 握着 ACP（`grok agent --no-leader`）→ 可以打字。空闲且 `wantedConnected: true` → 服务端自己连上。
- **完整 ACP host。** 实现客户端侧的 `terminal/*`、`fs/*`、`session/request_permission`，让 agent 能在 recorded cwd 里跑命令、读文件、写文件。
- **实时流。** SSE 转发每一个 `session/update`：思考、工具卡片（Pending → Running → Completed / Failed）、终端输出、助手正文、token 用量。TUI 握锁时，`UpdatesFileTail`（约 800ms）把 `updates.jsonl` 新行转成同一套 SSE。
- **历史读 grok 的文件。** `GET /api/agents/:id/history` 优先读 `updates.jsonl`，并设 `X-History-Source: tui`。overlay `history.jsonl` 只是 TUI 目录出现前的握手兜底（`X-History-Source: agent`）。TUI 目录一旦存在，overlay 停止追加。
- **导入官方 session。** 侧栏 Import sheet 搜索 `~/.grok/sessions`。打开 / 导入走同一条路：`POST /api/agents` + `resumeSessionId` + `connect: false`，**不抢写锁**。
- **星标 / 归档 / 彻底删除。** 关一行是软归档。归档视图里可以 restore，或删 overlay。官方 session 文件默认保留；二次确认才会 `?deleteTuiSession=1`。
- **图片附件。** 拖、贴、点 `+`。每轮最多 5 张、每张 5 MB，png / jpeg / webp / gif。字节写到 `<recorded cwd>/uploads/`（目录必须已经存在）。prompt 同时带 inline ACP `image`、`resource_link` 和绝对路径。
- **可安装 PWA。** iOS / Android 加到主屏幕。≤720px 侧栏收成抽屉；桌面用 Split.js 分栏。
- **主题。** Dark / Light，存在 `localStorage`，`<html data-theme>` 在首屏前就套上，避免闪白。
- **`gr` CLI。** 装完后任意目录：`gr` 打开面板，`gr status` 看 PM2，`gr install` 重跑安装器。

---

## 架构总览

```
  手机 / 桌面浏览器 (PWA)
  src/  Vanilla TS + Vite
        hash 路由  #/  |  #/agents/<overlay-uuid>
           │
           │  REST  /api/*
           │  SSE   /api/agents/:id/stream
           │        /api/agents/stream
           ▼
  grok-remote server.ts   :7910
           │
           ├─ AgentManager          overlay 注册表 + 生命周期
           ├─ AcpClient             grok agent --no-leader stdio
           │     ├─ terminal-host   真正 spawn shell
           │     ├─ fs-host         读/写 recorded cwd
           │     └─ permission-host 权限回调（--always-approve 时自动放行）
           ├─ session-ownership     ~/.grok/active_sessions.json → heldBy
           ├─ tui-bridge            读 ~/.grok/sessions
           ├─ tui-reconcile         把 lived-in TUI session 合进侧栏
           ├─ conversation-history  GET history 的 TUI-first 解析
           └─ updates-tail          TUI 握锁时轮询 updates.jsonl
           │
           ▼
  ~/.grok/sessions/<enc-cwd>/<sessionId>/     对话真相
  ~/.grok/active_sessions.json                写锁
  ~/.grok-remote/agents/<uuid>/meta.json      指针 + UI 状态
```

两层永远不要混：

| 层 | 路径 | 职责 |
|----|------|------|
| 官方 TUI | `~/.grok/sessions/...` | 对话、标题、token、工具调用日志 |
| overlay | `~/.grok-remote/agents/<uuid>/` | 侧栏行：星标、归档、文件夹、是否想保持连接 |

`:id` 在 HTTP 上可以是 overlay UUID **或** grok `sessionId`。服务端用 `getByIdOrSession` 查到后再 **rebind** 成 overlay UUID。JSON 里的 `id` 永远是 overlay UUID。单纯 `GET` / 改 hash **不会** 把已归档行恢复。

---

## 原理

### 1. 磁盘布局

```
~/.grok/
├── active_sessions.json                # [{ session_id, pid, cwd, opened_at }]
└── sessions/
    └── <encodeURIComponent(cwd)>/
        └── <sessionId>/
            ├── summary.json            # title, cwd, timestamps, session_kind
            ├── signals.json            # turns, model, usage
            └── updates.jsonl           # 持久 turn 日志 + 直播尾巴

~/.grok-remote/
├── settings.json                       # defaultModel, defaultCwd, autoApprove, retentionDays, …
├── folders.json                        # folder.agentIds = overlay UUID
└── agents/
    └── <overlay-uuid>/
        ├── meta.json                   # 唯一必需文件
        └── history.jsonl               # 握手兜底；TUI 目录出现后停止追加
```

- **永远不要** 创建 `~/.grok-remote/agents/<id>/cwd/`。`meta.json` 里的 `cwd` 是真实工作区，连接前可以不存在。
- `session_kind === "subagent"` 只在 `summary.json` 明确写了才算。缺省当 main。
- `wantedConnected` 缺省 hydrates 成 **false**。只有显式 `true` 才会在重启后自动拉 ACP（归档或 `heldBy: "tui"` 除外）。
- 环境变量：`GROK_HOME` 改 grok 家目录，`GROK_REMOTE_HOME` 改 overlay 根，`GROK_BIN` 改 grok 可执行文件。

### 2. 写锁（ownership）

`holderForSession(sessionId)` 读 `active_sessions.json`，确认 pid 还活着，再看 `/proc/<pid>/cmdline`：

| holder | 含义 | prompt / connect / model |
|--------|------|--------------------------|
| `tui` | 官方 `grok` pager（不是 `grok agent`） | **409** `{ heldBy: "tui" }` |
| `remote` | 本进程（或其它进程）的 `grok agent` | 允许走我们的 ACP 子进程 |
| `null` | 空闲 | connect / prompt 可以拉起 ACP |

TUI 握锁时：

- `PublicAgent.status === "observed"`
- 输入框只读
- `beginView` 启动 `UpdatesFileTail`，把新行转成和 ACP 一样的 SSE
- 这些事件 **不会** 再写入 overlay `history.jsonl`

### 3. 写路径：ACP

remote 握锁时 spawn：

```
grok agent --no-leader [--always-approve] stdio
```

- JSON-RPC 2.0，一行一个对象，UTF-8。
- `--no-leader`：每个 ACP 进程独立，互不抢 TUI leader，才能并行多聊。
- `--always-approve`：agent 不卡在权限提示；我们仍实现 permission 回调。
- cwd 是 recorded session cwd 或 Settings `defaultCwd`，必须是已存在的真实路径。

握手 `initialize` 之后：

```
session/new     → 新聊，grok 在 ~/.grok/sessions 建目录
session/load    → 恢复已有 sessionId
session/prompt  → 开一轮；agent 推 session/update；最后 stopReason + token
session/cancel  → 取消进行中的一轮
```

agent 会反过来调我们（client）：

| method | 我们必须做的事 |
|--------|----------------|
| `terminal/create` | 真的 spawn 命令，返回 `{ terminalId }` |
| `terminal/output` / `wait_for_exit` / `kill` / `release` | 读输出、等退出、杀进程、清理 |
| `fs/read_text_file` / `fs/write_text_file` | 在 recorded cwd 里读写 |
| `session/request_permission` | 选允许；`--always-approve` 时自动 `allow_always` |

`terminal/create` 如果回 `{}` 而不跑命令，所有工具调用都会失败。工作目录永远是会话 recorded cwd，不是 grok-remote 进程 cwd，也不是 overlay 沙箱。

### 4. 读路径：history + tail

```
GET /api/agents/:id/history?turns=50   或  ?all=1
Content-Type: application/x-ndjson
X-Total-Turns / X-Returned-Turns / X-History-Source=tui|agent|empty
```

解析顺序：`findTuiSessionDir(sessionId, cwd)` → `tuiUpdatesToHistory()`。只有这个目录不存在时才回落到 overlay jsonl。

直播：

- ACP 握锁：`session/update` 通知直接进 SSE ring（每 overlay 最近约 200 条），浏览器 `EventSource` 用 `Last-Event-ID` 重放。
- TUI 握锁：`UpdatesFileTail` 约 800ms 读一次 `updates.jsonl`，`liveEventFromUpdateRow` 转成同一套事件名。

前端按 turn 渲染，时间顺序固定：

1. 用户气泡
2. 思考托盘（默认折叠，直播标记保持可见）
3. 工具日志（一张托盘；折叠只藏已完成，进行中的行留下）
4. 助手正文
5. token footer（`prompt_complete` 关 turn，用量经常晚一拍到达）

### 5. 侧栏如何出现一行

`GET /api/agents` 不是“只列出 overlay 目录”。`AgentManager` 会：

1. 读本地 overlay
2. `listTuiSessions()` 扫 `~/.grok/sessions`
3. `planTuiReconcile` 把 lived-in 的官方 session 合进来（已有 `lastSessionId` 就更新，没有就建指针）
4. 去重：同一个 `sessionId` 只留一个 overlay（优先未归档、更早创建的）
5. 归档行仍宣称自己的 `lastSessionId`，避免同一 TUI session 又被克隆回直播列表

新建：

```
POST /api/agents   {}                         # 立刻 spawn ACP，cwd 必须可用
POST /api/agents   { resumeSessionId, connect: false }   # 只建指针，不抢锁
```

没有 `resumeSessionId` 且没有可用 cwd → **400** `cwd required`。导入不要求目录此刻在磁盘上。

### 6. 前端怎么拼起来

纯 Vanilla TypeScript + Vite，**没有 React**（Flow 页和 `@xyflow/react` 已移除）。

| 文件 | 职责 |
|------|------|
| `src/main.ts` | 启动、hash 路由、抽屉、桌面 Split.js、顶栏、PWA |
| `src/views/agents.ts` | 侧栏：列表、文件夹、筛选、拖拽、星标/归档/删除 |
| `src/views/chat.ts` | 对话：历史回放、SSE、composer、工具卡 |
| `src/views/cwd-sheet.ts` | 选工作目录 |
| `src/views/import-sheet.ts` | 搜索并导入官方 session |
| `src/views/model-sheet.ts` | 模型 + reasoning effort |
| `src/views/prompt-sheet.ts` | 替代 `window.prompt` / `confirm`，手机不会掉进系统对话框 |
| `src/lib/api.ts` | REST 封装 |
| `src/lib/sse.ts` | EventSource + 具名事件 |
| `src/lib/render.ts` | 气泡 / markdown-light / 工具卡 / toast |
| `src/lib/themes.ts` | `dark` \| `light` |
| `src/style.css` | 设计令牌、安全区、动态视口、sheet |

路由只有两条：

```
#/                  欢迎页（空 chat + 上次会话会自动跳回去）
#/agents/<id>       打开该 overlay
```

旧桌面路由（`#/settings`、`#/flow`、`#/mcp`、`#/sessions` …）一律 `redirect → #/`。

断点：

- `≤720px`：侧栏是抽屉；hamburger 打开；点会话或点遮罩关闭。视口锁在 `--drawer-lock-h`，避免键盘把 composer 抬进抽屉旁的空隙。
- `>720px`：Split.js 分栏，尺寸记在 `localStorage`。顶栏左侧按钮可折叠侧栏。跨过断点会 `location.reload()`，避免两套布局互相污染。

Composer：

- 桌面：Enter 发送，Shift+Enter 换行。
- 手机 / CJK IME：Enter 换行，必须点 Send。发送中按钮变成取消。
- `/` 打开斜杠面板，数据来自 ACP `available_commands_update` ∪ `GET /api/system/skills?cwd=`。
- 空输入时显示最多 6 个 suggestion chips。

---

## 使用方法

### 环境

- macOS 或 Linux
- Node.js 20+（macOS 安装器缺 Node 时会走 Homebrew）
- 本机已安装并登录 `grok` CLI（写路径会 spawn `grok agent --no-leader stdio`）
- 若要从其它设备访问：Tailscale 账号（个人免费，[tailscale.com](https://tailscale.com)）

### 安装

```sh
git clone https://github.com/Charry-C/grok-remote.git
cd grok-remote
./install.sh
```

只在本机、不走 Tailscale：

```sh
./install.sh --local
```

安装器逐步做这些事（每步幂等，带 `[ OK ]` / `[skip]` / `[warn]` / `[FAIL]`）：

1. 确认 node ≥ 20
2. 确保 pm2
3. 确保 tailscale（`--local` 跳过）
4. 启动 tailscaled
5. 检查 tailscale 登录
6. 解析 tailnet URL
7. `npm install`
8. `vite build` 出 `dist/`
9. 写 PM2 `ecosystem.config.cjs`
10. 用 PM2 拉起服务（默认 `:7910`，`HOST=0.0.0.0`）
11. 可选开机自启
12. `pm2 save`
13. 安装 `gr` 到 `PATH`
14. 用 Chrome 打开面板（SSH / `CI=1` / `NO_OPEN=1` / `--no-open` 会跳过）

开机自启可用 `--auto-start` / `--no-auto-start` 或 `AUTO_START=1|0` 预选。非交互（`CI`、`NO_PROMPT=1`）默认不开。

Tailscale 若警告未登录：跑 `tailscale up`，打开它打印的 URL；macOS 必要时先开一次 `Tailscale.app`。然后再跑一遍 `./install.sh`。

`--local` / `gr install --local` 把服务绑在 `127.0.0.1`，不碰 overlay，也不碰官方 session。

### 日常使用

#### 开新对话

点侧栏 `+ New`。第一次会弹出 Working directory sheet，填本机上的真实项目路径，写入 `defaultCwd` 并复用。长按 `+ New` 可改。

随后 `POST /api/agents {}`：服务端在该目录 spawn ACP，grok 在 `~/.grok/sessions` 建新 session。第一轮 `session_summary_generated` 会给这一行自动起名。

没有可用 cwd → API 400 `cwd required`。导入旧 session 不要求目录此刻存在。

#### 导入已有 TUI 会话

侧栏 Import：按 id / 标题 / cwd 搜本机 `~/.grok/sessions`（含 leftover / hidden）。Open 和 Import 同一条 API：

```http
POST /api/agents
{ "resumeSessionId": "<grok-session-id>", "connect": false }
```

物化（或找回）overlay，必要时把归档行恢复。**不** 抢 ACP 写锁。浏览器再跳到 `#/agents/<overlay-uuid>`。只改 hash 或只 `GET` 不会 unarchive。

子 agent 会话会带 `sessionKind: "subagent"`。侧栏不会自动为它们建 overlay。

#### 聊天

- 打字，点 Send。桌面 Enter 发送。
- 思考默认折叠，工具调用一张托盘往下长。
- 点顶栏右侧状态点：连接 / 断开。断开只杀 `grok agent`，overlay 和官方 session 都在。再发一条或点连接会 `session/load` 同一个 `sessionId`。
- TUI 占用时状态是 “TUI · 只读”，composer 锁住。先离开终端 pager。
- 点 composer 里的 Model：换模型和 reasoning effort。TUI 占用时 409。
- 历史默认最近 50 轮；上面有 “load all earlier turns”。

命令行续聊（不经过本 UI）：

```sh
grok -p "<follow-up>" -r <sessionId>       # 一次性 headless
cd <cwd> && grok --resume <sessionId>      # 交互 TUI
```

#### 附件

三种方式：拖到 composer、剪贴板粘贴、点 `+`。

限制：每轮 5 张、每张 5 MB、png / jpeg / webp / gif。文件落到 `<recorded cwd>/uploads/<name>`。agent 同时收到：

- 文本里的绝对路径
- ACP `image`（inline base64）
- ACP `resource_link`

有视觉能力的模型会看图；没有的仍可用 shell 读磁盘。cwd 还不存在时不会落盘。

#### 斜杠命令

composer 开头输入 `/` 打开面板：`/compact`、`/always-approve`、`/context`、`/session-info`，以及 grok 通过 `available_commands_update` 或 `~/.grok/skills` / 仓库 `.grok/skills` 加进来的命令。方向键 + Enter 确认，Esc 关掉。

#### 文件夹、星标、归档

- 侧栏底部可建文件夹。长按（触摸约 450ms）或鼠标拖，把会话丢进文件夹。
- `☆ / ★`：星标置顶。
- `×`：归档。ACP 停，`wantedConnected` 变 false，行进 Archived。reconcile 仍认领这个 `lastSessionId`。
- Archived 里：restore 只恢复 overlay，不自动连接。delete 只删 overlay 和文件夹引用。官方文件默认留下。第二次确认才会带 `?deleteTuiSession=1`；TUI 握锁时这次 opt-in 也是 409。

保留策略（`retentionDays`，默认 30，`0` 关闭）只在 grok **已经删掉** session 目录之后清理 overlay。星标、归档、仍 lived-in 的 TUI session 不会被自动删。

#### 主题与 PWA

侧栏 Appearance：Dark / Light，存在 `grok-remote.theme`。

手机打开 tailnet URL：

- 侧栏是左上汉堡抽屉
- 支持的浏览器会出安装条
- iOS Safari 提示 Share → Add to Home Screen
- 装好后独立运行，状态栏颜色跟主题走

Service worker（`public/sw.js`）：

- `/api/*` 永远走网络，不缓存
- 其它同源 GET：cache-first + 后台再验证
- 预缓存 `/`、`/index.html`、manifest

### `gr` 命令

`./install.sh` 会把 `gr` 链到 `/usr/local/bin`（或 `~/.local/bin` 并提示改 PATH）。用 `GR_HOME` 覆盖安装目录。

| 命令 | 作用 |
|------|------|
| `gr` | 确认服务健康，打印 URL，询问是否打开 |
| `gr status` | PM2 状态、uptime、重启、内存、CPU、tailnet URL |
| `gr open` | 必要时启动，然后打开面板 |
| `gr url` | 只打印 URL |
| `gr start` | `pm2 start ecosystem.config.cjs`。`--local` 绑 localhost |
| `gr stop` | `pm2 stop grok-remote` |
| `gr restart` | `pm2 restart grok-remote` |
| `gr logs` | `pm2 logs grok-remote --lines 100` |
| `gr install` | 重跑安装器。`--local` 保持本机模式 |
| `gr version` | 打印版本 |
| `gr help` | 子命令表 |

### 运维

```sh
pm2 logs grok-remote
pm2 status
pm2 restart grok-remote
pm2 stop grok-remote
pm2 delete grok-remote
```

开机存活：

```sh
pm2 save
pm2 startup           # 按它打印的命令做
```

进程收到 SIGTERM / SIGINT 会先断开所有 ACP（写下 `lastSessionId`）再退出。官方 TUI 文件不动。

默认端口 `7910`，可用 `PORT` / `HOST` 改。PM2 配置在 `ecosystem.config.cjs`。

---

## HTTP API

全部 JSON，除非另注。权威细节在 [PROTOCOL.md](./PROTOCOL.md)。

没有 `GET /api/models`，也没有 `GET /api/tui/sessions`。手机 UI 不再调用 MCP / LSP / memory / leaders / worktrees 管理接口；服务端 `handleSystem` 现在只挂 models + skills。

| Method | Path | 作用 |
|--------|------|------|
| GET | `/api/agents` | overlay 列表（含 TUI reconcile） |
| POST | `/api/agents` | 新聊或导入。`{ name?, model?, cwd?, resumeSessionId?, connect? }` |
| GET | `/api/agents/:id` | `PublicAgent`。不 unarchive |
| PATCH | `/api/agents/:id` | `{ name, starred, archived, settings? }` |
| DELETE | `/api/agents/:id` | 删 overlay。`?deleteTuiSession=1` 才动官方目录 |
| POST | `/api/agents/:id/prompt` | `{ text, attachments? }`。202。TUI 握锁 409 |
| POST | `/api/agents/:id/cancel` | 取消进行中的一轮 |
| POST | `/api/agents/:id/connect` | spawn ACP + `session/load`。409 if TUI |
| POST | `/api/agents/:id/disconnect` | 杀 ACP，`wantedConnected: false` |
| POST | `/api/agents/:id/model` | 换模型 / effort。409 if TUI |
| GET | `/api/agents/:id/history` | NDJSON。`?turns=N` 或 `?all=1` |
| GET | `/api/agents/:id/stream` | 该会话 SSE |
| GET | `/api/agents/stream` | 侧栏列表变更 SSE |
| GET, POST, PATCH, DELETE | `/api/folders` | 文件夹 |
| PUT | `/api/agents/:id/folder` | `{ folderId }` 或 `null` 回到顶层 |
| GET | `/api/system/sessions` | 读磁盘上的官方 session。`q` / `limit` / `includeEmpty=1` |
| GET | `/api/system/models` | `grok models` |
| GET | `/api/system/skills` | 只读技能列表，给 `/` 面板。`?cwd=` |
| GET, PATCH | `/api/settings` | `defaultCwd`、`defaultModel`、`autoApprove`、`retentionDays`、`debug` |
| GET | `/api/hello` | tailscale 身份 + 版本 |
| GET | `/api/health` | 存活 |

`GET /api/agents/:id/files/raw` 仍给聊天图片附件用。后台终端 HTTP 仍在，但手机 UI 不再暴露入口。目录浏览与 `/trace` 已删除。

---

## 开发

```sh
npm install
npm start                 # :7910，同时提供 dist/ 和 /api/*
npm run dev               # Vite :7911，把 /api 代理到 7910
npm run typecheck         # tsc --noEmit
npm test                  # node:test + tsx
npm run test:integration  # 拉起 server.ts 打 /api/*；需要已登录的 grok
```

- 前端：`src/`。构建是 Vite（esbuild 剥类型）；类型检查是单独一步。
- 后端：裸 Node `http`，`tsx` 直接跑 `server.ts`。不编译也能生产跑（PM2 `interpreter_args: --import tsx`）。
- 单测：`test/*.test.ts`。覆盖 helpers 和 TUI-first 契约（history source、overlay cwd、ownership 409、session join、delete / retention、`wantedConnected`、folder sticky）。
- 集成测：`test/integration/*.test.ts`，需 `RUN_LOCAL_INTEGRATION=1`。会在随机高位端口拉 `server.ts`。
- ACP 探针：

```sh
node experiments/probe.js "Reply with the word ack." exp1.log
node experiments/probe.js "Run \`ls\` and tell me what you see." exp2.log
```

探针日志不要提交（含主机名和家目录）。用来对照 [PROTOCOL.md](./PROTOCOL.md) 里的帧。

---

## 目录

```
grok-remote/
├── install.sh                  # bash 引导，确认 Node 后交给 installer.ts
├── installer.ts                # 带动画的安装流程
├── bin/gr                      # gr CLI
├── server.ts                   # Node http + REST/SSE
├── ecosystem.config.cjs        # PM2
├── vite.config.ts              # :7911，/api → :7910
├── index.html                  # PWA shell、顶栏、安全区 viewport
├── PROTOCOL.md                 # ACP 帧 + HTTP 契约
├── lib/                        # 后端
│   ├── acp-client.ts           # grok agent stdio
│   ├── agent-manager.ts        # overlay 注册表
│   ├── tui-bridge.ts           # ~/.grok/sessions
│   ├── tui-reconcile.ts        # 侧栏与官方 session 对齐
│   ├── session-ownership.ts    # 写锁
│   ├── conversation-history.ts # TUI-first GET history
│   ├── updates-tail.ts         # 只读尾巴
│   ├── session-list.ts         # GET /api/system/sessions
│   ├── delete-agent.ts         # 删 overlay，可选 rm TUI
│   ├── folders.ts
│   ├── history.ts              # overlay 兜底 jsonl
│   ├── retention.ts
│   ├── terminal-host.ts
│   ├── fs-host.ts
│   ├── permission-host.ts
│   └── routes/system/          # models + skills
├── src/
│   ├── main.ts
│   ├── style.css
│   ├── views/                  # agents, chat, *-sheet
│   └── lib/                    # api, sse, render, themes, …
├── test/
├── public/                     # manifest、sw、图标
├── experiments/probe.js
└── docs/                       # 抓下来的 grok CLI help，不是本服务协议
```

---

## 和桌面版差在哪

相对上游 / 早期带 Settings 的版本，这个手机改版：

- 删掉 Settings、Files、Flow（React + xyflow）、Trace、Changelog、独立 system 页
- 删掉 MCP / LSP / memory / leaders / worktrees / health / import 页面和对应后端路由模块
- 主题只留 Dark / Light
- 交互收成抽屉 + bottom sheet（cwd / import / model / filter / confirm）
- composer 对齐 Grok 应用：附件、模型芯片、suggestion chips、手机 Enter 换行
- Vite 不再挂 `@vitejs/plugin-react`

会话模型没变：仍然是 TUI-first overlay + ACP 写路径 + `updates.jsonl` 只读尾巴。

---

## License

MIT。见 [LICENSE](./LICENSE)。
