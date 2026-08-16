// Dispatcher for leftover /api/system/* routes used by the chat remote.

import type { IncomingMessage, ServerResponse } from 'node:http';

import * as modelsRoutes   from './system/models.js';
import * as skillsRoutes   from './system/skills.js';

export type RouteParams = Record<string, string>;
export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  urlObj: URL,
  params?: RouteParams,
) => Promise<void> | void;

export type RouteRegistrar = (method: string, path: string, handler: RouteHandler) => void;

interface RouteModule {
  register?: (add: RouteRegistrar) => void;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

const ROUTES = new Map<string, RouteHandler>();
function add(method: string, path: string, handler: RouteHandler): void {
  ROUTES.set(`${method} ${path}`, handler);
}

const REGISTRARS: RouteModule[] = [
  modelsRoutes as RouteModule,
  skillsRoutes as RouteModule,
];
for (const mod of REGISTRARS) {
  if (mod && typeof mod.register === 'function') mod.register(add);
}

export async function handleSystem(req: IncomingMessage, res: ServerResponse, url: string): Promise<boolean> {
  const method = req.method || 'GET';
  const exact = ROUTES.get(`${method} ${url}`);
  if (exact) {
    try {
      const urlObj = new URL(req.url || '/', 'http://x');
      await exact(req, res, urlObj);
    } catch (err) {
      if (!res.headersSent) {
        const msg = err instanceof Error ? err.message : String(err);
        send(res, 500, { ok: false, error: msg });
      }
    }
    return true;
  }

  for (const [key, handler] of ROUTES) {
    const [m, pattern] = splitKey(key);
    if (m !== method) continue;
    const params = matchPattern(pattern, url);
    if (params) {
      try {
        const urlObj = new URL(req.url || '/', 'http://x');
        await handler(req, res, urlObj, params);
      } catch (err) {
        if (!res.headersSent) {
          const msg = err instanceof Error ? err.message : String(err);
          send(res, 500, { ok: false, error: msg });
        }
      }
      return true;
    }
  }
  send(res, 404, { ok: false, error: 'not found' });
  return false;
}

function splitKey(key: string): [string, string] {
  const i = key.indexOf(' ');
  return [key.slice(0, i), key.slice(i + 1)];
}

function matchPattern(pattern: string, url: string): RouteParams | null {
  const p = pattern.split('/').filter(Boolean);
  const u = url.split('/').filter(Boolean);
  if (p.length !== u.length) return null;
  const params: RouteParams = {};
  for (let i = 0; i < p.length; i++) {
    const part = p[i] || '';
    const got = u[i] || '';
    if (part.startsWith(':')) params[part.slice(1)] = decodeURIComponent(got);
    else if (part !== got) return null;
  }
  return params;
}
