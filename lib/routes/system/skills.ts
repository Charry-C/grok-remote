// Skills routes.

import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { send } from '../helpers.js';
import type { RouteRegistrar } from '../system.js';

const HISTORY_DIR_NAME = '.history';
const USAGE_FILE       = path.join(os.homedir(), '.grok-remote', 'skill-usage.json');

type SkillScope = 'cwd' | 'repo' | 'user-grok' | 'user-claude';

interface SkillSource { scope: SkillScope; dir: string | null }

interface UsageEntry {
  count?: number;
  lastUsedAt?: string | null;
  lastAgentId?: string | null;
}

type UsageMap = Record<string, UsageEntry>;

interface SkillRecord {
  scope: SkillScope;
  name: string;
  dir: string;
  mdPath: string;
  title: string;
  description: string;
  shortDescription: string;
  otherFiles: string[];
  mtime: string | null;
  archived: boolean;
  usageCount: number;
  lastUsedAt: string | null;
}

interface ParsedFrontmatter {
  name?: string;
  description?: string;
  shortDescription?: string;
}

export function register(add: RouteRegistrar): void {
  add('GET',  '/api/system/skills', listHandler);
}

function hostCwd(req?: IncomingMessage): string {
  if (req) {
    try {
      const q = new URL(req.url || '/', 'http://x').searchParams.get('cwd');
      if (q && q.trim()) return q.trim();
    } catch { /* ignore */ }
  }
  return process.cwd();
}

function activeSources(baseCwd?: string): { scope: SkillScope; dir: string }[] {
  const cwd = (baseCwd && baseCwd.trim()) || process.cwd();
  const home = os.homedir();
  const repo = findRepoRoot(cwd);
  const sources: SkillSource[] = [
    { scope: 'cwd',         dir: path.join(cwd, '.grok', 'skills') },
    { scope: 'repo',        dir: repo ? path.join(repo, '.grok', 'skills') : null },
    { scope: 'user-grok',   dir: path.join(home, '.grok', 'skills') },
    { scope: 'user-claude', dir: path.join(home, '.claude', 'skills') },
  ];
  const present = sources.filter((s): s is { scope: SkillScope; dir: string } =>
    Boolean(s.dir) && safeIsDir(s.dir as string));
  return present.filter((s, i, arr) =>
    arr.findIndex((x) => path.resolve(x.dir) === path.resolve(s.dir)) === i);
}

function allScopes(baseCwd?: string): { scope: SkillScope; dir: string }[] {
  const cwd = (baseCwd && baseCwd.trim()) || process.cwd();
  const home = os.homedir();
  const repo = findRepoRoot(cwd);
  const sources: SkillSource[] = [
    { scope: 'cwd',         dir: path.join(cwd, '.grok', 'skills') },
    { scope: 'repo',        dir: repo ? path.join(repo, '.grok', 'skills') : null },
    { scope: 'user-grok',   dir: path.join(home, '.grok', 'skills') },
    { scope: 'user-claude', dir: path.join(home, '.claude', 'skills') },
  ];
  return sources.filter((s): s is { scope: SkillScope; dir: string } => Boolean(s.dir));
}

function scopeDir(scope: string): string | null {
  const s = allScopes().find((x) => x.scope === scope);
  return s ? s.dir : null;
}

function archiveDirForScope(scope: string): string | null {
  const dir = scopeDir(scope);
  if (!dir) return null;
  return dir + '.archive';
}

function listHandler(req: IncomingMessage, res: ServerResponse): void {
  const urlObj = new URL(req.url || '/', 'http://x');
  const includeArchived = urlObj.searchParams.get('includeArchived') === '1';
  const sources = activeSources(hostCwd(req));
  const usage = readUsageMap();

  const skills: SkillRecord[] = [];
  for (const { scope, dir } of sources) {
    for (const name of safeReaddir(dir)) {
      const skillDir = path.join(dir, name);
      try {
        if (!fs.statSync(skillDir).isDirectory()) continue;
      } catch { continue; }
      const mdPath = path.join(skillDir, 'SKILL.md');
      if (!safeIsFile(mdPath)) continue;
      skills.push(buildSkillRecord({
        scope, name, skillDir, mdPath, archived: false, usage,
      }));
    }
  }

  if (includeArchived) {
    for (const { scope } of allScopes()) {
      const adir = archiveDirForScope(scope);
      if (!adir || !safeIsDir(adir)) continue;
      for (const name of safeReaddir(adir)) {
        const skillDir = path.join(adir, name);
        try {
          if (!fs.statSync(skillDir).isDirectory()) continue;
        } catch { continue; }
        const mdPath = path.join(skillDir, 'SKILL.md');
        if (!safeIsFile(mdPath)) continue;
        skills.push(buildSkillRecord({
          scope, name, skillDir, mdPath, archived: true, usage,
        }));
      }
    }
  }

  send(res, 200, {
    ok: true,
    skills,
    sources: sources.map((s) => ({ scope: s.scope, dir: s.dir })),
  });
}

