// Normalize token-usage payloads from ACP / grok-remote events.
//
// The message footer used to read `_x.ai/session/prompt_complete`, but that
// notification only carries stopReason. The numbers live on:
//   - session/prompt RPC result (`prompt_result._meta` + `_meta.usage`)
//   - `_x.ai/session/update` with `sessionUpdate: "turn_completed"` (`update.usage`)

export interface TokenMeta {
  inputTokens?: number; input_tokens?: number;
  outputTokens?: number; output_tokens?: number;
  cachedReadTokens?: number; cached_read_tokens?: number; cachedTokens?: number;
  reasoningTokens?: number; reasoning_tokens?: number;
  totalTokens?: number | null; total_tokens?: number | null;
  costUsdTicks?: number; cost_usd_ticks?: number; total_cost_usd_ticks?: number;
  costUSD?: number; costUsd?: number; cost_usd?: number; total_cost_usd?: number;
  modelId?: string | null; model_id?: string | null; model?: string | null;
  stopReason?: string | null; stop_reason?: string | null;
}

type Rec = Record<string, unknown>;

function asRec(v: unknown): Rec | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  return v as Rec;
}

function pickNum(obj: Rec | null | undefined, ...keys: string[]): number | undefined {
  if (!obj) return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
}

function pickStr(obj: Rec | null | undefined, ...keys: string[]): string | undefined {
  if (!obj) return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return undefined;
}

function collectLayers(payload: unknown): Rec[] {
  const root = asRec(payload);
  if (!root) return [];
  const params = asRec(root['params']);
  const update = asRec(root['update']) || asRec(params && params['update']);
  const meta = asRec(root['_meta']) || asRec(params && params['_meta']);
  const usage =
    asRec(root['usage']) ||
    asRec(meta && meta['usage']) ||
    asRec(update && update['usage']);
  const layers: Rec[] = [];
  // Most-specific first so a nested `usage` object wins over a wrapper
  // that only has stopReason / sessionId.
  for (const layer of [usage, meta, update, params, root]) {
    if (layer && !layers.includes(layer)) layers.push(layer);
  }
  return layers;
}

export function extractTokenMeta(payload: unknown): TokenMeta | null {
  const layers = collectLayers(payload);
  if (!layers.length) return null;

  const out: TokenMeta = {};
  for (const layer of layers) {
    if (out.inputTokens == null) {
      out.inputTokens = pickNum(layer, 'inputTokens', 'input_tokens');
    }
    if (out.outputTokens == null) {
      out.outputTokens = pickNum(layer, 'outputTokens', 'output_tokens');
    }
    if (out.cachedReadTokens == null) {
      out.cachedReadTokens = pickNum(layer, 'cachedReadTokens', 'cached_read_tokens', 'cachedTokens');
    }
    if (out.reasoningTokens == null) {
      out.reasoningTokens = pickNum(layer, 'reasoningTokens', 'reasoning_tokens');
    }
    if (out.totalTokens == null) {
      out.totalTokens = pickNum(layer, 'totalTokens', 'total_tokens');
    }
    if (out.costUsdTicks == null) {
      out.costUsdTicks = pickNum(layer, 'costUsdTicks', 'cost_usd_ticks', 'total_cost_usd_ticks');
    }
    if (out.costUSD == null) {
      out.costUSD = pickNum(layer, 'costUSD', 'costUsd', 'cost_usd', 'total_cost_usd');
    }
    if (out.modelId == null) {
      out.modelId = pickStr(layer, 'modelId', 'model_id', 'model') ?? null;
    }
    if (out.stopReason == null) {
      out.stopReason = pickStr(layer, 'stopReason', 'stop_reason') ?? null;
    }
  }

  if (!hasTurnLedger(out) && out.totalTokens == null && !out.modelId && !out.stopReason) {
    return null;
  }
  return out;
}

export function hasTokenUsage(meta: TokenMeta | null | undefined): boolean {
  if (!meta) return false;
  const vals = [
    meta.inputTokens, meta.input_tokens,
    meta.outputTokens, meta.output_tokens,
    meta.cachedReadTokens, meta.cached_read_tokens, meta.cachedTokens,
    meta.reasoningTokens, meta.reasoning_tokens,
  ];
  return vals.some((v) => typeof v === 'number' && Number.isFinite(v));
}

export function hasCost(meta: TokenMeta | null | undefined): boolean {
  if (!meta) return false;
  const ticks = meta.costUsdTicks ?? meta.cost_usd_ticks ?? meta.total_cost_usd_ticks;
  const usd = meta.costUSD ?? meta.costUsd ?? meta.cost_usd ?? meta.total_cost_usd;
  return (typeof ticks === 'number' && Number.isFinite(ticks))
    || (typeof usd === 'number' && Number.isFinite(usd));
}

/** True when the payload has anything worth painting on the turn footer. */
export function hasTurnLedger(meta: TokenMeta | null | undefined): boolean {
  return hasTokenUsage(meta) || hasCost(meta);
}

export function mergeTokenMeta(
  base: TokenMeta | null | undefined,
  extra: TokenMeta | null | undefined,
): TokenMeta {
  const out: TokenMeta = { ...(base || {}) };
  if (!extra) return out;
  for (const [k, v] of Object.entries(extra) as [keyof TokenMeta, TokenMeta[keyof TokenMeta]][]) {
    if (v != null) out[k] = v as never;
  }
  return out;
}

export function isTurnCompletedPayload(payload: unknown): boolean {
  const root = asRec(payload);
  if (!root) return false;
  const params = asRec(root['params']);
  const update = asRec(root['update']) || asRec(params && params['update']);
  const kind = update && update['sessionUpdate'];
  return kind === 'turn_completed';
}
