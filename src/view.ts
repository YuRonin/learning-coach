import { Component, ItemView, MarkdownRenderer, Modal, TFile, type WorkspaceLeaf } from 'obsidian';
import type LearningCoachPlugin from './main';
import { draftContext, summarizeSession, VERDICT_LABELS, type Session } from './domain';
import { CoachSettingsTab } from './settings';
import { localDate } from './review';

export const VIEW_TYPE = 'learning-coach-view';

class SettingsModal extends Modal {
  constructor(private readonly coach: LearningCoachPlugin) { super(coach.app); }
  onOpen(): void {
    this.modalEl.addClass('lc-settings-modal');
    const tab = new CoachSettingsTab(this.app, this.coach);
    tab.containerEl = this.contentEl;
    tab.display();
  }
  onClose(): void { this.contentEl.empty(); }
}

export class CoachView extends ItemView {
  private unsubscribe: (() => void) | null = null;
  private renderComponent: Component | null = null;
  private draft = '';
  private draftKey = '';
  private draftTimer: ReturnType<typeof setTimeout> | undefined;
  private goal = '';
  private tab: 'today' | 'learn' | 'history' = 'today';
  private renderedTab = 'today';
  private scrollPositions: Record<string, number> = {};

  constructor(leaf: WorkspaceLeaf, private readonly coach: LearningCoachPlugin) { super(leaf); }
  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return '学习教练'; }
  getIcon(): string { return 'graduation-cap'; }

  showTab(tab: 'today' | 'learn' | 'history'): void { this.tab = tab; this.render(); }

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
    globalThis.clearTimeout(this.draftTimer);
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
    globalThis.clearTimeout(this.draftTimer);
    if (this.coach.engine.current && this.draftKey === draftContext(this.coach.engine.current)) {
      await this.coach.engine.saveDraft(this.draft, this.draftKey);
    }
  }

  render(): void {
    const { contentEl } = this;
    this.scrollPositions[this.renderedTab] = contentEl.querySelector('.lc-body')?.scrollTop ?? 0;
    const oldScroll = this.scrollPositions[this.tab] ?? 0;
    this.renderedTab = this.tab;
    const focused = contentEl.contains(document.activeElement) && document.activeElement instanceof HTMLTextAreaElement ? document.activeElement : null;
    const inputRole = focused?.dataset.lcInput;
    const cursor = focused ? [focused.selectionStart, focused.selectionEnd] : null;
    const openDetails = new Set(Array.from(contentEl.querySelectorAll('details[open] summary')).map(el => el.textContent));
    if (this.renderComponent) this.removeChild(this.renderComponent);
    this.renderComponent = this.addChild(new Component());
    contentEl.empty();
    contentEl.addClass('lc-root');
    const header = contentEl.createDiv({ cls: 'lc-header' });
    const heading = header.createDiv();
    heading.createEl('h2', { text: '学习教练' });
    heading.createEl('p', { text: '读懂一点，再向前一步。', cls: 'lc-tagline' });
    this.button(header, '设置', () => { new SettingsModal(this.coach).open(); });
    const nav = contentEl.createEl('nav', { cls: 'lc-nav', attr: { 'aria-label': '学习导航' } });
    for (const [key, label] of [['today', '今日'], ['learn', '学习台'], ['history', '记录']] as const) {
      const button = this.button(nav, label, async () => {
        await this.flushDraft(); this.showTab(key);
        this.contentEl.querySelector<HTMLButtonElement>(`[data-page="${key}"]`)?.focus({ preventScroll: true });
      });
      button.dataset.page = key;
      if (this.tab === key) { button.addClass('is-active'); button.setAttribute('aria-current', 'page'); }
    }
    const body = contentEl.createDiv({ cls: 'lc-body', attr: { role: 'region', 'aria-label': this.tab === 'today' ? '今日学习' : this.tab === 'learn' ? '学习台' : '学习记录' } });
    if (this.tab === 'today') this.renderToday(body);
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
      setup.createEl('h3', { text: '先连接你的模型' });
      setup.createEl('p', { text: '填写服务地址、密钥和模型名称。连接成功后，选一篇笔记就能开始。', cls: 'lc-muted' });
      this.button(setup, '配置模型', () => { new SettingsModal(this.coach).open(); }, true);
      setup.createEl('p', { text: '第一步：连接模型　第二步：选择笔记　第三步：开始练习', cls: 'lc-caption' });
      return;
    }
    if (session && session.status !== 'ended') {
      const card = body.createDiv({ cls: 'lc-card' });
      card.createDiv({ text: '接着上次学', cls: 'lc-eyebrow' });
      card.createEl('h3', { text: session.source.name });
      card.createEl('p', { text: session.goal, cls: 'lc-muted' });
      this.button(card, '回到学习现场', () => this.showTab('learn'), true);
    }
    const cards = this.coach.getReviews();
    const due = cards.filter(card => card.due <= localDate());
    const summary = body.createDiv({ cls: 'lc-card' });
    summary.createDiv({ text: '今天的安排', cls: 'lc-eyebrow' });
    summary.createEl('h3', { text: due.length ? `${due.length} 项可以复习` : '今天没有到期复习' });
    summary.createEl('p', { text: due.length ? '先做一项也很好。回答后会更新下一次复习日期。' : cards.length ? `下一次复习：${cards[0]!.due}。也可以提前练习。` : '完成并评价一道题后，它会进入复习安排。', cls: 'lc-muted' });
    this.button(summary, '选择笔记开始学习', () => this.coach.chooseNote(this.goal), !(session && session.status !== 'ended') && !due.length, this.coach.engine.busy);
    const list = due.length ? due : cards.slice(0, 3);
    for (const [index, card] of list.slice(0, 10).entries()) {
      const item = body.createDiv({ cls: 'lc-card lc-review-card' });
      item.createDiv({ text: `${card.source.name} · ${card.due}`, cls: 'lc-eyebrow' });
      item.createEl('p', { text: card.question.prompt, cls: 'lc-review-question' });
      item.createEl('p', { text: card.reason, cls: 'lc-caption' });
      const actions = item.createDiv({ cls: 'lc-actions' });
      this.button(actions, card.due <= localDate() ? '开始复习' : '提前复习', () => this.coach.review(card), index === 0 && !(session && session.status !== 'ended'), this.coach.engine.busy);
      if (card.due <= localDate()) this.button(actions, '明天再学', () => this.coach.snoozeReview(card.id));
    }
    if (due.length > 10) body.createEl('p', { text: '先显示前 10 项；完成后会补入后续内容。', cls: 'lc-caption' });
  }

  private renderStart(body: HTMLElement): void {
    const card = body.createDiv({ cls: 'lc-card lc-welcome' });
    card.createEl('div', { text: '从一篇笔记开始', cls: 'lc-eyebrow' });
    card.createEl('h3', { text: '今天想学会什么？' });
    card.createEl('p', { text: '打开一篇笔记。教练会围绕它讲解、提问，并根据你的回答调整下一步。', cls: 'lc-muted' });
    let fileName = '请先在编辑区打开一篇笔记';
    try { fileName = this.coach.currentNote().path; } catch { /* Empty vault is a normal initial state. */ }
    card.createDiv({ text: fileName, cls: 'lc-source-pill' });
    const label = card.createEl('label', { text: '这次的学习目标（可选）', cls: 'lc-label' });
    const input = label.createEl('textarea', { attr: { placeholder: '例如：理解核心概念，并能用在自己的项目中', rows: '3', 'aria-label': '本次学习目标' } });
    input.dataset.lcInput = 'goal';
    input.maxLength = 1000;
    input.value = this.goal;
    input.addEventListener('blur', () => { void this.coach.safely(() => this.flushDraft()); });
    input.addEventListener('input', () => { this.goal = input.value.slice(0, 1000); });
    const actions = card.createDiv({ cls: 'lc-actions' });
    this.button(actions, '开始学习当前笔记', async () => {
      const file = this.coach.currentNote();
      await this.coach.startFile(file, this.goal);
    }, true, this.coach.engine.busy);
    this.button(actions, '选择其他笔记', () => this.coach.chooseNote(this.goal), false, this.coach.engine.busy);
    card.createEl('p', { text: `本轮计划 ${this.coach.data.settings.questionsPerSession} 题 · ${this.coach.data.settings.learningMode === 'guided' ? '先讲后练' : '先测再学'}，可在设置中调整。`, cls: 'lc-caption' });
    card.createEl('p', { text: '也可以选中一段文字，右键选择“用学习教练学习选中内容”。首次使用请先配置模型。', cls: 'lc-caption' });
  }

  private renderSession(body: HTMLElement, session: Session): void {
    const engine = this.coach.engine;
    const key = draftContext(session);
    if (this.draftKey !== key) { this.draftKey = key; this.draft = session.draft; }
    if (session.pending && ['answer', 'dispute', 'ask'].includes(session.pending.action)) this.draft = session.draft;
    const summary = body.createDiv({ cls: 'lc-session-summary' });
    const status = engine.busy ? '教练正在准备…' : session.status === 'paused' ? '已暂停 · 可以继续' : session.status === 'ended' ? '本次学习已结束' : session.pending ? '本轮等待重试' : session.question ? '轮到你了' : '一起回看这一题';
    summary.createDiv({ text: status, cls: `lc-status${engine.busy ? ' is-working' : ''}`, attr: { role: 'status', 'aria-live': 'polite' } });
    this.button(summary, `来源：${session.source.name}${session.source.selection ? ' · 选中片段' : ''}`, async () => {
      await this.app.workspace.openLinkText(session.source.path, '', true);
    });
    summary.createEl('p', { text: session.goal, cls: 'lc-goal' });
    summary.createEl('p', { text: `${session.reviewOf ? '复习' : '本轮'}进度：${session.attempts.filter(a => a.assessment).length} / ${session.targetQuestions} 题`, cls: 'lc-caption' });
    const progress = summary.createEl('progress', { cls: 'lc-progress', attr: { 'aria-label': '本轮已评价题数', max: String(session.targetQuestions), value: String(Math.min(session.targetQuestions, session.attempts.filter(a => a.assessment).length)) } });
    progress.setAttribute('aria-valuetext', `已完成 ${session.attempts.filter(a => a.assessment).length} 题，计划 ${session.targetQuestions} 题`);
    const file = this.app.vault.getAbstractFileByPath(session.source.path);
    if (file instanceof TFile && file.stat.mtime !== session.source.mtime) {
      summary.createEl('p', { text: '源笔记已修改。本轮仍使用开始学习时保存的片段；学习新版内容请结束后重新开始。', cls: 'lc-caption' });
    } else if (!file) summary.createEl('p', { text: '原文件已移动或删除，本轮使用已保存的材料快照。', cls: 'lc-caption' });
    if (session.outline.length) {
      const outline = body.createEl('details', { cls: 'lc-outline' });
      outline.createEl('summary', { text: `学习路线 · ${session.outline.length} 个目标` });
      const list = outline.createEl('ol');
      for (const item of session.outline) list.createEl('li', { text: item });
    }
    // Keep the latest teaching message near the task; disclose older interactions on demand.
    const recent = session.entries.slice(-12);
    const latestCoach = [...recent].reverse().find(entry => entry.role === 'coach');
    if (latestCoach && session.status !== 'ended' && session.question) {
      const bubble = body.createDiv({ cls: 'lc-bubble lc-coach' });
      bubble.createDiv({ text: '教练讲解', cls: 'lc-speaker' });
      this.markdown(bubble, latestCoach.text, session.source.path);
    }
    const timeline = body.createEl('details', { cls: 'lc-timeline lc-disclosure' });
    timeline.createEl('summary', { text: `本轮互动 · ${session.entries.length} 条` });
    for (const entry of recent) {
      const bubble = timeline.createDiv({ cls: `lc-bubble lc-${entry.role}` });
      bubble.createDiv({ text: entry.role === 'coach' ? '学习教练' : entry.role === 'user' ? '我的回答' : '学习记录', cls: 'lc-speaker' });
      if (entry.role === 'coach') this.markdown(bubble, entry.text, session.source.path);
      else bubble.createDiv({ text: entry.text, cls: 'lc-plain' });
    }
    if (session.entries.length > 12) timeline.createEl('p', { text: '这里显示最近 12 条互动，导出记录可查看完整过程。', cls: 'lc-caption' });
    if (session.error) body.createDiv({ text: session.error, cls: 'lc-error', attr: { role: 'alert' } });

    if (session.status === 'ended') {
      const done = body.createDiv({ cls: 'lc-card lc-complete' });
      done.createEl('h3', { text: '本轮小结' });
      const list = done.createEl('ul');
      for (const line of summarizeSession(session)) list.createEl('li', { text: line });
      this.button(done, '查看复习安排', () => this.showTab('today'), true);
    } else if (session.status === 'paused') {
      const card = body.createDiv({ cls: 'lc-card' });
      card.createEl('p', { text: '目标、题目和已提交的回答都保留在这里。' });
      this.button(card, '继续学习', () => engine.resume(), true, engine.busy);
    } else if (session.status === 'ready' && session.pending && !engine.busy) {
      const card = body.createDiv({ cls: 'lc-card' });
      card.createEl('p', { text: '这一轮还没有完成。重试会沿用已保存的回答，不会重复提交作答。' });
      this.button(card, '重试这一轮', () => engine.retry(), true);
    } else if (session.status === 'ready' && !session.pending) {
      if (session.question) this.renderQuestion(body, session);
      else if (session.attempts.at(-1)?.assessment) this.renderFeedback(body, session);
      else this.button(body, '准备第一道题', () => engine.perform('start'), true, engine.busy);
    }
    body.appendChild(timeline);
    const footer = body.createDiv({ cls: 'lc-footer' });
    if (session.status !== 'ended') {
      if (session.status !== 'paused') this.button(footer, engine.busy ? '暂停请求' : '暂停', async () => { await this.flushDraft(); await engine.pause(); });
      this.button(footer, '今天到这里', async () => { await this.flushDraft(); await this.coach.finishSession(); }, false, engine.busy);
    }
    this.button(footer, '保存为笔记', async () => { await this.flushDraft(); await this.coach.exportRecord(); }, false, engine.busy);
    footer.createEl('p', { text: `已记录 ${session.attempts.length} 次作答 · 模型调用 ${session.calls}/${this.coach.data.settings.maxCalls} 次`, cls: 'lc-caption' });
    if (engine.busy) footer.createEl('p', { text: '请求完成后会更新本轮内容。暂停后迟到的结果不会写入。', cls: 'lc-caption', attr: { role: 'status', 'aria-live': 'polite' } });
  }

  private input(parent: HTMLElement, placeholder: string): HTMLTextAreaElement {
    const label = parent.createEl('label', { cls: 'lc-answer-label' });
    label.createSpan({ text: placeholder.startsWith('说明') ? '复核理由' : '我的回答或追问', cls: 'lc-label' });
    const input = label.createEl('textarea', { cls: 'lc-answer', attr: { placeholder, rows: '5', 'aria-label': placeholder, maxlength: '6000' } });
    input.value = this.draft;
    input.dataset.lcInput = 'answer';
    input.disabled = this.coach.engine.busy;
    input.addEventListener('blur', () => { void this.coach.safely(() => this.flushDraft()); });
    input.addEventListener('input', () => {
      this.draft = input.value;
      globalThis.clearTimeout(this.draftTimer);
      const key = this.draftKey;
      this.draftTimer = globalThis.setTimeout(() => {
        if (key === this.draftKey) void this.coach.safely(() => this.flushDraft());
      }, 600);
    });
    return input;
  }

  private renderQuestion(body: HTMLElement, session: Session): void {
    const question = session.question!;
    const card = body.createDiv({ cls: 'lc-card lc-question' });
    card.createDiv({ text: '试着用自己的话回答', cls: 'lc-eyebrow' });
    this.markdown(card, question.prompt, session.source.path);
    if (question.hints || question.revealed) card.createEl('p', { text: question.revealed ? '已查看讲解，本次作答会保留这一条件。' : '已使用提示，本次作答会保留这一条件。', cls: 'lc-caption' });
    const input = this.input(card, '写下你的理解。暂时不会也可以直接说。');
    const actions = card.createDiv({ cls: 'lc-actions' });
    const submit = async () => { const value = input.value; await this.flushDraft(); await this.coach.engine.perform('answer', value); };
    this.button(actions, '提交回答', submit, true, this.coach.engine.busy);
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) {
        event.preventDefault(); void this.coach.safely(submit);
      }
    });
    const help = card.createDiv({ cls: 'lc-actions lc-secondary-actions' });
    this.button(help, '给点提示', async () => { await this.flushDraft(); await this.coach.engine.perform('hint'); }, false, this.coach.engine.busy);
    this.button(help, '直接讲解', async () => { await this.flushDraft(); await this.coach.engine.perform('explain'); }, false, this.coach.engine.busy);
    this.button(help, '发送追问', async () => { const value = input.value; await this.flushDraft(); await this.coach.engine.perform('ask', value); }, false, this.coach.engine.busy);
    if (!session.reviewOf) this.button(help, '跳过这题', () => this.coach.engine.perform('next'), false, this.coach.engine.busy);
    card.createEl('p', { text: '回答会自动保存草稿。使用提示或查看讲解后，会保留这次学习条件。', cls: 'lc-caption' });
  }

  private renderFeedback(body: HTMLElement, session: Session): void {
    const attempt = session.attempts.at(-1)!;
    const assessment = attempt.assessment!;
    const card = body.createDiv({ cls: 'lc-card lc-feedback' });
    card.dataset.verdict = assessment.verdict;
    card.createDiv({ text: VERDICT_LABELS[assessment.verdict], cls: 'lc-verdict' });
    this.markdown(card, assessment.feedback, session.source.path);
    const quote = card.createEl('details');
    quote.createEl('summary', { text: '查看原文依据与评分要点' });
    quote.createEl('blockquote', { text: attempt.question.referenceQuote });
    quote.createEl('p', { text: attempt.question.rubric, cls: 'lc-plain' });
    card.createEl('p', { text: '这是本次回答的评价，不是永久掌握结论。', cls: 'lc-caption' });
    const reachedTarget = session.attempts.filter(a => a.assessment).length >= session.targetQuestions;
    if (reachedTarget || session.reviewOf) {
      this.button(card, '完成本轮', () => this.coach.finishSession(), true, this.coach.engine.busy);
    }
    if (!session.reviewOf) this.button(card, reachedTarget ? '再练一题' : '继续下一步', () => this.coach.engine.perform('next'), !reachedTarget, this.coach.engine.busy);
    const review = this.coach.getReviews().find(item => item.id === (session.reviewOf ?? `${session.id}/${attempt.question.id}`));
    if (review) card.createEl('p', { text: `下次复习：${review.due}`, cls: 'lc-caption' });
    const correction = card.createEl('details', { cls: 'lc-correction' });
    correction.createEl('summary', { text: '我不同意这个评价' });
    const input = this.input(correction, '说明哪里判错了，或补充你认为支持答案的依据。');
    this.button(correction, '请求复核', async () => {
      const value = input.value; await this.flushDraft(); await this.coach.engine.perform('dispute', value);
    }, false, this.coach.engine.busy);
  }

  private renderHistory(body: HTMLElement): void {
    const sessions = [...this.coach.data.archive];
    if (this.coach.engine.current) sessions.push(this.coach.engine.current);
    if (!sessions.length) {
      const empty = body.createDiv({ cls: 'lc-card lc-empty' });
      empty.createEl('h3', { text: '每一步理解，都值得留下' });
      empty.createEl('p', { text: '开始学习后，你的回答、反馈和复习安排会保存在这里。', cls: 'lc-muted' });
      this.button(empty, '开始第一次学习', () => this.showTab('learn'), true);
      return;
    }
    for (const session of sessions.reverse()) {
      const card = body.createDiv({ cls: 'lc-card' });
      card.createDiv({ text: session.createdAt.slice(0, 10), cls: 'lc-eyebrow' });
      card.createEl('h3', { text: session.source.name });
      card.createEl('p', { text: session.goal, cls: 'lc-muted' });
      card.createEl('p', { text: `${session.attempts.length} 次作答 · ${session.status === 'ended' ? '已结束' : '进行中'}`, cls: 'lc-caption' });
      this.button(card, '导出完整学习记录', () => this.coach.exportRecord(session));
      if (session.status !== 'ended') this.button(card, '继续这次学习', () => this.coach.restoreSession(session), true, this.coach.engine.busy);
      const details = card.createEl('details', { cls: 'lc-history-details' });
      details.createEl('summary', { text: '查看学习证据' });
      if (!session.attempts.length) details.createEl('p', { text: '本次还没有提交回答。' });
      for (const attempt of session.attempts) {
        details.createEl('h4', { text: attempt.question.prompt });
        details.createEl('p', { text: attempt.answer, cls: 'lc-plain' });
        details.createEl('p', { text: attempt.assessment ? `${VERDICT_LABELS[attempt.assessment.verdict]}：${attempt.assessment.feedback}` : '待评价', cls: 'lc-caption' });
      }
    }
  }
}
