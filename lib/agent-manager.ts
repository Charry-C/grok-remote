// Registry of live AcpClient instances + per-agent SSE ring buffers and history.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

import { AcpClient, type AcpClientSettings } from './acp-client.js';
import { sessionModelSwitchBlockReason, trimText } from './session-model.js';
import { load as loadSettings } from './settings.js';
import {
  ensureAgentDirs,
  agentDir,
  append as historyAppend,
  recordedCwd,
  resolveStartCwd,
  removeEmptyOverlayCwds,
} from './history.js';
import { createRing, type SseRing, type SseRingEntry } from './sse.js';
import { findTuiSessionDir, listTuiSessions } from './tui-bridge.js';
import { pickOverlayForSession, planOverlayDedupe, planTuiReconcile } from './tui-reconcile.js';

export { pickOverlayForSession };
import {
  applyBgTaskUpdate,
  extractSessionUpdate,
  hydrateBgTasksForAgent,
  type BgTask,
} from './bg-tasks.js';
import {
  holderForSession,
  readActiveSessions,
  readCmdline,
  SessionHeldError,
  type ActiveSessionRow,
  type HeldBy,
} from './session-ownership.js';
import { UpdatesFileTail } from './updates-tail.js';
import { assignAgentToFolder } from './folders.js';

export type { BgTask };
export { SessionHeldError };

const SSE_RING_LIMIT = 200;

function agentsRoot(): string {
  const override = process.env['GROK_REMOTE_HOME'];
  return path.join(override || path.join(os.homedir(), '.grok-remote'), 'agents');
}

function nowIso(): string { return new Date().toISOString(); }

export interface AgentMeta {
  id: string;
  name: string;
  autoNamed: boolean;
  modelHint: string | null;
  cwd: string;
  createdAt: string;
  lastSeen: string;
  lastSessionId: string | null;
  lastError: string | null;
  starred: boolean;
  archived: boolean;
  archivedAt: string | null;
  settings: AcpClientSettings | null;
  // true → keep the grok process up (or bring it back).
  // missing or false → stay disconnected. Do not treat absent as true.
  wantedConnected?: boolean;
}

/** Browser views are disposable. The grok process stays up only when
 *  wantedConnected is explicitly true and the row is not archived.
 *  A missing flag means disconnected. */
export function shouldKeepConnected(a: {
  archived?: boolean | null;
  wantedConnected?: boolean | null;
}): boolean {
  if (a && a.archived) return false;
  return a?.wantedConnected === true;
}

interface AgentRingEntry extends SseRingEntry {
  id: string;
  event: string;
  data: Record<string, unknown>;
}

export interface AgentRecord extends AgentMeta {
  client: AcpClient | null;
  ring: SseRing<AgentRingEntry>;
  status: string;
  eventCounter: number;
  bgTasks?: Map<string, BgTask>;
  totalTokens?: number;
  inFlight?: number;
  _inFlightIds?: Set<string>;
  _lastTokenEmit?: number;
  _reconnectTimer?: ReturnType<typeof setTimeout> | null;
  _reconnectAttempts?: number;
  /** Cached findTuiSessionDir after sessionId is known. Avoids a stat per SSE. */
  _tuiDir?: string | null;
}

export interface AgentSpawnOptions {
  name?: string;
  model?: string;
  cwd?: string;
  settings?: AcpClientSettings | null;
  resumeSessionId?: string;
}

export interface AgentCreateOptions extends AgentSpawnOptions {
  connect?: boolean;
}

export interface AgentPatch {
  name?: string;
  starred?: boolean;
  archived?: boolean;
  settings?: AcpClientSettings | null;
}

export interface PublicAgent {
  id: string;
  name: string;
  model: string | null;
  reasoningEffort: string | null;
  status: string;
  connected: boolean;
  cwd: string;
  createdAt: string;
  lastSeen: string;
  lastSessionId: string | null;
  handshakeMeta: unknown;
  agentCapabilities: unknown;
  sessionId: string | null;
  availableCommands: unknown[];
  lastError: string | null;
  exitInfo: unknown;
  starred: boolean;
  archived: boolean;
  archivedAt: string | null;
  settings: AcpClientSettings | null;
  totalTokens: number;
  inFlight: number;
  wantedConnected: boolean;
  source: 'tui' | 'remote';
  heldBy: HeldBy;
}

export interface PromptAttachment {
  name?: string;
  mimeType?: string;
  dataBase64?: string;
}

export interface PromptInput {
  text?: string;
  attachments?: PromptAttachment[];
}

export interface SavedFile {
  rel: string;
  abs: string;
  mimeType: string | null;
  size: number;
}

export function countRunningBg(record: AgentRecord | null | undefined): number {
  if (!record || !record.bgTasks) return 0;
  let n = 0;
  for (const v of record.bgTasks.values()) if (!v.completed) n++;
  return n;
}

/** True once findTuiSessionDir hits. Handshake (no sessionId yet) stays false. */
function tuiPresentFor(record: AgentRecord): boolean {
  if (record._tuiDir) return true;
  if (record._tuiDir === null) return false;
  const sid = record.client?.sessionId || record.lastSessionId;
  if (!sid) return false;
  record._tuiDir = findTuiSessionDir(sid, record.cwd);
  return !!record._tuiDir;
}

function metaPath(id: string): string {
  return path.join(agentDir(id), 'meta.json');
}

function readMetaFromDisk(id: string): Partial<AgentMeta> | null {
  try {
    return JSON.parse(fs.readFileSync(metaPath(id), 'utf8')) as Partial<AgentMeta>;
  } catch { return null; }
}

