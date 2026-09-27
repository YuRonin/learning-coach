import test from 'node:test';
import assert from 'node:assert/strict';
import { nearDuplicate, validateQuality } from '../src/quality';
import { examTypes } from '../src/exam';
import { emptyCounts, allocationFor } from '../src/question-policy';
import { makeSession, DEFAULT_SETTINGS, summarizeSession } from '../src/domain';
import { reviewCards } from '../src/review';
import { LearningSession } from '../src/session';
import { proposeKnowledge, validatePrerequisites } from '../src/knowledge';

const text = '超时不等于失败，执行结果可能未知。恢复需要保存真实状态与执行标识。';
const point = proposeKnowledge(text, '超时')[0]!;
const question = { type: 'short' as const, prompt: '没有收到响应时可以怎样核实状态？', referenceQuote: text, expectedAnswer: '查询保存的状态。', rubric: '说明状态查询。', options: [], correctOptions: [] };
test('exam integer types are deterministic and never include disabled categories', () => {
  const policy = { enabled: ['single', 'boolean'] as ('single' | 'boolean')[], mode: 'fixed' as const, weights: { ...emptyCounts(), single: 70, boolean: 30 } };
  const types = examTypes(policy, 10);
  assert.equal(types.filter(t => t === 'single').length, 7);
  assert.equal(types.filter(t => t === 'boolean').length, 3);
  assert.throws(() => examTypes(policy, 0));
});
test('local quality checks reject leaked answers and cosmetic rewrites', () => {
  assert.ok(nearDuplicate('为什么超时不能认定失败？', '为什么超时不能认定失败!'));
  assert.throws(() => validateQuality({ ...question, prompt: '正确答案：A，请选择。' }, []));
  assert.throws(() => validateQuality(question, [{ ...question, id: 'q', hints: 0, revealed: false }]));
});
test('uncertain independent review never displays a question or creates evidence', async () => {
  let calls = 0;
  const engine = new LearningSession(null, { save: async () => {}, changed() {}, settings: () => DEFAULT_SETTINGS,
    ask: async messages => { calls++; return JSON.parse(messages.at(-1)!.content).action === 'quality-check' ? JSON.stringify({ verdict: 'uncertain', reason: '材料不足。' }) : JSON.stringify({ message: '请回答', outline: ['核实状态'], question }); } });
  await engine.start({ path: 'c.md', name: 'c', text, mtime: 1, selection: true }, '', { courseId: 'c', unitId: 'u', focus: point,
    allocation: allocationFor({ enabled: ['short'], mode: 'fixed', weights: { ...emptyCounts(), short: 100 } }, [], 'c') });
  assert.equal(calls, 2); assert.equal(engine.current!.question, null); assert.equal(engine.current!.attempts.length, 0);
  assert.equal(engine.current!.allocation!.displayed.short, 0); assert.match(engine.current!.error!, /审题未通过/);
});
test('exam sessions disallow hints and skipping, while ordinary follow-up can preserve independence', async () => {
  const s = makeSession({ path: 'c.md', name: 'c', text, mtime: 1, selection: true }, ''); s.question = { ...question, id: 'q', hints: 0, revealed: false }; s.examId = 'exam';
  const engine = new LearningSession(s, { save: async () => {}, changed() {}, settings: () => DEFAULT_SETTINGS, ask: async () => JSON.stringify({ message: '可以明天继续学习。', question: null, assessment: null, helpExposure: 'none' }) });
  await assert.rejects(engine.perform('hint'), /章节检验/); await assert.rejects(engine.perform('next'), /章节检验/);
  delete s.examId; await engine.perform('ask', '明天可以继续吗？'); assert.equal(engine.current!.question!.revealed, false);
});
test('cyclic or missing prerequisites are rejected', () => {
  const b = { ...point, id: 'b', prerequisites: [point.id] };
  assert.throws(() => validatePrerequisites([{ ...point, prerequisites: ['b'] }, b]), /循环/);
  assert.throws(() => validatePrerequisites([{ ...point, prerequisites: ['missing'] }]), /停用/);
});

