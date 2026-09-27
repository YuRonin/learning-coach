import { t as tr } from './i18n';
import { z } from 'zod';
import { normalizeEvidence } from './evidence';
import type { Question, Reply, Session } from './domain';
import type { ChatMessage } from './api';

export function nearDuplicate(a: string, b: string): boolean {
  const left = normalizeEvidence(a), right = normalizeEvidence(b);
  if (left === right) return true;
  if (Math.min(left.length, right.length) < 12) return false;
  const grams = (s: string) => new Set(Array.from({ length: s.length - 1 }, (_, i) => s.slice(i, i + 2)));
  const x = grams(left), y = grams(right);
  return [...x].filter(g => y.has(g)).length / new Set([...x, ...y]).size >= 0.9;
}

export function validateQuality(question: NonNullable<Reply['question']>, previous: Question[]): void {
  if (previous.some(p => nearDuplicate(p.prompt, question.prompt))) throw new Error(tr('m306'));
  if (/(?:correct answer(?: is)?|answer is|正确答案|答案是|应选|选择答案)\s*[:：]?\s*[A-F](?:[、，,\s]*[A-F])*/i.test(question.prompt)) throw new Error(tr('m307'));
}

export const qualityResultSchema = z.object({ verdict: z.enum(['supported', 'uncertain', 'invalid']), reason: z.string().min(1).max(1000) });
export function qualityMessages(question: NonNullable<Reply['question']>, session: Session): ChatMessage[] {
  return [
    { role: 'system', content: tr('m308') },
    { role: 'user', content: JSON.stringify({ action: 'quality-check', source: session.source.text, question }) },
  ];
}