function writeMeta(record: AgentRecord): void {
  try {
    fs.mkdirSync(agentDir(record.id), { recursive: true });
    const out: AgentMeta = {
      id: record.id,
      name: record.name,
      autoNamed: !!record.autoNamed,
      modelHint: record.modelHint || null,
      cwd: record.cwd,
      createdAt: record.createdAt,
      lastSeen: record.lastSeen,
      lastSessionId: record.lastSessionId || null,
      lastError: record.lastError || null,
      starred: !!record.starred,
      archived: !!record.archived,
      archivedAt: record.archivedAt || null,
      settings: record.settings && typeof record.settings === 'object' ? record.settings : null,
      wantedConnected: record.wantedConnected === true,
    };
    fs.writeFileSync(metaPath(record.id), JSON.stringify(out, null, 2));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[meta] write failed for ${record.id}: ${msg}\n`);
  }
}

function listPersistedAgentIds(): string[] {
  try {
    return fs.readdirSync(agentsRoot()).filter((name) => {
      try {
        return fs.statSync(path.join(agentsRoot(), name)).isDirectory()
            && fs.existsSync(path.join(agentsRoot(), name, 'meta.json'));
      } catch { return false; }
    });
  } catch { return []; }
}

const MIME_EXT: Record<string, string> = {
  'image/png':  '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif':  '.gif',
  'image/svg+xml': '.svg',
};

export function sanitizeFilename(name: string | null | undefined): string {
  return String(name || '')
    .replace(/[\\/]/g, '_')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '_')
    .slice(0, 100);
}

export function uniqueUploadName(dir: string, requestedName: string | undefined, mimeType: string | undefined): string {
  let raw = sanitizeFilename(requestedName);
  if (!raw) {
    const ext = (mimeType && MIME_EXT[mimeType]) || '';
    raw = `image-${Date.now()}${ext}`;
  }
  let candidate = raw;
  const ext = path.extname(raw);
  const stem = ext ? raw.slice(0, -ext.length) : raw;
  let i = 1;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${stem}-${i++}${ext}`;
  }
  return candidate;
}

export function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes)) return '? bytes';
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function attachmentLine(f: SavedFile): string {
  const size = humanSize(f.size);
  return `- ${f.abs} (${f.mimeType || 'application/octet-stream'}, ${size})`;
}

export interface AgentManagerOptions {
  autoStart?: boolean;
  /** Override settings.defaultCwd (tests). undefined → load settings. */
  defaultCwd?: string | null;
}

export class AgentManager extends EventEmitter {
  agents: Map<string, AgentRecord>;
  private _shuttingDown = false;
  private _reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private _viewers = new Map<string, number>();
  private _tails = new Map<string, UpdatesFileTail>();
  private _holderRows: ActiveSessionRow[] | undefined;
  private _readCmd: (pid: number) => string = readCmdline;
  private _defaultCwdOverride: string | null | undefined;

  constructor(opts: AgentManagerOptions = {}) {
    super();
    this.agents = new Map();
    this._defaultCwdOverride = opts.defaultCwd;
    if (opts.autoStart === false) return;
    removeEmptyOverlayCwds();
    this._hydrateFromDisk();
    this.dedupeOverlayTwins();
    setImmediate(() => {
      if (this._shuttingDown) return;
      try { this.reconcileTuiSessions(); } catch { /* first pass best-effort */ }
      this._syncHolders();
      this._resumeWantedAgents();
      this._reconcileTimer = setInterval(() => {
        if (this._shuttingDown) return;
        try { this.reconcileTuiSessions(); } catch { /* next tick */ }
        try { this._syncHolders(); } catch { /* next tick */ }
      }, 4000);
    });
  }

  private _fallbackCwd(): string {
    if (this._defaultCwdOverride !== undefined) {
      return typeof this._defaultCwdOverride === 'string' ? this._defaultCwdOverride.trim() : '';
    }
    try {
      const s = loadSettings();
      return typeof s.defaultCwd === 'string' ? s.defaultCwd.trim() : '';
    } catch {
      return '';
    }
  }

  private _startCwd(recordCwd: string): string {
    return resolveStartCwd(recordCwd, this._fallbackCwd());
  }

  /** Pin active_sessions rows / cmdline for tests or a single list tick. */
  setHolderLookup(opts: { rows?: ActiveSessionRow[]; readCmd?: (pid: number) => string } | null): void {
    if (!opts) {
      this._holderRows = undefined;
      this._readCmd = readCmdline;
      return;
    }
    if (opts.rows !== undefined) this._holderRows = opts.rows;
    if (opts.readCmd) this._readCmd = opts.readCmd;
  }

  syncHolders(): void {
    this._syncHolders();
  }

  pollUpdateTails(): void {
    for (const tail of this._tails.values()) tail.poll();
  }

  /** Kill auto-imported lastSessionId twins. One-shot at startup, after hydrate. */
  dedupeOverlayTwins(): number {
    const actions = planOverlayDedupe([...this.agents.values()].map((a) => ({
      id: a.id,
      lastSessionId: a.lastSessionId || null,
      archived: a.archived,
      autoNamed: a.autoNamed,
      starred: a.starred,
      wantedConnected: a.wantedConnected,
      createdAt: a.createdAt,
    })));
    for (const { lastSessionId, kept, dropped } of actions) {
      process.stderr.write(`[reconcile] deduped lastSessionId=${lastSessionId} kept=${kept} dropped=${dropped}\n`);
      void this.kill(dropped);
    }
    return actions.length;
  }

  private _hydrateFromDisk(): void {
    for (const id of listPersistedAgentIds()) {
      const meta = readMetaFromDisk(id);
      if (!meta || !meta.id) continue;
      const ring = createRing<AgentRingEntry>(SSE_RING_LIMIT);
      const record: AgentRecord = {
        id: meta.id,
        name: meta.name || `agent-${meta.id.slice(0, 8)}`,
        autoNamed: !!meta.autoNamed,
        modelHint: meta.modelHint || null,
        cwd: meta.cwd || '',
        createdAt: meta.createdAt || nowIso(),
        lastSeen: meta.lastSeen || nowIso(),
        lastSessionId: meta.lastSessionId || null,
        lastError: meta.lastError || null,
        starred: !!meta.starred,
        archived: !!meta.archived,
        archivedAt: meta.archivedAt || null,
        settings: meta.settings && typeof meta.settings === 'object' ? meta.settings : null,
        client: null,
        ring,
        status: 'disconnected',
        eventCounter: 0,
        // Read === true first. Hydrating with !== false then writeMeta
        // would persist true for a missing key.
        wantedConnected: meta.wantedConnected === true,
      };
      const missing = !Object.prototype.hasOwnProperty.call(meta, 'wantedConnected');
      if (missing) {
        record.wantedConnected = false;
        writeMeta(record);
      }
      record.bgTasks = hydrateBgTasksForAgent({
        agentId: record.id,
        sessionId: record.lastSessionId,
        cwd: record.cwd,
      });
      this.agents.set(record.id, record);
    }
  }