interface BuildSkillArgs {
  scope: SkillScope;
  name: string;
  skillDir: string;
  mdPath: string;
  archived: boolean;
  usage: UsageMap;
}

function buildSkillRecord({ scope, name, skillDir, mdPath, archived, usage }: BuildSkillArgs): SkillRecord {
  const parsed = parseSkillHeader(mdPath);
  const u: UsageEntry | null = (usage && usage[name]) || null;
  return {
    scope,
    name,
    dir: skillDir,
    mdPath,
    title:            parsed.name || name,
    description:      parsed.description || '',
    shortDescription: parsed.shortDescription || '',
    otherFiles: safeReaddir(skillDir).filter((f) => f !== 'SKILL.md' && f !== HISTORY_DIR_NAME),
    mtime: safeMtime(mdPath),
    archived: !!archived,
    usageCount: u ? (u.count || 0) : 0,
    lastUsedAt: u ? (u.lastUsedAt || null) : null,
  };
}

function readUsageMap(): UsageMap {
  try {
    const raw = fs.readFileSync(USAGE_FILE, 'utf8');
    const obj = JSON.parse(raw);
    return (obj && typeof obj === 'object') ? obj as UsageMap : {};
  } catch {
    return {};
  }
}

function findRepoRoot(start: string): string | null {
  let cur = path.resolve(start);
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(cur, '.git'))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

function safeIsDir(p: string): boolean { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

function safeIsFile(p: string): boolean { try { return fs.statSync(p).isFile(); } catch { return false; } }

function safeReaddir(p: string): string[] { try { return fs.readdirSync(p); } catch { return []; } }

function safeMtime(p: string): string | null { try { return fs.statSync(p).mtime.toISOString(); } catch { return null; } }

function parseSkillHeader(mdPath: string): ParsedFrontmatter {
  let text = '';
  try { text = fs.readFileSync(mdPath, 'utf8'); }
  catch { return {}; }
  if (!text.startsWith('---')) return {};
  const after = text.indexOf('\n', 3);
  if (after === -1) return {};
  const end = text.indexOf('\n---', after);
  if (end === -1) return {};
  const fm = text.slice(after + 1, end);
  return parseFrontmatterBlock(fm);
}

function parseFrontmatterBlock(fm: string): ParsedFrontmatter {
  const lines = fm.split('\n');
  const out: ParsedFrontmatter = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] || '';
    const m = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
    if (!m) { i++; continue; }
    const key = m[1] || '';
    let val = (m[2] || '').trim();

    if (key === 'metadata' && (val === '' || val === undefined)) {
      i++;
      while (i < lines.length && /^\s+/.test(lines[i] || '')) {
        const subm = (lines[i] || '').match(/^\s+([A-Za-z][\w-]*)\s*:\s*(.*)$/);
        if (subm) {
          const subKey = subm[1] || '';
          let subVal = (subm[2] || '').trim();
          subVal = unquote(subVal);
          if (subKey === 'short-description') out.shortDescription = subVal;
        }
        i++;
      }
      continue;
    }

    if (val === '>' || val === '|') {
      const collected: string[] = [];
      i++;
      while (i < lines.length && /^\s+/.test(lines[i] || '')) {
        collected.push((lines[i] || '').replace(/^\s+/, ''));
        i++;
      }
      val = val === '>' ? collected.join(' ') : collected.join('\n');
    } else {
      val = unquote(val);
      i++;
    }

    if (key === 'name') out.name = val;
    else if (key === 'description') out.description = val;
  }
  return out;
}

function unquote(s: string): string {
  if (!s) return s;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}
