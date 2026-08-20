# grok-remote internal protocol notes

What the backend has to speak, and what the frontend has to render.

grok-remote is a **remote UI over official Grok TUI sessions**. Conversation truth is `~/.grok/sessions/<urlencoded-cwd>/<sessionId>/{updates.jsonl,summary.json}`. The overlay (`~/.grok-remote/agents/<uuid>/meta.json`) is star / archive / rename / folders / settings / `wantedConnected` only. There is no isolated sandbox `cwd/`. Overlay `history.jsonl` is not the durable record.

ACP (`grok agent --no-leader stdio`) is the **write path** when remote holds the lock. The frames below were captured by probing that transport against grok 0.1.212. Run `experiments/probe.js "<your prompt>" <out.log>` to regenerate traces against your local `grok` install. Original captures are not checked in (they include hostnames and home paths).

When the official TUI pager holds the session, grok-remote does **not** start ACP. It tails `updates.jsonl` and refuses writes with HTTP **409** `{ heldBy: "tui" }`.

---

## Disk layout (TUI-first)

```
~/.grok/
├── active_sessions.json          # write lock: [{ session_id, pid, cwd, opened_at }]
└── sessions/<encodeURIComponent(cwd)>/<sessionId>/
    ├── summary.json              # title, info.cwd, timestamps, session_kind
    ├── signals.json
    └── updates.jsonl             # durable conversation + live tail

~/.grok-remote/
├── settings.json
├── folders.json                  # agentIds = overlay UUIDs
└── agents/<overlay-uuid>/
    └── meta.json                 # the only required overlay file
    └── history.jsonl             # handshake fallback only; stop appending once a TUI dir exists
```

- **Never** create `~/.grok-remote/agents/<id>/cwd/`. Recorded `cwd` in `meta.json` is the real workspace and may not exist yet.
- `session_kind` is `"subagent"` only when `summary.json` says so. Missing field = main session.
- `wantedConnected` missing hydrates as `false`. Explicit `true` still auto-resumes ACP after restart (unless archived or `heldBy: "tui"`).

---

## Ownership / write lock

`holderForSession(sessionId)` reads `~/.grok/active_sessions.json`, checks the pid is alive, and classifies cmdline:

| holder | Meaning | HTTP writes (prompt / connect / model) |
| ------ | ------- | -------------------------------------- |
| `tui` | official `grok` pager (not `grok agent`) | **409** `{ ok: false, error, heldBy: "tui" }` |
| `remote` | this process (or another) `grok agent` | allowed for our ACP child |
| `null` | free | connect / prompt may start ACP |

`SessionHeldError` is always `heldBy: "tui"`. Payload:

```json
{ "ok": false, "error": "TUI is using this session (01a00639…).", "heldBy": "tui" }
```

While held by TUI, `PublicAgent.status` is `observed`. `beginView` starts `UpdatesFileTail` (~800ms) on that session's `updates.jsonl` and forwards live events over SSE. Those events are **not** appended to overlay `history.jsonl`.

---

## Transport

`grok agent --no-leader [--always-approve] stdio` — JSON-RPC 2.0 over stdin/stdout, newline-delimited, UTF-8. One JSON object per line.

`--always-approve` so the agent does not block on permission prompts (we still implement the callbacks).

`--no-leader` keeps each ACP process independent so we can manage many in parallel without fighting the TUI leader.

Working directory is the **recorded session cwd** (or Settings `defaultCwd`), an existing real path. Never `~/.grok-remote/agents/<id>/cwd/`.

## Handshake

