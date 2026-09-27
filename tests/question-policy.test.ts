import test from 'node:test';
import assert from 'node:assert/strict';
import { allocationFor, defaultPolicy, emptyCounts, questionPolicySchema, requestedType, type QuestionPolicy } from '../src/question-policy';
import { DEFAULT_SETTINGS, makeSession, parseReply, sessionSchema } from '../src/domain';
import { LearningSession } from '../src/session';
import { reviewCards } from '../src/review';

const source = { path: '课程.md', name: '课程', text: '超时不等于失败，执行结果可能未知。恢复需要保存真实状态与执行标识。', mtime: 1, selection: false };
const single: QuestionPolicy = { enabled: ['single'], mode: 'fixed', weights: { ...emptyCounts(), single: 100 } };
const question = { type: 'single' as const, prompt: '如何理解超时？', referenceQuote: '超时不等于失败，执行结果可能未知。', rubric: '说明结果未知', expectedAnswer: '执行结果未知', options: [{ id: 'A', text: '执行失败' }, { id: 'B', text: '结果未知' }], correctOptions: ['B'] };
const reply = (q = question) => JSON.stringify({ message: '请独立判断。', outline: ['理解超时'], question: q });

test('policy rejects empty selections, duplicate types, zero enabled weights and invalid totals', () => {
  for (const p of [{ ...single, enabled: [] }, { ...single, enabled: ['single', 'single'] }, { ...single, weights: emptyCounts() }, { ...single, weights: { ...single.weights, short: 1 } }]) assert.equal(questionPolicySchema.safeParse(p).success, false);
  assert.equal(questionPolicySchema.safeParse(defaultPolicy()).success, true);
});

test('fixed allocation carries integer deficits across short sessions and freezes its configuration', () => {
  const policy: QuestionPolicy = { enabled: ['single', 'boolean', 'short'], mode: 'fixed', weights: { single: 60, boolean: 30, multiple: 0, short: 10 } };
  const sessions: { courseId: string; allocation: ReturnType<typeof allocationFor> }[] = [];
  const totals = emptyCounts();
  for (let i = 0; i < 100; i++) {
    const allocation = allocationFor(policy, sessions, 'course');
    const type = requestedType({ allocation, attempts: [] })!;
    allocation.displayed[type]++;
    totals[type]++;
    sessions.push({ courseId: 'course', allocation });
  }
  assert.deepEqual(totals, { single: 60, boolean: 30, multiple: 0, short: 10 });
  policy.enabled.splice(0); policy.weights.single = 0;
  assert.equal(sessions[0]!.allocation.policy.weights.single, 60);
  assert.equal(sessions[0]!.allocation.policy.enabled.length, 3);
});

test('adaptive policy accepts only explicitly enabled types and rejects missing type', () => {
  const s = makeSession(source, ''); s.courseId = 'course';
  s.allocation = allocationFor({ ...defaultPolicy(), enabled: ['single', 'short'] }, [], 'course');
  s.pending = { id: 'p', action: 'start', input: '', attemptId: null };
  assert.equal(requestedType(s), null);
  assert.equal(parseReply(reply(), s).question?.type, 'single');
  assert.throws(() => parseReply(reply({ ...question, type: undefined as never }), s));
  assert.throws(() => parseReply(JSON.stringify({ message: '试试', outline: ['目标'], question: { ...question, type: 'boolean', options: [{ id: 'A', text: '正确' }, { id: 'B', text: '错误' }] } }), s));
});

test('failed generation, restart and retry preserve allocation; skipped displayed questions still count', async () => {
  let fail = true;
  const deps = { settings: () => DEFAULT_SETTINGS, changed() {}, save: async () => {}, ask: async () => { if (fail) throw new Error('测试失败'); return reply(); } };
  const engine = new LearningSession(null, deps);
  await engine.start(source, '', { courseId: 'course', unitId: 'unit', allocation: allocationFor(single, [], 'course') });
  assert.equal(engine.current!.allocation!.displayed.single, 0);
  assert.ok(engine.current!.pending);
  const restarted = new LearningSession(sessionSchema.parse(engine.current), deps);
  fail = false;
  await restarted.retry();
  assert.equal(restarted.current!.allocation!.displayed.single, 1);
  await restarted.perform('next');
  assert.equal(restarted.current!.allocation!.displayed.single, 2);
  assert.equal(restarted.current!.attempts.length, 0);
});

test('review regenerates disabled question type without falling back after failure', async () => {
  const s = makeSession(source, '复习'); s.courseId = 'course';
  s.attempts.push({ id: 'a', question: { ...question, type: 'short', options: [], correctOptions: [], id: 'old', hints: 0, revealed: false }, answer: '未知', at: s.createdAt, assessment: { verdict: 'correct', feedback: '符合依据' }, revisions: [] });
  const card = reviewCards([s], {})[0]!;
  let fail = true;
  const engine = new LearningSession(null, { settings: () => DEFAULT_SETTINGS, changed() {}, save: async () => {}, ask: async () => { if (fail) throw new Error('测试失败'); return reply(); } });
  await engine.startReview(card, allocationFor(single, [], 'course'));
  assert.equal(engine.current!.question, null);
  assert.equal(engine.current!.reviewOf, card.id);
  assert.ok(engine.current!.pending);
  fail = false; await engine.retry();
  assert.equal(engine.current!.question!.type, 'single');
  assert.equal(engine.current!.allocation!.displayed.single, 1);
  assert.equal(engine.current!.attempts.length, 0);
});
