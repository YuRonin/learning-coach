import { t as tr } from './i18n';
import { z } from 'zod';
import type { Course } from './course';
import type { Session } from './domain';
import { knowledgeEvidence } from './knowledge';
import { localDate, reviewCards } from './review';

export const taskSchema = z.object({
  id: z.string(), courseId: z.string(), unitId: z.string(), knowledgeId: z.string(), title: z.string(),
  kind: z.enum(['review', 'repair', 'learn']), reason: z.string(), minutes: z.number().positive(),
  status: z.enum(['todo', 'started', 'done', 'deferred', 'skipped']), sessionId: z.string().optional(), reviewId: z.string().optional(),
});
export const planSchema = z.object({ id: z.string(), date: z.string(), timezone: z.string(), budget: z.number().int().min(5).max(240), tasks: z.array(taskSchema), createdAt: z.string() });
export type DailyPlan = z.infer<typeof planSchema>;
export type LearningTask = z.infer<typeof taskSchema>;

export function makePlan(courses: Course[], sessions: Session[], budget: number, previous: DailyPlan[] = [], date = localDate(), timezone = Intl.DateTimeFormat().resolvedOptions().timeZone, snoozes: Record<string, string> = {}): DailyPlan {
  if (!Number.isInteger(budget) || budget < 5 || budget > 240) throw new Error(tr('m299'));
  const reviews = reviewCards(sessions, snoozes);
  const candidates: LearningTask[] = [];
  const done = new Set(previous.flatMap(p => p.tasks.filter(t => t.status === 'started' || p.date === date && ['done', 'skipped', 'deferred'].includes(t.status)).map(t => `${t.courseId}:${t.knowledgeId}`)));
  for (const course of courses.filter(c => !c.archived).sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))) for (const unit of course.units.filter(u => !u.excluded)) {
    for (const point of unit.knowledge?.filter(p => p.active && p.confirmed) ?? []) {
      if (done.has(`${course.id}:${point.id}`)) continue;
      const reviewId = `knowledge:${course.id}:${point.id}:${point.revision}`;
      if (snoozes[reviewId] && snoozes[reviewId]! > date) continue;
      const state = knowledgeEvidence(course.id, unit.id, point, sessions);
      const review = reviews.find(r => r.focus?.id === point.id && r.courseId === course.id && r.focus.revision === point.revision && r.due <= date);
      const missingPrerequisite = point.prerequisites.some(id => {
        const prerequisite = unit.knowledge?.find(p => p.id === id && p.active && p.confirmed);
        return !prerequisite || knowledgeEvidence(course.id, unit.id, prerequisite, sessions).count === 0;
      });
      if (missingPrerequisite || (!review && state.priority >= 2)) continue;
      const kind = review ? 'review' : state.priority === 0 ? 'repair' : 'learn';
      const durations = sessions.filter(s => s.focus?.id === point.id && s.status === 'ended' && (s.activeSeconds ?? 0) > 30).map(s => s.activeSeconds! / 60).sort((a, b) => a - b);
      const minutes = Math.max(3, Math.min(20, Math.round(durations.length ? durations[Math.floor(durations.length / 2)]! : kind === 'learn' ? 8 : 5)));
      candidates.push({ id: crypto.randomUUID(), courseId: course.id, unitId: unit.id, knowledgeId: point.id, title: point.title, kind,
        reason: review ? tr('m300', [review.due]) : kind === 'repair' ? tr('m301') : tr('m302'), minutes, status: 'todo', reviewId: review?.id });
    }
  }
  const tasks: LearningTask[] = []; let remaining = budget;
  const courseRemaining = new Map(courses.map(c => [c.id, c.minutes]));
  // Reserve a place for new content when it fits, so a review backlog cannot starve learning forever.
  const newItem = candidates.find(t => t.kind === 'learn');
  const sorted = [...candidates.filter(t => t.kind === 'review'), ...candidates.filter(t => t.kind === 'repair'), ...candidates.filter(t => t.kind === 'learn')];
  if (newItem && budget >= newItem.minutes + 5 && (courseRemaining.get(newItem.courseId) ?? 0) >= newItem.minutes) { tasks.push(newItem); remaining -= newItem.minutes; courseRemaining.set(newItem.courseId, courseRemaining.get(newItem.courseId)! - newItem.minutes); }
  for (const task of sorted) {
    if (tasks.includes(task) || task.minutes > remaining || task.minutes > (courseRemaining.get(task.courseId) ?? 0) || tasks.length >= 12) continue;
    if (task.kind === 'review' && tasks.filter(t => t.kind === 'review').length >= 5) continue;
    tasks.push(task); remaining -= task.minutes; courseRemaining.set(task.courseId, courseRemaining.get(task.courseId)! - task.minutes);
  }
  tasks.sort((a, b) => ['review', 'repair', 'learn'].indexOf(a.kind) - ['review', 'repair', 'learn'].indexOf(b.kind));
  return { id: crypto.randomUUID(), date, timezone, budget, tasks, createdAt: new Date().toISOString() };
}

export function reconcilePlans(plans: DailyPlan[], session: Session): void {
  for (const plan of plans) for (const task of plan.tasks) {
    if (task.id !== session.taskId && task.sessionId !== session.id) continue;
    if (['skipped', 'deferred'].includes(task.status)) continue;
    task.sessionId = session.id;
    const count = session.attempts.filter(a => a.assessment && !a.question.invalidated).length;
    task.status = session.status === 'ended' && count >= session.targetQuestions ? 'done' : 'started';
  }
}
