import { t as tr } from './i18n';
import type { Session } from './domain';
import { normalizeEvidence } from './evidence';

export function unitEvidence(courseId: string, unitId: string, sessions: Session[], sourceMtime?: number) {
  const related = sessions.filter(s => s.courseId === courseId && s.unitId === unitId);
  const records = related.flatMap(s => s.attempts.filter(a => a.assessment && !a.question.invalidated).map(attempt => ({ attempt, source: s.source })))
    .filter((r, i, all) => all.findIndex(b => b.attempt.id === r.attempt.id) === i)
    .sort((a, b) => a.attempt.at.localeCompare(b.attempt.at));
  const latest = records.at(-1);
  // Evidence from a different saved text or file revision cannot raise this version's state.
  const attempts = records.filter(r => r.source.mtime === latest?.source.mtime && r.source.text === latest?.source.text)
    .map(r => r.attempt);
  const last = attempts.at(-1);
  if (!last) return { label: tr('m497'), count: 0, priority: 1 };
  if (sourceMtime !== undefined && !related.some(s => s.source.mtime === sourceMtime && s.attempts.some(a => a.id === last.id))) {
    return { label: tr('m498'), count: attempts.length, priority: 0 };
  }
  if (last.assessment?.verdict === 'uncertain') return { label: tr('m499'), count: attempts.length, priority: 0 };
  const independent = (a: typeof last) => a.assessment?.verdict === 'correct' && !a.question.hints && !a.question.revealed && !a.question.reused
    && a.confidence !== 'guessed' && a.confidence !== 'unsure';
  if (!independent(last)) return { label: tr('m147'), count: attempts.length, priority: 0 };
  const lastGap = attempts.findLastIndex(a => !independent(a));
  const previous = attempts.slice(lastGap + 1, -1).find(a => independent(a)
    && new Date(last.at).getTime() - new Date(a.at).getTime() >= 86_400_000
    && normalizeEvidence(a.question.prompt) !== normalizeEvidence(last.question.prompt));
  return { label: previous ? tr('m044') : tr('m500'), count: attempts.length, priority: previous ? 3 : 2 };
}
