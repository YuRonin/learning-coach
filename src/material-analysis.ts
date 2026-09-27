import { t as tr } from './i18n';
import { z } from 'zod';
import type { ChatMessage } from './api';
import { extractJson } from './domain';

const candidateSchema = z.object({ points: z.array(z.object({ title: z.string().trim().min(1).max(200), quote: z.string().min(8).max(24000) })).min(1).max(12) });
const mappingSchema = z.object({ matches: z.array(z.object({ id: z.string(), reason: z.string().min(1).max(500) })).max(100) });
export type MappingPoint = { id: string; title: string; quote: string };

export function splitMessages(text: string): ChatMessage[] {
  if (text.length < 8 || text.length > 24000) throw new Error(tr('m269'));
  return [{ role: 'system', content: tr('m270') },
    { role: 'user', content: JSON.stringify({ action: 'suggest-knowledge', source: text }) }];
}
export function parseSplits(raw: string, text: string) {
  const result = candidateSchema.parse(extractJson(raw)).points;
  if (result.some(p => !text.includes(p.quote)) || new Set(result.map(p => p.quote)).size !== result.length) throw new Error(tr('m271'));
  return result;
}
export function mappingMessages(text: string, points: MappingPoint[]): ChatMessage[] {
  if (text.length < 8 || text.length > 24000 || !points.length || points.length > 100) throw new Error(tr('m272'));
  return [{ role: 'system', content: tr('m273') },
    { role: 'user', content: JSON.stringify({ action: 'suggest-mapping', source: text, points: points.map(p => ({ id: p.id, title: p.title, quote: p.quote.slice(0, 300) })) }) }];
}
export function parseMappings(raw: string, points: MappingPoint[]) {
  const result = mappingSchema.parse(extractJson(raw)).matches;
  if (result.some(p => !points.some(point => point.id === p.id)) || new Set(result.map(p => p.id)).size !== result.length) throw new Error(tr('m274'));
  return result;
}
