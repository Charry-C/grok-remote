// Pure helpers for chat turn replay / dedup. Kept out of ChatView so
// node:test can cover the leave-and-reenter empty-YOU cases without a DOM.

export interface UserTurnLike {
  userText?: string;
  user?: unknown;
  assistant?: unknown;
  tools?: unknown[];
}

export function isReplayPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const rec = payload as {
    _meta?: { isReplay?: unknown };
    data?: { _meta?: { isReplay?: unknown } };
    params?: { _meta?: { isReplay?: unknown } };
    update?: { _meta?: { isReplay?: unknown } };
  };
  if (rec._meta && rec._meta.isReplay === true) return true;
  if (rec.data && rec.data._meta && rec.data._meta.isReplay === true) return true;
  // session/load replays `_x.ai/session/update` with isReplay on params._meta,
  // not the top-level envelope the rest of the stream uses.
  if (rec.params && rec.params._meta && rec.params._meta.isReplay === true) return true;
  if (rec.update && rec.update._meta && rec.update._meta.isReplay === true) return true;
  return false;
}

export function eventTimeMs(eventOrPayload: unknown): number | null {
  if (!eventOrPayload || typeof eventOrPayload !== 'object') return null;
  const rec = eventOrPayload as {
    _t?: unknown;
    at?: unknown;
    data?: { _t?: unknown };
  };
  if (typeof rec._t === 'number' && Number.isFinite(rec._t)) return rec._t;
  if (rec.data && typeof rec.data._t === 'number' && Number.isFinite(rec.data._t)) return rec.data._t;
  if (typeof rec.at === 'string') {
    const t = Date.parse(rec.at);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

export function isStaleLiveEvent(payload: unknown, watermark: number | null | undefined): boolean {
  if (watermark == null || !Number.isFinite(watermark) || watermark <= 0) return false;
  const t = eventTimeMs(payload);
  if (t == null) return false;
  return t <= watermark;
}

export function isNonTextUserContent(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const content = (payload as { content?: unknown }).content;
  if (!content || typeof content !== 'object') return false;
  const type = (content as { type?: unknown }).type;
  return typeof type === 'string' && type !== 'text';
}

export function normalizeUserText(text: unknown): string {
  return String(text || '').replace(/\s+$/g, '').trim();
}

export function userTextsMatch(a: unknown, b: unknown): boolean {
  const na = normalizeUserText(a);
  const nb = normalizeUserText(b);
  if (!na && !nb) return true;
  if (na === nb) return true;
  if (!na || !nb) return false;
  const longer = na.length >= nb.length ? na : nb;
  const shorter = na.length >= nb.length ? nb : na;
  return longer.startsWith(shorter) && longer.includes('Attached files:');
}

export function shouldRenderUserBubble(text: unknown, attachments?: unknown[]): boolean {
  if (Array.isArray(attachments) && attachments.length > 0) return true;
  return !!normalizeUserText(text);
}

export function hasMatchingUserTurn(turns: UserTurnLike[], text: unknown): boolean {
  const want = normalizeUserText(text);
  if (!want) return false;
  return turns.some((t) => userTextsMatch(t && t.userText, want));
}
