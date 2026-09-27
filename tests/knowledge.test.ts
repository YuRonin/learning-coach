import test from 'node:test';
import assert from 'node:assert/strict';
import { dataSchema, DEFAULT_SETTINGS, makeSession } from '../src/domain';
import { proposeKnowledge, knowledgeEvidence, replaceKnowledge } from '../src/knowledge';
import { reviewCards } from '../src/review';

const text = '# 并发\n并发是在一段时间内交替推进多个任务。\n# 并行\n并行是在同一时刻执行多个任务。';
test('migration keeps course history with stable unit IDs and never invents knowledge mapping', () => {
  const session = makeSession({ path: '课.md', name: '课', text, mtime: 1, selection: false }, '');
  session.courseId = 'c'; session.unitId = '课.md';
  const data = dataSchema.parse({ version: 3, settings: DEFAULT_SETTINGS, session, archive: [], courses: [{ id: 'c', name: '课程', folder: '', examDate: '', minutes: 25, units: [{ id: '课.md', path: '课.md', title: '课' }] }] });
  assert.notEqual(data.courses[0]!.units[0]!.id, '课.md');
  assert.equal(data.session!.unitId, data.courses[0]!.units[0]!.id);
  assert.equal(data.session!.focus, undefined);
  assert.deepEqual(dataSchema.parse(data), data);
});
test('local candidates keep exact source text; split and merge retain historical IDs without transferring state', () => {
  const points = proposeKnowledge(text, '课程');
  assert.equal(points.length, 2);
  assert.ok(points.every(p => !p.confirmed && text.includes(p.quote)));
  const merged = replaceKnowledge(points, points.map(p => p.id), [{ title: '并发与并行', quote: text }], text);
  assert.equal(merged.filter(p => p.active).length, 1);
  assert.deepEqual(merged.at(-1)!.parents, points.map(p => p.id));
  assert.throws(() => replaceKnowledge(points, [points[0]!.id], [{ title: '无依据', quote: '这是材料中不存在的内容。' }], text));
});
test('evidence and review queues isolate concepts and revisions', () => {
  const [a, b] = proposeKnowledge(text, '课程'); a!.confirmed = b!.confirmed = true;
  const session = makeSession({ path: '课.md', name: '课', text: a!.quote, mtime: 1, selection: true }, '');
  session.courseId = 'c'; session.unitId = 'u'; session.focus = a!;
  session.attempts.push({ id: 'a', question: { id: 'q', knowledgeId: a!.id, prompt: '解释并发', referenceQuote: a!.quote, rubric: '交替推进', expectedAnswer: '交替推进', hints: 0, revealed: false }, answer: '交替推进', at: session.createdAt, assessment: { verdict: 'correct', feedback: '符合要点' }, revisions: [] });
  assert.equal(knowledgeEvidence('c', 'u', a!, [session]).count, 1);
  assert.equal(knowledgeEvidence('c', 'u', b!, [session]).count, 0);
  assert.equal(knowledgeEvidence('c', 'u', { ...a!, revision: 2 }, [session]).count, 0);
  const next = structuredClone(session); next.id = 'next'; next.attempts[0]!.id = 'next-attempt'; next.attempts[0]!.question.id = 'next-q';
  assert.equal(reviewCards([session, next]).length, 1);
});