  private _resumeWantedAgents(): void {
    if (this._shuttingDown) return;
    const queue = [...this.agents.values()].filter((a) => !a.client && shouldKeepConnected(a));
    let i = 0;
    const kick = (): void => {
      if (this._shuttingDown) return;
      if (i >= queue.length) return;
      const rec = queue[i++];
      if (rec && !rec.client && shouldKeepConnected(rec)) {
        if (this._heldBy(rec) === 'tui') {
          rec.status = 'observed';
        } else {
          try { this._connectRecord(rec); } catch { /* next */ }
        }
      }
      if (i < queue.length) setTimeout(kick, 400);
    };
    kick();
  }

  private _clearReconnect(record: AgentRecord): void {
    if (record._reconnectTimer) {
      clearTimeout(record._reconnectTimer);
      record._reconnectTimer = null;
    }
  }

  private _scheduleReconnect(record: AgentRecord): void {
    if (this._shuttingDown || !shouldKeepConnected(record) || record.client) return;
    this._clearReconnect(record);
    const n = (record._reconnectAttempts || 0) + 1;
    record._reconnectAttempts = n;
    const delay = Math.min(15000, 800 * Math.pow(2, n - 1));
    record._reconnectTimer = setTimeout(() => {
      record._reconnectTimer = null;
      if (this._shuttingDown || record.client || !shouldKeepConnected(record)) return;
      try { this._connectRecord(record); } catch { /* retry later via exit */ }
    }, delay);
  }

  list(): PublicAgent[] {
    const remote = this._remotePids();
    const rows = this._readActiveSessions();
    const tuiDirCache = new Map<string, string | null>();
    return [...this.agents.values()].map((a) => this._publicRecord(a, { remote, rows, tuiDirCache }));
  }

  get(id: string): PublicAgent | null {
    const a = this.agents.get(id);
    return a ? this._publicRecord(a) : null;
  }

  getRaw(id: string): AgentRecord | null {
    return this.agents.get(id) || null;
  }

  /** Dual-lookup: overlay UUID or TUI sessionId. Caller must use rec.id for manager.*. */
  getByIdOrSession(idOrSid: string): AgentRecord | null {
    let key = String(idOrSid || '').trim();
    if (!key) return null;
    try { key = decodeURIComponent(key); } catch { /* already decoded or malformed */ }
    key = key.trim();
    if (!key) return null;
    const direct = this.agents.get(key);
    if (direct) return direct;
    const matches: AgentRecord[] = [];
    for (const rec of this.agents.values()) {
      if (rec.lastSessionId === key || rec.client?.sessionId === key) matches.push(rec);
    }
    return pickOverlayForSession(matches);
  }

  /** Pointer-only import. Does not start ACP. Missing cwd is allowed. */
  importOverlay(opts: {
    name?: string;
    cwd?: string;
    resumeSessionId: string;
    settings?: AcpClientSettings | null;
  }): PublicAgent {
    const sid = String(opts.resumeSessionId || '').trim();
    const rec = this._materializeRecord({
      name: opts.name || (sid ? sid.slice(0, 8) : 'imported'),
      cwd: opts.cwd,
      resumeSessionId: sid || undefined,
      wantedConnected: false,
      settings: opts.settings,
      autoNamed: !opts.name,
    });
    const pub = this._publicRecord(rec);
    this.emit('list_changed', { event: 'agent_added', agent: pub });
    return pub;
  }

  /**
   * POST /api/agents contract. Only `connect === true` (or a new chat with no
   * resumeSessionId) starts ACP. Hitting an archived overlay restores it.
   */
  async createFromPost(opts: AgentCreateOptions = {}): Promise<PublicAgent> {
    const resumeId = typeof opts.resumeSessionId === 'string' && opts.resumeSessionId.trim()
      ? opts.resumeSessionId.trim()
      : '';
    const wantConnect = opts.connect === true;
    if (!resumeId) return this.spawn({
      name: opts.name,
      model: opts.model,
      cwd: opts.cwd,
      settings: opts.settings,
    });

    const existing = this.getByIdOrSession(resumeId);
    if (existing) {
      const id = existing.id;
      if (existing.archived) await this.update(id, { archived: false });
      if (wantConnect) {
        try { await this.connect(id); }
        catch (err) { if (!(err instanceof SessionHeldError)) throw err; }
      }
      return this.get(id) || this._publicRecord(existing);
    }

    if (wantConnect) {
      return this.spawn({
        name: opts.name,
        model: opts.model,
        cwd: opts.cwd,
        settings: opts.settings,
        resumeSessionId: resumeId,
      });
    }

    return this.importOverlay({
      name: opts.name,
      cwd: opts.cwd,
      resumeSessionId: resumeId,
      settings: opts.settings,
    });
  }

  private _publicRecord(a: AgentRecord, ctx?: {
    remote?: Set<number>;
    rows?: ActiveSessionRow[];
    tuiDirCache?: Map<string, string | null>;
  }): PublicAgent {
    const handshake = a.client?.handshake as { _meta?: unknown; agentCapabilities?: unknown } | null;
    const heldBy = this._heldBy(a, ctx?.remote, ctx?.rows);
    let status = a.client?.status || a.status || 'disconnected';
    if (status === 'observed' && heldBy !== 'tui') status = 'disconnected';
    return {
      id: a.id,
      name: a.name,
      model: a.client?.modelId || a.modelHint || null,
      reasoningEffort: a.client?.reasoningEffort
        || (a.settings && typeof a.settings.reasoningEffort === 'string' ? a.settings.reasoningEffort : null)
        || null,
      status,
      connected: !!a.client,
      cwd: a.cwd,
      createdAt: a.createdAt,
      lastSeen: a.lastSeen,
      lastSessionId: a.client?.sessionId || a.lastSessionId || null,
      handshakeMeta: handshake?._meta || null,
      agentCapabilities: handshake?.agentCapabilities || null,
      sessionId: a.client?.sessionId || a.lastSessionId || null,
      availableCommands: a.client?.availableCommands || [],
      lastError: a.client?.lastError || a.lastError || null,
      exitInfo: a.client?.exitInfo || null,
      starred:    !!a.starred,
      archived:   !!a.archived,
      archivedAt: a.archivedAt || null,
      settings:   a.settings && typeof a.settings === 'object' ? a.settings : null,
      totalTokens: typeof a.totalTokens === 'number' ? a.totalTokens : 0,
      inFlight: typeof a.inFlight === 'number' ? a.inFlight : 0,
      wantedConnected: a.wantedConnected === true,
      source: this._sourceOf(a, ctx?.tuiDirCache),
      heldBy,
    };
  }

