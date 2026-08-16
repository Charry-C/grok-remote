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

const EFFORT_LOW: ReasoningEffortOption = { id: 'low', label: 'low' };
const EFFORT_MEDIUM: ReasoningEffortOption = { id: 'medium', label: 'med' };
const EFFORT_HIGH: ReasoningEffortOption = { id: 'high', label: 'high' };
const EFFORT_XHIGH: ReasoningEffortOption = { id: 'xhigh', label: 'xhigh' };

/** Canonical rank used to clamp an unsupported effort to the nearest valid one. */
const EFFORT_RANK: readonly string[] = [
  'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
];

const GROK_45_EFFORTS: readonly ReasoningEffortOption[] = [
  EFFORT_LOW, EFFORT_MEDIUM, EFFORT_HIGH,
];

const GROK_46_EFFORTS: readonly ReasoningEffortOption[] = [
  EFFORT_LOW, EFFORT_MEDIUM, EFFORT_HIGH, EFFORT_XHIGH,
];

function fallbackEffort(ids: readonly string[]): string {
  if (ids.includes('high')) return 'high';
  return ids.length ? ids[ids.length - 1]! : '';
}

export interface GrokModelVersion {
  major: number;
  minor: number;
}

function modelBaseId(id: string | null | undefined): string {
  if (id == null) return '';
  const raw = String(id).trim();
  if (!raw) return '';
  const slash = raw.lastIndexOf('/');
  return (slash >= 0 ? raw.slice(slash + 1) : raw).toLowerCase();
}

/** Parse grok-4.5 / grok-4.6 / grok-4.20-multi-agent style ids. */
export function grokModelVersion(id: string | null | undefined): GrokModelVersion | null {
  const base = modelBaseId(id);
  if (!base) return null;
  const m = base.match(/^grok[-_]?(\d+)(?:\.(\d+))?/i);
  if (!m) return null;
  return { major: Number(m[1]), minor: m[2] != null ? Number(m[2]) : 0 };
}

/**
 * Reasoning depths the picker should offer for a model.
 *
 * Official xAI menus (cannot be disabled):
 *   grok-4.5 → low / medium / high
 *   grok-4.6 and later → low / medium / high / xhigh
 * Unknown ids keep the full canonical list so custom models stay pickable.
 */
export function effortsForModel(id: string | null | undefined): readonly ReasoningEffortOption[] {
  const ver = grokModelVersion(id);
  if (!ver) return REASONING_EFFORTS;
  if (ver.major > 4 || (ver.major === 4 && ver.minor >= 6)) return GROK_46_EFFORTS;
  if (ver.major === 4 && ver.minor === 5) return GROK_45_EFFORTS;
  return REASONING_EFFORTS;
}

/** True when `effort` is in the model's advertised menu. */
export function modelSupportsEffort(
  id: string | null | undefined,
  effort: string | null | undefined,
): boolean {
  const want = effort == null ? '' : String(effort).trim();
  if (!want) return false;
  return effortsForModel(id).some((opt) => opt.id === want);
}

/**
 * Map an effort onto the model's menu. Empty input becomes `high` when that
 * level exists (xAI default); otherwise the last advertised level.
 * An out-of-range value (xhigh on 4.5, none on 4.6) snaps to the nearest rank.
 */
export function clampReasoningEffort(
  id: string | null | undefined,
  effort: string | null | undefined,
): string {
  const options = effortsForModel(id);
  if (!options.length) return '';
  const ids = options.map((opt) => opt.id);
  const want = effort == null ? '' : String(effort).trim();
  if (want && ids.includes(want)) return want;
  if (!want) return fallbackEffort(ids);
  const wantRank = EFFORT_RANK.indexOf(want);
  if (wantRank < 0) return fallbackEffort(ids);
  let best = fallbackEffort(ids);
  let bestDist = Number.POSITIVE_INFINITY;
  for (const optId of ids) {
    const rank = EFFORT_RANK.indexOf(optId);
    const dist = rank < 0 ? 999 : Math.abs(rank - wantRank);
    if (dist < bestDist) {
      bestDist = dist;
      best = optId;
    }
  }
  return best;
}

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
