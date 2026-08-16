// Pure helpers for the composer model chip and picker.
// Keep this DOM-free so unit tests can cover the label format.

export interface ReasoningEffortOption {
  id: string;
  label: string;
}

export const REASONING_EFFORTS: readonly ReasoningEffortOption[] = [
  { id: 'none', label: 'none' },
  { id: 'minimal', label: 'min' },
  { id: 'low', label: 'low' },
  { id: 'medium', label: 'med' },
  { id: 'high', label: 'high' },
  { id: 'xhigh', label: 'xhigh' },
];

export interface ModelAgentLike {
  model?: string | null;
  reasoningEffort?: string | null;
  status?: string | null;
  connected?: boolean;
  archived?: boolean;
  heldBy?: string | null;
  inFlight?: number;
  sessionId?: string | null;
  settings?: {
    model?: string | null;
    reasoningEffort?: string | null;
  } | null;
}

export interface ModelChipInput {
  modelId?: string | null;
  effort?: string | null;
  displayName?: string | null;
}

export function prettyModelId(id: string | null | undefined): string {
  if (id == null) return '';
  const raw = String(id).trim();
  if (!raw) return '';
  const slash = raw.lastIndexOf('/');
  const base = slash >= 0 ? raw.slice(slash + 1) : raw;
  const m = base.match(/^grok[-_]?(.*)$/i);
  if (!m) return base;
  const rest = (m[1] || '').trim();
  if (!rest) return 'Grok';
  const tokens = rest.split(/[-_]+/).filter(Boolean);
  const prettyRest = tokens.map((t) => {
    if (/^\d+(\.\d+)*$/.test(t)) return t;
    if (/^[a-z]/.test(t)) return t.charAt(0).toUpperCase() + t.slice(1);
    return t;
  }).join(' ');
  return prettyRest ? `Grok ${prettyRest}` : 'Grok';
}

export function formatModelChip(input: ModelChipInput): string {
  const id = input && input.modelId != null ? String(input.modelId).trim() : '';
  const given = input && input.displayName != null ? String(input.displayName).trim() : '';
  const name = given && given !== id ? given : prettyModelId(id);
  const label = name || 'Model';
  const effort = input && input.effort != null ? String(input.effort).trim() : '';
  return effort ? `${label} ${effort}` : label;
}

export function resolveAgentModel(agent: ModelAgentLike | null | undefined): string {
  if (!agent) return '';
  const live = typeof agent.model === 'string' ? agent.model.trim() : '';
  if (live) return live;
  return agent.settings && typeof agent.settings.model === 'string'
    ? agent.settings.model.trim()
    : '';
}

export function resolveAgentEffort(agent: ModelAgentLike | null | undefined): string {
  if (!agent) return '';
  const live = typeof agent.reasoningEffort === 'string' ? agent.reasoningEffort.trim() : '';
  if (live) return live;
  return agent.settings && typeof agent.settings.reasoningEffort === 'string'
    ? agent.settings.reasoningEffort.trim()
    : '';
}

export interface ModelSwitchGate {
  disabled: boolean;
  reason: string | null;
}

export interface ModelSwitchGateInput {
  hasAgent?: boolean;
  composerEnabled?: boolean;
  switching?: boolean;
  inFlight?: boolean;
  agent?: ModelAgentLike | null;
}

export function modelSwitchGate(input: ModelSwitchGateInput = {}): ModelSwitchGate {
  if (!input.hasAgent) {
    return { disabled: true, reason: 'No conversation selected.' };
  }
  if (input.switching) {
    return { disabled: true, reason: 'Switching model\u2026' };
  }
  const agent = input.agent || null;
  if (agent && agent.archived) {
    return { disabled: true, reason: 'Archived conversations cannot switch models.' };
  }
  if (input.composerEnabled === false || (agent && agent.heldBy === 'tui')) {
    return { disabled: true, reason: 'TUI is using this session.' };
  }
  const status = agent && typeof agent.status === 'string' ? agent.status : '';
  const busy = !!input.inFlight
    || status === 'running'
    || (typeof agent?.inFlight === 'number' && agent.inFlight > 0);
  if (busy) {
    return { disabled: true, reason: 'Wait until this turn finishes.' };
  }
  if (status === 'starting') {
    return { disabled: true, reason: 'Agent is connecting\u2026' };
  }
  const connected = !!(agent && agent.connected)
    && status !== 'disconnected'
    && status !== 'exited'
    && status !== 'killed'
    && status !== 'observed';
  if (!connected) {
    return { disabled: true, reason: 'Reconnect to switch models.' };
  }
  if (!(agent && typeof agent.sessionId === 'string' && agent.sessionId.trim())) {
    return { disabled: true, reason: 'Session is not ready.' };
  }
  return { disabled: false, reason: null };
}