  private _sourceOf(a: AgentRecord, cache?: Map<string, string | null>): 'tui' | 'remote' {
    const sid = a.client?.sessionId || a.lastSessionId;
    if (!sid) return 'remote';
    const key = `${sid}\0${a.cwd || ''}`;
    if (cache && cache.has(key)) return cache.get(key) ? 'tui' : 'remote';
    const dir = findTuiSessionDir(sid, a.cwd);
    if (cache) cache.set(key, dir);
    return dir ? 'tui' : 'remote';
  }

  private _readActiveSessions(): ActiveSessionRow[] {
    if (this._holderRows) return this._holderRows;
    return readActiveSessions();
  }

  private _remotePids(): Set<number> {
    const out = new Set<number>();
    for (const rec of this.agents.values()) {
      const pid = rec.client?.proc?.pid;
      if (typeof pid === 'number' && pid > 0) out.add(pid);
    }
    return out;
  }

  private _heldBy(a: AgentRecord, remotePids?: Set<number>, rows?: ActiveSessionRow[]): HeldBy {
    const sid = a.client?.sessionId || a.lastSessionId;
    if (!sid) return null;
    return holderForSession(
      sid,
      remotePids || this._remotePids(),
      rows || this._readActiveSessions(),
      this._readCmd,
    );
  }

  reconcileTuiSessions(): { created: number; updated: number; dropped: number } {
    const sessions = listTuiSessions(200, { includeEmpty: true });
    const plan = planTuiReconcile(
      [...this.agents.values()].map((a) => ({
        id: a.id,
        lastSessionId: a.client?.sessionId || a.lastSessionId || null,
        name: a.name,
        archived: a.archived,
        autoNamed: a.autoNamed,
        starred: a.starred,
        wantedConnected: a.wantedConnected,
        connected: !!a.client,
        createdAt: a.createdAt,
      })),
      sessions,
    );
    let created = 0;
    let updated = 0;
    let dropped = 0;
    for (const { agentId, session } of plan.update) {
      const rec = this.agents.get(agentId);
      if (!rec) continue;
      let changed = false;
      if (!rec.archived && rec.autoNamed && session.title && rec.name !== session.title) {
        rec.name = session.title;
        changed = true;
      }
      if (session.updatedAt && session.updatedAt > rec.lastSeen) {
        rec.lastSeen = session.updatedAt;
        changed = true;
      }
      if (changed) {
        writeMeta(rec);
        updated += 1;
        this.emit('list_changed', { event: 'agent_updated', agent: this._publicRecord(rec) });
      }
    }
    for (const session of plan.create) {
      if (session.sessionKind === 'subagent') continue;
      const rec = this._materializeRecord({
        name: session.title || session.sessionId.slice(0, 8),
        cwd: session.cwd,
        resumeSessionId: session.sessionId,
        wantedConnected: false,
        createdAt: session.createdAt || nowIso(),
        lastSeen: session.updatedAt || nowIso(),
        autoNamed: true,
      });
      created += 1;
      this.emit('list_changed', { event: 'agent_added', agent: this._publicRecord(rec) });
    }
    for (const id of plan.drop) {
      void this.kill(id);
      dropped += 1;
    }
    return { created, updated, dropped };
  }

  private _materializeRecord(opts: {
    name: string;
    cwd?: string;
    resumeSessionId?: string;
    wantedConnected: boolean;
    settings?: AcpClientSettings | null;
    createdAt?: string;
    lastSeen?: string;
    autoNamed?: boolean;
    model?: string | null;
  }): AgentRecord {
    const id = randomUUID();
    ensureAgentDirs(id);
    const workCwd = recordedCwd(opts.cwd);
    const ring = createRing<AgentRingEntry>(SSE_RING_LIMIT);
    const record: AgentRecord = {
      id,
      name: opts.name || `agent-${id.slice(0, 8)}`,
      autoNamed: opts.autoNamed !== false,
      modelHint: opts.model || null,
      cwd: workCwd,
      createdAt: opts.createdAt || nowIso(),
      lastSeen: opts.lastSeen || nowIso(),
      lastSessionId: opts.resumeSessionId || null,
      lastError: null,
      starred: false,
      archived: false,
      archivedAt: null,
      settings: opts.settings && typeof opts.settings === 'object' ? opts.settings : null,
      client: null,
      ring,
      status: opts.wantedConnected ? 'starting' : 'disconnected',
      eventCounter: 0,
      wantedConnected: opts.wantedConnected,
    };
    record.bgTasks = hydrateBgTasksForAgent({
      agentId: record.id,
      sessionId: record.lastSessionId,
      cwd: record.cwd,
    });
    this.agents.set(id, record);
    writeMeta(record);
    return record;
  }

