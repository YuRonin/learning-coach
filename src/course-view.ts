import { markdownInFolder } from './vault-files';
import { t as tr } from './i18n';
import { Modal, TFile } from 'obsidian';
import type LearningCoachPlugin from './main';
import { unitEvidence, type Course } from './course';
import { policyEditor } from './question-policy-view';
import { defaultPolicy, questionLabels } from './question-policy';
import { renderKnowledge } from './knowledge-view';
import { ExamModal, renderExamReport } from './exam-view';
import { RequirementModal, ClearCourseModal } from './requirements-view';
import { knowledgeEvidence } from './knowledge';

export class CourseModal extends Modal {
  constructor(private coach: LearningCoachPlugin, private course?: Course) { super(coach.app); }
  onOpen(): void {
    this.modalEl.addClass('lc-settings-modal');
    this.contentEl.addClass('lc-root', 'lc-course-form');
    this.contentEl.createEl('h2', { text: this.course ? tr('m014') : tr('m015') });
    const field = (label: string, value: string, type = 'text') => {
      const row = this.contentEl.createEl('label', { cls: 'lc-label', text: label });
      return row.createEl('input', { attr: { type, value, 'aria-label': label } });
    };
    const name = field(tr('m016'), this.course?.name ?? '');
    name.maxLength = 100;
    const folder = field(tr('m017'), this.course?.folder ?? '');
    folder.placeholder = tr('m018');
    const excluded = new Set(this.course?.units.filter(u => u.excluded).map(u => u.path) ?? []);
    const preview = this.contentEl.createEl('details', { cls: 'lc-disclosure' });
    preview.createEl('summary', { text: tr('m019') });
    const previewList = preview.createDiv();
    const refreshPreview = () => {
      previewList.empty();
      const prefix = folder.value.trim().replace(/^\/+|\/+$/g, '');
      const files = markdownInFolder(this.coach.app.vault, prefix).filter(f => f.stat.size > 0 && (!prefix || f.path.startsWith(`${prefix}/`)) && !f.path.startsWith(`${this.coach.data.settings.outputFolder}/`));
      previewList.createEl('p', { text: tr('m020', [files.length]), cls: 'lc-caption' });
      for (const file of files) {
        const label = previewList.createEl('label', { cls: 'lc-option lc-policy-option', text: file.path });
        const check = label.createEl('input', { attr: { type: 'checkbox', 'aria-label': tr('m021', [file.path]) } });
        check.checked = !excluded.has(file.path);
        check.addEventListener('change', () => { if (check.checked) excluded.delete(file.path); else excluded.add(file.path); });
      }
    };
    folder.addEventListener('change', refreshPreview); refreshPreview();
    const date = field(tr('m022'), this.course?.examDate ?? '', 'date');
    const minutes = field(tr('m023'), String(this.course?.minutes ?? 25), 'number');
    minutes.min = '5'; minutes.max = '240';
    const priority = field(tr('m024'), String(this.course?.priority ?? 0), 'number');
    priority.min = '0'; priority.max = '2';
    const policy = policyEditor(this.contentEl, this.course?.questionPolicy ?? defaultPolicy());
    this.contentEl.createEl('p', { text: tr('m025'), cls: 'lc-caption' });
    const error = this.contentEl.createDiv({ cls: 'lc-error', attr: { role: 'alert' } });
    const save = this.contentEl.createEl('button', { text: tr('m026'), cls: 'mod-cta' });
    save.addEventListener('click', () => {
      if (!name.value.trim()) { error.textContent = tr('m027'); return; }
      if (!Number.isInteger(Number(minutes.value)) || Number(minutes.value) < 5 || Number(minutes.value) > 240) {
        error.textContent = tr('m028'); return;
      }
      let questionPolicy;
      try { questionPolicy = policy(); } catch (e) { error.textContent = (e as Error).message; return; }
      save.disabled = true;
      void this.coach.saveCourse({ id: this.course?.id, name: name.value, folder: folder.value, examDate: date.value, minutes: Number(minutes.value), priority: Number(priority.value), questionPolicy, excludedPaths: [...excluded] })
        .then(() => this.close()).catch(e => { error.textContent = e instanceof Error ? e.message : tr('m029'); save.disabled = false; });
    });
  }
  onClose(): void { this.contentEl.empty(); }
}

