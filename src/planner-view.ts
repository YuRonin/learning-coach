import { t as tr } from './i18n';
import type LearningCoachPlugin from './main';
import { localDate } from './review';

export function renderPlan(parent: HTMLElement, coach: LearningCoachPlugin): void {
  const card = parent.createDiv({ cls: 'lc-card' });
  card.createEl('h3', { text: tr('m278') });
  const input = card.createEl('label', { text: tr('m279'), cls: 'lc-label' }).createEl('input', { attr: { type: 'number', min: '5', max: '240', 'aria-label': tr('m279') } });
  const latest = coach.data.plans.filter(p => p.date === localDate()).at(-1);
  input.value = String(latest?.budget ?? 25);
  const button = (el: HTMLElement, text: string, action: () => unknown, primary = false) => {
    const b = el.createEl('button', { text, cls: primary ? 'mod-cta' : '' }); b.disabled = coach.engine.busy;
    b.addEventListener('click', () => { void coach.safely(async () => { await action(); }); });
  };
  button(card, tr('m280'), () => coach.planToday(Number(input.value)), true);
  button(card, tr('m281'), () => coach.planToday(10));
  card.createEl('p', { text: tr('m282'), cls: 'lc-caption' });
  if (latest) card.createEl('p', { text: tr('m283', [latest.date, latest.timezone, latest.tasks.reduce((n, t) => n + t.minutes, 0), latest.budget]), cls: 'lc-caption' });
  const tasks = [...coach.data.plans.flatMap(p => p.id === latest?.id ? p.tasks : p.tasks.filter(t => t.status === 'started'))];
  if (latest && !tasks.length) card.createEl('p', { text: tr('m284') });
  for (const task of tasks) {
    const course = coach.data.courses.find(c => c.id === task.courseId);
    if (!course || course.archived) continue;
    const row = card.createDiv({ cls: 'lc-course-unit' });
    const status = { todo: tr('m285'), started: tr('m286'), done: tr('m287'), deferred: tr('m288'), skipped: tr('m289') }[task.status];
    row.createEl('h4', { text: `${task.title} · ${status}` });
    row.createEl('p', { text: tr('m290', [course.name, task.minutes, task.reason]), cls: 'lc-caption' });
    if (task.status === 'todo' || task.status === 'started') {
      button(row, task.status === 'started' ? tr('m291') : tr('m292'), () => coach.startTask(task));
      button(row, tr('m293'), () => coach.changeTask(task.id, 'deferred'));
      button(row, tr('m294'), () => coach.changeTask(task.id, 'skipped'));
    }
    if (task.sessionId) {
      const session = coach.allSessions().find(s => s.id === task.sessionId);
      if (session) row.createEl('p', { text: tr('m295', [session.attempts.filter(a => a.assessment && !a.question.invalidated).length, Math.round((session.activeSeconds ?? 0) / 60)]), cls: 'lc-caption' });
    }
  }
  for (const course of coach.data.courses.filter(c => !c.archived && c.examDate)) {
    const remaining = Math.ceil((new Date(`${course.examDate}T12:00:00`).getTime() - Date.now()) / 86400000);
    const points = course.units.filter(u => !u.excluded).flatMap(u => u.knowledge?.filter(p => p.active && p.confirmed) ?? []);
    const uncovered = points.filter(p => !coach.evidenceSessions().some(s => s.courseId === course.id && s.focus?.id === p.id && s.focus.revision === p.revision && s.focus.fingerprint === p.fingerprint && s.attempts.some(a => a.assessment && !a.question.invalidated))).length;
    if (remaining <= 30) card.createEl('p', { text: tr('m296', [course.name, remaining >= 0 ? tr('m297', [remaining]) : tr('m298'), uncovered]), cls: 'lc-caption' });
  }
}
