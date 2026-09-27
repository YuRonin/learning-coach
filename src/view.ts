import { t as tr, getLanguage } from './i18n';
import { Component, ItemView, MarkdownRenderer, Modal, TFile, type WorkspaceLeaf } from 'obsidian';
import type LearningCoachPlugin from './main';
import { draftContext, summarizeSession, VERDICT_LABELS, QUESTION_LABELS, type Session } from './domain';
import { renderCourses } from './course-view';
import { CoachSettingsTab } from './settings';
import { localDate } from './review';
import { questionLabels } from './question-policy';
import { renderPlan } from './planner-view';
import { renderExamReport } from './exam-view';

export const VIEW_TYPE = 'learning-coach-view';

class QuestionReportModal extends Modal {
  constructor(private coach: LearningCoachPlugin, private sessionId: string, private questionId: string) { super(coach.app); }
  onOpen(): void {
    this.modalEl.addClass('lc-settings-modal');
    this.contentEl.addClass('lc-root', 'lc-course-form');
    this.contentEl.createEl('h2', { text: tr('m501') });
    this.contentEl.createEl('p', { text: tr('m502'), cls: 'lc-caption' });
    const label = this.contentEl.createEl('label', { text: tr('m503'), cls: 'lc-label' });
    const input = label.createEl('textarea', { attr: { 'aria-label': tr('m503'), maxlength: '1000', placeholder: tr('m504') } });
    const error = this.contentEl.createDiv({ cls: 'lc-error', attr: { role: 'alert' } });
    const submit = this.contentEl.createEl('button', { text: tr('m505'), cls: 'mod-cta' });
    submit.addEventListener('click', () => {
      submit.disabled = true;
      void this.coach.changeQuestionValidity(this.sessionId, this.questionId, input.value).then(() => this.close())
        .catch(e => { error.textContent = e instanceof Error ? e.message : tr('m506'); submit.disabled = false; });
    });
  }
  onClose(): void { this.contentEl.empty(); }
}

class SettingsModal extends Modal {
  constructor(private readonly coach: LearningCoachPlugin) { super(coach.app); }
  onOpen(): void {
    this.modalEl.addClass('lc-settings-modal');
    const tab = new CoachSettingsTab(this.app, this.coach);
    tab.containerEl = this.contentEl;
    tab.renderInto(this.contentEl);
  }
  onClose(): void { this.contentEl.empty(); }
}

export class CoachView extends ItemView {
  private unsubscribe: (() => void) | null = null;
  private renderComponent: Component | null = null;
  private draft = '';
  private draftKey = '';
  private draftTimer: number | undefined;
  private draftWindow?: Window;
  private goal = '';
  private tab: 'courses' | 'today' | 'learn' | 'history' = 'today';
  private renderedTab = 'today';
  private scrollPositions: Record<string, number> = {};
  private historyLimit = 30;

