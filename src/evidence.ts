import { t as tr } from './i18n';
import type { Question, Session } from './domain';

export function normalizeEvidence(text: string): string {
  return text.normalize('NFKC').replace(/[\s\p{P}]/gu, '').toLowerCase();
}

/** Exact saved content identifies legacy copies whose review IDs were regenerated. */
function sameQuestion(a: Question, b: Question): boolean {
  if ((a.originId ?? a.id) === (b.originId ?? b.id)) return true;
  return JSON.stringify([a.type ?? 'short', a.prompt, a.referenceQuote, a.rubric, a.expectedAnswer, a.options ?? [], a.correctOptions ?? []])
    === JSON.stringify([b.type ?? 'short', b.prompt, b.referenceQuote, b.rubric, b.expectedAnswer, b.options ?? [], b.correctOptions ?? []]);
}

/** Mutates only a transaction snapshot; original submissions and grades remain intact. */
export function setQuestionValidity(sessions: Session[], source: Session['source'], target: Question, reason: string | null, at: string): number {
  let affected = 0;
  for (const session of sessions) {
    if (session.source.path !== source.path || session.source.text !== source.text || session.source.mtime !== source.mtime) continue;
    const questions = [...session.attempts.map(a => a.question), ...(session.retiredQuestions ?? []), ...(session.question ? [session.question] : []), ...(session.reviewFallback ? [session.reviewFallback] : [])];
    const matches = questions.filter(q => sameQuestion(q, target));
    if (!matches.length) continue;
    if (session.pending && (session.question && matches.includes(session.question)
      || session.attempts.some(a => a.id === session.pending!.attemptId && matches.includes(a.question)))) {
      throw new Error(tr('m131'));
    }
    let changed = false;
    for (const question of matches) {
      if (reason !== null && !question.invalidated) { question.invalidated = { reason, at }; changed = true; }
      else if (reason === null && question.invalidated) { delete question.invalidated; changed = true; }
    }
    if (changed) {
      affected++;
      session.updatedAt = at;
      session.entries.push({ id: crypto.randomUUID(), role: 'system', at,
        text: reason === null ? tr('m132', [target.prompt]) : tr('m133', [target.prompt, reason]) });
    }
  }
  return affected;
}
