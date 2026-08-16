// Poll an updates.jsonl file and emit live ACP-shaped events for new lines.

import fs from 'node:fs';

import { liveEventFromUpdateRow, type HistoryEvent } from './tui-bridge.js';

export class UpdatesFileTail {
  private offset = 0;
  private leftover = '';
  private timer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  constructor(
    private readonly file: string,
    private readonly sessionId: string,
    private readonly onEvents: (events: HistoryEvent[]) => void,
    private readonly intervalMs = 800,
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    try { this.offset = fs.statSync(this.file).size; } catch { this.offset = 0; }
    this.leftover = '';
    this.timer = setInterval(() => {
      try { this.poll(); } catch { /* next tick */ }
    }, this.intervalMs);
  }

  stop(): void {
    this.started = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  poll(): HistoryEvent[] {
    let st: fs.Stats;
    try { st = fs.statSync(this.file); } catch { return []; }
    if (st.size < this.offset) {
      this.offset = 0;
      this.leftover = '';
    }
    if (st.size === this.offset) return [];
    const fd = fs.openSync(this.file, 'r');
    let buf: Buffer;
    try {
      const len = st.size - this.offset;
      buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, this.offset);
    } finally {
      fs.closeSync(fd);
    }
    this.offset = st.size;
    const chunk = this.leftover + buf.toString('utf8');
    const parts = chunk.split('\n');
    this.leftover = parts.pop() || '';
    const events: HistoryEvent[] = [];
    for (const line of parts) {
      const t = line.trim();
      if (!t) continue;
      let row: Record<string, unknown>;
      try { row = JSON.parse(t) as Record<string, unknown>; } catch { continue; }
      const ev = liveEventFromUpdateRow(row, this.sessionId);
      if (ev) events.push(ev);
    }
    if (events.length) this.onEvents(events);
    return events;
  }
}
