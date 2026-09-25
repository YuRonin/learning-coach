import test from 'node:test';
import assert from 'node:assert/strict';
import { LearningSession } from '../src/session';
import { DEFAULT_SETTINGS, makeSession, parseReply, exportSession, sessionSchema, type Session } from '../src/domain';
import type { ChatMessage } from '../src/api';

const source = { path: '笔记/Harness.md', name: 'Harness', text: '超时不等于失败，执行结果可能未知。恢复需要保存真实状态与执行标识。', mtime: 42, selection: false };
const question = { prompt: '为什么超时后不能直接重试？', referenceQuote: '超时不等于失败，执行结果可能未知。', rubric: '指出请求可能已经执行成功。', expectedAnswer: '可能已经执行但回执丢失，应先查询结果。' };
const questionReply = JSON.stringify({ message: '先用一个情境看看你的理解。', outline: ['能区分超时与失败'], question, assessment: null });
const answerReply = JSON.stringify({ message: '你指出了执行成功但回执丢失的可能。', outline: [], question: null, assessment: { verdict: 'correct', feedback: '回答覆盖了结果未知这一关键点。' } });
const hintReply = JSON.stringify({ message: '如果请求已执行，只是响应没有回来呢？', question: null, assessment: null });

function fixture(initial: Session | null = null) {
  let persisted: Session | null = initial;
  let response = questionReply;
  let asks = 0;
  let model: ((messages: ChatMessage[], signal: AbortSignal) => Promise<string>) | null = null;
  const saved: Session[] = [];
  const settings = { ...DEFAULT_SETTINGS, model: 'fixture' };
  const engine = new LearningSession(initial, {
    save: async value => { persisted = structuredClone(value); saved.push(persisted); },
    ask: async (messages, signal) => { asks++; return model ? model(messages, signal) : response; },
    settings: () => settings,
    changed: () => {},
  });
  return { engine, settings, saved, setResponse: (value: string) => { response = value; },
    setModel: (value: typeof model) => { model = value; },
    persisted: () => persisted, asks: () => asks };
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error('Condition did not become true');
}

test('starts with a sourced question and no invented evidence', async () => {
  const f = fixture(); await f.engine.start(source, '理解超时');
  assert.equal(f.engine.current?.question?.referenceQuote, question.referenceQuote);
  assert.equal(f.engine.current?.attempts.length, 0);
  assert.equal(f.engine.current?.calls, 1);
  assert.equal(f.engine.current?.pending, null);
});

test('rejects oversized or empty source without sending data', async () => {
  const f = fixture();
  await assert.rejects(f.engine.start({ ...source, text: 'x'.repeat(24_001) }, ''), /24,000/);
  await assert.rejects(f.engine.start({ ...source, text: '  ' }, ''), /没有/);
  assert.equal(f.asks(), 0);
});

test('persists the original answer before requesting a grade', async () => {
  const f = fixture(); await f.engine.start(source, '');
  f.setModel(async () => {
    assert.equal(f.persisted()?.attempts[0]?.answer, '可能成功但回执丢失');
    assert.equal(f.persisted()?.attempts[0]?.assessment, null);
    return answerReply;
  });
  await f.engine.perform('answer', '可能成功但回执丢失');
  assert.equal(f.engine.current?.attempts.length, 1);
  assert.equal(f.engine.current?.attempts[0]?.assessment?.verdict, 'correct');
  assert.equal(f.engine.current?.question, null);
});

test('retry preserves one answer and never creates duplicate evidence', async () => {
  const f = fixture(); await f.engine.start(source, '');
  f.setModel(async () => { throw new Error('network down'); });
  await f.engine.perform('answer', '结果未知');
  const id = f.engine.current?.attempts[0]?.id;
  assert.ok(f.engine.current?.pending);
  f.setModel(null); f.setResponse(answerReply);
  await f.engine.retry();
  assert.equal(f.engine.current?.attempts.length, 1);
  assert.equal(f.engine.current?.attempts[0]?.id, id);
  assert.equal(f.engine.current?.entries.filter(e => e.role === 'user').length, 1);
});

test('restart restores pending work and resumes without repeating a submission', async () => {
  const f = fixture(); await f.engine.start(source, '');
  f.setModel(async () => { throw new Error('offline'); });
  await f.engine.perform('answer', '服务端可能执行了');
  const disk = sessionSchema.parse(JSON.parse(JSON.stringify(f.persisted())));
  disk.status = 'paused';
  const recovered = fixture(disk); recovered.setResponse(answerReply);
  await recovered.engine.resume(); await recovered.engine.retry();
  assert.equal(recovered.engine.current?.attempts.length, 1);
  assert.equal(recovered.engine.current?.attempts[0]?.assessment?.verdict, 'correct');
});

test('hints and revealed explanations are recorded as learning conditions', async () => {
  const f = fixture(); await f.engine.start(source, '');
  f.setResponse(hintReply); await f.engine.perform('hint'); await f.engine.perform('explain');
  f.setResponse(answerReply); await f.engine.perform('answer', '回执丢了');
  assert.equal(f.engine.current?.attempts[0]?.question.hints, 1);
  assert.equal(f.engine.current?.attempts[0]?.question.revealed, true);
});

