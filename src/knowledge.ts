import { t as tr } from './i18n';
import { z } from 'zod';
import type { Session } from './domain';
import { unitEvidence } from './unit-evidence';

export const knowledgeSchema = z.object({
  id: z.string(), title: z.string().trim().min(1).max(200), quote: z.string().min(8).max(24000),
  revision: z.number().int().positive(), fingerprint: z.string(), confirmed: z.boolean(), active: z.boolean(),
  parents: z.array(z.string()).default([]), prerequisites: z.array(z.string()).default([]),
});
export type Knowledge = z.infer<typeof knowledgeSchema>;
export function validatePrerequisites(points: Knowledge[]): void {
  const active = new Map(points.filter(p => p.active).map(p => [p.id, p]));
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error(tr('m194'));
    if (visited.has(id)) return;
    const point = active.get(id);
    if (!point) throw new Error(tr('m195'));
    visiting.add(id); for (const parent of point.prerequisites) visit(parent); visiting.delete(id); visited.add(id);
  };
  for (const id of active.keys()) visit(id);
}
export const focusSchema = z.object({ id: z.string(), title: z.string(), revision: z.number().int().positive(), fingerprint: z.string() });
export type Focus = z.infer<typeof focusSchema>;

export function fingerprint(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return `${text.length}:${(hash >>> 0).toString(16)}`;
}

/** Local candidates only. Importing never calls a model or treats headings as an exam syllabus. */
export function proposeKnowledge(text: string, name: string): Knowledge[] {
  const lines = text.split('\n');
  const sections: { title: string; lines: string[] }[] = [];
  let current = { title: name, lines: [] as string[] };
  let fence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const heading = !fence && /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) { if (current.lines.join('\n').trim().length >= 8) sections.push(current); current = { title: heading[1]!, lines: [] }; }
    current.lines.push(line);
  }
  if (current.lines.join('\n').trim().length >= 8) sections.push(current);
  return sections.flatMap(section => {
    const body = section.lines.join('\n');
    const chunks: Knowledge[] = [];
    for (let offset = 0; offset < body.length; offset += 24000) {
      const quote = body.slice(offset, offset + 24000);
      if (quote.trim().length < 8) continue;
      chunks.push({ id: crypto.randomUUID(), title: `${section.title}${body.length > 24000 ? tr('m196', [chunks.length + 1]) : ''}`.slice(0, 200), quote,
        revision: 1, fingerprint: fingerprint(text), confirmed: false, active: true, parents: [], prerequisites: [] });
    }
    return chunks;
  });
}

export function knowledgeEvidence(courseId: string, unitId: string, point: Knowledge, sessions: Session[], changed = false) {
  if (!point.confirmed) return { label: tr('m197'), count: 0, priority: 4 };
  if (changed) return { label: tr('m198'), count: 0, priority: 0 };
  const matching = sessions.filter(s => s.focus?.id === point.id && s.focus.revision === point.revision && s.focus.fingerprint === point.fingerprint);
  return unitEvidence(courseId, unitId, matching);
}

export function replaceKnowledge(points: Knowledge[], selected: string[], replacements: { title: string; quote: string }[], text: string): Knowledge[] {
  if (!selected.length || selected.some(id => !points.some(p => p.id === id && p.active))) throw new Error(tr('m199'));
  const created = replacements.map(p => knowledgeSchema.parse({ ...p, id: crypto.randomUUID(), revision: 1, fingerprint: fingerprint(text), confirmed: true, active: true, parents: selected, prerequisites: [] }));
  if (!created.length || created.some(p => !text.includes(p.quote))) throw new Error(tr('m200'));
  return [...points.map(p => selected.includes(p.id) ? { ...p, active: false } : p), ...created];
}
