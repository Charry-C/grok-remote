// Pure helpers for the contextual topbar.
//
// The topbar title is "where am I?", not the product name:
//   home      -> Grok Remote
//   chat      -> conversation name + live connection status
//
// Kept DOM-free so the mapping can be unit-tested.

export type TopbarKind = 'home' | 'chat';
export type LiveKind = 'ok' | 'warn' | 'fail' | 'idle' | 'run';
export type ConnectionAction = 'connect' | 'disconnect' | 'none';

export interface TopbarLive {
  kind: LiveKind;
  label: string;
}

export interface TopbarContext {
  kind: TopbarKind;
  title: string;
  model?: string | null;
  cwd?: string | null;
  live?: TopbarLive | null;
  connectionAction?: ConnectionAction;
}

export interface TopbarAgent {
  id?: string | null;
  name?: string | null;
  model?: string | null;
  cwd?: string | null;
  status?: string | null;
  connected?: boolean | null;
  inFlight?: number | null;
  heldBy?: string | null;
  wantedConnected?: boolean | null;
  settings?: { model?: string | null } | null;
}

export const PRODUCT_NAME = 'Grok';
export const PRODUCT_DOCUMENT_TITLE = 'grok-remote';

export function conversationTitle(agent: TopbarAgent | null | undefined): string {
  const name = agent?.name != null ? String(agent.name).trim() : '';
  if (name) return name;
  const id = agent?.id ? String(agent.id) : '';
  if (id) return `agent-${id.slice(0, 8)}`;
  return 'Conversation';
}

export function shortModel(model: string | null | undefined): string {
  if (model == null) return '';
  const s = String(model).trim();
  if (!s) return '';
  const slash = s.lastIndexOf('/');
  return slash >= 0 ? s.slice(slash + 1) : s;
}

export function formatCwd(cwd: string | null | undefined): string {
  if (cwd == null) return '';
  let display = String(cwd).trim();
  if (!display) return '';

  display = display
    .replace(/^\/root(?=\/|$)/, '~')
    .replace(/^\/home\/[^/]+(?=\/|$)/, '~')
    .replace(/^\/Users\/[^/]+(?=\/|$)/, '~');

  const MAX = 32;
  if (display.length <= MAX) return display;

  const tilde = display.startsWith('~');
  const segs = display.replace(/^~\/?/, '').split('/').filter(Boolean);
  if (segs.length <= 2) return display;
  return `${tilde ? '~' : ''}/…/${segs.slice(-2).join('/')}`;
}

export function liveFromAgent(agent: TopbarAgent | null | undefined): TopbarLive | null {
  if (!agent) return null;
  const status = String(agent.status || '');
  const inFlight = typeof agent.inFlight === 'number' ? agent.inFlight : 0;

  if (agent.heldBy === 'tui' || status === 'observed') {
    return { kind: 'warn', label: 'TUI · 只读' };
  }
  if (status === 'errored' || status === 'killed') {
    return { kind: 'fail', label: 'error' };
  }
  if (status === 'disconnected' || status === 'exited') {
    return { kind: 'warn', label: 'offline' };
  }
  if (status === 'starting') {
    return { kind: 'idle', label: 'connecting' };
  }
  if (status === 'running' || inFlight > 0) {
    return { kind: 'run', label: inFlight > 0 ? 'working' : 'running' };
  }
  if (agent.connected || status === 'idle') {
    return { kind: 'ok', label: 'connected' };
  }
  return { kind: 'idle', label: status || 'offline' };
}

export function connectionActionFor(agent: TopbarAgent | null | undefined): ConnectionAction {
  if (!agent) return 'none';
  if (agent.heldBy === 'tui' || agent.status === 'observed') return 'none';
  if (agent.status === 'starting') return 'none';
  const disconnected = agent.status === 'disconnected' || agent.status === 'exited'
    || agent.status === 'errored' || agent.status === 'killed'
    || (!agent.connected && agent.wantedConnected === false);
  return disconnected ? 'connect' : 'disconnect';
}

export interface ConnectionConfirmCopy {
  title: string;
  hint: string;
  confirmLabel: string;
  danger: boolean;
}

/** Confirm-sheet copy for a connect / disconnect tap. `none` has no sheet. */
export function connectionConfirmFor(action: ConnectionAction): ConnectionConfirmCopy | null {
  if (action === 'disconnect') {
    return {
      title: 'Disconnect this conversation?',
      hint: 'The agent process stops. Sending a message will reconnect.',
      confirmLabel: 'Disconnect',
      danger: true,
    };
  }
  if (action === 'connect') {
    return {
      title: 'Reconnect this conversation?',
      hint: 'Start the agent process for this session.',
      confirmLabel: 'Connect',
      danger: false,
    };
  }
  return null;
}

export function contextFromAgent(agent: TopbarAgent | null | undefined): TopbarContext {
  if (!agent || !agent.id) {
    return { kind: 'home', title: PRODUCT_NAME };
  }
  const model = shortModel(agent.model || agent.settings?.model || '');
  return {
    kind: 'chat',
    title: conversationTitle(agent),
    model: model || null,
    cwd: agent.cwd || null,
    live: liveFromAgent(agent),
    connectionAction: connectionActionFor(agent),
  };
}

export function documentTitleFor(ctx: TopbarContext, anyAgentBusy: boolean): string {
  const page = ctx.kind === 'home' ? PRODUCT_DOCUMENT_TITLE : `${ctx.title} · ${PRODUCT_DOCUMENT_TITLE}`;
  return anyAgentBusy ? `(*) ${page}` : page;
}

export function pageTitle(label: string | null | undefined): string {
  const s = label != null ? String(label).trim() : '';
  return s || PRODUCT_NAME;
}
