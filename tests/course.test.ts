import test from 'node:test';
import assert from 'node:assert/strict';
import { courseUnits, unitEvidence } from '../src/course';
import { dataSchema, DEFAULT_SETTINGS, gradeChoice, makeSession, parseReply, questionSchema, validateQuestion } from '../src/domain';
import { LearningSession } from '../src/session';
import { reviewCards } from '../src/review';

const source = { path: '课程/第一章.md', name: '第一章', text: '超时不等于失败，执行结果可能未知。恢复需要保存真实状态与执行标识。', mtime: 1, selection: false };
const question = questionSchema.parse({ id: 'q', type: 'single', prompt: '超时是否说明失败？',
  options: [{ id: 'A', text: '一定失败' }, { id: 'B', text: '结果未知' }], correctOptions: ['B'],
  referenceQuote: '超时不等于失败，执行结果可能未知。', rubric: '区分超时和失败', expectedAnswer: '超时只表示没有及时收到响应。' });

test('course folder boundary excludes neighboring folders and naturally orders units', () => {
  const units = courseUnits(['课程/10.md', '课程/2.md', '课程备份/1.md', '其他.md'].map(path => ({ path, basename: path })), '课程/');
  assert.deepEqual(units.map(u => u.path), ['课程/2.md', '课程/10.md']);
});

test('old plugin data loads without erasing configuration or requiring courses', () => {
  const data = dataSchema.parse({ version: 1, settings: { ...DEFAULT_SETTINGS, baseUrl: 'https://example.test/v1' }, session: makeSession(source, ''), archive: [] });
  assert.deepEqual(data.courses, []);
  assert.equal(data.settings.baseUrl, 'https://example.test/v1');
});

test('connection fields can be absent from the version 5 syncable settings payload', () => {
  const data = dataSchema.parse({ version: 5, settings: { model: 'fixture-model' }, session: null, archive: [] });
  assert.equal(data.version, 5);
  assert.equal(data.settings.apiKey, '');
  assert.equal(data.settings.baseUrl, 'https://api.openai.com/v1');
});

test('invalid candidate choice keys, duplicate options and malformed boolean questions are rejected', () => {
  assert.throws(() => validateQuestion({ ...question, correctOptions: ['C'] }));
  assert.throws(() => validateQuestion({ ...question, options: [question.options![0]!, question.options![0]!] }));
  assert.throws(() => validateQuestion({ ...question, type: 'boolean' }));
  assert.throws(() => validateQuestion({ ...question, type: 'multiple' }));
});

test('choice grading requires an exact valid selection including all multi-select answers', () => {
  assert.equal(gradeChoice(question, 'B')?.verdict, 'correct');
  assert.equal(gradeChoice(question, 'A')?.verdict, 'incorrect');
  assert.throws(() => gradeChoice(question, 'C'));
  assert.throws(() => gradeChoice(question, 'B,B'));
  const multi = { ...question, type: 'multiple' as const, correctOptions: ['A', 'B'] };
  assert.equal(gradeChoice(multi, 'B,A')?.verdict, 'correct');
  assert.equal(gradeChoice(multi, 'A')?.verdict, 'incorrect');
});

test('objective submission persists one real attempt and grades without network even at call limit', async () => {
  const session = makeSession(source, ''); session.question = question; session.calls = 30;
  session.courseId = 'course'; session.unitId = source.path;
  const saved: typeof session[] = [];
  const engine = new LearningSession(session, { save: async s => { saved.push(structuredClone(s)); },
    ask: async () => { throw new Error('must not call model'); }, settings: () => DEFAULT_SETTINGS, changed: () => {} });
  await engine.perform('answer', 'B');
  assert.equal(saved[0]!.attempts[0]!.assessment, null);
  assert.equal(engine.current?.attempts.length, 1);
  assert.equal(engine.current?.attempts[0]?.assessment?.verdict, 'correct');
  assert.equal(engine.current?.calls, 30);
  assert.equal(engine.current?.courseId, 'course');
  assert.equal(engine.current?.pending, null);
});

function evidence() {
  const session = makeSession(source, ''); session.courseId = 'course'; session.unitId = source.path;
  session.attempts.push({ id: 'a', question, answer: 'B', at: '2026-09-20T08:00:00Z', assessment: { verdict: 'correct', feedback: '符合答案' }, revisions: [] });
  return session;
}

test('stable course evidence requires delayed independent answers to different questions and regresses after gaps', () => {
  const s = evidence();
  assert.equal(unitEvidence('course', source.path, [s]).label, '练习中');
  s.attempts.push({ ...s.attempts[0]!, id: 'b', at: '2026-09-22T08:00:00Z' });
  assert.equal(unitEvidence('course', source.path, [s]).label, '练习中');
  s.attempts[1]!.question = { ...question, prompt: '网络超时但服务端已保存，应如何判断？' };
  assert.equal(unitEvidence('course', source.path, [s]).label, '暂时稳定');
  s.attempts[1]!.confidence = 'guessed';
  assert.equal(unitEvidence('course', source.path, [s]).label, '待巩固');
});

test('same-day repeats never accelerate spacing and unsure answers reset it', () => {
  const initial = evidence();
  const review = evidence(); review.id = 'r'; review.reviewOf = `${initial.id}/${question.id}`;
  review.attempts[0]!.id = 'b'; review.attempts[0]!.at = '2026-09-20T09:00:00Z';
  assert.equal(reviewCards([initial, review])[0]!.streak, 1);
  review.attempts[0]!.confidence = 'unsure';
  assert.equal(reviewCards([initial, review])[0]!.streak, 0);
  assert.equal(reviewCards([initial, review])[0]!.courseId, 'course');
});

test('course generation rejects wrong question types and previously answered prompts', () => {
  const s = evidence();
  s.pending = { id: 'p', action: 'next', input: '', attemptId: null };
  const reply = { message: '重新思考这个概念。', question, assessment: null };
  assert.throws(() => parseReply(JSON.stringify(reply), s), /题型/);
  const boolean = { ...question, type: 'boolean', options: [{ id: 'A', text: '正确' }, { id: 'B', text: '错误' }] };
  assert.throws(() => parseReply(JSON.stringify({ ...reply, question: boolean }), s), /重复/);
});

test('edited sources mark old course evidence as stale', () => {
  const s = evidence();
  assert.equal(unitEvidence('course', source.path, [s], 2).label, '材料已更新');
  assert.equal(unitEvidence('course', source.path, [s], 1).label, '练习中');
});

test('a pending local grade recovers after restart without another attempt or a network call', async () => {
  const session = evidence();
  session.attempts[0]!.assessment = null;
  session.pending = { id: 'pending', action: 'answer', input: 'B', attemptId: 'a' };
  session.question = question;
  session.status = 'paused';
  const engine = new LearningSession(session, { save: async () => {},
    ask: async () => { throw new Error('must not call model'); }, settings: () => DEFAULT_SETTINGS, changed: () => {} });
  await engine.resume(); await engine.retry();
  assert.equal(engine.current?.attempts.length, 1);
  assert.equal(engine.current?.attempts[0]?.assessment?.verdict, 'correct');
  assert.equal(engine.current?.pending, null);
});
