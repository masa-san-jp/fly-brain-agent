import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';
import { startBridgeServer } from '../src/server.mjs';

function validPayload(extra = {}) {
  return {
    event: 'startled',
    agent_id: 0,
    t_ms: 123456,
    state: { behavior: 'escape jump', energy: 0.62, pos: [0.4, -1.1, 0.2], yaw: 1.2, flying: false },
    recent_behaviors: ['walking', 'escape jump'],
    ...extra,
  };
}

async function makeServer(options = {}) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'fly-bridge-test-'));
  const server = await startBridgeServer({
    port: 0,
    logPath: path.join(tempDir, 'calls.jsonl'),
    workspaceDir: path.join(tempDir, 'workspace'),
    ...options,
  });
  return { server, tempDir };
}

function sendAndReceive(port, request, options = {}) {
  const origin = options.origin ?? 'http://localhost:5173';
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('timed out waiting for WebSocket response'));
    }, options.timeoutMs ?? 2000);
    ws.once('open', () => ws.send(JSON.stringify(request)));
    ws.once('message', (data) => {
      clearTimeout(timer);
      const result = JSON.parse(data.toString());
      ws.close();
      resolve(result);
    });
    ws.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function request(id, backend = 'mock', payload = validPayload()) {
  return { type: 'event', id, backend, payload };
}

test('mock WebSocket round trip and whitelist field stripping', async (t) => {
  let seenEvent;
  let seenPrompt;
  const { server, tempDir } = await makeServer({
    backendOverrides: {
      mock: ({ event, prompt }) => {
        seenEvent = event;
        seenPrompt = prompt;
        return JSON.stringify({ text: '了解、見ているよ。', valence: 'positive' });
      },
    },
  });
  t.after(async () => { await server.close(); await rm(tempDir, { recursive: true, force: true }); });

  const result = await sendAndReceive(server.port, request('round-trip', 'mock', validPayload({ unknown: 'drop', state: { ...validPayload().state, extra: 'drop' } })));
  assert.deepEqual(result, {
    type: 'reply', id: 'round-trip', backend: 'mock', text: '了解、見ているよ。', valence: 'positive', latencyMs: result.latencyMs,
  });
  assert.deepEqual(seenEvent, validPayload());
  assert.match(seenPrompt, /検証済みイベントJSON/);
  assert.match(seenPrompt, /"pos":\[0.4,-1.1,0.2\]/);
  assert.doesNotMatch(seenPrompt, /unknown|extra/);
});

test('rejects non-local origins', async (t) => {
  const { server, tempDir } = await makeServer();
  t.after(async () => { await server.close(); await rm(tempDir, { recursive: true, force: true }); });

  await assert.rejects(new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}`, { origin: 'https://evil.example' });
    ws.once('unexpected-response', (_request, response) => reject(new Error(`rejected with ${response.statusCode}`)));
    ws.once('open', () => { ws.close(); resolve(); });
    ws.once('error', reject);
  }), /rejected with 401|rejected with 403|Unexpected server response/);
});

test('rejects invalid payloads with bad_request', async (t) => {
  const { server, tempDir } = await makeServer();
  t.after(async () => { await server.close(); await rm(tempDir, { recursive: true, force: true }); });
  const result = await sendAndReceive(server.port, request('invalid', 'mock', validPayload({ state: { behavior: 'x', energy: 1, pos: [0, 0], yaw: 0, flying: false } })));
  assert.equal(result.type, 'error');
  assert.equal(result.id, 'invalid');
  assert.equal(result.code, 'bad_request');
});

test('returns busy while claude-code or codex is running', async (t) => {
  let release;
  const blocker = new Promise((resolve) => { release = resolve; });
  const { server, tempDir } = await makeServer({
    backendOverrides: { 'claude-code': async () => { await blocker; return JSON.stringify({ text: '完了', valence: 'positive' }); } },
  });
  t.after(async () => { release(); await server.close(); await rm(tempDir, { recursive: true, force: true }); });

  const first = sendAndReceive(server.port, request('first', 'claude-code'));
  await new Promise((resolve) => setTimeout(resolve, 30));
  const second = await sendAndReceive(server.port, request('second', 'claude-code'));
  assert.equal(second.code, 'busy');
  release();
  assert.equal((await first).type, 'reply');
});

test('kills a slow injected command at timeout', async (t) => {
  const { server, tempDir } = await makeServer({
    timeoutMs: 80,
    commandOverrides: {
      'claude-code': { command: process.execPath, args: () => ['-e', 'setInterval(() => {}, 1000)'] },
    },
  });
  t.after(async () => { await server.close(); await rm(tempDir, { recursive: true, force: true }); });
  const result = await sendAndReceive(server.port, request('slow', 'claude-code'));
  assert.equal(result.type, 'error');
  assert.equal(result.code, 'timeout');
});

test('enforces configurable per-backend rate limits', async (t) => {
  const { server, tempDir } = await makeServer({
    rateLimits: { mock: { limit: 1, windowMs: 60_000 } },
  });
  t.after(async () => { await server.close(); await rm(tempDir, { recursive: true, force: true }); });
  assert.equal((await sendAndReceive(server.port, request('one'))).type, 'reply');
  const second = await sendAndReceive(server.port, request('two'));
  assert.equal(second.code, 'rate_limited');
});

test('does not pass or return environment secrets', async (t) => {
  const previous = process.env.SECRET;
  process.env.SECRET = 'never-send-this-secret';
  let seenChildEnv;
  const { server, tempDir } = await makeServer({
    backendOverrides: {
      mock: ({ childEnv }) => {
        seenChildEnv = childEnv;
        return process.env.SECRET;
      },
    },
  });
  t.after(async () => {
    await server.close();
    await rm(tempDir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.SECRET;
    else process.env.SECRET = previous;
  });

  const result = await sendAndReceive(server.port, request('secret'));
  const serialized = JSON.stringify(result);
  assert.equal(seenChildEnv.SECRET, undefined);
  assert.doesNotMatch(serialized, /never-send-this-secret/);
  assert.doesNotMatch(await readFile(path.join(tempDir, 'calls.jsonl'), 'utf8'), /never-send-this-secret/);
});