  async update(id: string, patch: AgentPatch): Promise<PublicAgent> {
    const a = this.agents.get(id);
    if (!a) throw new Error('agent not found');
    if (!patch || typeof patch !== 'object') throw new Error('invalid patch');
    let changed = false;
    if (typeof patch.name === 'string' && patch.name.trim()) {
      a.name = patch.name.trim().slice(0, 200);
      a.autoNamed = false;
      changed = true;
    }
    if (typeof patch.starred === 'boolean' && a.starred !== patch.starred) {
      a.starred = patch.starred;
      changed = true;
    }
    if (typeof patch.archived === 'boolean' && a.archived !== patch.archived) {
      a.archived = patch.archived;
      a.archivedAt = patch.archived ? nowIso() : null;
      changed = true;
      if (patch.archived) {
        a.wantedConnected = false;
        this._clearReconnect(a);
        if (a.client) {
          try { await a.client.shutdown('SIGTERM'); } catch { /* ignore */ }
          a.client = null;
          a.status = 'disconnected';
        }
      }
    }
    if (patch.settings === null) {
      if (a.settings != null) {
        a.settings = null;
        changed = true;
      }
    } else if (patch.settings && typeof patch.settings === 'object') {
      const next: AcpClientSettings = { ...(a.settings || {}), ...patch.settings };
      for (const k of Object.keys(next)) {
        const v = next[k];
        if (v == null) { delete next[k]; continue; }
        if (typeof v === 'string' && v.length === 0) { delete next[k]; continue; }
        if (Array.isArray(v) && v.length === 0) { delete next[k]; continue; }
      }
      a.settings = Object.keys(next).length ? next : null;
      changed = true;
    }
    if (changed) {
      writeMeta(a);
      const emitEvent = this._emitEventFactory(a);
      emitEvent('agent_updated', {
        id: a.id,
        name: a.name,
        starred: !!a.starred,
        archived: !!a.archived,
      });
      this.emit('list_changed', { event: 'agent_updated', agent: this._publicRecord(a) });
    }
    return this._publicRecord(a);
  }

  async switchModel(id: string, opts: { model?: string; reasoningEffort?: string } = {}): Promise<PublicAgent> {
    const a = this.agents.get(id);
    if (!a) throw new Error('agent not found');
    const model = trimText(opts.model);
    const reasoningEffort = trimText(opts.reasoningEffort);
    if (!model && !reasoningEffort) throw new Error('model or reasoningEffort required');

    const reason = sessionModelSwitchBlockReason({
      heldBy: this._heldBy(a),
      archived: !!a.archived,
      connected: !!a.client,
      inFlight: typeof a.inFlight === 'number' ? a.inFlight : 0,
      status: a.client?.status || a.status,
      sessionReady: a.client ? !!a.client.sessionId : false,
    });
    if (reason) {
      if (this._heldBy(a) === 'tui') throw new SessionHeldError(a.lastSessionId || a.id);
      throw new Error(reason);
    }
    const client = a.client;
    if (!client) throw new Error('Reconnect to switch models.');
    if (!client.sessionId) await client.waitUntilReady();

    const next: AcpClientSettings = { ...(a.settings || {}) };
    if (model) {
      next.model = model;
      a.modelHint = model;
    }
    if (reasoningEffort) next.reasoningEffort = reasoningEffort;
    a.settings = next;
    writeMeta(a);

    if (model) await client.setModel(model);
    if (reasoningEffort) await client.setMode(reasoningEffort);

    const emitEvent = this._emitEventFactory(a);
    emitEvent('agent_updated', {
      id: a.id,
      name: a.name,
      model: client.modelId,
      reasoningEffort: client.reasoningEffort,
    });
    this.emit('list_changed', { event: 'agent_updated', agent: this._publicRecord(a) });
    return this._publicRecord(a);
  }

  private _emitEventFactory(record: AgentRecord): (event: string, data: Record<string, unknown>) => void {
    return (event: string, data: Record<string, unknown>): void => {
      const meta = data && typeof data === 'object'
        ? (data as { _meta?: { isReplay?: unknown } })._meta
        : undefined;
      // session/load echoes every prior turn with isReplay=true. Persisting
      // or fanning those out duplicates YOU bubbles on the next page load.
      if (meta && meta.isReplay === true) {
        record.lastSeen = nowIso();
        return;
      }
      record.eventCounter = (record.eventCounter || 0) + 1;
      const eventId = `${Date.now()}-${record.eventCounter}`;
      const wrapped: AgentRingEntry = { id: eventId, event, data: { ...data, _t: Date.now() } };
      record.ring.push(wrapped);
      record.lastSeen = nowIso();
      this.emit(`agent:${record.id}`, wrapped);
      const upd = extractSessionUpdate(data);
      if (upd) {
        if (!record.bgTasks) record.bgTasks = new Map();
        const changed = applyBgTaskUpdate(record.bgTasks, upd, {
          at: record.lastSeen,
          defaultCwd: record.cwd,
        });
        if (changed) {
          this.emit('list_changed', { event: 'bg_tasks', id: record.id, count: countRunningBg(record) });
        }
      }
      const at = record.lastSeen;
      const tuiPresent = tuiPresentFor(record);
      setImmediate(() => historyAppend(record.id, { eventId, at, event, data }, { tuiPresent }));
    };
  }

