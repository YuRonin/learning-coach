import test from 'node:test';
import assert from 'node:assert/strict';
import { splitMessages, parseSplits, mappingMessages, parseMappings } from '../src/material-analysis';

const text = '并发指一段时间内交替推进多个任务。并行指同一时刻执行多个任务。';
const points = [{ id: 'concurrency', title: '并发', quote: text }];
test('model split suggestions must cite exact source and cannot smuggle unrelated content', () => {
  assert.equal(parseSplits(JSON.stringify({ points: [{ title: '并发', quote: '并发指一段时间内交替推进多个任务。' }] }), text).length, 1);
  assert.throws(() => parseSplits(JSON.stringify({ points: [{ title: '未知', quote: '材料没有给出的其他知识点。' }] }), text), /引用不符/);
  assert.throws(() => splitMessages('x'.repeat(24001)), /24,000/);
  assert.equal(JSON.parse(splitMessages(text)[1]!.content).source, text);
});
test('mapping suggestions allow uncertainty, reject invented IDs and bound source disclosure', () => {
  assert.deepEqual(parseMappings('{"matches":[]}', points), []);
  assert.throws(() => parseMappings('{"matches":[{"id":"invented","reason":"猜测"}]}', points), /未知/);
  const messages = mappingMessages(text, [{ ...points[0]!, quote: 'x'.repeat(1000) }]);
  assert.equal(JSON.parse(messages[1]!.content).points[0].quote.length, 300);
  assert.throws(() => mappingMessages(text, Array.from({ length: 101 }, () => points[0]!)), /一百/);
});
