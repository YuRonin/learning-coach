import { draftContext, makeSession, parseReply, type Action, type Session, type Settings } from './domain';
import type { ReviewCard } from './review';
import { buildMessages } from './prompts';
import type { ChatMessage } from './api';

export interface SessionDependencies {
  save: (session: Session) => Promise<void>;
  ask: (messages: ChatMessage[], signal: AbortSignal) => Promise<string>;
  settings: () => Settings;
  changed: () => void;
}

/** A single writer owns a session. Model output is only applied after validation and persistence. */
export class LearningSession {
  busy = false;
  private controller: AbortController | null = null;
  private stopRequested = false;
  private disposed = false;
  private draftWrite: Promise<void> = Promise.resolve();

  constructor(public current: Session | null, private readonly deps: SessionDependencies) {}

  private notify(): void { if (!this.disposed) this.deps.changed(); }

  private async commit(session: Session): Promise<void> {
    session.updatedAt = new Date().toISOString();
    await this.deps.save(structuredClone(session));
    this.current = session;
    this.notify();
  }

  private entry(session: Session, role: 'coach' | 'user' | 'system', text: string): void {
    session.entries.push({ id: crypto.randomUUID(), role, text, at: new Date().toISOString() });
  }

  async start(source: Session['source'], goal: string): Promise<void> {
    await this.draftWrite;
    if (this.busy) throw new Error('请先暂停正在进行的请求。');
    if (this.current?.status === 'ready') throw new Error('请先暂停当前学习，再开始新笔记。');
    this.busy = true;
    this.stopRequested = false;
    try {
      const session = makeSession(source, goal);
      session.mode = this.deps.settings().learningMode;
      session.targetQuestions = this.deps.settings().questionsPerSession;
      await this.commit(session);
    }
    finally { this.busy = false; this.notify(); }
    if (this.stopRequested) { await this.changeStatus('paused'); return; }
    await this.perform('start');
  }

  async perform(action: Action, input = ''): Promise<void> {
    await this.draftWrite;
    if (this.busy) throw new Error('正在处理上一轮，请稍候。');
    const current = this.current;
    if (!current || current.status !== 'ready') throw new Error('请先开始或恢复学习。');
    if (current.pending) throw new Error('上一轮尚未完成，请重试或结束本次学习。');
    if (current.calls >= this.deps.settings().maxCalls) throw new Error('已达到本次模型调用上限。可以结束并保存记录，或在设置中提高上限。');
    if (action === 'start' && current.entries.length) throw new Error('当前学习已经开始。');
    if (['answer', 'hint', 'explain', 'ask'].includes(action) && !current.question) throw new Error('当前没有待回答的问题。');
    if (['answer', 'dispute', 'ask'].includes(action) && !input.trim()) throw new Error('请先输入内容。');
    if (action === 'next' && current.reviewOf) throw new Error('本次复习只验证一道题，请结束后从今日页选择下一项。');
    if (input.length > 6000) throw new Error('单次回答请控制在 6,000 个字符以内。');
    const lastAttempt = current.attempts.at(-1);
    if (action === 'dispute' && (!lastAttempt?.assessment || current.question)) throw new Error('请在本题评价完成后、进入下一题前复核。');

    this.busy = true;
    this.stopRequested = false;
    this.notify();
    try {
      const next = structuredClone(current);
      let attemptId: string | null = null;
      if (action === 'answer' && next.question) {
        attemptId = crypto.randomUUID();
        next.attempts.push({ id: attemptId, question: structuredClone(next.question), answer: input.trim(),
          at: new Date().toISOString(), assessment: null, revisions: [] });
        next.draft = '';
        this.entry(next, 'user', input.trim());
      } else if (action === 'dispute') {
        attemptId = lastAttempt!.id;
        next.draft = '';
        this.entry(next, 'user', `请求复核：${input.trim()}`);
      } else if (action === 'hint') this.entry(next, 'user', '请给我一点提示。');
      else if (action === 'explain') this.entry(next, 'user', '请直接讲解这道题。');
      else if (action === 'ask') { this.entry(next, 'user', `追问：${input.trim()}`); next.draft = ''; }
      else if (action === 'next' && next.question) {
        this.entry(next, 'system', '用户跳过当前题，未记录为答对。');
        next.question = null;
        next.draft = '';
      }
      next.pending = { id: crypto.randomUUID(), action, input: input.trim(), attemptId };
      next.error = null;
      await this.commit(next);
      await this.executePending();
    } finally { await this.finishRequest(); }
  }

  async retry(): Promise<void> {
    await this.draftWrite;
    if (this.busy || !this.current?.pending || this.current.status !== 'ready') throw new Error('当前没有可重试的请求。');
    this.busy = true;
    this.stopRequested = false;
    this.notify();
    try { await this.executePending(); }
    finally { await this.finishRequest(); }
  }

  private async finishRequest(): Promise<void> {
    try {
      if (this.stopRequested && this.current?.status === 'ready' && !this.disposed) {
        await this.commit({ ...structuredClone(this.current), status: 'paused' });
      }
    } finally {
      this.busy = false; this.controller = null; this.notify();
    }
  }

