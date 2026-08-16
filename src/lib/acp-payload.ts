// Pure helpers for un-narrowing ACP payloads received over SSE / history.
// Extracted from src/views/chat.ts so they can be unit-tested without DOM.

interface UnknownRecord {
  [key: string]: unknown;
}

interface MaybeUpdateWrapper {
  update?: unknown;
}

/**
 * Some history endpoints wrap the ACP `update` object inside an envelope:
 * `{ update: { ... } }`. SSE events arrive already unwrapped by the server.
 * Returns the inner update when present, otherwise the payload itself (or
 * an empty object so callers can safely property-access the result).
 */
export function unwrap(payload: unknown): UnknownRecord {
  if (payload && typeof payload === 'object') {
    const maybe = payload as MaybeUpdateWrapper;
    if (maybe.update && typeof maybe.update === 'object') {
      return maybe.update as UnknownRecord;
    }
    return payload as UnknownRecord;
  }
  return {};
}

/**
 * Best-effort text extractor for ACP content blocks. Handles three shapes:
 *   - plain strings
 *   - `{ content: 'text' }`
 *   - `{ content: { text: 'text' } }`
 *   - `{ text: 'text' }`
 * Returns null when no string can be found, so callers can branch on it.
 */
export function extractText(payload: unknown): string | null {
  if (!payload) return null;
  if (typeof payload === 'string') return payload;
  if (typeof payload !== 'object') return null;
  const p = payload as {
    content?: unknown;
    text?: unknown;
  };
  if (p.content) {
    if (typeof p.content === 'string') return p.content;
    if (typeof p.content === 'object' && p.content !== null) {
      const inner = (p.content as { text?: unknown }).text;
      if (typeof inner === 'string') return inner;
    }
  }
  if (typeof p.text === 'string') return p.text;
  return null;
}

/**
 * Text for an error banner, or null when the payload is empty noise
 * (native EventSource reconnects, `{}`, missing message).
 */
export function errorBannerText(data: unknown): string | null {
  if (data == null) return null;
  if (typeof data === 'string') {
    const trimmed = data.trim();
    if (!trimmed || trimmed === '{}' || trimmed === '[]') return null;
    return trimmed;
  }
  if (typeof data !== 'object' || Array.isArray(data)) return null;
  const rec = data as UnknownRecord;
  const inner = rec.message ?? rec.error;
  if (typeof inner === 'string') {
    const trimmed = inner.trim();
    return trimmed || null;
  }
  return null;
}
