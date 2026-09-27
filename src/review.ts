import { t as tr } from './i18n';
import type { Question, Session } from './domain';
import type { Focus } from './knowledge';
import { normalizeEvidence } from './evidence';

export interface ReviewCard {
  id: string;
  source: Session['source'];
  question: Question;
  goal: string;
  due: string;
  streak: number;
  lastAt: string;
  reason: string;
  verdict: string;
  courseId?: string;
  unitId?: string;
  focus?: Focus;
}

export function localDate(value = new Date()): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}

export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  return localDate(new Date(year!, month! - 1, day! + days, 12));
}

/** Recomputed from original attempts, so retries and grading revisions cannot award extra repetitions. */
export function reviewCards(sessions: Session[], snoozes: Record<string, string> = {}): ReviewCard[] {
  const cards = new Map<string, ReviewCard>();
  const attempts = sessions.flatMap(session => session.attempts.map(attempt => ({ session, attempt })))
    .sort((a, b) => a.attempt.at.localeCompare(b.attempt.at));
  const seen = new Set<string>();
  for (const { session, attempt } of attempts) {
    if (!attempt.assessment || attempt.question.invalidated || seen.has(attempt.id)) continue;
    seen.add(attempt.id);
    const id = session.focus ? `knowledge:${session.courseId}:${session.focus.id}:${session.focus.revision}` : session.reviewOf ?? `${session.id}/${attempt.question.id}`;
    const existing = cards.get(id);
    const previous = existing?.source.text === session.source.text && existing.source.mtime === session.source.mtime ? existing : undefined;
    const independent = attempt.assessment.verdict === 'correct' && !attempt.question.hints && !attempt.question.revealed && !attempt.question.reused
      && attempt.confidence !== 'guessed' && attempt.confidence !== 'unsure';
    const sameDay = previous && (localDate(new Date(previous.lastAt)) === localDate(new Date(attempt.at)) || (session.focus && normalizeEvidence(previous.question.prompt) === normalizeEvidence(attempt.question.prompt)));
    const streak = independent ? (sameDay ? Math.max(1, previous.streak) : (previous?.streak ?? 0) + 1) : 0;
    const interval = independent ? [1, 3, 7, 14, 30][Math.min(streak - 1, 4)]! : 1;
    const reason = attempt.assessment.verdict === 'uncertain' ? tr('m340')
      : attempt.question.reused ? tr('m341')
      : independent ? tr('m342')
      : attempt.assessment.verdict === 'correct' ? tr('m343')
      : tr('m344');
    cards.set(id, { id, source: session.source, question: attempt.question, goal: session.goal,
      due: addDays(localDate(new Date(attempt.at)), interval), streak, lastAt: attempt.at, reason,
      verdict: attempt.assessment.verdict, courseId: session.courseId, unitId: session.unitId, focus: session.focus });
  }
  for (const card of cards.values()) {
    const snooze = snoozes[card.id];
    if (snooze && snooze > card.due && snooze > localDate(new Date(card.lastAt))) card.due = snooze;
  }
  return [...cards.values()].sort((a, b) => a.due.localeCompare(b.due) || a.lastAt.localeCompare(b.lastAt));
}