  private async executePending(): Promise<void> {
    if (!this.current?.pending) return;
    try {
      if (this.stopRequested || this.disposed) throw new Error('已暂停。');
      if (this.current.calls >= this.deps.settings().maxCalls) throw new Error('已达到本次模型调用上限，请结束学习或调整设置。');
      const started = structuredClone(this.current);
      started.calls += 1;
      started.error = null;
      await this.commit(started);
      this.controller = new AbortController();
      if (this.stopRequested || this.disposed) this.controller.abort();
      const content = await this.deps.ask(buildMessages(started), this.controller.signal);
      if (this.stopRequested || this.disposed) throw new Error('已暂停。');
      const reply = parseReply(content, started);
      const next = structuredClone(started);
      const pending = next.pending!;
      if (pending.action === 'start') next.outline = reply.outline;
      if (reply.question) {
        next.question = { ...reply.question, id: crypto.randomUUID(), hints: 0, revealed: false };
      }
      if (reply.assessment && pending.attemptId) {
        const attempt = next.attempts.find(a => a.id === pending.attemptId);
        if (!attempt) throw new Error('没有找到对应的真实作答，已停止本次评价。');
        if (attempt.assessment) attempt.revisions.push(attempt.assessment);
        attempt.assessment = reply.assessment;
        next.question = null;
      }
      if (pending.action === 'hint' && next.question) next.question.hints += 1;
      if (['explain', 'ask'].includes(pending.action) && next.question) next.question.revealed = true;
      this.entry(next, 'coach', reply.message);
      if (reply.question) this.entry(next, 'system', `本轮问题：${reply.question.prompt}`);
      next.pending = null;
      next.error = null;
      await this.commit(next);
    } catch (error) {
      if (!this.current || this.disposed) return;
      const failed = structuredClone(this.current);
      failed.error = error instanceof Error ? error.message : '本轮未完成，可以重试。';
      if (this.stopRequested) { failed.status = 'paused'; failed.error = null; }
      await this.commit(failed);
    }
  }

  async pause(): Promise<void> {
    if (!this.current || this.current.status === 'ended') return;
    if (this.busy) {
      this.stopRequested = true;
      this.controller?.abort();
      return;
    }
    await this.draftWrite;
    await this.changeStatus('paused');
  }

  async resume(): Promise<void> {
    await this.draftWrite;
    if (this.busy || this.current?.status !== 'paused') return;
    await this.changeStatus('ready');
  }

  async end(): Promise<void> {
    await this.draftWrite;
    if (this.busy) throw new Error('请先暂停请求，再结束本次学习。');
    if (!this.current || this.current.status === 'ended') return;
    const next = structuredClone(this.current);
    next.status = 'ended';
    next.pending = null;
    next.error = null;
    this.entry(next, 'system', '本次学习已结束；结束不等于全部掌握。');
    this.busy = true;
    try { await this.commit(next); }
    finally { this.busy = false; this.notify(); }
  }

  private async changeStatus(status: 'paused' | 'ready'): Promise<void> {
    if (!this.current) return;
    this.busy = true;
    try { await this.commit({ ...structuredClone(this.current), status }); }
    finally { this.busy = false; this.notify(); }
  }

  saveDraft(text: string, context = this.current ? draftContext(this.current) : ''): Promise<void> {
    const write = this.draftWrite.catch(() => undefined).then(async () => {
      if (this.disposed || this.busy || !this.current || this.current.status === 'ended' || draftContext(this.current) !== context) return;
      const next = { ...structuredClone(this.current), draft: text.slice(0, 6000) };
      await this.deps.save(next);
      this.current = next;
    });
    this.draftWrite = write;
    return write;
  }

  async restore(session: Session): Promise<void> {
    await this.draftWrite;
    if (this.busy) throw new Error('请先暂停当前请求。');
    this.busy = true;
    try { await this.commit({ ...structuredClone(session), status: session.status === 'ended' ? 'ended' : 'paused' }); }
    finally { this.busy = false; this.notify(); }
  }

  async startReview(card: ReviewCard): Promise<void> {
    await this.draftWrite;
    if (this.busy || this.current?.status === 'ready') throw new Error('请先暂停当前学习。');
    const session = makeSession(card.source, card.goal);
    session.reviewOf = card.id;
    session.targetQuestions = 1;
    session.outline = ['在不查看提示的情况下重新解释或应用这个知识点'];
    session.question = { ...card.question, id: crypto.randomUUID(), hints: 0, revealed: false };
    this.entry(session, 'coach', '这次先独立尝试。原文、提示和答案会在需要时再提供。');
    this.entry(session, 'system', `本轮问题：${card.question.prompt}`);
    this.busy = true;
    try { await this.commit(session); }
    finally { this.busy = false; this.notify(); }
  }

  dispose(): void {
    this.disposed = true;
    this.stopRequested = true;
    this.controller?.abort();
  }
}
