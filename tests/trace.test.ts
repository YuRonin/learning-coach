import test from 'node:test';
import assert from 'node:assert/strict';
import { TraceStore, parseTraceMarkdown, traceFolder, traceMarkdown } from '../src/trace';
import { ModelGateway } from '../src/api';
import { DEFAULT_SETTINGS, makeSession } from '../src/domain';
import { LearningSession } from '../src/session';
import { LearningCache } from '../src/cache';

function fixture() {
  const files = new Map<string, string>(); let enabled = true;
  const store = new TraceStore({ write: async (path, text) => { files.set(path, text); } }, () => ({ enabled, folder: '学习教练/运行追踪', version: '0.9.1' }));
  return { files, store, records: () => [...files.values()].map(parseTraceMarkdown), disable: () => { enabled = false; } };
}
const settings = { ...DEFAULT_SETTINGS, model: 'private-model-name', apiKey: 'synthetic-secret-only', baseUrl: 'https://private-gateway.example.test' };
const source = { path: 'private-note.md', name: 'private-name', text: '超时不等于失败，执行结果可能未知。恢复需要保存真实状态与执行标识。', mtime: 1, selection: false };
const reply = JSON.stringify({ message: '请回答。', outline: ['理解超时'], question: { prompt: '超时说明了什么？', referenceQuote: source.text, rubric: '指出结果未知。', expectedAnswer: '结果可能未知。' } });

test('trace stores only whitelisted metadata, actual usage, and unique vault paths', async () => {
  const f = fixture(); const gateway = new ModelGateway(async () => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: 'private-answer' } }], usage: { prompt_tokens: 42, completion_tokens: 7, prompt_cache_hit_tokens: 32 } }) }));
  gateway.traceStore = f.store;
  await gateway.complete(settings, [{ role: 'user', content: source.text }]);
  await gateway.complete(settings, [{ role: 'user', content: source.text }]);
  assert.equal(f.files.size, 2);
  const all = [...f.files.values()].join('');
  for (const secret of [settings.apiKey, settings.baseUrl, settings.model, source.text, 'private-answer']) assert.ok(!all.includes(secret));
  const record = f.records()[0]!;
  assert.equal(record.outcome, 'success');
  assert.equal(record.events.find(e => e.status === 'success' && e.kind === 'request')?.cachedInputTokens, 32);
  const contaminated = { ...record, apiKey: 'must-be-stripped', events: record.events.map(e => ({ ...e, content: 'must-be-stripped' })) };
  assert.ok(!traceMarkdown(contaminated).includes('must-be-stripped'));
  for (const path of ['../x', '/x', '.obsidian/logs', 'a//b', 'a/../b']) assert.throws(() => traceFolder(path));
});

test('cancelled requests ignore late responses and never log raw transport errors', async () => {
  const f = fixture(); let resolve!: (value: {status: number; text: string}) => void;
  const gateway = new ModelGateway(() => new Promise(r => { resolve = r; })); gateway.traceStore = f.store;
  const controller = new AbortController(); const pending = gateway.complete(settings, [], controller.signal);
  while (!resolve) await new Promise(r => setTimeout(r, 1));
  controller.abort(); await assert.rejects(pending);
  resolve({ status: 200, text: 'sensitive-late-body' }); await f.store.flush();
  assert.equal(f.records()[0]?.outcome, 'cancelled');
  assert.ok(![...f.files.values()].join('').includes('sensitive-late-body'));
});

test('cache hits do not create requests and retries link to the same operation', async () => {
  const f = fixture(); let calls = 0;
  const cache = new LearningCache({ read: async () => '', write: async () => {} });
  const initial = makeSession(source, 'private-goal'); initial.pending = { id: 'same-operation', action: 'start', input: '', attemptId: null };
  const deps = { save: async () => {}, settings: () => settings, changed() {}, cache, trace: f.store, ask: async () => { calls++; return calls === 1 ? '{}' : reply; } };
  const engine = new LearningSession(structuredClone(initial), deps);
  await engine.retry(); await engine.retry();
  const cachedEngine = new LearningSession(structuredClone(initial), deps); await cachedEngine.retry();
  assert.equal(calls, 2); const records = f.records(); assert.equal(records.length, 3);
  assert.equal(records[0]!.outcome, 'failure'); assert.equal(records[1]!.outcome, 'success');
  assert.equal(records[0]!.operationRef, records[1]!.operationRef);
  assert.notEqual(records[0]!.traceId, records[1]!.traceId);
  assert.ok(records[2]!.events.some(e => e.kind === 'cache' && e.status === 'hit'));
  assert.ok(!records[2]!.events.some(e => e.kind === 'request'));
  assert.ok(![...f.files.values()].join('').includes(source.text));
});

test('trace storage failure does not lose learning; learning storage failure marks failure', async () => {
  const broken = new TraceStore({ write: async () => { throw Error('disk'); } }, () => ({ enabled: true, folder: '日志', version: '0.9.1' }));
  const engine = new LearningSession(null, { trace: broken, save: async () => {}, settings: () => settings, changed() {}, ask: async () => reply });
  await engine.start(source, ''); assert.ok(engine.current?.question); assert.equal(broken.storageFailed, true);
  const f = fixture(); const initial = makeSession(source, '');
  const failed = new LearningSession(initial, { trace: f.store, save: async () => { throw Error('save failed'); }, settings: () => settings, changed() {}, ask: async () => reply });
  await assert.rejects(failed.perform('start'));
  assert.equal(f.records()[0]?.outcome, 'failure');
  assert.ok(f.records()[0]?.events.some(e => e.kind === 'persist' && e.code === 'storage'));
});

test('disabled logging creates no files and bounded traces retain a final outcome', async () => {
  const f = fixture(); const run = (await f.store.begin('start'))!;
  for (let i = 0; i < 140; i++) await run.event({ kind: 'cache', status: 'hit' });
  await Promise.all([run.finish('success'), run.finish('failure')]);
  assert.equal(f.records()[0]!.events.length, 128); assert.equal(f.records()[0]!.outcome, 'success');
  f.disable(); assert.equal(await f.store.begin('answer'), undefined); assert.equal(f.files.size, 1);
});
