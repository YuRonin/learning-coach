import { t as tr } from './i18n';
import { Modal } from 'obsidian';
import type LearningCoachPlugin from './main';
import type { Course } from './course';
import { examTypes, type Exam } from './exam';
import { defaultPolicy, questionLabels, questionTypes } from './question-policy';
import { policyEditor } from './question-policy-view';

export class ExamModal extends Modal {
  constructor(private coach: LearningCoachPlugin, private course: Course, private unit: Course['units'][number]) { super(coach.app); }
  onOpen(): void {
    this.modalEl.addClass('lc-settings-modal'); this.contentEl.addClass('lc-root', 'lc-course-form');
    this.contentEl.createEl('h2', { text: tr('m134') });
    this.contentEl.createEl('p', { text: tr('m135'), cls: 'lc-caption' });
    const points = this.unit.knowledge?.filter(p => p.confirmed && p.active) ?? [];
    const ids = new Set(points.map(p => p.id));
    for (const point of points) {
      const label = this.contentEl.createEl('label', { text: point.title, cls: 'lc-option lc-policy-option' });
      const check = label.createEl('input', { attr: { type: 'checkbox', 'aria-label': tr('m136', [point.title]) } });
      check.checked = true; check.addEventListener('change', () => { if (check.checked) ids.add(point.id); else ids.delete(point.id); preview.textContent = ''; });
    }
    const count = this.contentEl.createEl('label', { text: tr('m137'), cls: 'lc-label' }).createEl('input', { attr: { type: 'number', min: '1', max: '20', 'aria-label': tr('m137') } });
    count.value = String(Math.min(20, Math.max(3, points.length)));
    const read = policyEditor(this.contentEl, this.course.questionPolicy ?? defaultPolicy());
    const preview = this.contentEl.createDiv({ cls: 'lc-caption', attr: { role: 'status' } });
    const error = this.contentEl.createDiv({ cls: 'lc-error', attr: { role: 'alert' } });
    let confirmed = '';
    const state = () => JSON.stringify({ ids: [...ids], policy: read(), count: Number(count.value) });
    const show = this.contentEl.createEl('button', { text: tr('m138') });
    show.addEventListener('click', () => {
      try {
        if (!ids.size || Number(count.value) < ids.size) throw new Error(tr('m139'));
        const types = examTypes(read(), Number(count.value));
        preview.textContent = tr('m140', [ids.size, questionTypes.map(t => tr('m141', [questionLabels[t], types.filter(v => v === t).length])).join('，')]);
        confirmed = state(); error.textContent = '';
      } catch (e) { error.textContent = (e as Error).message; }
    });
    const start = this.contentEl.createEl('button', { text: tr('m142'), cls: 'mod-cta' });
    start.addEventListener('click', () => {
      try {
        if (state() !== confirmed) throw new Error(tr('m143'));
        start.disabled = true;
        void this.coach.createExam(this.course, this.unit, [...ids], read(), Number(count.value)).then(() => this.close()).catch(e => { error.textContent = (e as Error).message; start.disabled = false; });
      } catch (e) { error.textContent = (e as Error).message; }
    });
  }
  onClose(): void { this.contentEl.empty(); }
}

export function renderExamReport(parent: HTMLElement, coach: LearningCoachPlugin, exam: Exam): void {
  const card = parent.createDiv({ cls: 'lc-card' }); card.createEl('h3', { text: tr('m144', [exam.title]) });
  let correct = 0, checked = 0;
  const missing: string[] = [];
  for (const item of exam.items) {
    const session = coach.allSessions().find(s => s.id === item.sessionId);
    const attempt = session?.attempts.find(a => a.assessment);
    if (attempt && !attempt.question.invalidated) { checked++; if (attempt.assessment?.verdict === 'correct') correct++; }
    if (!attempt || attempt.question.invalidated || attempt.assessment?.verdict !== 'correct') missing.push(item.focus.title);
    const row = card.createEl('details', { cls: 'lc-disclosure' });
    row.createEl('summary', { text: `${item.focus.title} · ${attempt?.question.invalidated ? tr('m145') : attempt?.assessment ? ({ correct: tr('m146'), partial: tr('m068'), incorrect: tr('m147'), uncertain: tr('m070') }[attempt.assessment.verdict]) : tr('m148')}` });
    if (attempt) {
      row.createEl('p', { text: attempt.question.prompt }); row.createEl('p', { text: tr('m149', [attempt.answer]) });
      row.createEl('p', { text: attempt.assessment?.feedback ?? tr('m113') }); row.createEl('p', { text: tr('m150', [attempt.question.referenceQuote]) });
      if (attempt.revisions.length) row.createEl('p', { text: tr('m151', [attempt.revisions.length]), cls: 'lc-caption' });
      if (!attempt.question.invalidated && session) {
        const review = row.createEl('button', { text: session.pending?.action === 'dispute' ? tr('m152') : tr('m153') });
        review.disabled = coach.engine.busy;
        review.addEventListener('click', () => new ExamReviewModal(coach, exam.id, session.id, session.pending?.input).open());
      }
    }
  }
  card.createEl('p', { text: tr('m154', [checked, correct]) });
  card.createEl('p', { text: missing.length ? tr('m155', [[...new Set(missing)].join('、')]) : tr('m156'), cls: 'lc-caption' });
}

class ExamReviewModal extends Modal {
  constructor(private coach: LearningCoachPlugin, private examId: string, private sessionId: string, private pendingReason?: string) { super(coach.app); }
  onOpen(): void {
    this.modalEl.addClass('lc-settings-modal'); this.contentEl.addClass('lc-root');
    this.contentEl.createEl('h2', { text: tr('m157') });
    this.contentEl.createEl('p', { text: tr('m158'), cls: 'lc-caption' });
    const reason = this.contentEl.createEl('label', { text: tr('m159'), cls: 'lc-label' }).createEl('textarea', { attr: { rows: '5', maxlength: '6000', 'aria-label': tr('m160') } });
    reason.value = this.pendingReason ?? ''; reason.disabled = !!this.pendingReason;
    const error = this.contentEl.createDiv({ cls: 'lc-error', attr: { role: 'alert' } });
    const button = this.contentEl.createEl('button', { text: tr('m161'), cls: 'mod-cta' });
    button.addEventListener('click', () => {
      button.disabled = true;
      void this.coach.reviewExamAnswer(this.examId, this.sessionId, reason.value).then(() => this.close()).catch(e => { error.textContent = (e as Error).message; button.disabled = false; });
    });
    const pause = this.contentEl.createEl('button', { text: tr('m162') });
    pause.addEventListener('click', () => { void this.coach.safely(() => this.coach.engine.pause()); });
  }
  onClose(): void { this.contentEl.empty(); }
}
