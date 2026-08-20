// Small fetch wrapper for the REST endpoints described in PROTOCOL.md.

export interface ApiError extends Error {
  status?: number;
  body?: unknown;
}

async function request(method: string, path: string, body?: unknown): Promise<unknown> {
  const opts: RequestInit = {
    method,
    headers: { accept: 'application/json' },
  };
  if (body !== undefined) {
    (opts.headers as Record<string, string>)['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(path, opts);
  const txt = await r.text();
  let data: unknown = null;
  if (txt) {
    try { data = JSON.parse(txt); }
    catch { data = txt; }
  }
  if (!r.ok) {
    const msg = (data && typeof data === 'object' && ('error' in data || 'message' in data))
      ? String((data as { error?: unknown; message?: unknown }).error
              ?? (data as { message?: unknown }).message)
      : `HTTP ${r.status}`;
    const err = new Error(msg) as ApiError;
    err.status = r.status;
    err.body = data;
    throw err;
  }
  return data;
}

export interface PromptInput {
  text?: string;
  attachments?: unknown[];
}

export interface HistoryOptions {
  turns?: number;
  all?: boolean;
}

export interface HistoryResult {
  events: unknown[];
  totalTurns: number;
  returnedTurns: number;
}

export const api = {
  hello:    (): Promise<unknown>   => request('GET',    '/api/hello'),

  listAgents:      (): Promise<unknown> => request('GET',    '/api/agents'),
  agentsStreamUrl: (): string => '/api/agents/stream',
  getAgent:     (id: string): Promise<unknown>          => request('GET',    `/api/agents/${encodeURIComponent(id)}`),
  createAgent:  (body?: Record<string, unknown>): Promise<unknown>  => request('POST',   '/api/agents', body || {}),
  deleteAgent:  (id: string, opts?: { deleteTuiSession?: boolean }): Promise<unknown> => {
    const q = opts?.deleteTuiSession ? '?deleteTuiSession=1' : '';
    return request('DELETE', `/api/agents/${encodeURIComponent(id)}${q}`);
  },
  updateAgent:  (id: string, patch?: Record<string, unknown>): Promise<unknown>   => request('PATCH',  `/api/agents/${encodeURIComponent(id)}`, patch || {}),
  switchModel:  (id: string, body?: { model?: string; reasoningEffort?: string }): Promise<unknown> =>
    request('POST', `/api/agents/${encodeURIComponent(id)}/model`, body || {}),
  disconnect:   (id: string): Promise<unknown>          => request('POST',   `/api/agents/${encodeURIComponent(id)}/disconnect`),
  connect:      (id: string): Promise<unknown>          => request('POST',   `/api/agents/${encodeURIComponent(id)}/connect`),
  prompt:       (id: string, textOrOpts: string | PromptInput): Promise<unknown> => {
    const body = (textOrOpts && typeof textOrOpts === 'object')
      ? {
          text: String(textOrOpts.text || ''),
          ...(Array.isArray(textOrOpts.attachments) && textOrOpts.attachments.length
            ? { attachments: textOrOpts.attachments }
            : {}),
        }
      : { text: String(textOrOpts || '') };
    return request('POST', `/api/agents/${encodeURIComponent(id)}/prompt`, body);
  },
  cancel:       (id: string): Promise<unknown> => request('POST',   `/api/agents/${encodeURIComponent(id)}/cancel`),
  history:      async (id: string, opts?: HistoryOptions): Promise<HistoryResult> => {
    const { turns, all } = opts || {};
    const qs = new URLSearchParams();
    if (all) qs.set('all', '1');
    if (typeof turns === 'number' && turns > 0) qs.set('turns', String(turns));
    const url = `/api/agents/${encodeURIComponent(id)}/history${qs.toString() ? `?${qs}` : ''}`;
    const r = await fetch(url, { headers: { accept: 'application/x-ndjson' } });
    if (!r.ok) {
      const err = new Error(`HTTP ${r.status}`) as ApiError;
      err.status = r.status;
      throw err;
    }
    const text = await r.text();
    const events: unknown[] = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { events.push(JSON.parse(trimmed)); } catch { /* skip malformed */ }
    }
    return {
      events,
      totalTurns:    parseInt(r.headers.get('X-Total-Turns')    || '0', 10) || 0,
      returnedTurns: parseInt(r.headers.get('X-Returned-Turns') || '0', 10) || 0,
    };
  },

  getSettings:  (): Promise<unknown> => request('GET',    '/api/settings'),
  patchSettings:(body: Record<string, unknown>): Promise<unknown> => request('PATCH', '/api/settings', body),

  skills: {
    list: (opts?: { includeArchived?: boolean; cwd?: string }): Promise<unknown> => {
      const qs = new URLSearchParams();
      if (opts && opts.includeArchived) qs.set('includeArchived', '1');
      if (opts && opts.cwd) qs.set('cwd', String(opts.cwd));
      const tail = qs.toString();
      return request('GET', `/api/system/skills${tail ? `?${tail}` : ''}`);
    },
  },

  systemModels: {
    get:      (): Promise<unknown>      => request('GET',  '/api/system/models'),
  },

  folders: {
    list:   (): Promise<unknown> => request('GET', '/api/folders'),
    create: (name: string): Promise<unknown> => request('POST', '/api/folders', { name }),
    update: (id: string, patch: { name?: string; agentIds?: string[] }): Promise<unknown> =>
      request('PATCH', `/api/folders/${encodeURIComponent(id)}`, patch || {}),
    remove: (id: string): Promise<unknown> => request('DELETE', `/api/folders/${encodeURIComponent(id)}`),
  },

  agents: {
    setFolder: (agentId: string, folderId: string | null): Promise<unknown> =>
      request('PUT', `/api/agents/${encodeURIComponent(agentId)}/folder`, { folderId }),
  },

  sessions: {
    list: (opts?: { q?: string; limit?: number; includeEmpty?: boolean }): Promise<unknown> => {
      const { q, limit, includeEmpty } = opts || {};
      const qs = new URLSearchParams();
      if (q && String(q).trim()) qs.set('q', String(q).trim());
      if (typeof limit === 'number' && limit > 0) qs.set('limit', String(limit));
      if (includeEmpty) qs.set('includeEmpty', '1');
      const tail = qs.toString();
      return request('GET', `/api/system/sessions${tail ? `?${tail}` : ''}`);
    },
  },
};
