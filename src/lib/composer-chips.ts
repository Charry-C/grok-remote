// Pure helpers for the Grok-style composer (suggestion chips + send state).

export interface ComposerChipCommand {
  name?: unknown;
  description?: unknown;
  kind?: unknown;
}

export interface ComposerChip {
  name: string;
  description: string;
  kind: string;
}

export function pickComposerChips(
  commands: ComposerChipCommand[] | null | undefined,
  limit = 6,
): ComposerChip[] {
  const out: ComposerChip[] = [];
  const seen = new Set<string>();
  for (const c of commands || []) {
    if (!c || typeof c.name !== 'string' || !c.name) continue;
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    out.push({
      name: c.name,
      description: typeof c.description === 'string' ? c.description : '',
      kind: typeof c.kind === 'string' ? c.kind : '',
    });
    if (out.length >= limit) break;
  }
  return out;
}

export function composerCanSend(text: unknown, attachmentCount: unknown): boolean {
  const n = typeof attachmentCount === 'number' && Number.isFinite(attachmentCount)
    ? attachmentCount
    : 0;
  return !!(String(text || '').trim() || n > 0);
}

export function insertComposerCommand(current: string, name: string): string {
  const prefix = `/${name} `;
  const v = String(current || '');
  if (!v.trim() || /^\/[\w-]*$/.test(v)) return prefix;
  if (v.startsWith(prefix) || v === `/${name}`) return v;
  return prefix + v.replace(/^\s+/, '');
}
