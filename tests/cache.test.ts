import test from 'node:test';
import assert from 'node:assert/strict';
import { LearningCache } from '../src/cache';
import { DEFAULT_SETTINGS, makeSession } from '../src/domain';
import { LearningSession } from '../src/session';
import { buildMessages } from '../src/prompts';

const settings = { ...DEFAULT_SETTINGS, model: 'fixture', apiKey: 'only-a-synthetic-test-secret' };
const source = { path: 'fixture.md', name: 'fixture', text: '超时不等于失败，执行结果可能未知。恢复需要保存真实状态与执行标识。', mtime: 1, selection: false };
const reply = JSON.stringify({ message: '请回答。', outline: ['理解超时'], question: { prompt: '超时说明了什么？', referenceQuote: source.text, rubric: '指出结果未知。', expectedAnswer: '结果可能未知。' } });
function fixture() {
  let text = ''; let time = 1000;
  const storage = { read: async () => text, write: async (value: string) => { text = value; } };
  const cache = new LearningCache(storage, () => time);
  return { cache, storage, text: () => text, advance: (n: number) => { time += n; }, reload: () => new LearningCache(storage, () => time) };
}
test('persistent cache expires, isolates service/model/material/authentication, and stores no request or credential', async () => {
  const f = fixture(); const messages = [{ role: 'user' as const, content: 'synthetic source' }];
  const key = (await f.cache.key(settings, messages))!;
  await f.cache.put(key, reply);
  const restored = f.reload(); await restored.load(); assert.equal(await restored.get(key), reply);
  assert.equal(f.text().includes(settings.apiKey), false); assert.equal(f.text().includes('synthetic source'), false);
  for (const patch of [{ model: 'other' }, { baseUrl: 'https://example.test' }, { apiKey: 'different' }, { temperature: 1 }]) assert.notEqual(await restored.key({ ...settings, ...patch }, messages), key);
  assert.notEqual(await restored.key(settings, [{ ...messages[0]!, content: 'changed source' }]), key);
  f.advance(7 * 86400000 + 1); assert.equal(await restored.get(key), null);
});
test('clear prevents stale writes; malformed cache is disposable and size is bounded', async () => {
  const f = fixture();
  const key = (await f.cache.key(settings, [{ role: 'user', content: 'before clear' }]))!;
  await f.cache.clear(); await f.cache.put(key, reply); assert.equal(f.cache.snapshot().entries, 0);
  for (let i = 0; i < 55; i++) {
    const k = (await f.cache.key(settings, [{ role: 'user', content: String(i) }]))!;
    await f.cache.put(k, '中'.repeat(20000));
  }
  assert.ok(f.cache.snapshot().entries <= 50); assert.ok(Buffer.byteLength(f.text()) <= 1_000_000);
  const malformed = new LearningCache({ read: async () => '{bad', write: async () => {} }); await malformed.load(); assert.equal(malformed.snapshot().entries, 0);
});
test('a cached validated generation works offline and at the call limit without creating attempts', async () => {
  const f = fixture(); let calls = 0;
  const initial = makeSession(source, ''); initial.pending = { id: 'p', action: 'start', input: '', attemptId: null };
  const deps = { save: async () => {}, settings: () => settings, changed() {}, cache: f.cache, ask: async () => { calls++; return reply; } };
  const first = new LearningSession(structuredClone(initial), deps); await first.retry(); assert.equal(calls, 1);
  const restored = f.reload(); await restored.load();
  initial.calls = settings.maxCalls;
  const second = new LearningSession(initial, { ...deps, cache: restored, ask: async () => { throw new Error('offline'); } });
  await second.retry(); assert.ok(second.current!.question); assert.equal(second.current!.calls, settings.maxCalls);
  assert.equal(second.current!.cacheHits, 1); assert.equal(second.current!.attempts.length, 0);
});
test('invalid generation is never cached and cached corruption is evicted before retry', async () => {
  const f = fixture(); const initial = makeSession(source, ''); initial.pending = { id: 'p', action: 'start', input: '', attemptId: null };
  const key = (await f.cache.key(settings, buildMessages(initial)))!;
  await f.cache.put(key, '{not valid');
  let calls = 0;
  const engine = new LearningSession(initial, { save: async () => {}, settings: () => settings, changed() {}, cache: f.cache, ask: async () => { calls++; return calls === 1 ? '{}' : reply; } });
  await engine.retry(); assert.equal(calls, 0); assert.equal(f.cache.snapshot().entries, 0);
  await engine.retry(); assert.equal(calls, 1); assert.equal(f.cache.snapshot().entries, 0);
  await engine.retry(); assert.equal(calls, 2); assert.ok(engine.current!.question);
});
test('disabling caching bypasses reads and writes; cache storage failure does not erase learning', async () => {
  const broken = new LearningCache({ read: async () => '', write: async () => { throw new Error('disk full'); } });
  const key = (await broken.key(settings, [{ role: 'user', content: 'x' }]))!;
  await broken.put(key, reply); assert.equal(broken.snapshot().storageFailed, true);
  await assert.rejects(broken.clear(), /缓存文件/);
  const f = fixture(); const engine = new LearningSession(null, { save: async () => {}, settings: () => ({ ...settings, cacheEnabled: false }), changed() {}, cache: f.cache, ask: async () => reply });
  await engine.start(source, ''); assert.ok(engine.current!.question); assert.equal(f.cache.snapshot().entries, 0);
});
