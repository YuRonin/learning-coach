import { t as tr } from './i18n';
import { Modal, TFile } from 'obsidian';
import type LearningCoachPlugin from './main';
import type { Course } from './course';
import { knowledgeEvidence, replaceKnowledge, type Knowledge } from './knowledge';
import { splitMessages, parseSplits } from './material-analysis';

export function renderKnowledge(parent: HTMLElement, coach: LearningCoachPlugin, course: Course, unit: Course['units'][number]): void {
  const button = (label: string, action: () => unknown) => {
    const b = parent.createEl('button', { text: label }); b.disabled = coach.engine.busy;
    b.addEventListener('click', () => { void coach.safely(async () => { await action(); }); });
  };
  const points = unit.knowledge?.filter(p => p.active) ?? [];
  if (!points.length) button(tr('m164'), () => coach.prepareKnowledge(course.id, unit.id));
  else {
    button(tr('m165'), () => new KnowledgeModal(coach, course.id, unit.id).open());
    const details = parent.createEl('details', { cls: 'lc-disclosure' });
    details.createEl('summary', { text: tr('m166', [points.length]) });
    for (const point of points) {
      const row = details.createDiv({ cls: 'lc-course-unit' });
      const file = coach.app.vault.getAbstractFileByPath(unit.path);
      const changed = file instanceof TFile && unit.materialMtime !== undefined && file.stat.mtime !== unit.materialMtime;
      const state = knowledgeEvidence(course.id, unit.id, point, coach.evidenceSessions(), changed);
      row.createEl('p', { text: `${point.title} · ${state.label}` });
      row.createEl('p', { text: tr('m167', [state.count]), cls: 'lc-caption' });
      const learn = row.createEl('button', { text: tr('m168'), cls: 'mod-cta' });
      learn.disabled = !point.confirmed || changed || coach.engine.busy;
      learn.addEventListener('click', () => { void coach.safely(() => coach.learnKnowledge(course, unit, point)); });
      const source = row.createEl('button', { text: tr('m169') });
      source.addEventListener('click', () => { void coach.safely(() => coach.openKnowledgeSource(unit.path, point.quote)); });
    }
    button(tr('m170'), () => coach.prepareKnowledge(course.id, unit.id));
  }
}

