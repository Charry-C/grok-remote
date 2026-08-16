// Pure helpers for reading grok's session model/effort snapshot and
// deciding whether a live model switch can be applied.

export interface SessionConfigOption {
  id?: string;
  category?: string;
  selected?: boolean;
}

export interface SessionSnapshot {
  modelId: string | null;
  reasoningEffort: string | null;
}

export function trimText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function ingestSessionSnapshot(result: unknown): SessionSnapshot {
  const out: SessionSnapshot = { modelId: null, reasoningEffort: null };
  if (!result || typeof result !== 'object') return out;
  const rec = result as Record<string, unknown>;

  const models = rec['models'];
  if (models && typeof models === 'object') {
    const current = trimText((models as Record<string, unknown>)['currentModelId']);
    if (current) out.modelId = current;
  }

  const meta = rec['_meta'];
  if (meta && typeof meta === 'object') {
    const cfg = (meta as Record<string, unknown>)['x.ai/sessionConfig'];
    if (cfg && typeof cfg === 'object') {
      const options = (cfg as Record<string, unknown>)['options'];
      if (Array.isArray(options)) {
        for (const raw of options) {
          if (!raw || typeof raw !== 'object') continue;
          const opt = raw as SessionConfigOption;
          if (!opt.selected) continue;
          const id = trimText(opt.id);
          if (!id) continue;
          if (opt.category === 'model') out.modelId = id;
          if (opt.category === 'mode') out.reasoningEffort = id;
        }
      }
    }
  }

  return out;
}

export function ingestSessionInfo(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const rec = result as Record<string, unknown>;
  const inner = rec['result'] && typeof rec['result'] === 'object'
    ? rec['result'] as Record<string, unknown>
    : rec;
  const model = trimText(inner['model']);
  return model || null;
}

export interface SwitchBlockInput {
  heldBy?: string | null;
  archived?: boolean;
  connected?: boolean;
  inFlight?: number;
  status?: string | null;
  sessionReady?: boolean;
}

export function sessionModelSwitchBlockReason(input: SwitchBlockInput): string | null {
  if (input.archived) return 'Archived conversations cannot switch models.';
  if (input.heldBy === 'tui') return 'TUI is using this session.';
  const status = typeof input.status === 'string' ? input.status : '';
  if (status === 'running' || (typeof input.inFlight === 'number' && input.inFlight > 0)) {
    return 'Wait until this turn finishes.';
  }
  if (status === 'starting') return 'Agent is connecting\u2026';
  if (!input.connected || status === 'disconnected' || status === 'exited' || status === 'killed' || status === 'observed') {
    return 'Reconnect to switch models.';
  }
  if (input.sessionReady === false) return 'Session is not ready.';
  return null;
}
