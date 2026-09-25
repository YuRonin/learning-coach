import type { Question, Session } from './domain';

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
    if (!attempt.assessment || seen.has(attempt.id)) continue;
    seen.add(attempt.id);
    const id = session.reviewOf ?? `${session.id}/${attempt.question.id}`;
    const previous = cards.get(id);
    const independent = attempt.assessment.verdict === 'correct' && !attempt.question.hints && !attempt.question.revealed;
    const streak = independent ? (previous?.streak ?? 0) + 1 : 0;
    const interval = independent ? [1, 3, 7, 14, 30][Math.min(streak - 1, 4)]! : 1;
    const reason = attempt.assessment.verdict === 'uncertain' ? '上次评价待核实，需要再次检查。'
      : independent ? '上次未请求提示且回答符合要点，隔一段时间再检验。'
      : attempt.assessment.verdict === 'correct' ? '上次使用过提示或讲解，这次尝试独立回答。'
      : '上次回答仍有缺口，建议优先巩固。';
    cards.set(id, { id, source: session.source, question: attempt.question, goal: session.goal,
      due: addDays(localDate(new Date(attempt.at)), interval), streak, lastAt: attempt.at, reason,
      verdict: attempt.assessment.verdict });
  }
  for (const card of cards.values()) {
    const snooze = snoozes[card.id];
    if (snooze && snooze > card.due && snooze > localDate(new Date(card.lastAt))) card.due = snooze;
  }
  return [...cards.values()].sort((a, b) => a.due.localeCompare(b.due) || a.lastAt.localeCompare(b.lastAt));
}