test('failed review can explicitly reuse an allowed original, but it cannot award independent evidence', async () => {
  const s = makeSession({ path: 'c.md', name: 'c', text, mtime: 1, selection: true }, '');
  s.courseId = 'c'; s.unitId = 'u'; s.focus = point;
  s.attempts.push({ id: 'a', question: { ...question, id: 'q', hints: 0, revealed: false }, answer: '查询状态', at: s.createdAt, revisions: [], assessment: { verdict: 'correct', feedback: '符合要点' } });
  const card = reviewCards([s])[0]!;
  const engine = new LearningSession(null, { save: async () => {}, changed() {}, settings: () => DEFAULT_SETTINGS, ask: async () => { throw new Error('offline'); } });
  await engine.startReview(card, allocationFor({ enabled: ['short'], mode: 'adaptive', weights: emptyCounts() }, [], 'c'));
  await engine.useReviewFallback(); assert.equal(engine.current!.question!.reused, true);
  const result = structuredClone(engine.current!);
  result.attempts.push({ ...s.attempts[0]!, id: 'b', question: result.question!, at: new Date(Date.now() + 86400000).toISOString() });
  assert.match(summarizeSession(result).join('\n'), /独立作答且符合要点 0 次/);
  assert.equal(reviewCards([s, result])[0]!.streak, 0);
  const blocked = new LearningSession(null, { save: async () => {}, changed() {}, settings: () => DEFAULT_SETTINGS, ask: async () => { throw new Error('offline'); } });
  await blocked.startReview(card, allocationFor({ enabled: ['single'], mode: 'adaptive', weights: emptyCounts() }, [], 'c'));
  await assert.rejects(blocked.useReviewFallback(), /不能回退/);
});

test('submitted exam regrading preserves one answer and the original grade across failure and retry', async () => {
  const s = makeSession({ path: 'c.md', name: 'c', text, mtime: 1, selection: true }, '');
  s.examId = 'exam'; s.status = 'ended';
  s.attempts.push({ id: 'a', question: { ...question, id: 'q', hints: 0, revealed: false }, answer: '查询状态', at: s.createdAt, revisions: [], assessment: { verdict: 'incorrect', feedback: '原评价' } });
  let calls = 0;
  const deps = { save: async () => {}, changed() {}, settings: () => DEFAULT_SETTINGS, examFinished: () => true, ask: async () => { if (++calls === 1) throw new Error('offline'); return JSON.stringify({ message: '已核对原文', question: null, assessment: { verdict: 'correct', feedback: '符合依据' } }); } };
  const engine = new LearningSession(s, deps);
  await engine.perform('dispute', '我的回答包含查询状态。');
  assert.equal(engine.current!.attempts[0]!.assessment!.verdict, 'incorrect');
  const resumed = new LearningSession(structuredClone(engine.current), deps);
  await resumed.retry();
  assert.equal(resumed.current!.status, 'ended'); assert.equal(resumed.current!.attempts.length, 1);
  assert.equal(resumed.current!.attempts[0]!.revisions[0]!.feedback, '原评价');
  assert.equal(resumed.current!.attempts[0]!.assessment!.verdict, 'correct');
  await assert.rejects(resumed.perform('next'), /恢复学习/);
  const unfinished = structuredClone(s); unfinished.status = 'ready'; unfinished.question = { ...question, id: 'unanswered', hints: 0, revealed: false };
  const closed = new LearningSession(unfinished, deps);
  await assert.rejects(closed.perform('answer', '交卷后补答'), /已交卷/);
  unfinished.pending = { id: 'pending', action: 'answer', input: '交卷后重试', attemptId: 'a' };
  await assert.rejects(closed.retry(), /已交卷/);
});
