```
  ██████╗ ██████╗
 ██╔════╝ ██╔══██╗
 ██║  ███╗██████╔╝
 ██║   ██║██╔══██╗
 ╚██████╔╝██║  ██║
  ╚═════╝ ╚═╝  ╚═╝
  ·  g r o k   r e m o t e  ·  v0.2.0
```

# grok-remote

A **remote UI** over official **Grok TUI sessions**. Drive the same conversations from any device on your **tailnet**. Multiple chats in parallel, a live web UI that streams every thought / tool call / response, reachable from your phone.

One command sets it up. PM2 keeps the server alive. Tailscale handles the networking. The dashboard is a controller, not a second session store: conversation truth lives in `~/.grok/sessions`. When grok-remote holds the write lock it speaks the **Agent Client Protocol** (ACP) to `grok agent --no-leader stdio`. When the official TUI pager holds the session, the UI tails `updates.jsonl` read-only.

Overlay state under `~/.grok-remote/agents/<uuid>/` is **`meta.json` only** — star, archive, rename, folders, per-chat settings, `wantedConnected`. There is no isolated sandbox `cwd/`. Overlay `history.jsonl` is **not** the durable record.

> Not affiliated with xAI, grok, or Tailscale.

> **Work in progress.** I'm pushing every change as I make it. Expect minor options to be broken at any given moment. Core session features (sidebar list, chat, tool calls, bg processes, TUI history, ownership) are functional.

---

## What it does

- **Remote UI over official TUI sessions.** Lived-in chats from `grok` on this machine show up in the sidebar. Click `+ New chat` to start a new official session in Settings' `defaultCwd`. The first turn auto-names it.
- **Overlay pointers, not sandboxes.** Each sidebar row is an overlay UUID pointing at a grok `sessionId`. Recorded `cwd` is the project's real path (it may be temporarily missing). grok-remote never invents `~/.grok-remote/agents/<id>/cwd/`.
- **Write lock + 409.** `~/.grok/active_sessions.json` says who holds the session. TUI pager → status `observed`, prompt / connect / model return **409** `{ heldBy: "tui" }`. Remote ACP (`grok agent --no-leader`) → you can type. Free + `wantedConnected: true` → the server connects.
- **Full ACP host.** Implements the client side of ACP (`terminal/*`, `fs/*`, `request_permission`) so the agent can run shell commands, read files, and write files when remote holds the lock.
- **Live streaming.** Server-Sent Events forward every `session/update`: thought chunks, tool-call cards (Pending → Running → Completed / Failed), streamed terminal output, the assistant message, token usage. While the TUI holds the lock, `UpdatesFileTail` (800ms) turns new `updates.jsonl` lines into the same SSE.
- **History is grok's files.** `GET /api/agents/:id/history` reads `updates.jsonl` first and sets `X-History-Source: tui`. Overlay `history.jsonl` is only a handshake fallback (`X-History-Source: agent`) before a TUI dir exists. Once the TUI dir is present, overlay appends stop.
- **Sessions search.** Settings → Sessions lists official sessions from `~/.grok/sessions` (`GET /api/system/sessions`). It does **not** shell out to `grok sessions list`, and there is no `/api/tui/sessions`. Open / import is `POST /api/agents` with `resumeSessionId` and `connect: false`.
- **Star, archive, delete-forever.** Closing a row **archives** the overlay (soft). Restore or **delete-forever** lives in the archived view. Delete removes the overlay only. Official session files stay unless you opt in (`?deleteTuiSession=1`).
- **Image attachments.** Drop or paste an image; bytes land at `<recorded cwd>/uploads/` (only when that directory exists). The prompt carries an inline ACP `image` block, a `resource_link`, and the absolute path.
- **Files tab + Flow tab.** Browse the recorded workspace. The conversation **Flow** tab (React / xyflow) graphs this chat's agent and tool-call satellites.
- **Mobile + PWA.** Installable on iOS and Android. Sidebar collapses to a drawer, 44px tap targets, safe-area-inset padding, dynamic-viewport sizing so the composer stays pinned on iOS Safari.
- **Themes.** Dark (default), light, hacker (phosphor green), unicorn. Persisted per browser.
- **A `gr` CLI on your PATH.** From any directory: `gr` opens the dashboard, `gr status` shows PM2 state, `gr install` re-runs the installer, etc.

---

## Requirements