  private _wireClient(record: AgentRecord): void {
    const id = record.id;
    const emitEvent = this._emitEventFactory(record);
    const client = record.client;
    if (!client) return;

    client.on('status', (s: Record<string, unknown>) => {
      emitEvent('agent_status', s);
      this.emit('list_changed', {
        event: 'agent_status',
        id: record.id,
        status: (s && s['status']) || record.status,
      });
    });
    client.on('handshake', (h: { _meta?: unknown; agentCapabilities?: unknown }) => {
      emitEvent('handshake', { meta: h?._meta || null, agentCapabilities: h?.agentCapabilities || null });
    });
    client.on('session_ready', (s: { sessionId?: string; resumed?: boolean }) => {
      if (s && s.sessionId) {
        if (record.lastSessionId !== s.sessionId) record._tuiDir = undefined;
        record.lastSessionId = s.sessionId;
        writeMeta(record);
      }
      record._reconnectAttempts = 0;
      emitEvent('session_ready', s as unknown as Record<string, unknown>);
    });
    client.on('update', (params: { update?: Record<string, unknown>; _meta?: Record<string, unknown>; sessionId?: string }) => {
      const u = params?.update || {};
      const event = (u['sessionUpdate'] as string) || 'update';
      const meta = params?._meta;
      const tt = meta && ((meta['totalTokens'] as number) ?? (meta['total_tokens'] as number));
      if (typeof tt === 'number' && Number.isFinite(tt) && tt > (record.totalTokens || 0)) {
        record.totalTokens = tt;
        const now = Date.now();
        if (!record._lastTokenEmit || (now - record._lastTokenEmit) >= 500) {
          record._lastTokenEmit = now;
          this.emit('list_changed', { event: 'agent_tokens', id: record.id, totalTokens: tt });
        }
      }
      const sub = u['sessionUpdate'];
      const callId = (u['toolCallId'] as string) || (u['id'] as string);
      if (callId) {
        if (!record._inFlightIds) record._inFlightIds = new Set();
        const updateParams = (meta as Record<string, unknown> | undefined)?.['updateParams'] as Record<string, unknown> | undefined;
        const metaStatus = updateParams && updateParams['status'];
        const rawStatus = (u['status'] as string) || (metaStatus as string) || '';
        const lowered = String(rawStatus).toLowerCase();
        const TERMINAL = new Set(['completed','success','succeeded','failed','error','errored','canceled','cancelled']);
        if (sub === 'tool_call' || sub === 'tool_call_start') {
          if (!TERMINAL.has(lowered)) record._inFlightIds.add(callId);
        } else if (sub === 'tool_call_update' || sub === 'tool_call_end') {
          if (TERMINAL.has(lowered)) record._inFlightIds.delete(callId);
        }
        const nextCount = record._inFlightIds.size;
        if (nextCount !== record.inFlight) {
          record.inFlight = nextCount;
          this.emit('list_changed', { event: 'agent_inflight', id: record.id, inFlight: nextCount });
        }
      }
      emitEvent(event, { update: u, _meta: params?._meta || null, sessionId: params?.sessionId });
    });
    client.on('x_notification', (msg: { method?: string; params?: { update?: Record<string, unknown> } }) => {
      const method = msg.method || 'x_notification';
      emitEvent(method.replace(/^_/, ''), { method, params: msg.params });

      const upd = msg?.params?.update;
      if (upd && upd['sessionUpdate'] === 'session_summary_generated' && record.autoNamed) {
        const summary = String(upd['session_summary'] || '').trim();
        if (summary) {
          const prev = record.name;
          const next = summary.length > 60 ? summary.slice(0, 60).replace(/\s+\S*$/, '') + '...' : summary;
          if (next && next !== prev) {
            record.name = next;
            writeMeta(record);
            emitEvent('agent_renamed', { id, name: next, prevName: prev, source: 'auto', summary });
          }
        }
      }
    });
    client.on('prompt_complete', (params: Record<string, unknown>) => emitEvent('prompt_complete', params));
    client.on('prompt_result',  (result: Record<string, unknown>) => emitEvent('prompt_result', result));
    client.on('error', (err: Error | { message?: string }) => {
      record.lastError = (err && (err as Error).message) || String(err);
      writeMeta(record);
      emitEvent('error', { message: record.lastError });
    });
    client.on('exit', (info: Record<string, unknown>) => {
      emitEvent('agent_exited', info);
      if (record.client === client) {
        record.client = null;
        record.status = 'disconnected';
        writeMeta(record);
        if (record._inFlightIds) record._inFlightIds.clear();
        if (record.inFlight) {
          record.inFlight = 0;
          this.emit('list_changed', { event: 'agent_inflight', id: record.id, inFlight: 0 });
        }
        emitEvent('agent_status', { status: 'disconnected', reason: 'process_exit' });
        this.emit('list_changed', { event: 'agent_status', id: record.id, status: 'disconnected' });
        // Crash / unexpected death: bring it back unless the user asked
        // for a disconnect. Server shutdown skips this via _shuttingDown.
        if (!this._shuttingDown && shouldKeepConnected(record)) {
          if (this._heldBy(record) === 'tui') {
            record.status = 'observed';
            this._syncTail(record.id);
          } else {
            this._scheduleReconnect(record);
          }
        }
      }
    });
    client.on('stderr', (chunk: string) => emitEvent('stderr', { chunk }));
  }

  async spawn({ name, model, cwd, settings, resumeSessionId }: AgentSpawnOptions = {}): Promise<PublicAgent> {
    const resumeId = typeof resumeSessionId === 'string' && resumeSessionId.trim()
      ? resumeSessionId.trim()
      : '';
    if (resumeId) {
      const matches: AgentRecord[] = [];
      for (const existing of this.agents.values()) {
        if (existing.lastSessionId === resumeId) matches.push(existing);
      }
      const hit = pickOverlayForSession(matches);
      if (hit) return this._publicRecord(hit);
    }

    const recorded = recordedCwd(cwd);
    const startCwd = this._startCwd(recorded);
    if (!startCwd) throw new Error('cwd required');

    const id = randomUUID();
    ensureAgentDirs(id);
    const workCwd = recorded || startCwd;

    const ring = createRing<AgentRingEntry>(SSE_RING_LIMIT);
    const record: AgentRecord = {
      id,
      name: name || `agent-${id.slice(0, 8)}`,
      autoNamed: !name,
      modelHint: model || null,
      cwd: workCwd,
      createdAt: nowIso(),
      lastSeen: nowIso(),
      lastSessionId: resumeId || null,
      lastError: null,
      starred: false,
      archived: false,
      archivedAt: null,
      settings: settings && typeof settings === 'object' ? settings : null,
      client: null,
      ring,
      status: 'starting',
      eventCounter: 0,
      wantedConnected: true,
    };
    this.agents.set(id, record);
    writeMeta(record);

    historyAppend(id, { at: nowIso(), event: 'agent_created', data: { id, name: record.name, cwd: workCwd, resumeSessionId: resumeId || null } }, { tuiPresent: tuiPresentFor(record) });

    try {
      this._connectRecord(record);
    } catch (err) {
      if (!(err instanceof SessionHeldError)) throw err;
    }
    const pub = this._publicRecord(record);
    this.emit('list_changed', { event: 'agent_added', agent: pub });
    return pub;
  }