class KnowledgeModal extends Modal {
  private analysis: AbortController | null = null;
  constructor(private coach: LearningCoachPlugin, private courseId: string, private unitId: string) { super(coach.app); }
  onOpen(): void {
    this.modalEl.addClass('lc-settings-modal'); this.contentEl.addClass('lc-root', 'lc-course-form');
    this.contentEl.createEl('h2', { text: tr('m165') });
    this.contentEl.createEl('p', { text: tr('m171'), cls: 'lc-caption' });
    const unit = this.coach.data.courses.find(c => c.id === this.courseId)!.units.find(u => u.id === this.unitId)!;
    let points = structuredClone(unit.knowledge ?? []);
    const selected = new Set<string>();
    const rows = this.contentEl.createDiv();
    const error = this.contentEl.createDiv({ attr: { role: 'alert' }, cls: 'lc-error' });
    const render = () => {
      rows.empty();
      for (const point of points.filter(p => p.active)) {
        const row = rows.createDiv({ cls: 'lc-card' });
        const label = row.createEl('label', { cls: 'lc-option lc-policy-option', text: tr('m172') });
        const select = label.createEl('input', { attr: { type: 'checkbox', 'aria-label': tr('m173', [point.title]) } });
        select.checked = selected.has(point.id);
        select.addEventListener('change', () => { if (select.checked) selected.add(point.id); else selected.delete(point.id); });
        const name = row.createEl('label', { text: tr('m174'), cls: 'lc-label' }).createEl('input', { value: point.title });
        name.addEventListener('input', () => { point.title = name.value; });
        const quote = row.createEl('label', { text: tr('m175'), cls: 'lc-label' }).createEl('textarea', { attr: { rows: '5' } });
        quote.value = point.quote;
        quote.addEventListener('input', () => { point.quote = quote.value; });
        const prereq = row.createEl('label', { text: tr('m176'), cls: 'lc-label' }).createEl('select');
        prereq.createEl('option', { value: '', text: tr('m177') });
        for (const other of points.filter(p => p.active && p.id !== point.id)) prereq.createEl('option', { value: other.id, text: other.title });
        prereq.value = point.prerequisites[0] ?? '';
        prereq.addEventListener('change', () => { point.prerequisites = prereq.value ? [prereq.value] : []; });
        const confirm = row.createEl('label', { cls: 'lc-option lc-policy-option', text: tr('m178') }).createEl('input', { attr: { type: 'checkbox', 'aria-label': tr('m179', [point.title]) } });
        confirm.checked = point.confirmed; confirm.addEventListener('change', () => { point.confirmed = confirm.checked; });
        const stop = row.createEl('button', { text: tr('m180') });
        stop.addEventListener('click', () => { point.active = false; selected.delete(point.id); render(); });
      }
    }; render();
    const replacements = this.contentEl.createEl('label', { text: tr('m181'), cls: 'lc-label' }).createEl('textarea', { attr: { rows: '4' } });
    const replace = this.contentEl.createEl('button', { text: tr('m182') });
    replace.addEventListener('click', () => {
      void this.coach.safely(async () => {
        try {
          const file = this.coach.app.vault.getAbstractFileByPath(unit.path);
          if (!(file instanceof TFile)) throw new Error(tr('m183'));
          const replacement = replacements.value.split('\n').filter(Boolean).map(line => { const i = line.search(/[|｜]/); if (i < 1) throw new Error(tr('m184')); return { title: line.slice(0, i), quote: line.slice(i + 1) }; });
          points = replaceKnowledge(points, [...selected], replacement, await this.coach.app.vault.read(file));
          selected.clear(); render(); error.textContent = tr('m185');
        } catch (e) { error.textContent = (e as Error).message; }
      });
    });
    const suggest = this.contentEl.createEl('button', { text: tr('m186') });
    const cancel = this.contentEl.createEl('button', { text: tr('m187') }); cancel.hidden = true;
    const status = this.contentEl.createDiv({ cls: 'lc-caption', attr: { role: 'status' } });
    status.textContent = tr('m188');
    cancel.addEventListener('click', () => this.analysis?.abort());
    suggest.addEventListener('click', () => {
      void this.coach.safely(async () => {
        if (this.analysis) return;
        const parent = points.find(p => selected.has(p.id) && p.active);
        if (selected.size !== 1 || !parent) { error.textContent = tr('m189'); return; }
        const originalQuote = parent.quote;
        const controller = new AbortController(); this.analysis = controller;
        suggest.disabled = true; save.disabled = true; replace.disabled = true; rows.inert = true; cancel.hidden = false;
        const trace = await this.coach.trace.begin('suggest-knowledge');
        try {
          await this.coach.flushSettings();
          const file = this.coach.app.vault.getAbstractFileByPath(unit.path);
          if (!(file instanceof TFile)) throw new Error(tr('m183'));
          const source = await this.coach.app.vault.read(file);
          if (!source.includes(originalQuote)) throw new Error(tr('m190'));
          const result = await this.coach.gateway.complete({ ...this.coach.data.settings }, splitMessages(originalQuote), controller.signal, trace);
          if (controller.signal.aborted) { await trace?.finish('cancelled'); return; }
          const proposed = parseSplits(result, originalQuote);
          await trace?.event({ kind: 'schema', status: 'passed' });
          await trace?.finish('success');
          points = replaceKnowledge(points, [parent.id], proposed, source).map(p => p.parents.includes(parent.id) && !unit.knowledge?.some(old => old.id === p.id) ? { ...p, confirmed: false } : p);
          selected.clear(); render(); error.textContent = '';
          status.textContent = tr('m191', [proposed.length]);
        } catch (e) { await trace?.event({ kind: 'schema', status: 'rejected', code: 'structure' }); await trace?.finish(controller.signal.aborted ? 'cancelled' : 'failure'); if (!controller.signal.aborted) error.textContent = e instanceof Error && e.name !== 'ZodError' ? e.message : tr('m192'); }
        finally { this.analysis = null; suggest.disabled = false; save.disabled = false; replace.disabled = false; rows.inert = false; cancel.hidden = true; }
      });
    });
    const save = this.contentEl.createEl('button', { text: tr('m193'), cls: 'mod-cta' });
    save.addEventListener('click', () => {
      const output = points.map(p => { const original = unit.knowledge?.find(old => old.id === p.id); return original && original.quote !== p.quote ? { ...p, revision: original.revision + 1 } : p; });
      save.disabled = true;
      void this.coach.saveKnowledge(this.courseId, this.unitId, output).then(() => this.close()).catch(e => { error.textContent = (e as Error).message; save.disabled = false; });
    });
  }
  onClose(): void { this.analysis?.abort(); this.contentEl.empty(); }
}
