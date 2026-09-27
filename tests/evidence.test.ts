import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, draftContext, exportSession, makeSession, questionSchema, sessionSchema, summarizeSession, type Session } from '../src/domain';
import { setQuestionValidity } from '../src/evidence';
import { unitEvidence } from '../src/course';
import { reviewCards } from '../src/review';
import { LearningSession } from '../src/session';
import { buildMessages } from '../src/prompts';

const source = { path: '测试课程/状态.md', name: '状态', text: '超时不等于失败，执行结果可能未知。应先查询真实状态。', mtime: 1, selection: false };
const question = questionSchema.parse({ id: 'q1', type: 'single', prompt: '超时说明什么？', options: [{ id: 'A', text: '必然失败' }, { id: 'B', text: '结果未知' }], correctOptions: ['B'],
  referenceQuote: '超时不等于失败，执行结果可能未知。', rubric: '区分结果未知与失败', expectedAnswer: 'B，超时只能说明未收到响应。' });

function evidence(id: string, at: string, prompt = question.prompt): Session {
  const s = makeSession(structuredClone(source), '理解状态');
  s.id = id; s.courseId = 'course'; s.unitId = source.path;
  s.attempts.push({ id: `attempt-${id}`, at, question: { ...structuredClone(question), id: `q-${id}`, prompt }, answer: 'B', assessment: { verdict: 'correct', feedback: '符合要点' }, revisions: [] });
  return s;
}
const initial = () => evidence('initial', '2026-09-20T08:00:00Z');
const later = () => evidence('later', '2026-09-22T08:00:00Z', '保存后断网，应如何判断执行结果？');

test('new material cannot borrow old evidence even when timestamps accidentally match', () => {
  const a = initial(), b = later(); b.source.text += '新内容。';
  assert.equal(unitEvidence('course', source.path, [a, b], 1).label, '练习中');
  b.source = { ...source, mtime: 2 };
  assert.equal(unitEvidence('course', source.path, [a, b], 2).label, '练习中');
});

test('punctuation changes do not count as a new question and a gap resets stability evidence', () => {
  const a = initial(), b = later(); b.attempts[0]!.question.prompt = '超 时说明什么!';
  assert.equal(unitEvidence('course', source.path, [a, b]).label, '练习中');
  const failed = evidence('failed', '2026-09-21T08:00:00Z'); failed.attempts[0]!.assessment!.verdict = 'incorrect';
  assert.equal(unitEvidence('course', source.path, [a, failed, later()]).label, '练习中');
});

test('voiding a question propagates to legacy review copies but not different questions or source versions', () => {
  const a = initial(), copy = evidence('copy', '2026-09-21T08:00:00Z'), other = later(), changed = initial();
  copy.reviewOf = `${a.id}/${a.attempts[0]!.question.id}`;
  changed.id = 'new-source'; changed.source.mtime = 2;
  const original = structuredClone(a.attempts[0]);
  assert.equal(setQuestionValidity([a, copy, other, changed], a.source, a.attempts[0]!.question, '有两个合理答案', '2026-09-23T08:00:00Z'), 2);
  assert.equal(a.attempts[0]!.answer, original!.answer);
  assert.deepEqual(a.attempts[0]!.assessment, original!.assessment);
  assert.ok(copy.attempts[0]!.question.invalidated);
  assert.equal(other.attempts[0]!.question.invalidated, undefined);
  assert.equal(changed.attempts[0]!.question.invalidated, undefined);
  assert.equal(reviewCards([a, copy]).length, 0);
  assert.equal(unitEvidence('course', source.path, [a, copy]).label, '未诊断');
  assert.match(exportSession(a), /已作废/);
  assert.match(summarizeSession(a).join('\n'), /没有足够的有效/);
  assert.equal(setQuestionValidity([a, copy], a.source, a.attempts[0]!.question, null, '2026-09-24T08:00:00Z'), 2);
  assert.equal(reviewCards([a, copy]).length, 1);
  assert.equal(a.entries.length, 2);
});

test('a voided review does not discard valid alternative questions in the same review chain', () => {
  const a = initial(), b = later(); b.reviewOf = `${a.id}/${a.attempts[0]!.question.id}`;
  setQuestionValidity([a, b], a.source, a.attempts[0]!.question, '题干含糊', '2026-09-23T08:00:00Z');
  assert.equal(reviewCards([a, b]).length, 1);
  assert.equal(reviewCards([a, b])[0]!.question.id, b.attempts[0]!.question.id);
  assert.equal(reviewCards([a, b])[0]!.streak, 1);
});