- macOS or Linux
- Node.js 20+ (installer can install it via Homebrew on macOS)
- Homebrew on macOS (only used if Node, or Tailscale for tailnet mode, are missing)
- A Tailscale account, free for personal use at [tailscale.com](https://tailscale.com), if you want tailnet access
- `grok` CLI installed and authenticated (remote writes spawn `grok agent --no-leader stdio`; conversation files live under `~/.grok/sessions`)

---

## Install

```sh
git clone https://github.com/daniel-farina/grok-remote.git
cd grok-remote
./install.sh
```

To run only on the current machine without Tailscale:

```sh
./install.sh --local
```

The installer walks through, with animated `[ OK ]` / `[skip]` / `[warn]` / `[FAIL]` badges per step:

1. verify node >= 20
2. ensure pm2 (process manager)
3. ensure tailscale
4. start tailscaled (daemon)
5. check tailscale auth
6. resolve tailnet url
7. install app dependencies (`npm install`)
8. build dashboard (`vite build`)
9. write pm2 ecosystem config
10. start under pm2
11. enable auto-start on boot (optional, opt-in prompt)
12. save pm2 process list
13. install `gr` command (global shortcut)
14. open dashboard in Chrome

Auto-open can be skipped with `--no-open`, `NO_OPEN=1`, `CI=1`, or when the installer detects you're over SSH.

The installer asks once whether to auto-start the server on reboot. Pick "yes" if you want the PWA dock icon to "just work" after a restart; on macOS this writes a user-level `launchd` entry that calls `pm2 resurrect` at login. Pre-select with `--auto-start` / `--no-auto-start` or `AUTO_START=1` / `AUTO_START=0`. Non-interactive installs (CI, `NO_PROMPT=1`) default to no.

If a step warns about Tailscale auth, run `tailscale up` and open the URL it prints. On macOS, open `Tailscale.app` once if `tailscaled` isn't running. Then re-run `./install.sh`, every step is idempotent.

For local-only installs, re-run setup with `./install.sh --local` or `gr install --local`. This keeps the server bound to `127.0.0.1` and does not touch overlay pointers under `~/.grok-remote/agents` or official sessions under `~/.grok/sessions`.

---

## Use

### Start a conversation

Set a **default cwd** in Settings first (the real project directory). Click `+ New chat`. That `POST /api/agents`s without `resumeSessionId`, so the server starts ACP in that directory and grok writes a new session under `~/.grok/sessions`. Type a message. The first response auto-names the row from grok's `session_summary_generated` event.

Without a usable default cwd the UI toasts `Set a default cwd in Settings first.` and the API returns 400 `cwd required`. Importing an existing session does not need the directory to exist on disk.

### Sessions (search / import)

The **Sessions** page is a search / debug surface over official files on this machine (`~/.grok/sessions`), including leftover / hidden ones. Search by id, title, or cwd. **Open** and **import** use the same path:

```http
POST /api/agents
{ "resumeSessionId": "<grok-session-id>", "connect": false }
```

That materializes (or finds) an overlay pointer and restores an archived row if needed. It does **not** take the ACP write lock. The browser then navigates to `#/agents/<overlay-uuid>`. Changing the hash or `GET /api/agents/:id` alone will not unarchive.

Subagent sessions appear here with `sessionKind: "subagent"`. New subagent overlays are not auto-created for the sidebar (they belong on the parent Trace tab).

### Attach images and files

Three ways:
- Drag a file onto the composer
- Paste from clipboard (Cmd+V / Ctrl+V)
- Click `attach image`

Limits: 5 attachments per turn, 5 MB each, png / jpeg / webp / gif. The file is saved to `<recorded cwd>/uploads/<name>` (the session's real working directory) and the agent receives:

- The absolute path in the text
- An ACP `image` content block (the inline base64)
- An ACP `resource_link` content block (formal reference)

Vision-capable models describe the image; non-vision models still have it on disk to inspect with shell tools. Uploads only happen when ACP already has an existing cwd.

### Files tab and Flow tab

Each conversation has a **Files** tab that browses the recorded working directory. Click into folders, preview text (line-numbered), HTML (sandboxed Source / Preview + open-in-new-tab), images, video / audio. The backend serves binary files via a `Range`-aware `/files/raw` endpoint so seeking works.

The **Flow** tab (React / xyflow, `src/views/system/flow.tsx`) graphs this conversation's agent and its tool-call satellites. It is a chat tab, not a separate global page.

### Slash commands

Typing `/` at the start of the composer opens a palette of grok's currently-available commands (`/compact`, `/always-approve`, `/context`, `/session-info`, plus anything grok adds via `available_commands_update`). Arrow keys + Enter to commit; Esc to dismiss.

### Disconnect / reconnect / TUI hold

Each conversation has a connect / disconnect control. Disconnect kills the `grok agent` process but keeps the overlay pointer and the official session. Sending another message (or clicking connect) respawns ACP and `session/load`s the saved `sessionId`.

`wantedConnected` is an explicit boolean. Missing hydrates as **false** (no auto-resume). Rows you have connected or prompted stay `true` and come back after a server restart — unless the official TUI pager holds the session.

If the TUI has the chat open, the row is `observed` / “watching TUI”. Prompt, connect, and model switch return **409** `{ heldBy: "tui" }`. Leave the terminal pager (or send from there) before taking the write lock.

You can also resume on the CLI. The Info tab shows:

```
grok -p "<follow-up>" -r <sessionId>       # one-shot, headless
cd <cwd> && grok --resume <sessionId>      # interactive TUI
```

### Star, archive, delete

Per sidebar item:
- `☆ / ★` toggle: starred conversations sort to the top
- `×` archives (soft). ACP stops, `wantedConnected` goes false, the row moves under `archived (N)`. Reconcile still claims that `lastSessionId`, so the same TUI session is not cloned back into the live list.
- In the archived view, `restore` brings the overlay back (does not auto-connect). `delete` is the only path to remove the overlay: folders unlink, `meta.json` goes away. **Official Grok session files are kept** unless you confirm the second prompt (`DELETE /api/agents/:id?deleteTuiSession=1`). That opt-in is refused with **409** `{ heldBy: "tui" }` while the pager holds the session.

Retention (Settings, default 30 days) only prunes overlay pointers after grok has already dropped the session directory. Lived-in TUI sessions, starred rows, and archived rows are never auto-removed. `0` disables cleanup.

### Themes

Topbar quick-toggle cycles `dark → light → hacker → unicorn → dark`. Settings has a full picker. The choice is persisted in localStorage and applied pre-DOM so there's no flash on reload.

### Copy entire conversation

The chat tabs row has a `copy conversation` button. Serializes all turns (user prompts, thought summaries, tool calls + their output, assistant messages) to clean plain text and puts it on the clipboard.

### Debug controls (optional)

Settings → `debug controls` toggle. When on, a `{ payload }` button appears in the composer. Clicking it opens an inspector showing the composer draft, the last sent request body, and the server response. Base64 image data is truncated in the visible `<pre>`; the per-section `copy` button copies the full payload.

### Mobile + PWA

Open the URL on your phone over your tailnet. The sidebar collapses to a slide-in drawer (hamburger top-left). On supported browsers an install banner offers to add it to your home screen; on iOS Safari it shows the manual "Share → Add to Home Screen" hint. Once installed it runs as a standalone app with the status bar tinted to match the theme.

---

## The `gr` command

After `./install.sh` the installer symlinks `gr` into `/usr/local/bin` (or `~/.local/bin` with a PATH hint as fallback). Run it from any directory.

| Command       | What it does                                                          |
|---------------|-----------------------------------------------------------------------|
| `gr`          | Ensure the server is healthy, show the URL, and offer to open it.      |
| `gr status`   | PM2 status, uptime, restarts, memory, cpu, tailnet URL.               |
| `gr open`     | Start the server if needed, then open the dashboard.                  |
| `gr url`      | Print only the URL on stdout (pipe-friendly).                         |
| `gr start`    | `pm2 start ecosystem.config.cjs` from the install dir. Pass `--local` to bind localhost. |
| `gr stop`     | `pm2 stop grok-remote`.                                               |
| `gr restart`  | `pm2 restart grok-remote`.                                            |
| `gr logs`     | `pm2 logs grok-remote --lines 100`.                                   |
| `gr install`  | Re-run the installer (idempotent). Pass `--local` to keep local-only mode. |
| `gr version`  | Print the grok-remote version.                                        |
| `gr help`     | Show the subcommand table.                                            |

Set `GR_HOME` to override how `gr` locates the project; otherwise it follows the symlink back to the install directory.

---

## How it works

```
+----------------------+   tailnet   +-----------------------+
|   Browser / iPhone   |  <-------> |  grok-remote server   |
|   dashboard (PWA)    |    REST    |   :7910                |
+----------------------+    SSE     |                        |
                                    |  overlay meta.json     |
                                    |  ACP when we hold lock |
                                    |  tail when TUI holds   |
                                    +-----------+------------+
                                                |
                    +---------------------------+---------------------------+
                    |                                                       |
                    v                                                       v
         ~/.grok-remote/agents/<uuid>/                         ~/.grok/
              meta.json only                         sessions/<enc-cwd>/<sessionId>/
                                                     updates.jsonl, summary.json, …
                                                     active_sessions.json  (write lock)
                    |                                                       ^
                    |   grok agent --no-leader stdio                        |
                    +-------------------------------------------------------+
```

### Disk layout

Conversation truth is the official Grok session directory:

```
~/.grok/
├── active_sessions.json                # who holds the write lock (TUI pid vs grok agent)
└── sessions/
    └── <encodeURIComponent(cwd)>/
        └── <sessionId>/
            ├── summary.json            # title, cwd, timestamps, session_kind
            ├── signals.json            # turns, model, usage
            ├── updates.jsonl           # durable turn log (GET history + live tail)
            └── …
```

grok-remote overlay is a pointer, not a copy of the chat:

```
~/.grok-remote/
├── settings.json                       # defaultModel, defaultCwd, autoApprove, retentionDays, …
├── folders.json                        # folder members = overlay UUIDs
└── agents/
    └── <overlay-uuid>/
        └── meta.json                   # name, star, archive, lastSessionId, recorded cwd, wantedConnected, settings
        └── history.jsonl               # leftover / handshake fallback only — not the durable record
```

There is **no** `agents/<id>/cwd/` sandbox. Recorded `cwd` in `meta.json` is the real workspace path and may not exist until you connect. Leftover overlay `history.jsonl` from the isolated-agent era is not deleted automatically; the server stops appending once `findTuiSessionDir` hits.

### REST API surface

`:id` on `/api/agents/:id*` is an overlay UUID **or** a grok `sessionId`. The server rebinds to the overlay UUID before any `manager.*` call. JSON `id` is always the overlay UUID. GET does not restore an archived row.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/agents` | overlay list (sidebar). Lived-in TUI sessions are reconciled in. |
| POST | `/api/agents` | new chat or import. Body `{ name?, model?, cwd?, resumeSessionId?, connect? }`. `connect` defaults false on resume. No `resumeSessionId` starts ACP (`cwd required` if no usable dir). |
| GET | `/api/agents/:id` | `PublicAgent` (handshake meta, `sessionId`, `heldBy`). Never the internal record. |
| PATCH | `/api/agents/:id` | `{ name, starred, archived, settings? }` |
| DELETE | `/api/agents/:id` | delete overlay + unlink folders. Official TUI files stay. `?deleteTuiSession=1` opts in to `rm` the session dir (409 if `heldBy: "tui"`). |
| POST | `/api/agents/:id/prompt` | `{ text, attachments? }`. 202. **409** `{ heldBy: "tui" }` when the pager holds the session. |
| POST | `/api/agents/:id/cancel` | cancel an in-flight turn |
| POST | `/api/agents/:id/connect` | spawn `grok agent --no-leader` and `session/load`. **409** `{ heldBy: "tui" }`. |
| POST | `/api/agents/:id/disconnect` | kill ACP; overlay + official session survive (`wantedConnected: false`) |
| POST | `/api/agents/:id/model` | switch model. **409** `{ heldBy: "tui" }`. |
| GET | `/api/agents/:id/history` | NDJSON. `?turns=N` (default 50) or `?all=1`. Headers: `X-Total-Turns`, `X-Returned-Turns`, **`X-History-Source`** (`tui` \| `agent` \| `empty`) |
| GET | `/api/agents/:id/stream` | SSE of live events (ACP or TUI tail) |
| GET | `/api/agents/:id/files` | list / read under recorded cwd. `?path=<rel>` |
| GET | `/api/agents/:id/files/raw` | `Range`-aware binary stream |
| GET | `/api/agents/:id/trace` | session files / subagent index |
| GET | `/api/system/sessions` | official sessions from `~/.grok/sessions` (not `grok sessions list`, not `/api/tui/sessions`). Query: `q`, `limit`, `includeEmpty=1`. |
| GET | `/api/system/models` | installed models (`grok models`). There is **no** `GET /api/models`. |
| GET, PATCH | `/api/settings` | `defaultModel`, `defaultCwd`, `autoApprove`, `retentionDays`, `debug`, … |
| GET | `/api/hello` | tailscale identity + version |
| GET | `/api/health` | liveness |

See [PROTOCOL.md](./PROTOCOL.md) for ACP frames, ownership 409, POST `connect` / `resumeSessionId`, and the history source header.

---

## Manage

PM2 is the system supervisor. The installer wired it for you; useful direct commands:

```sh
pm2 logs grok-remote       # follow logs
pm2 status                 # all PM2 processes
pm2 restart grok-remote    # restart
pm2 stop grok-remote       # stop
pm2 delete grok-remote     # remove from PM2
```

To survive reboot:

```sh
pm2 save
pm2 startup           # follow the instructions it prints
```

The server itself handles SIGTERM / SIGINT gracefully: it disconnects every live ACP client (saves `lastSessionId`) before exiting. Official TUI files are not touched.

---

## Develop

```sh
npm install
npm start             # backend on :7910 (serves dist/ + /api/*)
npm run dev           # Vite dev server on :7911, proxies /api → 7910
npm run typecheck     # tsc --noEmit
npm test              # unit tests (node:test + tsx)
npm run test:integration  # boots server.ts and hits /api/*; needs grok logged in
```

- Frontend lives under `src/`. Vanilla TypeScript + Vite. Views: `src/views/{agents,chat,settings,files,trace}.ts` plus `src/views/system/*` (Sessions, Models, …). Helpers: `src/lib/{api,sse,render,themes,copy,slash-palette,attach-images,pwa}.ts`. The conversation **Flow** tab (`src/views/system/flow.tsx`) is the only React surface.
- Backend is plain Node http. Overlay + ACP: `lib/{acp-client,agent-manager,terminal-host,fs-host,permission-host,sse,history,settings}.ts`. TUI-first: `lib/{tui-bridge,tui-reconcile,session-ownership,conversation-history,updates-tail,session-list,delete-agent}.ts`.
- Build is Vite (esbuild type-strip); type-checking is a separate `npm run typecheck` step.

### Tests

Unit tests live under `test/*.test.ts` and run with `node --import tsx --test`. They cover helpers plus TUI-first contracts (history source, overlay cwd, ownership 409, session join, delete / retention, `wantedConnected`).

Integration tests live under `test/integration/*.test.ts` and are gated on `RUN_LOCAL_INTEGRATION=1`. They boot `server.ts` via `tsx` on a random high port and hit public endpoints. `/api/system/health` shells out to `grok inspect`, so they need a logged-in `grok` CLI. Skipped without the env var.

`experiments/probe.js` is a small standalone ACP client that talks to `grok agent stdio` and dumps every JSON-RPC frame. Run it to regenerate the traces summarized in [PROTOCOL.md](./PROTOCOL.md):

```sh
node experiments/probe.js "Reply with the word ack." exp1.log
node experiments/probe.js "Run \`ls\` and tell me what you see." exp2.log
```

---

## Layout

```
grok-remote/
├── install.sh                  # bash bootstrap (verifies Node, hands off)
├── installer.ts                # animated 13-step installer
├── bin/gr                      # the gr CLI
├── server.ts                   # Node http server + REST/SSE
├── ecosystem.config.cjs        # PM2 config
├── vite.config.ts
├── tsconfig.json
├── tsconfig.server.json
├── index.html
├── lib/                        # backend (ACP host + TUI bridge + overlay)
│   ├── acp-client.ts
│   ├── agent-manager.ts
│   ├── tui-bridge.ts           # ~/.grok/sessions
│   ├── tui-reconcile.ts
│   ├── session-ownership.ts    # active_sessions.json → heldBy
│   ├── conversation-history.ts # TUI-first GET history
│   ├── updates-tail.ts
│   ├── session-list.ts         # GET /api/system/sessions join
│   ├── delete-agent.ts         # overlay delete + optional TUI rm
│   ├── history.ts              # overlay fallback jsonl
│   ├── retention.ts
│   └── routes/                 # /api/system/* (models, mcp, …)
├── src/
│   ├── main.ts
│   ├── style.css
│   ├── views/
│   │   ├── agents.ts           # sidebar
│   │   ├── chat.ts             # includes Flow tab
│   │   ├── files.ts
│   │   ├── settings.ts
│   │   └── system/             # Sessions, Models, flow.tsx, …
│   └── lib/
├── test/
├── public/                     # PWA assets
├── experiments/                # ACP probe
├── docs/                       # grok CLI help captures (not the HTTP surface)
├── PROTOCOL.md                 # ACP + HTTP wire contract
└── package.json
```

`docs/` is captured `grok` CLI help. It is not this server's protocol.

---

## What's next

- Optional bearer-token auth on top of Tailscale's perimeter.
- Server-side OCR fallback so non-vision models can still see text inside attached images.

---

## Star history

[![Star History Chart](https://api.star-history.com/svg?repos=daniel-farina/grok-remote&type=Date)](https://star-history.com/#daniel-farina/grok-remote&Date)

---

## License

MIT. See [LICENSE](./LICENSE).
