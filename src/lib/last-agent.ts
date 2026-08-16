const KEY = 'grok-remote.last-agent-id';

export function saveLastAgent(id: string | null): void {
  try {
    if (id) localStorage.setItem(KEY, id);
    else localStorage.removeItem(KEY);
  } catch { /* ignore */ }
}

export function loadLastAgent(): string | null {
  try { return localStorage.getItem(KEY); } catch { return null; }
}
