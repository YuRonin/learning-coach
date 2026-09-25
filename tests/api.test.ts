import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { endpoint, ModelGateway } from '../src/api';
import { DEFAULT_SETTINGS } from '../src/domain';

test('normalizes root, versioned, proxy and complete endpoint paths without duplicate v1', () => {
  assert.equal(endpoint(' https://example.com/ ', 'compatible'), 'https://example.com/v1/chat/completions');
  assert.equal(endpoint('https://example.com/v1/', 'compatible'), 'https://example.com/v1/chat/completions');
  assert.equal(endpoint('https://example.com/gateway/v2', 'compatible'), 'https://example.com/gateway/v2/chat/completions');
  assert.equal(endpoint('https://example.com/v1/chat/completions', 'compatible'), 'https://example.com/v1/chat/completions');
  assert.equal(endpoint('http://localhost:11434', 'ollama'), 'http://localhost:11434/api/chat');
  assert.equal(endpoint('http://localhost:11434/api/', 'ollama'), 'http://localhost:11434/api/chat');
  assert.equal(endpoint('http://localhost:11434/api/chat', 'ollama'), 'http://localhost:11434/api/chat');
});

test('rejects ambiguous URLs and credentials in URL', () => {
  for (const base of ['localhost:11434', 'file:///tmp/a', 'https://user:secret@example.com', 'https://example.com?key=secret', 'https://example.com/#a']) {
    assert.throws(() => endpoint(base, 'compatible'));
  }
});

test('compatible request carries the key only in the Authorization header', async () => {
  const gateway = new ModelGateway(async request => {
    assert.equal(request.headers.Authorization, 'Bearer test-secret');
    assert.equal(request.url, 'https://example.com/v1/chat/completions');
    assert.equal(request.body.includes('test-secret'), false);
    assert.equal(JSON.parse(request.body).model, 'test-model');
    return { status: 200, text: JSON.stringify({ choices: [{ message: { content: 'OK' } }] }) };
  });
  assert.equal(await gateway.complete({ ...DEFAULT_SETTINGS, baseUrl: 'https://example.com/v1', apiKey: 'test-secret', model: 'test-model' }, []), 'OK');
});

test('native Ollama uses chat, options and supports an empty key', async () => {
  const gateway = new ModelGateway(async request => {
    assert.equal(request.headers.Authorization, undefined);
    assert.equal(JSON.parse(request.body).options.temperature, 0.3);
    return { status: 200, text: '{"message":{"content":"你好"}}' };
  });
  assert.equal(await gateway.complete({ ...DEFAULT_SETTINGS, provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'local' }, []), '你好');
});

test('HTTP error messages never echo provider bodies or secrets', async () => {
  const gateway = new ModelGateway(async () => ({ status: 401, text: 'secret-key-123 raw request details' }));
  await assert.rejects(gateway.complete({ ...DEFAULT_SETTINGS, model: 'test' }, []), error => {
    assert.match(String(error), /401/);
    assert.doesNotMatch(String(error), /secret-key/);
    return true;
  });
});

test('rejects missing model without issuing network request', async () => {
  let calls = 0;
  const gateway = new ModelGateway(async () => { calls++; return { status: 200, text: '{}' }; });
  await assert.rejects(gateway.complete(DEFAULT_SETTINGS, []), /模型名称/);
  assert.equal(calls, 0);
});

test('cancelled request rejects promptly and ignores late network response', async () => {
  let finish!: (value: { status: number; text: string }) => void;
  const gateway = new ModelGateway(() => new Promise(resolve => { finish = resolve; }));
  const controller = new AbortController();
  const pending = gateway.complete({ ...DEFAULT_SETTINGS, model: 'test' }, [], controller.signal);
  controller.abort();
  await assert.rejects(pending, /暂停/);
  finish({ status: 200, text: '{"choices":[{"message":{"content":"late"}}]}' });
});

test('timeout does not wait forever or leak the transport error', async () => {
  const gateway = new ModelGateway(() => new Promise(() => {}));
  await assert.rejects(gateway.complete({ ...DEFAULT_SETTINGS, model: 'test', timeoutSeconds: 0.01 }, []), /超时/);
});

test('malformed and empty provider responses are rejected', async () => {
  for (const text of ['<html>login</html>', '{}', 'null', '{"choices":[{"message":{"content":null}}]}']) {
    const gateway = new ModelGateway(async () => ({ status: 200, text }));
    await assert.rejects(gateway.complete({ ...DEFAULT_SETTINGS, model: 'test' }, []));
  }
});

test('connection test works against an actual local HTTP fixture without sending notes', async () => {
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      assert.equal(request.url, '/v1/chat/completions');
      assert.equal(request.headers.authorization, 'Bearer local-fixture');
      const payload = JSON.parse(body);
      assert.deepEqual(payload.messages, [{ role: 'user', content: 'Reply with OK only.' }]);
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const gateway = new ModelGateway(async request => {
      const response = await fetch(request.url, request);
      return { status: response.status, text: await response.text() };
    });
    await gateway.test({ ...DEFAULT_SETTINGS, baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'local-fixture', model: 'fixture' });
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
