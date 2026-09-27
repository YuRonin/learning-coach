import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import { dataSchema, DEFAULT_SETTINGS, makeSession } from '../src/domain';
import { proposeKnowledge } from '../src/knowledge';
import { makePlan } from '../src/planner';
import { reviewCards } from '../src/review';

const text = '并发是在一段时间内交替推进多个任务。并行是在同一时刻执行多个任务。';
const points = Array.from({ length: 500 }, (_, i) => ({ ...proposeKnowledge(text, `合成知识点 ${i}`)[0]!, confirmed: true }));
const sessions = Array.from({ length: 3000 }, (_, i) => {
  const s = makeSession({ path: '合成课程.md', name: '合成课程', text, mtime: 1, selection: true }, '基准测试');
  s.courseId = 'synthetic'; s.unitId = 'unit'; s.focus = points[i % points.length]; s.status = 'ended';
  s.attempts.push({ id: `attempt-${i}`, question: { id: `question-${i}`, type: 'short', prompt: `情境 ${i} 的两个任务分别是什么关系？`, referenceQuote: text, rubric: '区分同时和交替', expectedAnswer: '根据发生时刻判断', hints: 0, revealed: false }, answer: '交替推进', at: new Date(2026, 0, 1 + Math.floor(i / 500)).toISOString(), assessment: { verdict: i % 3 ? 'correct' : 'partial', feedback: '合成评价。' }, revisions: [] });
  return s;
});
const data = { version: 5, settings: DEFAULT_SETTINGS, session: null, archive: sessions, courses: [{ id: 'synthetic', name: '合成课程', folder: '', examDate: '', minutes: 25, units: [{ id: 'unit', path: '合成课程.md', title: '合成章节', knowledge: points }] }] };
const results: Record<string, number> = {};
let start = performance.now(); const json = JSON.stringify(data); results.serializeMs = performance.now() - start; results.bytes = Buffer.byteLength(json);
start = performance.now(); const parsed = dataSchema.parse(JSON.parse(json)); results.parseValidateMs = performance.now() - start;
start = performance.now(); reviewCards(parsed.archive); results.reviewMs = performance.now() - start;
start = performance.now(); makePlan(parsed.courses, parsed.archive, 60); results.planMs = performance.now() - start;
await mkdir('.test-artifacts/performance', { recursive: true });
start = performance.now(); await writeFile('.test-artifacts/performance/synthetic-data.json', json); results.writeMs = performance.now() - start;
await writeFile('.test-artifacts/performance/results.json', JSON.stringify({ sessions: 3000, knowledge: 500, runtime: process.version, results, limitation: 'Desktop synthetic benchmark; not mobile memory or real vault storage.' }, null, 2));
console.log(JSON.stringify(results));
