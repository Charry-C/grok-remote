// Pure helpers for the contextual topbar.
//
// The topbar title is "where am I?", not the product name:
//   home      -> Grok Remote
//   chat      -> conversation name + live status + model + cwd
//   settings  -> Settings
//   system    -> page label
//
// Kept DOM-free so the mapping can be unit-tested.

export type TopbarKind = 'home' | 'chat' | 'settings' | 'system';
export type LiveKind = 'ok' | 'warn' | 'fail' | 'idle' | 'run';

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
}

export interface TopbarAgent {
  id?: string | null;
  name?: string | null;
  model?: string | null;
  cwd?: string | null;
  status?: string | null;
  connected?: boolean | null;
  inFlight?: number | null;
  settings?: { model?: string | null } | null;
}

export const PRODUCT_NAME = 'Grok Remote';
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

  if (status === 'errored' || status === 'killed') {
    return { kind: 'fail', label: status };
  }
  if (status === 'disconnected' || status === 'exited') {
    return { kind: 'warn', label: 'offline' };
  }
  if (status === 'starting') {
    return { kind: 'idle', label: 'starting' };
  }
  if (status === 'running' || inFlight > 0) {
    return { kind: 'run', label: inFlight > 0 ? 'working' : 'running' };
  }
  if (agent.connected || status === 'idle') {
    return { kind: 'ok', label: 'connected' };
  }
  return { kind: 'idle', label: status || 'idle' };
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
