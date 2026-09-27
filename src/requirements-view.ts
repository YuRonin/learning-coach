import { t as tr } from './i18n';
import { Modal } from 'obsidian';
import type LearningCoachPlugin from './main';
import type { Course } from './course';
import { mappingMessages, parseMappings } from './material-analysis';

export class RequirementModal extends Modal {
  private analysis: AbortController | null = null;
  constructor(private coach: LearningCoachPlugin, private course: Course) { super(coach.app); }
  onOpen(): void {
    this.modalEl.addClass('lc-settings-modal'); this.contentEl.addClass('lc-root', 'lc-course-form');
    this.contentEl.createEl('h2', { text: tr('m036') });
    this.contentEl.createEl('p', { text: tr('m322'), cls: 'lc-caption' });
    const label = this.contentEl.createEl('label', { text: tr('m323'), cls: 'lc-label' }).createEl('input');
    const kind = this.contentEl.createEl('label', { text: tr('m324'), cls: 'lc-label' }).createEl('select');
    for (const [value, text] of [['syllabus', tr('m325')], ['goal', tr('m326')], ['question', tr('m327')]]) kind.createEl('option', { value, text });
    const text = this.contentEl.createEl('label', { text: tr('m328'), cls: 'lc-label' }).createEl('textarea', { attr: { rows: '6' } }); text.maxLength = 24000;
    const selected = new Set<string>();
    const points = this.course.units.filter(u => !u.excluded).flatMap(u => u.knowledge?.filter(p => p.active && p.confirmed) ?? []);
    const checks = new Map<string, HTMLInputElement>();
    for (const unit of this.course.units.filter(u => !u.excluded)) for (const point of unit.knowledge?.filter(p => p.active && p.confirmed) ?? []) {
      const row = this.contentEl.createEl('label', { text: `${unit.title} · ${point.title}`, cls: 'lc-option lc-policy-option' });
      const check = row.createEl('input', { attr: { type: 'checkbox' } });
      checks.set(point.id, check);
      check.addEventListener('change', () => { if (check.checked) selected.add(point.id); else selected.delete(point.id); });
    }
    const error = this.contentEl.createDiv({ cls: 'lc-error', attr: { role: 'alert' } });
    const suggest = this.contentEl.createEl('button', { text: tr('m329') });
    const cancel = this.contentEl.createEl('button', { text: tr('m330') }); cancel.hidden = true;
    const preview = this.contentEl.createDiv({ cls: 'lc-caption', attr: { role: 'status' } });
    preview.textContent = tr('m331');
    cancel.addEventListener('click', () => this.analysis?.abort());
    suggest.addEventListener('click', () => {
      void this.coach.safely(async () => {
        if (this.analysis) return;
        const controller = new AbortController(); this.analysis = controller;
        suggest.disabled = true; save.disabled = true; text.disabled = true; cancel.hidden = false;
        for (const check of checks.values()) check.disabled = true;
        const trace = await this.coach.trace.begin('suggest-mapping');
        try {
          await this.coach.flushSettings();
          const result = await this.coach.gateway.complete({ ...this.coach.data.settings }, mappingMessages(text.value, points), controller.signal, trace);
          if (controller.signal.aborted) { await trace?.finish('cancelled'); return; }
          const matches = parseMappings(result, points);
          await trace?.event({ kind: 'schema', status: 'passed' });
          await trace?.finish('success');
          selected.clear(); for (const check of checks.values()) check.checked = false;
          preview.empty(); preview.createEl('p', { text: matches.length ? tr('m332') : tr('m333') });
          for (const match of matches) {
            selected.add(match.id); checks.get(match.id)!.checked = true;
            preview.createEl('p', { text: `${points.find(p => p.id === match.id)!.title}：${match.reason}` });
          }
          error.textContent = '';
        } catch (e) { await trace?.event({ kind: 'schema', status: 'rejected', code: 'structure' }); await trace?.finish(controller.signal.aborted ? 'cancelled' : 'failure'); if (!controller.signal.aborted) error.textContent = e instanceof Error && e.name !== 'ZodError' ? e.message : tr('m334'); }
        finally { this.analysis = null; suggest.disabled = false; save.disabled = false; text.disabled = false; cancel.hidden = true; for (const check of checks.values()) check.disabled = false; }
      });
    });
    const save = this.contentEl.createEl('button', { text: tr('m335'), cls: 'mod-cta' });
    save.addEventListener('click', () => {
      if (!label.value.trim() || text.value.trim().length < 8 || !selected.size) { error.textContent = tr('m336'); return; }
      save.disabled = true;
      void this.coach.saveRequirement(this.course.id, { id: crypto.randomUUID(), label: label.value.trim(), kind: kind.value as 'syllabus' | 'goal' | 'question', text: text.value, knowledgeIds: [...selected], confirmedAt: new Date().toISOString() })
        .then(() => this.close()).catch(e => { error.textContent = (e as Error).message; save.disabled = false; });
    });
  }
  onClose(): void { this.analysis?.abort(); this.contentEl.empty(); }
}

export class ClearCourseModal extends Modal {
  constructor(private coach: LearningCoachPlugin, private course: Course) { super(coach.app); }
  onOpen(): void {
    this.contentEl.addClass('lc-root'); this.contentEl.createEl('h2', { text: tr('m337') });
    this.contentEl.createEl('p', { text: tr('m338', [this.course.name]) });
    const button = this.contentEl.createEl('button', { text: tr('m339') });
    button.addEventListener('click', () => { button.disabled = true; void this.coach.safely(async () => { try { await this.coach.clearCourseRecords(this.course.id); this.close(); } finally { button.disabled = false; } }); });
  }
  onClose(): void { this.contentEl.empty(); }
}
