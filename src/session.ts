import { t as tr } from './i18n';
import { draftContext, gradeChoice, makeSession, parseReply, extractJson, type Action, type Session, type Settings, type Question } from './domain';
import type { ReviewCard } from './review';
import { buildMessages } from './prompts';
import type { ChatMessage } from './api';
import { requestedType, type QuestionAllocation } from './question-policy';
import type { Focus } from './knowledge';
import { qualityMessages, qualityResultSchema, validateQuality } from './quality';
import type { TraceRun, TraceStore } from './trace';
import type { ResponseCache } from './cache';

export interface SessionDependencies {
  save: (session: Session) => Promise<void>;
  ask: (messages: ChatMessage[], signal: AbortSignal, settings?: Settings, trace?: TraceRun) => Promise<string>;
  cache?: ResponseCache;
  trace?: TraceStore;
  examFinished?: (id: string) => boolean;
  settings: () => Settings;
  changed: () => void;
}

/** A single writer owns a session. Model output is only applied after validation and persistence. */
export class LearningSession {
  busy = false;
  private trace?: TraceRun;
  private controller: AbortController | null = null;
  private stopRequested = false;
  private disposed = false;
  private draftWrite: Promise<void> = Promise.resolve();
  private activeSince = Date.now();

  constructor(public current: Session | null, private readonly deps: SessionDependencies) {}

  private notify(): void { if (!this.disposed) this.deps.changed(); }

  private ensureActive(): void { if (this.disposed) throw new Error(tr('m345')); }

  private async commit(session: Session): Promise<void> {
    const now = Date.now();
    if (this.current?.id === session.id && this.current.status === 'ready') session.activeSeconds = (session.activeSeconds ?? 0) + Math.min(300, Math.max(0, (now - this.activeSince) / 1000));
    this.activeSince = now;
    session.updatedAt = new Date().toISOString();
    try { await this.deps.save(structuredClone(session)); await this.trace?.event({ kind: 'persist', status: 'success' }); }
    catch (error) { await this.trace?.event({ kind: 'persist', status: 'failure', code: 'storage' }); throw error; }
    this.current = session;
    this.notify();
  }

  private entry(session: Session, role: 'coach' | 'user' | 'system', text: string): void {
    session.entries.push({ id: crypto.randomUUID(), role, text, at: new Date().toISOString() });
  }

  async start(source: Session['source'], goal: string, course?: { courseId: string; unitId: string; allocation?: QuestionAllocation; focus?: Focus; taskId?: string; previousQuestions?: Question[]; examId?: string; examIndex?: number }): Promise<void> {
    await this.draftWrite;
    this.ensureActive();
    if (this.busy) throw new Error(tr('m257'));
    if (this.current?.status === 'ready') throw new Error(tr('m346'));
    this.busy = true;
    this.stopRequested = false;
    try {
      const session = makeSession(source, goal);
      Object.assign(session, structuredClone(course));
      session.mode = course && !course.focus ? 'diagnostic' : this.deps.settings().learningMode;
      session.targetQuestions = this.deps.settings().questionsPerSession;
      if (session.examId) { session.targetQuestions = 1; session.mode = 'diagnostic'; }
      await this.commit(session);
    }
    finally { this.busy = false; this.notify(); }
    if (this.stopRequested) { await this.changeStatus('paused'); return; }
    await this.perform('start');
  }