test('skip generates no successful answer', async () => {
  const f = fixture(); await f.engine.start(source, '');
  const oldId = f.engine.current?.question?.id;
  await f.engine.perform('next');
  assert.equal(f.engine.current?.attempts.length, 0);
  assert.notEqual(f.engine.current?.question?.id, oldId);
  assert.ok(f.engine.current?.entries.some(e => e.text.includes('跳过')));
});

test('rejects fabricated citations and grading during hint actions', async () => {
  const f = fixture(); await f.engine.start(source, '');
  f.setResponse(JSON.stringify({ message: 'hi', question: { ...question, referenceQuote: '这是一段笔记里面不存在的内容。' }, assessment: null }));
  await f.engine.perform('next');
  assert.match(f.engine.current?.error ?? '', /引用/);
  assert.equal(f.engine.current?.question, null);
  const session = makeSession(source, '');
  session.pending = { id: 'pending', action: 'hint', input: '', attemptId: null };
  assert.throws(() => parseReply(answerReply, session), /提示环节/);
});

test('two concurrent answer submissions cannot both enter the model', async () => {
  const f = fixture(); await f.engine.start(source, '');
  let complete!: (value: string) => void;
  f.setModel(() => new Promise(resolve => { complete = resolve; }));
  const first = f.engine.perform('answer', '答案一');
  await assert.rejects(f.engine.perform('answer', '答案二'), /上一轮/);
  await waitFor(() => f.asks() === 2); complete(answerReply); await first;
  assert.equal(f.engine.current?.attempts.length, 1);
  assert.equal(f.engine.current?.attempts[0]?.answer, '答案一');
});

test('pause discards late model results even if transport ignores cancellation', async () => {
  const f = fixture(); await f.engine.start(source, '');
  let complete!: (value: string) => void;
  f.setModel(() => new Promise(resolve => { complete = resolve; }));
  const running = f.engine.perform('answer', '答案');
  await waitFor(() => f.asks() === 2);
  await f.engine.pause(); complete(answerReply); await running;
  assert.equal(f.engine.current?.status, 'paused');
  assert.equal(f.engine.current?.attempts[0]?.assessment, null);
  assert.ok(f.engine.current?.pending);
});

test('grading revision retains original answer and previous assessment', async () => {
  const f = fixture(); await f.engine.start(source, '');
  f.setResponse(answerReply); await f.engine.perform('answer', '原始答案');
  f.setResponse(JSON.stringify({ message: '复核后发现依据不足。', question: null, assessment: { verdict: 'uncertain', feedback: '需要更多依据。' } }));
  await f.engine.perform('dispute', '这段原文没有支持这个推论');
  const attempt = f.engine.current?.attempts[0];
  assert.equal(attempt?.answer, '原始答案');
  assert.equal(attempt?.assessment?.verdict, 'uncertain');
  assert.equal(attempt?.revisions[0]?.verdict, 'correct');
});

test('call budget stops before issuing another request', async () => {
  const f = fixture(); await f.engine.start(source, '');
  f.settings.maxCalls = 1;
  await assert.rejects(f.engine.perform('hint'), /上限/);
  assert.equal(f.asks(), 1);
});

test('ending without answers does not claim mastery and disallows further actions', async () => {
  const f = fixture(); await f.engine.start(source, ''); await f.engine.end();
  assert.equal(f.engine.current?.attempts.length, 0);
  assert.equal(f.engine.current?.status, 'ended');
  await assert.rejects(f.engine.perform('answer', '答案'), /开始或恢复/);
});

test('draft is persisted and exported records contain evidence, not API secrets', async () => {
  const f = fixture(); await f.engine.start(source, ''); await f.engine.saveDraft('还没写完');
  assert.equal(f.persisted()?.draft, '还没写完');
  f.setResponse(answerReply); await f.engine.perform('answer', '已提交的答案');
  const markdown = exportSession(f.engine.current!);
  assert.match(markdown, /已提交的答案/);
  assert.match(markdown, /\[\[笔记\/Harness.md\]\]/);
  assert.doesNotMatch(markdown, /apiKey|Authorization/);
  assert.equal(f.engine.current?.draft, '');
});

test('model call is not made if persisting the real answer fails', async () => {
  const f = fixture(); await f.engine.start(source, '');
  let calls = 0;
  const engine = new LearningSession(f.engine.current, {
    save: async () => { throw new Error('disk full'); },
    ask: async () => { calls++; return answerReply; }, settings: () => f.settings, changed: () => {},
  });
  await assert.rejects(engine.perform('answer', '不能丢失的答案'), /disk full/);
  assert.equal(calls, 0);
  assert.equal(engine.current?.attempts.length, 0);
  assert.equal(engine.busy, false);
});

test('submitting while draft autosave is in progress waits and keeps the answer', async () => {
  const f = fixture(); await f.engine.start(source, '');
  let release!: () => void;
  let writes = 0;
  const engine = new LearningSession(f.engine.current, {
    save: async () => { if (++writes === 1) await new Promise<void>(resolve => { release = resolve; }); },
    ask: async () => answerReply, settings: () => f.settings, changed: () => {},
  });
  const saving = engine.saveDraft('正在输入的答案');
  await waitFor(() => writes === 1);
  const submitted = engine.perform('answer', '完整的提交答案');
  const result = submitted.then(() => null, error => error);
  release();
  await saving;
  assert.equal(await result, null);
  assert.equal(engine.current?.attempts[0]?.answer, '完整的提交答案');
});