  constructor(leaf: WorkspaceLeaf, private readonly coach: LearningCoachPlugin) { super(leaf); }
  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return tr('m062'); }
  getIcon(): string { return 'graduation-cap'; }

  showTab(tab: 'courses' | 'today' | 'learn' | 'history'): void { this.tab = tab; this.render(); }

  async onOpen(): Promise<void> {
    this.unsubscribe = this.coach.subscribe(() => this.render());
    this.registerDomEvent(this.contentEl.ownerDocument, 'visibilitychange', () => {
      if (this.contentEl.ownerDocument.visibilityState === 'hidden') {
        void this.coach.safely(() => this.flushDraft());
      }
    });
    this.render();
  }

  async onClose(): Promise<void> {
    this.unsubscribe?.();
    this.draftWindow?.clearTimeout(this.draftTimer);
    await this.flushDraft();
    if (this.renderComponent) this.removeChild(this.renderComponent);
  }

  private button(parent: HTMLElement, label: string, action: () => Promise<unknown> | void, primary = false, disabled = false): HTMLButtonElement {
    const button = parent.createEl('button', { text: label, cls: primary ? 'mod-cta' : '' });
    button.disabled = disabled;
    button.addEventListener('click', () => { void this.coach.safely(async () => { await action(); }); });
    return button;
  }

  private markdown(parent: HTMLElement, text: string, source = ''): void {
    // Do not auto-fetch remote images suggested by the model. Text and normal links remain readable.
    const clean = text.replace(/</g, '&lt;').replace(/!\[/g, '[');
    const el = parent.createDiv({ cls: 'lc-prose' });
    if (this.renderComponent) void MarkdownRenderer.render(this.app, clean, el, source, this.renderComponent);
  }

  private async flushDraft(): Promise<void> {
    this.draftWindow?.clearTimeout(this.draftTimer);
    if (this.coach.engine.current && this.draftKey === draftContext(this.coach.engine.current)) {
      await this.coach.engine.saveDraft(this.draft, this.draftKey);
    }
  }

  render(): void {
    this.contentEl.lang = getLanguage();
    const { contentEl } = this;
    this.scrollPositions[this.renderedTab] = contentEl.querySelector('.lc-body')?.scrollTop ?? 0;
    const oldScroll = this.scrollPositions[this.tab] ?? 0;
    this.renderedTab = this.tab;
    const activeElement = contentEl.doc.activeElement;
    const focused = contentEl.contains(activeElement) && activeElement?.tagName === 'TEXTAREA' ? activeElement as HTMLTextAreaElement : null;
    const inputRole = focused?.dataset.lcInput;
    const cursor = focused ? [focused.selectionStart, focused.selectionEnd] : null;
    const openDetails = new Set(Array.from(contentEl.querySelectorAll('details[open] summary')).map(el => el.textContent));
    if (this.renderComponent) this.removeChild(this.renderComponent);
    this.renderComponent = this.addChild(new Component());
    contentEl.empty();
    contentEl.addClass('lc-root');
    const header = contentEl.createDiv({ cls: 'lc-header' });
    const heading = header.createDiv();
    heading.createEl('h2', { text: tr('m062') });
    heading.createEl('p', { text: tr('m507'), cls: 'lc-tagline' });
    this.button(header, tr('m508'), () => { new SettingsModal(this.coach).open(); });
    const nav = contentEl.createEl('nav', { cls: 'lc-nav', attr: { 'aria-label': tr('m509') } });
    for (const [key, label] of [['courses', tr('m510')], ['today', tr('m511')], ['learn', tr('m512')], ['history', tr('m123')]] as const) {
      const button = this.button(nav, label, async () => {
        await this.flushDraft(); this.showTab(key);
        this.contentEl.querySelector<HTMLButtonElement>(`[data-page="${key}"]`)?.focus({ preventScroll: true });
      });
      button.dataset.page = key;
      if (this.tab === key) { button.addClass('is-active'); button.setAttribute('aria-current', 'page'); }
    }
    const body = contentEl.createDiv({ cls: 'lc-body', attr: { role: 'region', 'aria-label': this.tab === 'courses' ? tr('m513') : this.tab === 'today' ? tr('m514') : this.tab === 'learn' ? tr('m512') : tr('m515') } });
    if (this.tab === 'courses') renderCourses(body, this.coach);
    else if (this.tab === 'today') this.renderToday(body);
    else if (this.tab === 'history') this.renderHistory(body);
    else {
      const session = this.coach.engine.current;
      if (session) this.renderSession(body, session);
      if (!session || session.status === 'ended') this.renderStart(body);
    }
    body.scrollTop = oldScroll;
    for (const detail of Array.from(contentEl.querySelectorAll('details'))) {
      if (openDetails.has(detail.querySelector('summary')?.textContent ?? '')) detail.open = true;
    }
    if (inputRole && cursor) {
      const replacement = contentEl.querySelector<HTMLTextAreaElement>(`textarea[data-lc-input="${inputRole}"]`);
      if (replacement && !replacement.disabled) { replacement.focus({ preventScroll: true }); replacement.setSelectionRange(cursor[0]!, cursor[1]!); }
    }
  }

  private renderToday(body: HTMLElement): void {
    const session = this.coach.engine.current;
    if (!this.coach.data.settings.model.trim()) {
      const setup = body.createDiv({ cls: 'lc-card lc-welcome' });
      setup.createEl('h3', { text: tr('m516') });
      setup.createEl('p', { text: tr('m517'), cls: 'lc-muted' });
      this.button(setup, tr('m518'), () => { new SettingsModal(this.coach).open(); }, true);
      setup.createEl('p', { text: tr('m519'), cls: 'lc-caption' });
      return;
    }
    if (session && session.status !== 'ended') {
      const card = body.createDiv({ cls: 'lc-card' });
      card.createDiv({ text: tr('m520'), cls: 'lc-eyebrow' });
      card.createEl('h3', { text: session.source.name });
      card.createEl('p', { text: session.goal, cls: 'lc-muted' });
      this.button(card, tr('m521'), () => this.showTab('learn'), true);
    }
    renderPlan(body, this.coach);
    const cards = this.coach.getReviews();
    const due = cards.filter(card => card.due <= localDate());
    const summary = body.createDiv({ cls: 'lc-card' });
    summary.createDiv({ text: tr('m522'), cls: 'lc-eyebrow' });
    summary.createEl('h3', { text: due.length ? tr('m523', [due.length]) : tr('m524') });
    this.button(summary, this.coach.data.courses.length ? tr('m525') : tr('m526'), () => this.showTab('courses'));
    summary.createEl('p', { text: due.length ? tr('m527') : cards.length ? tr('m528', [cards[0]!.due]) : tr('m529'), cls: 'lc-muted' });
    this.button(summary, tr('m210'), () => this.coach.chooseNote(this.goal), !(session && session.status !== 'ended') && !due.length, this.coach.engine.busy);
    const list = due.length ? due : cards.slice(0, 3);
    for (const [index, card] of list.slice(0, 10).entries()) {
      const item = body.createDiv({ cls: 'lc-card lc-review-card' });
      item.createDiv({ text: `${card.source.name} · ${card.due}`, cls: 'lc-eyebrow' });
      item.createEl('p', { text: card.question.prompt, cls: 'lc-review-question' });
      item.createEl('p', { text: card.reason, cls: 'lc-caption' });
      const actions = item.createDiv({ cls: 'lc-actions' });
      this.button(actions, card.due <= localDate() ? tr('m530') : tr('m531'), () => this.coach.review(card), index === 0 && !(session && session.status !== 'ended'), this.coach.engine.busy);
      if (card.due <= localDate()) this.button(actions, tr('m532'), () => this.coach.snoozeReview(card.id));
    }
    if (due.length > 10) body.createEl('p', { text: tr('m533'), cls: 'lc-caption' });
  }

  private renderStart(body: HTMLElement): void {
    const card = body.createDiv({ cls: 'lc-card lc-welcome' });
    card.createEl('div', { text: tr('m534'), cls: 'lc-eyebrow' });
    card.createEl('h3', { text: tr('m535') });
    card.createEl('p', { text: tr('m536'), cls: 'lc-muted' });
    let fileName = tr('m537');
    try { fileName = this.coach.currentNote().path; } catch { /* Empty vault is a normal initial state. */ }
    card.createDiv({ text: fileName, cls: 'lc-source-pill' });
    const label = card.createEl('label', { text: tr('m538'), cls: 'lc-label' });
    const input = label.createEl('textarea', { attr: { placeholder: tr('m539'), rows: '3', 'aria-label': tr('m540') } });
    input.dataset.lcInput = 'goal';
    input.maxLength = 1000;
    input.value = this.goal;
    input.addEventListener('blur', () => { void this.coach.safely(() => this.flushDraft()); });
    input.addEventListener('input', () => { this.goal = input.value.slice(0, 1000); });
    const actions = card.createDiv({ cls: 'lc-actions' });
    this.button(actions, tr('m541'), async () => {
      const file = this.coach.currentNote();
      await this.coach.startFile(file, this.goal);
    }, true, this.coach.engine.busy);
    this.button(actions, tr('m542'), () => this.coach.chooseNote(this.goal), false, this.coach.engine.busy);
    card.createEl('p', { text: tr('m543', [this.coach.data.settings.questionsPerSession, this.coach.data.settings.learningMode === 'guided' ? tr('m436') : tr('m437')]), cls: 'lc-caption' });
    card.createEl('p', { text: tr('m544'), cls: 'lc-caption' });
  }

  private renderSession(body: HTMLElement, session: Session): void {
    const engine = this.coach.engine;
    const exam = this.coach.data.exams.find(e => e.id === session.examId);
    const examActive = exam?.status === 'active';
    const key = draftContext(session);
    if (this.draftKey !== key) { this.draftKey = key; this.draft = session.draft; }
    if (session.pending && ['answer', 'dispute', 'ask'].includes(session.pending.action)) this.draft = session.draft;
    const summary = body.createDiv({ cls: 'lc-session-summary' });
    const status = engine.busy ? tr('m545') : session.status === 'paused' ? tr('m546') : session.status === 'ended' ? tr('m547') : session.pending ? tr('m548') : session.question ? tr('m549') : tr('m550');
    summary.createDiv({ text: status, cls: `lc-status${engine.busy ? ' is-working' : ''}`, attr: { role: 'status', 'aria-live': 'polite' } });
    this.button(summary, tr('m551', [session.source.name, session.source.selection ? tr('m552') : '']), async () => {
      await this.app.workspace.openLinkText(session.source.path, '', true);
    });
    summary.createEl('p', { text: session.goal, cls: 'lc-goal' });
    if (session.focus) summary.createEl('p', { text: tr('m553', [session.focus.title, session.focus.revision]), cls: 'lc-caption' });
    if (session.focus && session.status !== 'ended' && !examActive) {
      const mode = summary.createEl('label', { text: tr('m554'), cls: 'lc-label' }).createEl('select', { attr: { 'aria-label': tr('m554') } });
      mode.createEl('option', { value: 'guided', text: tr('m436') }); mode.createEl('option', { value: 'diagnostic', text: tr('m437') });
      mode.value = session.mode; mode.disabled = engine.busy || !!session.pending;
      mode.addEventListener('change', () => { void this.coach.safely(() => engine.setMode(mode.value as Session['mode'])); });
    }
    else if (!session.focus && session.courseId) summary.createEl('p', { text: tr('m555'), cls: 'lc-caption' });
    if (examActive) summary.createEl('p', { text: tr('m556', [(session.examIndex ?? 0) + 1, exam.items.length]), cls: 'lc-caption' });
    const graded = session.attempts.filter(a => a.assessment && !a.question.invalidated).length;
    summary.createEl('p', { text: tr('m557', [session.reviewOf ? tr('m558') : tr('m559'), graded, session.targetQuestions]), cls: 'lc-caption' });
    if (session.allocation) summary.createEl('p', { text: tr('m560', [session.allocation.policy.enabled.map(t => questionLabels[t]).join('、'), session.allocation.policy.mode === 'fixed' ? tr('m039') : tr('m040')]), cls: 'lc-caption' });
    const progress = summary.createEl('progress', { cls: 'lc-progress', attr: { 'aria-label': tr('m561'), max: String(session.targetQuestions), value: String(Math.min(session.targetQuestions, graded)) } });
    progress.setAttribute('aria-valuetext', tr('m562', [graded, session.targetQuestions]));
    const file = this.app.vault.getAbstractFileByPath(session.source.path);
    if (file instanceof TFile && file.stat.mtime !== session.source.mtime) {
      summary.createEl('p', { text: tr('m563'), cls: 'lc-caption' });
    } else if (!file) summary.createEl('p', { text: tr('m564'), cls: 'lc-caption' });
    if (session.outline.length && !examActive) {
      const outline = body.createEl('details', { cls: 'lc-outline' });
      outline.createEl('summary', { text: tr('m565', [session.outline.length]) });
      const list = outline.createEl('ol');
      for (const item of session.outline) list.createEl('li', { text: item });
    }
    // Keep the latest teaching message near the task; disclose older interactions on demand.
    const recent = session.entries.slice(-12);
    const latestCoach = [...recent].reverse().find(entry => entry.role === 'coach');
    if (latestCoach && session.status !== 'ended' && session.question && !examActive) {
      const bubble = body.createDiv({ cls: 'lc-bubble lc-coach' });
      bubble.createDiv({ text: tr('m566'), cls: 'lc-speaker' });
      this.markdown(bubble, latestCoach.text, session.source.path);
    }
    const timeline = body.createEl('details', { cls: 'lc-timeline lc-disclosure' });
    timeline.createEl('summary', { text: tr('m567', [session.entries.length]) });
    for (const entry of recent) {
      const bubble = timeline.createDiv({ cls: `lc-bubble lc-${entry.role}` });
      bubble.createDiv({ text: entry.role === 'coach' ? tr('m062') : entry.role === 'user' ? tr('m568') : tr('m515'), cls: 'lc-speaker' });
      if (entry.role === 'coach') this.markdown(bubble, entry.text, session.source.path);
      else bubble.createDiv({ text: entry.text, cls: 'lc-plain' });
    }
    if (session.entries.length > 12) timeline.createEl('p', { text: tr('m569'), cls: 'lc-caption' });
    if (session.error) body.createDiv({ text: session.error, cls: 'lc-error', attr: { role: 'alert' } });
    if (session.error && session.reviewFallback && !engine.busy && session.allocation?.policy.enabled.includes(session.reviewFallback.type ?? 'short')) {
      this.button(body, tr('m570'), () => engine.useReviewFallback());
    }
    if (session.question?.reused) body.createEl('p', { text: tr('m571'), cls: 'lc-caption' });

    if (session.status === 'ended') {
      if (exam?.status === 'finished') renderExamReport(body, this.coach, exam);
      const done = body.createDiv({ cls: 'lc-card lc-complete' });
      done.createEl('h3', { text: tr('m572') });
      const list = done.createEl('ul');
      for (const line of summarizeSession(session)) list.createEl('li', { text: line });
      this.button(done, tr('m573'), () => this.showTab('today'), true);
    } else if (session.status === 'paused') {
      const card = body.createDiv({ cls: 'lc-card' });
      card.createEl('p', { text: tr('m574') });
      this.button(card, tr('m575'), () => engine.resume(), true, engine.busy);
    } else if (session.status === 'ready' && session.pending && !engine.busy) {
      const card = body.createDiv({ cls: 'lc-card' });
      card.createEl('p', { text: tr('m576') });
      this.button(card, tr('m577'), () => engine.retry(), true);
    } else if (session.status === 'ready' && !session.pending) {
      if (session.question) this.renderQuestion(body, session);
      else if (session.attempts.at(-1)?.assessment) this.renderFeedback(body, session);
      else this.button(body, tr('m578'), () => engine.perform('start'), true, engine.busy);
    }
    if (!examActive) body.appendChild(timeline); else timeline.remove();
    const footer = body.createDiv({ cls: 'lc-footer' });
    if (session.status !== 'ended') {
      if (session.status !== 'paused') this.button(footer, engine.busy ? tr('m579') : tr('m474'), async () => { await this.flushDraft(); await engine.pause(); });
      this.button(footer, examActive ? tr('m580') : tr('m581'), async () => { await this.flushDraft(); await this.coach.finishSession(); }, false, engine.busy);
    }
    if (!examActive) this.button(footer, tr('m582'), async () => { await this.flushDraft(); await this.coach.exportRecord(); }, false, engine.busy);
    footer.createEl('p', { text: tr('m583', [session.attempts.length, session.calls, this.coach.data.settings.maxCalls]), cls: 'lc-caption' });
    if (session.cacheHits) footer.createEl('p', { text: tr('m584', [session.cacheHits]), cls: 'lc-caption' });
    if (engine.busy) footer.createEl('p', { text: tr('m585'), cls: 'lc-caption', attr: { role: 'status', 'aria-live': 'polite' } });
  }

  private input(parent: HTMLElement, placeholder: string, labelText = tr('m589')): HTMLTextAreaElement {
    const label = parent.createEl('label', { cls: 'lc-answer-label' });
    label.createSpan({ text: labelText, cls: 'lc-label' });
    const input = label.createEl('textarea', { cls: 'lc-answer', attr: { placeholder, rows: '5', 'aria-label': placeholder, maxlength: '6000' } });
    input.value = this.draft;
    input.dataset.lcInput = 'answer';
    input.disabled = this.coach.engine.busy;
    input.addEventListener('blur', () => { void this.coach.safely(() => this.flushDraft()); });
    input.addEventListener('input', () => {
      this.draft = input.value;
      this.draftWindow?.clearTimeout(this.draftTimer);
      const key = this.draftKey;
      this.draftWindow = this.contentEl.win;
      this.draftTimer = this.draftWindow.setTimeout(() => {
        if (key === this.draftKey) void this.coach.safely(() => this.flushDraft());
      }, 600);
    });
    return input;
  }

  private renderQuestion(body: HTMLElement, session: Session): void {
    const question = session.question!;
    const card = body.createDiv({ cls: 'lc-card lc-question' });
    if (question.invalidated) {
      card.createEl('h3', { text: tr('m590') });
      card.createEl('p', { text: question.invalidated.reason, cls: 'lc-plain' });
      this.button(card, tr('m591'), () => this.coach.engine.perform('next'), true, this.coach.engine.busy);
      this.button(card, tr('m592'), () => this.coach.changeQuestionValidity(session.id, question.id, null), false, this.coach.engine.busy);
      return;
    }
    const choice = question.type && question.type !== 'short';
    card.createDiv({ text: `${QUESTION_LABELS[question.type ?? 'short']} · ${choice ? tr('m593') : tr('m594')}`, cls: 'lc-eyebrow' });
    this.markdown(card, question.prompt, session.source.path);
    if (question.hints || question.revealed) card.createEl('p', { text: question.revealed ? tr('m595') : tr('m596'), cls: 'lc-caption' });
    let selected = [...(session.choiceDraft ?? [])];
    let confidence = session.confidenceDraft;
    const saveSelection = () => this.coach.engine.saveChoiceDraft([...selected], confidence, draftContext(session));
    if (choice) {
      const group = card.createEl('fieldset', { cls: 'lc-options' });
      group.createEl('legend', { text: question.type === 'multiple' ? tr('m597') : tr('m598'), cls: 'lc-caption' });
      for (const option of question.options ?? []) {
        const label = group.createEl('label', { cls: 'lc-option' });
        const control = label.createEl('input', { attr: { type: question.type === 'multiple' ? 'checkbox' : 'radio', name: `question-${question.id}`, value: option.id } });
        control.checked = selected.includes(option.id);
        control.disabled = this.coach.engine.busy;
        label.createSpan({ text: `${option.id}　${option.text}` });
        control.addEventListener('change', () => {
          selected = question.type === 'multiple' ? (control.checked ? [...selected.filter(id => id !== option.id), option.id] : selected.filter(id => id !== option.id)) : [option.id];
          void this.coach.safely(saveSelection);
        });
      }
    }
    const confidenceLabel = card.createEl('label', { text: tr('m599'), cls: 'lc-label' });
    const certainty = confidenceLabel.createEl('select', { attr: { 'aria-label': tr('m600') } });
    for (const [value, label] of [['', tr('m601')], ['certain', tr('m102')], ['unsure', tr('m103')], ['guessed', tr('m104')]]) certainty.createEl('option', { value, text: label });
    certainty.value = confidence ?? '';
    certainty.addEventListener('change', () => {
      confidence = (certainty.value || undefined) as Session['confidenceDraft'];
      void this.coach.safely(saveSelection);
    });
    const followup = choice ? card.createEl('details', { cls: 'lc-disclosure' }) : null;
    followup?.createEl('summary', { text: tr('m602') });
    const input = this.input(followup ?? card, choice ? tr('m603') : tr('m604'), choice ? tr('m588') : tr('m589'));
    const actions = card.createDiv({ cls: 'lc-actions' });
    const submit = async () => { const value = choice ? selected.sort().join(',') : input.value; await saveSelection(); await this.flushDraft(); await this.coach.engine.perform('answer', value); };
    this.button(actions, tr('m605'), submit, true, this.coach.engine.busy);
    if (!choice) input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) {
        event.preventDefault(); void this.coach.safely(submit);
      }
    });
    if (session.examId) { card.createEl('p', { text: tr('m606'), cls: 'lc-caption' }); return; }
    const help = card.createDiv({ cls: 'lc-actions lc-secondary-actions' });
    this.button(help, tr('m607'), async () => { await this.flushDraft(); await this.coach.engine.perform('hint'); }, false, this.coach.engine.busy);
    this.button(help, tr('m608'), async () => { await this.flushDraft(); await this.coach.engine.perform('explain'); }, false, this.coach.engine.busy);
    this.button(followup ?? help, tr('m609'), async () => { const value = input.value; await this.flushDraft(); await this.coach.engine.perform('ask', value); }, false, this.coach.engine.busy);
    if (followup) card.appendChild(followup);
    if (!session.reviewOf) this.button(help, tr('m610'), () => this.coach.engine.perform('next'), false, this.coach.engine.busy);
    this.button(help, tr('m611'), async () => { await this.flushDraft(); new QuestionReportModal(this.coach, session.id, question.id).open(); }, false, this.coach.engine.busy);
    card.createEl('p', { text: tr('m612'), cls: 'lc-caption' });
  }

  private renderFeedback(body: HTMLElement, session: Session): void {
    const exam = this.coach.data.exams.find(e => e.id === session.examId && e.status === 'active');
    if (exam) {
      const card = body.createDiv({ cls: 'lc-card' }); card.createEl('p', { text: tr('m613') });
      this.button(card, (session.examIndex ?? 0) + 1 < exam.items.length ? tr('m614') : tr('m615'), () => this.coach.continueExam(exam.id), true, this.coach.engine.busy); return;
    }
    const attempt = session.attempts.at(-1)!;
    const assessment = attempt.assessment!;
    const card = body.createDiv({ cls: 'lc-card lc-feedback' });
    if (attempt.question.invalidated) {
      card.createEl('h3', { text: tr('m616') });
      card.createEl('p', { text: attempt.question.invalidated.reason, cls: 'lc-plain' });
      this.button(card, tr('m591'), () => this.coach.engine.perform('next'), true, this.coach.engine.busy);
      this.button(card, tr('m592'), () => this.coach.changeQuestionValidity(session.id, attempt.question.id, null), false, this.coach.engine.busy);
      return;
    }
    card.dataset.verdict = assessment.verdict;
    card.createDiv({ text: VERDICT_LABELS[assessment.verdict], cls: 'lc-verdict' });
    card.createEl('p', { text: attempt.question.prompt, cls: 'lc-plain' });
    if (attempt.question.options?.length) card.createEl('p', { text: tr('m617', [attempt.question.options.filter(o => attempt.answer.split(',').includes(o.id)).map(o => `${o.id}：${o.text}`).join('；')]), cls: 'lc-caption' });
    this.markdown(card, assessment.feedback, session.source.path);
    if (assessment.verdict !== 'correct') {
      const cause = card.createEl('label', { text: tr('m618'), cls: 'lc-label' }).createEl('select', { attr: { 'aria-label': tr('m619') } });
      for (const [value, text] of [['unknown', tr('m620')], ['concept', tr('m621')], ['memory', tr('m622')], ['reading', tr('m623')], ['calculation', tr('m624')]]) cause.createEl('option', { value, text });
      cause.value = attempt.mistakeCause ?? 'unknown'; cause.disabled = this.coach.engine.busy;
      cause.addEventListener('change', () => { void this.coach.safely(() => this.coach.engine.setMistakeCause(cause.value as NonNullable<typeof attempt.mistakeCause>)); });
    }
    if (session.attempts.slice(-2).length === 2 && session.attempts.slice(-2).every(a => a.assessment?.verdict !== 'correct')) {
      card.createEl('p', { text: tr('m625'), cls: 'lc-caption' });
      this.button(card, tr('m626'), () => { void this.app.workspace.openLinkText(session.source.path, '', true); });
      this.button(card, tr('m627'), () => this.coach.engine.pause());
    }
    const quote = card.createEl('details');
    quote.createEl('summary', { text: tr('m628') });
    quote.createEl('blockquote', { text: attempt.question.referenceQuote });
    quote.createEl('p', { text: attempt.question.rubric, cls: 'lc-plain' });
    card.createEl('p', { text: tr('m629'), cls: 'lc-caption' });
    const reachedTarget = session.attempts.filter(a => a.assessment && !a.question.invalidated).length >= session.targetQuestions;
    if (reachedTarget || session.reviewOf) {
      this.button(card, tr('m630'), () => this.coach.finishSession(), true, this.coach.engine.busy);
    }
    if (!session.reviewOf) this.button(card, assessment.verdict !== 'correct' ? tr('m631') : reachedTarget ? tr('m632') : tr('m633'), () => this.coach.engine.perform('next'), !reachedTarget, this.coach.engine.busy);
    else this.button(card, tr('m634'), () => this.coach.engine.perform('next'), false, this.coach.engine.busy);
    const review = this.coach.getReviews().find(item => item.id === (session.focus ? `knowledge:${session.courseId}:${session.focus.id}:${session.focus.revision}` : session.reviewOf ?? `${session.id}/${attempt.question.id}`));
    if (review) card.createEl('p', { text: tr('m635', [review.due]), cls: 'lc-caption' });
    const correction = card.createEl('details', { cls: 'lc-correction' });
    correction.createEl('summary', { text: tr('m636') });
    const input = this.input(correction, tr('m637'), tr('m159'));
    this.button(correction, tr('m638'), async () => {
      const value = input.value; await this.flushDraft(); await this.coach.engine.perform('dispute', value);
    }, false, this.coach.engine.busy);
    this.button(correction, tr('m501'), async () => { await this.flushDraft(); new QuestionReportModal(this.coach, session.id, attempt.question.id).open(); }, false, this.coach.engine.busy);
  }

  private renderHistory(body: HTMLElement): void {
    const sessions = [...this.coach.data.archive];
    if (this.coach.engine.current) sessions.push(this.coach.engine.current);
    if (!sessions.length) {
      const empty = body.createDiv({ cls: 'lc-card lc-empty' });
      empty.createEl('h3', { text: tr('m639') });
      empty.createEl('p', { text: tr('m640'), cls: 'lc-muted' });
      this.button(empty, tr('m641'), () => this.showTab('learn'), true);
      return;
    }
    if (sessions.length > this.historyLimit) this.button(body, tr('m642', [this.historyLimit, sessions.length]), () => { this.historyLimit += 30; this.render(); });
    for (const session of sessions.reverse().slice(0, this.historyLimit)) {
      if (session.examId && this.coach.data.exams.find(e => e.id === session.examId)?.status === 'active') continue;
      const card = body.createDiv({ cls: 'lc-card' });
      card.createDiv({ text: session.createdAt.slice(0, 10), cls: 'lc-eyebrow' });
      card.createEl('h3', { text: session.source.name });
      card.createEl('p', { text: session.goal, cls: 'lc-muted' });
      card.createEl('p', { text: tr('m643', [session.attempts.length, session.status === 'ended' ? tr('m644') : tr('m645')]), cls: 'lc-caption' });
      this.button(card, tr('m646'), () => this.coach.exportRecord(session));
      if (session.status !== 'ended') this.button(card, tr('m647'), () => this.coach.restoreSession(session), true, this.coach.engine.busy);
      const details = card.createEl('details', { cls: 'lc-history-details' });
      details.createEl('summary', { text: tr('m648') });
      if (!session.attempts.length) details.createEl('p', { text: tr('m649') });
      for (const attempt of session.attempts) {
        details.createEl('h4', { text: attempt.question.prompt });
        for (const option of attempt.question.options ?? []) details.createEl('p', { text: `${option.id}：${option.text}`, cls: 'lc-caption' });
        details.createEl('p', { text: attempt.answer, cls: 'lc-plain' });
        details.createEl('p', { text: attempt.assessment ? `${VERDICT_LABELS[attempt.assessment.verdict]}：${attempt.assessment.feedback}` : tr('m113'), cls: 'lc-caption' });
        if (attempt.question.invalidated) {
          details.createEl('p', { text: tr('m650', [attempt.question.invalidated.reason]), cls: 'lc-caption' });
          this.button(details, tr('m592'), () => this.coach.changeQuestionValidity(session.id, attempt.question.id, null), false, this.coach.engine.busy);
        } else this.button(details, tr('m501'), () => { new QuestionReportModal(this.coach, session.id, attempt.question.id).open(); }, false, this.coach.engine.busy);
      }
      const unsubmitted = [...(session.retiredQuestions ?? []), ...(session.question && !session.attempts.some(a => a.question.id === session.question!.id) ? [session.question] : [])];
      for (const question of unsubmitted) {
        details.createEl('h4', { text: tr('m651', [question.prompt]) });
        if (question.invalidated) {
          details.createEl('p', { text: tr('m118', [question.invalidated.reason]), cls: 'lc-caption' });
          this.button(details, tr('m592'), () => this.coach.changeQuestionValidity(session.id, question.id, null), false, this.coach.engine.busy);
        } else this.button(details, tr('m501'), () => { new QuestionReportModal(this.coach, session.id, question.id).open(); }, false, this.coach.engine.busy);
      }
    }
  }
}