  async perform(action: Action, input = ''): Promise<void> {
    await this.draftWrite;
    this.ensureActive();
    if (this.busy) throw new Error(tr('m347'));
    const current = this.current;
    const closedExamReview = action === 'dispute' && current?.examId && this.deps.examFinished?.(current.examId);
    if (!current || current.status !== 'ready' && !(current.status === 'ended' && closedExamReview)) throw new Error(tr('m348'));
    if (current.pending) throw new Error(tr('m349'));
    if (current.examId && this.deps.examFinished?.(current.examId) && action !== 'dispute') throw new Error(tr('m350'));
    if (current.examId && ['hint', 'explain', 'ask', 'next', 'dispute'].includes(action) && !closedExamReview) throw new Error(tr('m351'));
    if (current.question?.invalidated && ['answer', 'hint', 'explain', 'ask'].includes(action)) throw new Error(tr('m352'));
    const localAnswer = action === 'answer' && current.question && gradeChoice(current.question, input.trim());
    if (!localAnswer && !['start', 'next'].includes(action) && current.calls >= this.deps.settings().maxCalls) throw new Error(tr('m353'));
    if (action === 'start' && current.entries.length) throw new Error(tr('m354'));
    if (['answer', 'hint', 'explain', 'ask'].includes(action) && !current.question) throw new Error(tr('m355'));
    if (['answer', 'dispute', 'ask'].includes(action) && !input.trim()) throw new Error(tr('m356'));
    if (action === 'next' && current.reviewOf && current.question && !current.question.invalidated) throw new Error(tr('m357'));
    if (input.length > 6000) throw new Error(tr('m358'));
    const lastAttempt = current.attempts.at(-1);
    if (action === 'dispute' && (!lastAttempt?.assessment || current.question)) throw new Error(tr('m359'));
    if (action === 'dispute' && lastAttempt?.question.invalidated) throw new Error(tr('m360'));

    this.busy = true;
    this.stopRequested = false;
    this.notify();
    try {
      const next = structuredClone(current);
      let attemptId: string | null = null;
      if (action === 'answer' && next.question) {
        attemptId = crypto.randomUUID();
        next.attempts.push({ id: attemptId, question: structuredClone(next.question), answer: input.trim(),
          at: new Date().toISOString(), assessment: null, revisions: [], confidence: next.confidenceDraft });
        next.draft = '';
        next.choiceDraft = [];
        next.confidenceDraft = undefined;
        this.entry(next, 'user', input.trim());
      } else if (action === 'dispute') {
        attemptId = lastAttempt!.id;
        next.draft = '';
        this.entry(next, 'user', tr('m361', [input.trim()]));
      } else if (action === 'hint') this.entry(next, 'user', tr('m362'));
      else if (action === 'explain') this.entry(next, 'user', tr('m363'));
      else if (action === 'ask') { this.entry(next, 'user', tr('m364', [input.trim()])); next.draft = ''; }
      else if (action === 'next' && next.question) {
        if (!next.attempts.some(a => a.question.id === next.question!.id)) {
          next.retiredQuestions = [...(next.retiredQuestions ?? []), structuredClone(next.question)];
        }
        this.entry(next, 'system', tr('m365'));
        next.question = null;
        next.draft = '';
      }
      next.pending = { id: crypto.randomUUID(), action, input: input.trim(), attemptId };
      next.error = null;
      this.trace = await this.beginTrace(next);
      await this.commit(next);
      await this.executePending();
    } catch (error) { await this.trace?.finish('failure'); throw error; } finally { await this.finishRequest(); }
  }

  async retry(): Promise<void> {
    await this.draftWrite;
    this.ensureActive();
    const closedExamReview = this.current?.status === 'ended' && this.current.pending?.action === 'dispute' && this.current.examId && this.deps.examFinished?.(this.current.examId);
    if (this.current?.examId && this.deps.examFinished?.(this.current.examId) && this.current.pending?.action !== 'dispute') throw new Error(tr('m366'));
    if (this.busy || !this.current?.pending || this.current.status !== 'ready' && !closedExamReview) throw new Error(tr('m367'));
    this.busy = true;
    this.stopRequested = false;
    this.notify();
    try { this.trace = await this.beginTrace(this.current!); await this.executePending(); }
    catch (error) { await this.trace?.finish('failure'); throw error; }
    finally { await this.finishRequest(); }
  }

  private beginTrace(session: Session) {
    return this.deps.trace?.begin(session.pending!.action, { sessionId: session.id, operationId: session.pending!.id, courseId: session.courseId, knowledgeId: session.focus?.id, taskId: session.taskId, examId: session.examId });
  }