export function renderCourses(parent: HTMLElement, coach: LearningCoachPlugin): void {
  const button = (el: HTMLElement, label: string, action: () => unknown, primary = false) => {
    const b = el.createEl('button', { text: label, cls: primary ? 'mod-cta' : '' });
    b.disabled = coach.engine.busy;
    b.addEventListener('click', () => { void coach.safely(async () => { await action(); }); });
  };
  const intro = parent.createDiv({ cls: 'lc-card' });
  intro.createEl('h3', { text: tr('m030') });
  intro.createEl('p', { text: tr('m031'), cls: 'lc-muted' });
  button(intro, tr('m015'), () => new CourseModal(coach).open(), true);
  for (const course of coach.data.courses) {
    const card = parent.createDiv({ cls: 'lc-card' });
    card.createEl('h3', { text: course.name });
    button(card, course.archived ? tr('m032') : tr('m033'), () => coach.archiveCourse(course.id, !course.archived));
    if (course.archived) { card.createEl('p', { text: tr('m034'), cls: 'lc-caption' }); button(card, tr('m035'), () => new ClearCourseModal(coach, course).open()); continue; }
    button(card, tr('m036'), () => new RequirementModal(coach, course).open());
    if (!course.requirements?.length) card.createEl('p', { text: tr('m037'), cls: 'lc-caption' });
    for (const requirement of course.requirements ?? []) {
      const details = card.createEl('details', { cls: 'lc-disclosure' }); details.createEl('summary', { text: tr('m038', [requirement.label, requirement.knowledgeIds.length]) }); details.createEl('p', { text: requirement.text, cls: 'lc-plain' });
    }
    const policy = course.questionPolicy ?? defaultPolicy();
    card.createEl('p', { text: `${policy.enabled.map(t => questionLabels[t] + (policy.mode === 'fixed' ? ` ${policy.weights[t]}%` : '')).join('、')} · ${policy.mode === 'fixed' ? tr('m039') : tr('m040')}`, cls: 'lc-caption' });
    card.createEl('p', { text: tr('m041', [course.minutes, course.examDate ? tr('m042', [course.examDate]) : '', course.units.length]), cls: 'lc-caption' });
    const sessions = coach.evidenceSessions();
    const units = course.units.filter(unit => !unit.excluded).map(unit => {
      const file = coach.app.vault.getAbstractFileByPath(unit.path);
      const points = unit.knowledge?.filter(p => p.active) ?? [];
      const states = points.map(p => knowledgeEvidence(course.id, unit.id, p, sessions, file instanceof TFile && unit.materialMtime !== undefined && file.stat.mtime !== unit.materialMtime));
      return { unit, available: file instanceof TFile && file.stat.size > 0,
        evidence: points.length ? { label: tr('m043', [states.filter(s => s.label === tr('m044')).length, points.length]), count: states.reduce((n, s) => n + s.count, 0), priority: Math.min(...states.map(s => s.priority)) } : unitEvidence(course.id, unit.id, sessions, file instanceof TFile ? file.stat.mtime : undefined) };
    });
    const next = units.filter(item => item.available).sort((a, b) => a.evidence.priority - b.evidence.priority)[0];
    if (next) {
      card.createEl('p', { text: tr('m045', [next.unit.title, next.evidence.label]) });
      button(card, tr('m046'), () => coach.learnUnit(course, next.unit), true);
    }
    else card.createEl('p', { text: tr('m047'), cls: 'lc-caption' });
    button(card, tr('m048'), () => new CourseModal(coach, course).open());
    const list = card.createEl('details', { cls: 'lc-disclosure' });
    list.createEl('summary', { text: tr('m049') });
    for (const { unit, evidence, available } of units) {
      const row = list.createDiv({ cls: 'lc-course-unit' });
      row.createEl('p', { text: `${unit.title} · ${evidence.label}`, cls: 'lc-plain' });
      row.createEl('p', { text: tr('m050', [unit.path, evidence.count]), cls: 'lc-caption' });
      if (unit.topics?.length) row.createEl('p', { text: tr('m051', [unit.topics.join('、')]), cls: 'lc-caption' });
      if (available) button(row, tr('m052'), () => coach.learnUnit(course, unit));
      if (available) button(row, tr('m053'), () => new SessionPolicyModal(coach, course, unit).open());
      if (available) renderKnowledge(row, coach, course, unit);
      else button(row, tr('m054'), () => coach.relinkUnit(course.id, unit.id));
      if (!available) row.createEl('p', { text: tr('m055'), cls: 'lc-caption' });
      if (unit.knowledge?.some(p => p.active && p.confirmed)) button(row, tr('m056'), () => new ExamModal(coach, course, unit).open());
    }
    for (const exam of coach.data.exams.filter(e => e.courseId === course.id)) {
      if (exam.status === 'active') button(card, tr('m057', [exam.title]), () => coach.continueExam(exam.id));
      else { const details = card.createEl('details'); details.createEl('summary', { text: tr('m058', [exam.title]) }); renderExamReport(details, coach, exam); }
    }
    card.createEl('p', { text: tr('m059'), cls: 'lc-caption' });
  }
}

class SessionPolicyModal extends Modal {
  constructor(private coach: LearningCoachPlugin, private course: Course, private unit: Course['units'][number]) { super(coach.app); }
  onOpen(): void {
    this.modalEl.addClass('lc-settings-modal');
    this.contentEl.addClass('lc-root', 'lc-course-form');
    this.contentEl.createEl('h2', { text: tr('m053') });
    this.contentEl.createEl('p', { text: tr('m060'), cls: 'lc-caption' });
    const read = policyEditor(this.contentEl, this.course.questionPolicy ?? defaultPolicy());
    const error = this.contentEl.createDiv({ cls: 'lc-error', attr: { role: 'alert' } });
    const start = this.contentEl.createEl('button', { text: tr('m061'), cls: 'mod-cta' });
    start.addEventListener('click', () => {
      try {
        const questionPolicy = read();
        start.disabled = true;
        void this.coach.learnUnit({ ...this.course, questionPolicy }, this.unit).then(() => this.close())
          .catch(e => { error.textContent = (e as Error).message; start.disabled = false; });
      } catch (e) { error.textContent = (e as Error).message; }
    });
  }
  onClose(): void { this.contentEl.empty(); }
}