test('voided attempts remain persisted but are excluded from model evidence and remediation', () => {
  const s = initial();
  setQuestionValidity([s], s.source, s.attempts[0]!.question, '材料不支持', '2026-09-23T08:00:00Z');
  const restored = sessionSchema.parse(JSON.parse(JSON.stringify(s)));
  restored.pending = { id: 'p', action: 'next', input: '', attemptId: null };
  const context = JSON.parse(buildMessages(restored)[1]!.content);
  assert.deepEqual(context.recentEvidence, []);
  assert.equal(context.remediation, null);
  assert.equal(restored.attempts[0]!.question.invalidated?.reason, '材料不支持');
});

test('review streak does not carry over a changed source snapshot', () => {
  const a = initial(), b = later(); b.reviewOf = `${a.id}/${a.attempts[0]!.question.id}`; b.source.text += '修订';
  assert.equal(reviewCards([a, b])[0]!.streak, 1);
});

test('saving selection and confidence immediately before submission freezes both once', async () => {
  const s = makeSession(source, ''); s.question = structuredClone(question);
  const engine = new LearningSession(s, { save: async () => { await new Promise(resolve => setTimeout(resolve, 2)); },
    ask: async () => { throw new Error('unexpected model request'); }, settings: () => DEFAULT_SETTINGS, changed: () => {} });
  const choice = ['B'];
  const saving = engine.saveChoiceDraft(choice, 'guessed', draftContext(s)); choice[0] = 'A';
  await Promise.all([saving, engine.saveDraft('我的追问', draftContext(s))]);
  assert.deepEqual(engine.current?.choiceDraft, ['B']);
  await Promise.allSettled([engine.perform('answer', 'B'), engine.perform('answer', 'B')]);
  assert.equal(engine.current?.attempts.length, 1);
  assert.equal(engine.current?.attempts[0]!.confidence, 'guessed');
});

test('stale draft writes cannot overwrite a restored different session', async () => {
  const a = makeSession(source, ''); a.question = structuredClone(question);
  const engine = new LearningSession(a, { save: async () => {}, ask: async () => '', settings: () => DEFAULT_SETTINGS, changed: () => {} });
  const b = makeSession(source, ''); b.question = structuredClone(question); b.draft = '新会话';
  await engine.restore(b);
  await engine.saveChoiceDraft(['A'], 'certain', draftContext(a));
  await engine.saveDraft('旧会话迟到的草稿', draftContext(a));
  assert.equal(engine.current?.draft, '新会话');
  assert.equal(engine.current?.choiceDraft, undefined);
});

test('disposed engines cannot submit or restore state after a plugin reload', async () => {
  const s = makeSession(source, ''); s.question = structuredClone(question); let writes = 0;
  const engine = new LearningSession(s, { save: async () => { writes++; }, ask: async () => '', settings: () => DEFAULT_SETTINGS, changed: () => {} });
  engine.dispose();
  await assert.rejects(engine.perform('answer', 'B'), /插件已关闭/);
  await assert.rejects(engine.restore(s), /插件已关闭/);
  assert.equal(writes, 0);
});

test('a voided unanswered question remains inspectable and reversible after switching questions', async () => {
  const s = makeSession(source, ''); s.question = structuredClone(question);
  setQuestionValidity([s], source, s.question, '题干不清楚', '2026-09-23T08:00:00Z');
  const engine = new LearningSession(s, { save: async () => {},
    ask: async () => JSON.stringify({ message: '换个情境试试看。', question: { ...question, prompt: '未收到保存响应时应先做什么？' } }),
    settings: () => DEFAULT_SETTINGS, changed: () => {} });
  await assert.rejects(engine.perform('answer', 'B'), /已作废/);
  await engine.perform('next');
  const next = sessionSchema.parse(JSON.parse(JSON.stringify(engine.current)));
  assert.equal(next.retiredQuestions?.length, 1);
  assert.equal(next.attempts.length, 0);
  assert.match(exportSession(next), /题干不清楚/);
  setQuestionValidity([next], source, next.retiredQuestions![0]!, null, '2026-09-24T08:00:00Z');
  assert.equal(next.retiredQuestions![0]!.invalidated, undefined);
  assert.equal(next.question?.prompt, '未收到保存响应时应先做什么？');
});