Client → Agent:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{
  "protocolVersion":1,
  "clientCapabilities":{
    "fs":{"readTextFile":true,"writeTextFile":true},
    "terminal":true
  }
}}
```

Agent → Client (response):

```json
{"jsonrpc":"2.0","id":1,"result":{
  "protocolVersion":1,
  "agentCapabilities":{
    "loadSession":true,
    "promptCapabilities":{"image":false,"audio":false,"embeddedContext":true},
    "mcpCapabilities":{"http":true,"sse":true},
    "_meta":{"x.ai/fs_notify":true}
  },
  "authMethods":[...],
  "_meta":{
    "grokShell":true,
    "currentWorkingDirectory":"...",
    "agentVersion":"0.1.212",
    "agentId":"<uuid>",
    "agentInstanceId":"<uuid>",
    "hostname":"...",
    "modelState":{"currentModelId":"grok-build","availableModels":[...]},
    "availableCommands":[
      {"name":"compact","description":"...","input":{"hint":"..."}},
      {"name":"always-approve","description":"...","input":{"hint":"on|off"}},
      {"name":"context","description":"...","input":null},
      {"name":"session-info","description":"...","input":null}
    ]
  }
}}
```

The `_meta` block is gold for the dashboard: agent ID, model, working dir, hostname, available slash commands.

## Session lifecycle

```
initialize        →  agent ready
session/new       →  { sessionId }     # new chat; grok creates ~/.grok/sessions/…
session/prompt    →  starts a turn; agent streams session/update; resolves with stopReason + token usage
session/load      →  resume an existing official session (agentCapabilities.loadSession=true)
session/cancel    →  cancel an in-flight prompt
```

### session/new params

```json
{"cwd":"<absolute path>","mcpServers":[]}
```

`cwd` is the real project directory, not an overlay sandbox.

### session/prompt params

```json
{"sessionId":"<id>","prompt":[{"type":"text","text":"..."}]}
```

Prompts are an array of content blocks. `type:"text"` is the basic one. The handshake's `promptCapabilities` reveals whether `image`/`audio`/`embeddedContext` are accepted.

### session/prompt response

```json
{"stopReason":"end_turn","_meta":{
  "sessionId":"...","requestId":"...","promptId":"...",
  "totalTokens":17382,"modelId":"grok-build",
  "inputTokens":17324,"outputTokens":58,
  "cachedReadTokens":128,"reasoningTokens":57
}}
```

Other stopReasons we should expect: `max_tokens`, `cancelled`, `error`, `tool_use` (TBD — verify when seen).

## Streaming events (Agent → Client notifications)

All sent as `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"...","update":{...},"_meta":{...}}}`.

Discriminator: `params.update.sessionUpdate`.

The same shapes are reconstructed from `updates.jsonl` rows when the TUI holds the lock (`liveEventFromUpdateRow`).

| sessionUpdate                  | Payload                                                                 | UI rendering                                              |
| ------------------------------ | ----------------------------------------------------------------------- | --------------------------------------------------------- |
| `agent_message_chunk`          | `content: {type:"text", text:"..."}`                                    | Append to assistant message buffer.                       |
| `agent_thought_chunk`          | `content: {type:"text", text:"..."}`                                    | Render in a collapsible "thinking" pane.                  |
| `tool_call`                    | `toolCallId, title, rawInput{...}` + `_meta.updateParams{kind,status}`  | Start a tool-call card. Status: `Pending`.                |
| `tool_call_update`             | `toolCallId, kind, title, content[], locations[], rawInput, _meta.updateParams.status` | Patch the existing card (title, status, output).         |
| `tool_call_delta_chunk`        | Incremental chunks (TBD shape; treat as append-to-most-recent-tool)     | Stream output into the current tool card.                 |
| `available_commands_update`    | Updated `availableCommands` list                                        | Refresh the slash-command palette.                        |
| `session_summary_generated`    | Compaction summary text                                                 | Show a "context compacted" pill; may auto-name the row.   |
| `task_backgrounded` / `task_completed` | Background task markers                                          | Bg-task panel (also hydrated from `updates.jsonl`).       |

`_meta` on every update carries: `totalTokens, eventId, agentTimestampMs, promptId, streamStartMs, turnStartMs, updateType, updateParams`. Use these for ordering, timing, and live token-usage display.

### Tool call lifecycle (observed)

1. `tool_call` (status `Pending`) — agent decided to call a tool. `rawInput` has the args (e.g. `{command, timeout, description}` for shell).
2. Agent sends `terminal/create` (or `fs/...`) as a JSON-RPC **request** back to us (the client). We MUST execute it and reply, or the tool fails.
3. `tool_call_update` — status transitions to `Running`, then `Completed` or `Failed`. `content[]` may carry text output, locations, etc.
4. Multiple `tool_call_delta_chunk` may stream between 2 and 3 for live output (e.g. long-running terminals).

## Agent → Client requests (we MUST handle)

The agent calls back into the client to do real work. Observed in exp2 — when we returned `{}` for `terminal/create`, all tool calls failed.

| method                  | Purpose                                                            | Minimal response                              |
| ----------------------- | ------------------------------------------------------------------ | --------------------------------------------- |
| `terminal/create`       | Spawn a shell command; capture output; return a terminal ID        | `{terminalId:"..."}` + actually run the cmd   |
| `terminal/output`       | Read accumulated output                                            | `{output:"...", truncated:false}`             |
| `terminal/wait_for_exit`| Block until exit                                                   | `{exitStatus:{exitCode:N, signal:null}}`      |
| `terminal/kill`         | SIGKILL                                                            | `{}`                                          |
| `terminal/release`      | Cleanup                                                            | `{}`                                          |
| `fs/read_text_file`     | Read a file                                                        | `{content:"..."}`                             |
| `fs/write_text_file`    | Write a file                                                       | `{}`                                          |
| `session/request_permission` | Ask user to approve a tool call (skipped under `--always-approve`) | `{outcome:{outcome:"selected",optionId:"allow_always"}}` |

Notes:
- The `terminal/create` request includes a full `env` array, `cwd`, `outputByteLimit`. Respect those when we spawn.
- We run commands in the **session's recorded working directory**, not the grok-remote process cwd and not an overlay sandbox. Handshake `_meta.currentWorkingDirectory` and `session/new` cwd should match that path.
- Isolated per-agent `~/.grok-remote/agents/<id>/cwd/` is gone. Uploads land at `<recorded cwd>/uploads/` only when that directory already exists.

## x.ai/* notifications (Agent → Client, no response required)

| method                         | Purpose                                          | UI |
| ------------------------------ | ------------------------------------------------ | -- |
| `_x.ai/session_notification`   | Auto-compact, retry state, diff review            | Toast / pill in the conversation. |
| `_x.ai/git_head_changed`       | HEAD moved (relevant if agent has a git worktree) | Update a small VCS indicator.     |
| `_x.ai/models/update`          | Model list / current model changed                | Refresh model picker.             |
| `_x.ai/session/prompt_complete`| Turn fully complete (after the response message). | Mark turn as final.               |

There are 72 `x.ai/*` extension methods total per the docs (fs, git, search, terminal, code, session, auth, telemetry). We start by handling only what the agent calls during normal operation and add others as we see them.

---

# Backend HTTP API (`server.ts`)

Everything is JSON unless noted. All URLs are relative to the server root.

Public agent JSON is always `PublicAgent` from `manager.get(id)`. Routes look up `:id` with `getByIdOrSession` (overlay UUID **or** grok `sessionId`), then **rebind** `id = rec.id`. Never send the internal `AgentRecord` (`client` / `ring`). JSON `id` is always the overlay UUID. GET does not restore an archived overlay.

There is **no** `GET /api/models` and **no** `GET /api/tui/sessions`.

## Agents

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET    | `/api/agents` | List overlay pointers (`PublicAgent`: id, name, model, status, cwd, `lastSessionId`, `heldBy`, `wantedConnected`, …) |
| POST   | `/api/agents` | New chat or import. See body below. |
| GET    | `/api/agents/:id` | `PublicAgent`. 404 if no overlay matches. Does not unarchive. |
| PATCH  | `/api/agents/:id` | `{ name?, starred?, archived?, settings? }` |
| DELETE | `/api/agents/:id` | Overlay only + folder unlink. See delete below. |
| POST   | `/api/agents/:id/prompt` | `session/prompt`. Body `{ text, attachments? }`. 202. **409** `{ heldBy: "tui" }` |
| POST   | `/api/agents/:id/cancel` | Cancel the in-flight prompt |
| POST   | `/api/agents/:id/connect` | Start ACP + `session/load`. **409** `{ heldBy: "tui" }` |
| POST   | `/api/agents/:id/disconnect` | Kill ACP; `wantedConnected: false`; official session stays |
| POST   | `/api/agents/:id/model` | Switch model. **409** `{ heldBy: "tui" }` |
| GET    | `/api/agents/:id/history` | Conversation NDJSON. See history below. |

### `POST /api/agents`

```json
{
  "name": "optional",
  "model": "optional",
  "cwd": "/abs/path",
  "resumeSessionId": "optional-grok-session-id",
  "connect": false
}
```

| Input | Behavior |
| ----- | -------- |
| No `resumeSessionId` | `spawn()`: `wantedConnected: true`, start ACP immediately. cwd must exist (body or Settings `defaultCwd`) or **400** `{ error: "cwd required" }`. Never mkdir an overlay sandbox. |
| `resumeSessionId` hits an overlay (including archived) | Return that row (`pickOverlayForSession`). Archived → **restore-on-open** (`archived: false`, leave the Archived folder). Start ACP only if `connect === true`. |
| `resumeSessionId` miss + `connect === true` | `spawn({ resumeSessionId })` (ACP; cwd must exist). |
| `resumeSessionId` miss + `connect !== true` (default) | Import overlay only (`wantedConnected: false`). **No** ACP. Missing cwd is **not** 400. |

Sessions "open" / "import" always POST `{ resumeSessionId, connect: false }`, then navigate to `#/agents/<returned overlay id>`. GET / hash-only does not restore.

### `DELETE /api/agents/:id`

Default: remove the overlay directory and unlink `folders.json`. **Do not** delete `~/.grok/sessions/…`.

`?deleteTuiSession=1` (exact query value `1`) also removes the official session dir:

1. Resolved path must sit under `sessionsRoot() + sep`.
2. `heldBy === "tui"` → **409** `{ heldBy: "tui" }`. No kill, no `rm` (pager may hold `updates.jsonl.lock`).
3. This-process ACP / `heldBy === "remote"` → kill overlay first, re-check holder. Still held → 409, overlay already gone, **TUI dir kept**. Free → `rm` TUI dir.
4. `heldBy === null` → kill overlay, then `rm` TUI dir.

### History

`GET /api/agents/:id/history?turns=50` (or `?all=1`).

`Content-Type: application/x-ndjson`.

| Header | Meaning |
| ------ | ------- |
| `X-Total-Turns` | User-message turns in the full log |
| `X-Returned-Turns` | Turns in this slice |
| `X-History-Source` | `tui` — `updates.jsonl`; `agent` — leftover overlay `history.jsonl`; `empty` — nothing yet |

Resolve order: `findTuiSessionDir(sessionId, cwd)` → `tuiUpdatesToHistory()`. Only if that directory is missing, fall back to overlay jsonl. Once a TUI dir exists, `historyAppend` is a no-op (including `user_message` and SSE).

## Streaming

| Path | Transport | Payload |
| ---- | --------- | ------- |
| `/api/agents/:id/stream` | SSE | Every `session/update` + lifecycle events. `:id` rebound to overlay UUID. |
| `/api/agents/stream` | SSE | Sidebar list changes |

SSE event names mirror the upstream discriminator: `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `tool_call_delta_chunk`, `available_commands_update`, `session_summary_generated`, plus `agent_status`, `prompt_complete`, and `error`.

Each SSE event's `data` is JSON: the unwrapped `update` object plus a `_t` timestamp.

Reconnect: client sends `Last-Event-ID`. Server buffers the last N events per overlay and replays. Closing the browser only drops the subscriber; it does not cancel the turn or kill ACP.

When `heldBy === "tui"`, the same stream is fed by `UpdatesFileTail` instead of ACP notifications.

## Sessions (official TUI files)

| Method | Path | Notes |
| ------ | ---- | ----- |
| GET | `/api/system/sessions` | Reads `~/.grok/sessions` on disk. **Does not** run `grok sessions list`. **`/api/tui/sessions` is gone.** |

Handled in `createServer` **before** `handleSystem`, using raw `req.url` so `q` / `limit` / `includeEmpty` survive.

Query:

- `q` — filter sessionId / title / summary / cwd
- `limit` — default 20, max 200
- `includeEmpty=1` — leftover / hidden (not lived-in) sessions

```json
{
  "ok": true,
  "raw": "",
  "items": [{
    "sessionId": "01a00639-78fa-7461-ad75-222e0ae00afd",
    "overlayId": "167292bf-4e7e-45a9-94aa-f712c87fb417",
    "title": "…",
    "summary": "…",
    "cwd": "/root",
    "created": "2026-08-15",
    "updated": "2026-08-15",
    "status": "local",
    "heldBy": null,
    "starred": false,
    "archived": false,
    "livedIn": true,
    "sessionKind": "main",
    "source": "tui"
  }]
}
```

`sessionKind` is `"main"` or `"subagent"`. `source` is always `"tui"`.

## Models

| Method | Path | Notes |
| ------ | ---- | ----- |
| GET | `/api/system/models` | **The** model list (`grok models` → `{ ok, raw, items:[{id,name}] }`). |

There is no `GET /api/models`. Per-conversation switch is `POST /api/agents/:id/model`.

## Skills (slash palette)

| Method | Path | Notes |
| ------ | ---- | ----- |
| GET | `/api/system/skills` | Read-only list from the TUI host. `?cwd=` is the conversation working directory (cwd + repo `.grok/skills`). Always includes `~/.grok/skills`. |

The `/` palette merges this list with ACP `available_commands_update`. There is no skills management API in the mobile remote.

## Settings

| Method | Path | Body |
| ------ | ---- | ---- |
| GET | `/api/settings` | Merged settings |
| PATCH | `/api/settings` | `{ defaultModel, defaultCwd, autoApprove, retentionDays, debug, … }` |

Persist to `~/.grok-remote/settings.json`.

`defaultCwd` is a hard requirement only when ACP is about to start (new chat, `connect: true`). Import-only POST does not 400 on a missing directory.

`retentionDays` (default 30, `0` disables) prunes **overlay pointers** after grok has already dropped the TUI directory. Starred, archived, and lived-in TUI sessions are never auto-removed.

## Other

| Method | Path | Notes |
| ------ | ---- | ----- |
| GET | `/api/hello` | Health-y endpoint + tailscale identity |
| GET | `/api/health` | Liveness |
| GET | `/api/agents/:id/files/raw` | `Range` stream |

---

# Frontend rendering rules (`src/`)

Per conversation, render a stream as a sequence of turns. Each turn has a chronological list of blocks:

1. **User message** — the prompt text.
2. **Thought** (collapsed by default) — concatenated `agent_thought_chunk.content.text`.
3. **Tool call** card — created on `tool_call`, patched by `tool_call_update` / `tool_call_delta_chunk`. Show: title, status pill (Pending/Running/Completed/Failed), expandable rawInput, expandable output stream.
4. **Assistant message** — concatenated `agent_message_chunk.content.text`.
5. **Footer chip** — token usage from the `prompt_complete` event (input/output/cached/reasoning + cost estimate).

History reload: `GET /api/agents/:id/history` (prefer `X-History-Source: tui`). Default last 50 turns; `?all=1` expands. Show "load all earlier turns" when `X-Total-Turns > X-Returned-Turns`.

When `heldBy === "tui"`: composer is read-only, connect/prompt/model are blocked, toast the 409 error. Status is `observed` / “watching TUI”.

Sidebar is the main list (`GET /api/agents` + `/api/agents/stream`). Rows are overlay UUIDs. Import sheet is search/debug (`GET /api/system/sessions`), not a second primary list.

Sidebar shows:
- name (editable)
- status dot (idle / running / errored / disconnected / observed)
- last activity
- star / archive / delete-forever (overlay; optional TUI delete)
- folders (drag/drop; system Archived folder)

There is no Settings page, Files tab, Flow tab, or Trace tab in the mobile remote. `defaultCwd` is set from the cwd sheet (tap / long-press `+ New`). Theme is Dark / Light in the sidebar. Model switch is the composer Model sheet (`GET /api/system/models` + `POST /api/agents/:id/model`).

---

# Open questions to revisit

- Exact shape of `tool_call_delta_chunk` — treat as append-to-most-recent-tool until a fresh probe is captured.
- MCP server config in `session/new` — leave empty for the ACP host; configure MCP via Settings / `~/.grok` as grok itself does.
