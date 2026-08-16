// SSE helpers for the agent stream endpoint.

import type { ServerResponse } from 'node:http';

export interface SseEvent {
  id?: string | number | null;
  event?: string;
  data: unknown;
}

export interface SseRingEntry {
  id: string | number;
  [key: string]: unknown;
}

export function writeHeaders(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // Disable Nagle on the underlying socket so each event ships immediately
  // instead of waiting for the ~200ms TCP coalescing window. EventSource
  // chunks are tiny so the bandwidth cost is negligible.
  try { res.socket && res.socket.setNoDelay(true); } catch { /* ignore */ }
  // Push headers to the client right away so EventSource transitions out of
  // CONNECTING as soon as the route handler accepts the request.
  try { if (typeof res.flushHeaders === 'function') res.flushHeaders(); } catch { /* ignore */ }
  // 2s is enough to survive a Tailscale blip without a 5s dead gap, and
  // the chat UI waits slightly longer than this before showing a warning.
  res.write('retry: 2000\n\n');
}

export function writeEvent(res: ServerResponse, { id, event, data }: SseEvent): boolean {
  if (res.writableEnded || res.destroyed) return false;
  let chunk = '';
  if (id != null) chunk += `id: ${id}\n`;
  if (event) chunk += `event: ${event}\n`;
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  // Support multi-line data per the SSE spec.
  for (const line of payload.split('\n')) chunk += `data: ${line}\n`;
  chunk += '\n';
  // res.write() returns false on kernel-buffer backpressure, NOT on a dead
  // socket. The chunk is still queued. Callers must treat false as "accepted"
  // and only hang up when the response is already ended/destroyed (or write
  // throws). Closing on backpressure drops the EventSource mid-turn.
  try {
    res.write(chunk);
    return true;
  } catch {
    return false;
  }
}

export function writePing(res: ServerResponse): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(': ping\n\n');
}

export interface SseRing<T extends SseRingEntry> {
  push(item: T): void;
  since(lastId: string | number | null | undefined): T[];
  all(): T[];
  size(): number;
}

// Ring buffer to support Last-Event-ID replay.
export function createRing<T extends SseRingEntry>(limit = 200): SseRing<T> {
  const buf: T[] = [];
  return {
    push(item: T): void {
      buf.push(item);
      if (buf.length > limit) buf.splice(0, buf.length - limit);
    },
    since(lastId: string | number | null | undefined): T[] {
      if (lastId == null || lastId === '') return buf.slice();
      const idx = buf.findIndex((e) => String(e.id) === String(lastId));
      if (idx < 0) return buf.slice();
      return buf.slice(idx + 1);
    },
    all(): T[] { return buf.slice(); },
    size(): number { return buf.length; },
  };
}