  private async finishRequest(): Promise<void> {
    try {
      if (this.stopRequested && this.current?.status === 'ready' && !this.disposed) {
        await this.commit({ ...structuredClone(this.current), status: 'paused' });
      }
    } finally {
      await this.trace?.finish(this.stopRequested || this.disposed ? 'cancelled' : this.current?.error ? 'failure' : 'success');
      this.trace = undefined;
      this.busy = false; this.controller = null; this.notify();
    }
  }

  private async executePending(): Promise<void> {
    if (!this.current?.pending) return;
    try {
      if (this.stopRequested || this.disposed) throw new Error(tr('m008'));
      const pendingAttempt = this.current.attempts.find(a => a.id === this.current?.pending?.attemptId);
      const localGrade = this.current.pending.action === 'answer' && pendingAttempt
        ? gradeChoice(pendingAttempt.question, pendingAttempt.answer) : null;
      if (localGrade) {
        await this.trace?.event({ kind: 'local-grade', status: 'success' });
        const next = structuredClone(this.current);
        next.attempts.find(a => a.id === pendingAttempt!.id)!.assessment = localGrade;
        next.question = null;
        next.pending = null;
        next.error = null;
        this.entry(next, 'coach', localGrade.feedback);
        await this.commit(next);
        return;
      }
      const started = structuredClone(this.current);
      started.error = null;
      this.controller = new AbortController();
      if (this.stopRequested || this.disposed) this.controller.abort();
      const settings = { ...this.deps.settings() };
      const messages = buildMessages(started);
      const cache = settings.cacheEnabled ? this.deps.cache : undefined;
      const key = ['start', 'next'].includes(started.pending!.action) ? await cache?.key(settings, messages) : null;
      const request = async (messages: ChatMessage[], key?: string | null, scope: 'generation' | 'audit' = 'generation') => {
        if (this.stopRequested || this.disposed) throw new Error(tr('m008'));
        const cached = key ? await cache?.get(key) : null;
        await this.trace?.event({ kind: 'cache', status: !key ? 'bypass' : cached ? 'hit' : 'miss', scope });
        if (cached) { started.cacheHits = (started.cacheHits ?? 0) + 1; return cached; }
        if (started.calls >= this.deps.settings().maxCalls) { await this.trace?.event({ kind: 'request', status: 'rejected', code: 'budget' }); throw new Error(tr('m368')); }
        started.calls += 1; await this.commit(started);
        if (this.stopRequested || this.disposed) throw new Error(tr('m008'));
        return this.deps.ask(messages, this.controller!.signal, settings, this.trace);
      };
      const content = await request(messages, key);
      if (this.stopRequested || this.disposed) throw new Error(tr('m008'));
      let reply;
      try { reply = parseReply(content, started); await this.trace?.event({ kind: 'schema', status: 'passed', scope: 'generation' }); }
      catch (e) { await this.trace?.event({ kind: 'schema', status: 'rejected', code: 'structure' }); if (key) await cache?.remove(key); throw e; }
      let quality: Question['quality'];
      if (reply.question && started.focus) {
        try { validateQuality(reply.question, [...(started.previousQuestions ?? []), ...started.attempts.map(a => a.question), ...(started.retiredQuestions ?? [])]); }
        catch (e) { await this.trace?.event({ kind: 'quality', status: 'rejected', code: 'duplicate-or-leak' }); if (key) await cache?.remove(key); throw e; }
        if (['short', 'multiple'].includes(reply.question.type ?? 'short')) {
          const auditMessages = qualityMessages(reply.question, started);
          const auditKey = await cache?.key(settings, auditMessages);
          const audit = await request(auditMessages, auditKey, 'audit');
          let checked;
          try { checked = qualityResultSchema.parse(extractJson(audit)); }
          catch (e) { await this.trace?.event({ kind: 'schema', status: 'rejected', scope: 'audit', code: 'structure' }); if (key) await cache?.remove(key); if (auditKey) await cache?.remove(auditKey); throw e; }
          if (this.stopRequested || this.disposed) throw new Error(tr('m008'));
          await this.trace?.event({ kind: 'quality', status: checked.verdict === 'supported' ? 'passed' : 'rejected', scope: 'audit' });
          if (checked.verdict !== 'supported') {
            if (key) await cache?.remove(key); if (auditKey) await cache?.remove(auditKey);
            throw new Error(tr('m369', [checked.reason]));
          }
          quality = { verdict: 'supported', reason: checked.reason };
          if (auditKey) await cache?.put(auditKey, audit);
        }
      }
      if (this.stopRequested || this.disposed) throw new Error(tr('m008'));
      if (key) await cache?.put(key, content);
      if (this.stopRequested || this.disposed) throw new Error(tr('m008'));
      const next = structuredClone(started);
      const pending = next.pending!;
      if (pending.action === 'start') next.outline = reply.outline;
      if (reply.question) {
        next.question = { ...reply.question, id: crypto.randomUUID(), knowledgeId: next.focus?.id, quality, hints: 0, revealed: false };
        if (next.allocation && reply.question.type) next.allocation.displayed[reply.question.type] += 1;
        next.choiceDraft = [];
        next.confidenceDraft = undefined;
      }
      if (reply.assessment && pending.attemptId) {
        const attempt = next.attempts.find(a => a.id === pending.attemptId);
        if (!attempt) throw new Error(tr('m370'));
        if (attempt.assessment) attempt.revisions.push(attempt.assessment);
        attempt.assessment = reply.assessment;
        next.question = null;
      }
      if (pending.action === 'hint' && next.question) next.question.hints += 1;
      if (pending.action === 'explain' && next.question) next.question.revealed = true;
      if (pending.action === 'ask' && next.question) {
        if (reply.helpExposure === 'hint') next.question.hints += 1;
        else if (reply.helpExposure !== 'none') next.question.revealed = true;
      }
      this.entry(next, 'coach', reply.message);
      if (reply.question) this.entry(next, 'system', tr('m371', [reply.question.prompt]));
      next.pending = null;
      next.error = null;
      await this.commit(next);
    } catch (error) {
      await this.trace?.finish(this.stopRequested || this.disposed ? 'cancelled' : 'failure');
      if (!this.current || this.disposed) return;
      const failed = structuredClone(this.current);
      failed.error = error instanceof Error ? error.message : tr('m372');
      if (this.stopRequested) { if (failed.status !== 'ended') failed.status = 'paused'; failed.error = null; }
      await this.commit(failed);
    }
  }