  private _connectRecord(record: AgentRecord): AcpClient {
    if (record.client) return record.client;
    if (this._heldBy(record) === 'tui') {
      record.status = 'observed';
      this._syncTail(record.id);
      throw new SessionHeldError(record.lastSessionId || record.id);
    }
    const startCwd = this._startCwd(record.cwd);
    if (!startCwd) throw new Error('cwd required');
    this._stopTail(record.id);
    record.status = 'starting';
    const client = new AcpClient({
      cwd: startCwd,
      modelHint: record.modelHint,
      settings: record.settings || null,
    });
    record.client = client;
    this._wireClient(record);
    const emitEvent = this._emitEventFactory(record);
    emitEvent('agent_status', { status: 'starting' });
    client.start({ resumeSessionId: record.lastSessionId || null }).catch((err: Error | { message?: string }) => {
      record.lastError = (err && (err as Error).message) || String(err);
      writeMeta(record);
      emitEvent('error', { message: record.lastError });
    });
    return client;
  }

  async connect(id: string): Promise<PublicAgent> {
    const a = this.agents.get(id);
    if (!a) throw new Error('agent not found');
    if (this._heldBy(a) === 'tui') {
      a.status = 'observed';
      throw new SessionHeldError(a.lastSessionId || a.id);
    }
    a.wantedConnected = true;
    this._clearReconnect(a);
    a._reconnectAttempts = 0;
    writeMeta(a);
    if (a.client) return this._publicRecord(a);
    this._connectRecord(a);
    return this._publicRecord(a);
  }

  async disconnect(id: string): Promise<PublicAgent> {
    const a = this.agents.get(id);
    if (!a) throw new Error('agent not found');
    a.wantedConnected = false;
    this._clearReconnect(a);
    if (!a.client) {
      writeMeta(a);
      return this._publicRecord(a);
    }
    const client = a.client;
    a.client = null;
    a.status = 'disconnected';
    if (client.sessionId) a.lastSessionId = client.sessionId;
    writeMeta(a);
    try { await client.shutdown('SIGTERM'); } catch { /* ignore */ }
    const emitEvent = this._emitEventFactory(a);
    if (a._inFlightIds) a._inFlightIds.clear();
    if (a.inFlight) {
      a.inFlight = 0;
      this.emit('list_changed', { event: 'agent_inflight', id: a.id, inFlight: 0 });
    }
    emitEvent('agent_status', { status: 'disconnected', reason: 'user_request' });
    this.emit('list_changed', { event: 'agent_status', id: a.id, status: 'disconnected' });
    return this._publicRecord(a);
  }

