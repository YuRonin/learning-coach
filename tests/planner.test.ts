import test from 'node:test';
import assert from 'node:assert/strict';
import { makePlan, reconcilePlans } from '../src/planner';
import { proposeKnowledge } from '../src/knowledge';
import { courseSchema } from '../src/course';
import { makeSession } from '../src/domain';
const text = '并发是在一段时间内交替推进多个任务。';
const points = Array.from({ length: 12 }, (_, i) => ({ ...proposeKnowledge(text, `知识点${i}`)[0]!, confirmed: true }));
const course = courseSchema.parse({ id: 'c', name: '课程', folder: '', examDate: '', minutes: 240, units: [{ id: 'u', path: 'c.md', title: '章节', knowledge: points }] });
test('10, 25 and 60 minute plans respect budget, keep stable saved tasks, and exclude archived courses', () => {
  const plans = [10, 25, 60].map(b => makePlan([course], [], b, [], '2026-09-26', 'Asia/Shanghai'));
  assert.deepEqual(plans.map(p => p.tasks.length), [1, 3, 7]);
  assert.ok(plans.every(p => p.tasks.reduce((sum, t) => sum + t.minutes, 0) <= p.budget));
  assert.equal(makePlan([{ ...course, archived: true }], [], 25).tasks.length, 0);
  plans[0]!.tasks[0]!.status = 'deferred';
  const next = makePlan([course], [], 25, [plans[0]!], '2026-09-26');
  assert.ok(!next.tasks.some(t => t.knowledgeId === plans[0]!.tasks[0]!.knowledgeId));
  assert.ok(makePlan([course], [], 25, [plans[0]!], '2026-09-27').tasks.some(t => t.knowledgeId === plans[0]!.tasks[0]!.knowledgeId));
  plans[0]!.tasks[0]!.status = 'started';
  assert.ok(!makePlan([course], [], 25, [plans[0]!], '2026-09-27').tasks.some(t => t.knowledgeId === plans[0]!.tasks[0]!.knowledgeId));
});
test('ending early does not mark a task complete and later evidence can complete it', () => {
  const plan = makePlan([course], [], 10);
  const s = makeSession({ path: 'c.md', name: '章节', text, mtime: 1, selection: false }, '');
  s.taskId = plan.tasks[0]!.id; s.status = 'ended'; s.targetQuestions = 1;
  reconcilePlans([plan], s); assert.equal(plan.tasks[0]!.status, 'started');
  s.attempts.push({ id: 'a', question: { id: 'q', prompt: '解释并发', referenceQuote: text, rubric: '交替', expectedAnswer: '交替', hints: 0, revealed: false }, answer: '交替', at: s.createdAt, assessment: { verdict: 'correct', feedback: '正确' }, revisions: [] });
  reconcilePlans([plan], s); assert.equal(plan.tasks[0]!.status, 'done');
  s.attempts[0]!.question.invalidated = { reason: '问题含糊', at: s.createdAt };
  reconcilePlans([plan], s); assert.equal(plan.tasks[0]!.status, 'started');
});

test('a snoozed weak knowledge point is not silently scheduled as remediation', () => {
  const point = points[0]!;
  const s = makeSession({ path: 'c.md', name: '章节', text, mtime: 1, selection: true }, '');
  s.courseId = 'c'; s.unitId = 'u'; s.focus = point;
  s.attempts.push({ id: 'a', question: { id: 'q', prompt: '解释并发', referenceQuote: text, rubric: '交替', expectedAnswer: '交替', hints: 0, revealed: false }, answer: '不知道', at: '2026-09-25T04:00:00Z', revisions: [], assessment: { verdict: 'incorrect', feedback: '需要巩固' } });
  const plan = makePlan([course], [s], 25, [], '2026-09-26', 'Asia/Shanghai', { [`knowledge:c:${point.id}:${point.revision}`]: '2026-09-28' });
  assert.ok(!plan.tasks.some(t => t.knowledgeId === point.id));
});
