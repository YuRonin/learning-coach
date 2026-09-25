import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSession, splitNote, dataSchema, DEFAULT_SETTINGS, extractJson } from '../src/domain';
import { addDays, localDate, reviewCards } from '../src/review';

const source = { path: 'study.md', name: 'study', text: '超时不等于失败，执行结果可能未知。', mtime: 1, selection: false };
function recorded(verdict: 'correct' | 'partial' | 'uncertain' = 'correct') {
  const session = makeSession(source, '理解超时');
  session.id = 'original';
  session.attempts.push({ id: 'attempt1', at: new Date(2026, 8, 25, 10).toISOString(), answer: '可能只是回执丢失',
    question: { id: 'q1', prompt: '为何不能直接重试？', referenceQuote: source.text, rubric: '结果未知', expectedAnswer: '查询执行状态', hints: 0, revealed: false },
    assessment: { verdict, feedback: '依据原文检查' }, revisions: [] });
  return session;
}

test('review dates use local calendar dates and cross month/year boundaries', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(localDate(new Date(2026, 8, 25, 0, 1)), '2026-09-25');
});

test('first evidence schedules the next day, successful review advances to three days', () => {
  const original = recorded();
  const review = recorded();
  review.id = 'review'; review.reviewOf = 'original/q1';
  review.attempts[0]!.id = 'attempt2';
  review.attempts[0]!.at = new Date(2026, 8, 26, 10).toISOString();
  assert.equal(reviewCards([original])[0]?.due, '2026-09-26');
  const cards = reviewCards([review, original]);
  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.due, '2026-09-29');
  assert.equal(cards[0]?.streak, 2);
});

test('hints or revealed answers reset the interval and do not count as independent repetitions', () => {
  const session = recorded(); session.attempts[0]!.question.hints = 1;
  const card = reviewCards([session])[0]!;
  assert.equal(card.streak, 0);
  assert.equal(card.due, '2026-09-26');
  assert.match(card.reason, /提示或讲解/);
});

test('regrading and duplicate session references do not create extra repetitions', () => {
  const session = recorded();
  session.attempts[0]!.revisions.push({ verdict: 'partial', feedback: 'earlier assessment' });
  const cards = reviewCards([session, session]);
  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.streak, 1);
  session.attempts[0]!.assessment!.verdict = 'partial';
  assert.equal(reviewCards([session])[0]?.streak, 0);
});

test('ungraded submissions do not enter review and uncertain grades remain visibly uncertain', () => {
  const session = recorded(); session.attempts[0]!.assessment = null;
  assert.equal(reviewCards([session]).length, 0);
  assert.match(reviewCards([recorded('uncertain')])[0]!.reason, /待核实/);
});

test('snooze changes the due date but not the learning evidence', () => {
  const session = recorded();
  assert.equal(reviewCards([session], { 'original/q1': '2026-09-30' })[0]?.due, '2026-09-30');
  assert.equal(session.attempts.length, 1);
});

test('long note splitting preserves every character without over-limit chunks', () => {
  const text = '# 标题\n' + '段落。\n'.repeat(13000);
  const parts = splitNote(text);
  assert.ok(parts.length > 1);
  assert.equal(parts.map(part => part.text).join(''), text);
  assert.ok(parts.every(part => part.text.length <= 24000));
});

test('version 0.1 data migrates with default session and review fields', () => {
  const session = JSON.parse(JSON.stringify(recorded()));
  delete session.reviewOf; delete session.mode; delete session.targetQuestions;
  const data = dataSchema.parse({ version: 1, settings: DEFAULT_SETTINGS, session, archive: [] });
  assert.equal(data.session?.reviewOf, null);
  assert.equal(data.session?.targetQuestions, 3);
  assert.deepEqual(data.reviewSnoozes, {});
});

test('compatible JSON extraction handles preambles and braces in quoted content', () => {
  assert.deepEqual(extractJson('下面是结果：\n{"message":"brace } and \\\"quote\\\"","question":null}\n结束'), { message: 'brace } and "quote"', question: null });
  assert.throws(() => extractJson('没有结构化结果'));
});