  async kill(id: string): Promise<boolean> {
    const a = this.agents.get(id);
    if (!a) return false;
    this._clearReconnect(a);
    this._stopTail(id);
    if (a.client) {
      try { await a.client.shutdown('SIGTERM'); } catch { /* ignore */ }
    }
    this.agents.delete(id);
    this.emit('list_changed', { event: 'agent_removed', id });
    // Drop dead overlay ids from folders.json so Archived / user folders
    // do not keep pointers after the overlay is gone.
    try { assignAgentToFolder(id, null); }
    catch { /* folder unlink must not block overlay removal */ }
    try {
      const dir = agentDir(id);
      if (dir.startsWith(agentsRoot() + path.sep)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[kill] failed to remove ${id}: ${msg}\n`);
    }
    return true;
  }

  async prompt(id: string, textOrOpts: string | PromptInput): Promise<{ ok: true; debug: Record<string, unknown> }> {
    const a = this.agents.get(id);
    if (!a) throw new Error('agent not found');
    if (this._heldBy(a) === 'tui') {
      throw new SessionHeldError(a.lastSessionId || a.id);
    }

    if (!a.client) {
      a.wantedConnected = true;
      writeMeta(a);
      this._connectRecord(a);
      await this._waitForSession(a, 8000);
    } else if (!a.client.sessionId) {
      await this._waitForSession(a, 8000);
    }
    if (!a.client) throw new Error('reconnect failed');

    let text: string;
    let attachments: PromptAttachment[];
    if (textOrOpts && typeof textOrOpts === 'object' && !Array.isArray(textOrOpts)) {
      text = String(textOrOpts.text || '');
      attachments = Array.isArray(textOrOpts.attachments) ? textOrOpts.attachments : [];
    } else {
      text = String(textOrOpts || '');
      attachments = [];
    }

    const savedFiles: SavedFile[] = [];
    if (attachments.length) {
      const uploadRoot = (a.client?.cwd && fs.existsSync(a.client.cwd))
        ? a.client.cwd
        : (a.cwd && fs.existsSync(a.cwd) ? a.cwd : '');
      if (!uploadRoot) throw new Error('cwd required');
      const uploadsDir = path.join(uploadRoot, 'uploads');
      fs.mkdirSync(uploadsDir, { recursive: true });
      for (const att of attachments) {
        if (!att || typeof att.dataBase64 !== 'string' || !att.dataBase64) continue;
        const buf = Buffer.from(att.dataBase64, 'base64');
        const candidate = uniqueUploadName(uploadsDir, att.name, att.mimeType);
        const abs = path.join(uploadsDir, candidate);
        fs.writeFileSync(abs, buf);
        savedFiles.push({
          rel: path.posix.join('uploads', candidate),
          abs,
          mimeType: att.mimeType || null,
          size: buf.length,
        });
      }
    }

    const handshake = a.client?.handshake as { agentCapabilities?: { promptCapabilities?: { image?: boolean; embeddedContext?: boolean } } } | null;
    const supportsImage = !!handshake?.agentCapabilities?.promptCapabilities?.image;
    let finalText = text;
    if (savedFiles.length) {
      const lines = savedFiles.map((f) => attachmentLine(f));
      const refBlock = 'Attached files:\n' + lines.join('\n');
      finalText = text && text.length ? `${text}\n\n${refBlock}` : refBlock;
    }

    const embeddedContext = !!handshake?.agentCapabilities?.promptCapabilities?.embeddedContext;
    const blocks: unknown[] = [];
    if (finalText && finalText.length) blocks.push({ type: 'text', text: finalText });
    for (let i = 0; i < savedFiles.length; i++) {
      const f = savedFiles[i]!;
      const mime = (f.mimeType || '').toLowerCase();
      if (!mime.startsWith('image/')) continue;
      try {
        const buf = fs.readFileSync(f.abs);
        blocks.push({
          type: 'image',
          mimeType: f.mimeType || 'image/png',
          data: buf.toString('base64'),
        });
      } catch { /* fall back to text+resource_link only */ }
    }
    if (embeddedContext) {
      for (const f of savedFiles) {
        blocks.push({
          type: 'resource_link',
          uri: 'file://' + f.abs,
          name: path.basename(f.abs),
          mimeType: f.mimeType || 'application/octet-stream',
          size: f.size,
        });
      }
    }
    if (!blocks.length) throw new Error('empty prompt');

    const histAttachments = savedFiles.map((f) => ({
      rel: f.rel, mimeType: f.mimeType, size: f.size,
    }));
    const histData: Record<string, unknown> = histAttachments.length
      ? { text: finalText, attachments: histAttachments }
      : { text: finalText };
    historyAppend(id, { at: nowIso(), event: 'user_message', data: histData }, { tuiPresent: tuiPresentFor(a) });
    a.ring.push({
      id: `${Date.now()}-user`,
      event: 'user_message',
      data: { ...histData, _t: Date.now() },
    });
    this.emit(`agent:${id}`, {
      id: `${Date.now()}-user`,
      event: 'user_message',
      data: { ...histData, _t: Date.now() },
    });
    a.client.prompt(blocks).catch(() => { /* error already emitted */ });
    return {
      ok: true,
      debug: {
        sessionId: a.client?.sessionId || null,
        composedText: finalText,
        promptBlocks: blocks,
        savedFiles: savedFiles.map((f) => ({
          abs: f.abs, rel: f.rel, mimeType: f.mimeType, size: f.size,
        })),
        supportsImage,
      },
    };
  }

  async cancel(id: string): Promise<boolean> {
    const a = this.agents.get(id);
    if (!a) return false;
    if (!a.client) return false;
    await a.client.cancel();
    return true;
  }

  private async _waitForSession(record: AgentRecord, timeoutMs: number): Promise<void> {
    if (record.client && record.client.sessionId) return;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (record.client && record.client.sessionId) return;
      if (record.client && record.client.status === 'errored') {
        throw new Error(record.client.lastError || 'agent errored during reconnect');
      }
      await new Promise<void>((r) => setTimeout(r, 100));
    }
    throw new Error('timed out waiting for session');
  }

  ring(id: string): SseRing<AgentRingEntry> | null {
    const a = this.agents.get(id);
    return a ? a.ring : null;
  }

  subscribe(id: string, listener: (event: AgentRingEntry) => void): () => void {
    this.on(`agent:${id}`, listener);
    return () => this.off(`agent:${id}`, listener);
  }

  beginView(id: string): () => void {
    this._viewers.set(id, (this._viewers.get(id) || 0) + 1);
    this._syncTail(id);
    return () => {
      const next = (this._viewers.get(id) || 1) - 1;
      if (next <= 0) this._viewers.delete(id);
      else this._viewers.set(id, next);
      this._syncTail(id);
    };
  }

  private _acpIsWriter(record: AgentRecord): boolean {
    if (!record.client) return false;
    const st = record.client.status || record.status;
    return st !== 'disconnected' && st !== 'exited' && st !== 'errored' && st !== 'observed';
  }

  private _syncTail(id: string): void {
    const rec = this.agents.get(id);
    if (!rec) {
      this._stopTail(id);
      return;
    }
    const viewers = this._viewers.get(id) || 0;
    const shouldTail = viewers > 0 && !this._acpIsWriter(rec);
    if (!shouldTail) {
      this._stopTail(id);
      return;
    }
    if (this._tails.has(id)) return;
    const sid = rec.client?.sessionId || rec.lastSessionId;
    if (!sid) return;
    const dir = findTuiSessionDir(sid, rec.cwd);
    if (!dir) return;
    const file = path.join(dir, 'updates.jsonl');
    const tail = new UpdatesFileTail(file, sid, (events) => {
      const emitEvent = this._emitEventFactory(rec);
      for (const ev of events) emitEvent(ev.event, ev.data);
    });
    this._tails.set(id, tail);
    tail.start();
  }

  private _stopTail(id: string): void {
    const tail = this._tails.get(id);
    if (!tail) return;
    tail.stop();
    this._tails.delete(id);
  }

  private _syncHolders(): void {
    const remote = this._remotePids();
    const rows = this._readActiveSessions();
    for (const rec of this.agents.values()) {
      const held = this._heldBy(rec, remote, rows);
      if (held === 'tui') {
        this._clearReconnect(rec);
        const wasObserved = rec.status === 'observed' && !rec.client;
        if (rec.client) {
          const client = rec.client;
          rec.client = null;
          rec.status = 'observed';
          if (client.sessionId) rec.lastSessionId = client.sessionId;
          writeMeta(rec);
          client.shutdown('SIGTERM').catch(() => { /* ignore */ });
        } else if (rec.status !== 'observed') {
          rec.status = 'observed';
        }
        if (!wasObserved) {
          this.emit('list_changed', { event: 'agent_status', id: rec.id, status: 'observed' });
        }
        this._syncTail(rec.id);
      } else if (rec.status === 'observed' && !rec.client) {
        if (shouldKeepConnected(rec)) {
          try { this._connectRecord(rec); } catch { /* held again or start failed */ }
        } else {
          rec.status = 'disconnected';
          this.emit('list_changed', { event: 'agent_status', id: rec.id, status: 'disconnected' });
          this._syncTail(rec.id);
        }
      }
    }
  }

  async shutdownAll(): Promise<void> {
    // Detach processes for a clean exit. Do NOT flip wantedConnected —
    // a pm2 restart should bring wanted agents back up.
    this._shuttingDown = true;
    if (this._reconcileTimer) {
      clearInterval(this._reconcileTimer);
      this._reconcileTimer = null;
    }
    for (const id of [...this._tails.keys()]) this._stopTail(id);
    const recs = [...this.agents.values()];
    await Promise.all(recs.map(async (a) => {
      this._clearReconnect(a);
      if (!a.client) return;
      if (a.client.sessionId) a.lastSessionId = a.client.sessionId;
      const client = a.client;
      a.client = null;
      a.status = 'disconnected';
      writeMeta(a);
      try { await client.shutdown('SIGTERM'); } catch { /* ignore */ }
    }));
  }
}