  async pause(): Promise<void> {
    if (this.disposed) return;
    if (!this.current) return;
    if (this.busy) {
      this.stopRequested = true;
      this.controller?.abort();
      return;
    }
    if (this.current.status === 'ended') return;
    await this.draftWrite;
    await this.changeStatus('paused');
  }

  async resume(): Promise<void> {
    await this.draftWrite;
    this.ensureActive();
    if (this.busy || this.current?.status !== 'paused') return;
    await this.changeStatus('ready');
  }

  async end(): Promise<void> {
    await this.draftWrite;
    this.ensureActive();
    if (this.busy) throw new Error(tr('m373'));
    if (!this.current || this.current.status === 'ended') return;
    const next = structuredClone(this.current);
    next.status = 'ended';
    next.pending = null;
    next.error = null;
    this.entry(next, 'system', tr('m374'));
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

  saveChoiceDraft(selected: string[], confidence: Session['confidenceDraft'], context: string): Promise<void> {
    const selection = [...selected];
    const write = this.draftWrite.catch(() => undefined).then(async () => {
      if (this.disposed || this.busy || !this.current || this.current.status !== 'ready' || draftContext(this.current) !== context) return;
      const next = { ...structuredClone(this.current), choiceDraft: selection, confidenceDraft: confidence };
      await this.deps.save(next);
      this.current = next;
    });
    this.draftWrite = write;
    return write;
  }

  async restore(session: Session): Promise<void> {
    await this.draftWrite;
    this.ensureActive();
    if (this.busy) throw new Error(tr('m242'));
    this.busy = true;
    try { await this.commit({ ...structuredClone(session), status: session.status === 'ended' ? 'ended' : 'paused' }); }
    finally { this.busy = false; this.notify(); }
  }

  async editRecords(work: () => Promise<Session | null>): Promise<void> {
    await this.draftWrite;
    if (this.busy || this.disposed) throw new Error(tr('m257'));
    this.busy = true;
    this.notify();
    try { this.current = await work(); }
    finally { this.busy = false; this.notify(); }
  }

  async setMode(mode: Session['mode']): Promise<void> {
    await this.draftWrite; this.ensureActive();
    if (this.busy || !this.current || this.current.pending) throw new Error(tr('m375'));
    this.busy = true;
    try { await this.commit({ ...structuredClone(this.current), mode }); } finally { this.busy = false; this.notify(); }
  }

  async setMistakeCause(cause: NonNullable<Session['attempts'][number]['mistakeCause']>): Promise<void> {
    await this.draftWrite; this.ensureActive();
    if (this.busy || !this.current || this.current.pending) throw new Error(tr('m376'));
    const next = structuredClone(this.current); const last = next.attempts.at(-1);
    if (!last?.assessment) throw new Error(tr('m377'));
    last.mistakeCause = cause; this.busy = true;
    try { await this.commit(next); } finally { this.busy = false; this.notify(); }
  }

  async startReview(card: ReviewCard, allocation?: QuestionAllocation, previousQuestions?: Question[]): Promise<void> {
    await this.draftWrite;
    this.ensureActive();
    if (this.busy || this.current?.status === 'ready') throw new Error(tr('m378'));
    if (card.question.invalidated) throw new Error(tr('m379'));
    const session = makeSession(card.source, card.goal);
    session.reviewOf = card.id;
    session.courseId = card.courseId;
    session.unitId = card.unitId;
    session.focus = card.focus ? structuredClone(card.focus) : undefined;
    if (card.focus) session.previousQuestions = structuredClone(previousQuestions ?? [card.question]);
    if (card.focus) session.reviewFallback = structuredClone(card.question);
    session.allocation = allocation ? structuredClone(allocation) : undefined;
    session.targetQuestions = 1;
    session.outline = [tr('m380')];
    const requested = requestedType(session);
    const regenerate = !!card.focus || allocation && (!allocation.policy.enabled.includes(card.question.type ?? 'short') || (requested && requested !== (card.question.type ?? 'short')));
    session.question = regenerate ? null : { ...card.question, originId: card.question.originId ?? card.question.id, id: crypto.randomUUID(), hints: 0, revealed: false };
    if (regenerate) session.goal += tr('m381', [card.question.prompt, card.question.referenceQuote]);
    else if (session.allocation) session.allocation.displayed[card.question.type ?? 'short'] += 1;
    this.entry(session, 'coach', tr('m382'));
    if (!regenerate) this.entry(session, 'system', tr('m371', [card.question.prompt]));
    this.busy = true;
    try { await this.commit(session); }
    finally { this.busy = false; this.notify(); }
    if (regenerate) await this.perform('next');
  }

  async useReviewFallback(): Promise<void> {
    await this.draftWrite; this.ensureActive();
    const current = this.current; const question = current?.reviewFallback;
    if (this.busy || !current?.reviewOf || !current.error || !current.pending || !['start', 'next'].includes(current.pending.action) || !question || question.invalidated) throw new Error(tr('m383'));
    const type = question.type ?? 'short'; const requested = requestedType(current);
    if (current.allocation && (!current.allocation.policy.enabled.includes(type) || requested && requested !== type)) throw new Error(tr('m384'));
    const next = structuredClone(current);
    next.question = { ...question, id: crypto.randomUUID(), originId: question.originId ?? question.id, hints: 0, revealed: false, reused: true };
    next.pending = null; next.error = null; next.status = 'ready';
    if (next.allocation) next.allocation.displayed[type]++;
    this.entry(next, 'system', tr('m385'));
    this.busy = true; try { await this.commit(next); } finally { this.busy = false; this.notify(); }
  }

  dispose(): void {
    this.disposed = true;
    this.stopRequested = true;
    this.controller?.abort();
  }
}
