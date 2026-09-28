import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { buildPrompt } from './prompt.mjs';
import { PayloadValidationError, validateEventPayload } from './validation.mjs';
import {
  DEFAULT_OLLAMA_MODEL,
  createCommandTask,
  createOllamaTask,
  minimalChildEnv,
  runRandom,
  runMock,
} from './backends.mjs';
import { nothingAction, validateArenaAction, validateBciAction } from '../../src/agents/arenaTools.js';

const BACKENDS = new Set(['ollama', 'claude-code', 'codex', 'mock', 'random']);
const DEFAULT_RATE_LIMITS = Object.freeze({
  ollama: { limit: 30, windowMs: 60_000 },
  'claude-code': { limit: 2, windowMs: 60_000 },
  codex: { limit: 2, windowMs: 60_000 },
  mock: { limit: 60, windowMs: 60_000 },
  random: { limit: 60, windowMs: 60_000 },
});
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_OLLAMA_TIMEOUT_MS = 30_000;
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

class TimeoutError extends Error {
  constructor() {
    super('backend timed out');
    this.name = 'TimeoutError';
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isAllowedOrigin(origin) {
  if (typeof origin !== 'string' || origin.length === 0) return false;
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

function boundedId(value) {
  return typeof value === 'string' && value.length <= 128 ? value : null;
}

function parseCliArgs(argv) {
  const result = { mock: false, port: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--mock') result.mock = true;
    else if (arg === '--port' || arg === '-p') {
      const value = Number(argv[++index]);
      if (!Number.isInteger(value) || value < 0 || value > 65535) throw new Error('invalid --port');
      result.port = value;
    }
  }
  return result;
}

function parseJsonOutput(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  const candidates = [text];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1].trim());
  const firstObject = text.indexOf('{');
  const lastObject = text.lastIndexOf('}');
  if (firstObject >= 0 && lastObject > firstObject) {
    candidates.push(text.slice(firstObject, lastObject + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (isRecord(parsed) && typeof parsed.text === 'string') {
        const valence = ['positive', 'negative', 'notify'].includes(parsed.valence) ? parsed.valence : 'notify';
        return { text: normalizeReplyText(parsed.text), valence };
      }
    } catch {
      // Try the next robust extraction form.
    }
  }
  return { text: normalizeReplyText(text) || '……', valence: 'notify' };
}

export function parseToolReply(raw, { event = 'request' } = {}) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  const candidates = [text];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1].trim());
  const firstObject = text.indexOf('{');
  const lastObject = text.lastIndexOf('}');
  if (firstObject >= 0 && lastObject > firstObject) candidates.push(text.slice(firstObject, lastObject + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (isRecord(parsed) && typeof parsed.text === 'string') {
        return { action: (event === 'bci' ? validateBciAction : validateArenaAction)(parsed.action), text: normalizeReplyText(parsed.text) || '環境を見ているよ。' };
      }
    } catch {
      // Invalid backend output becomes a safe no-op.
    }
  }
  return { action: nothingAction(), text: '環境を見ているよ。' };
}

function normalizeReplyText(value) {
  return Array.from(String(value).replace(/[\r\n\t ]+/g, ' ').trim()).slice(0, 40).join('');
}

function secretValues(sourceEnv = process.env) {
  return Object.entries(sourceEnv)
    .filter(([, value]) => typeof value === 'string' && value.length >= 4)
    .map(([, value]) => value)
    .sort((left, right) => right.length - left.length);
}

function redactSecrets(value, sourceEnv = process.env) {
  let output = String(value);
  for (const secret of secretValues(sourceEnv)) output = output.split(secret).join('[REDACTED]');
  return output;
}

function makeRateLimiter(rateLimits) {
  const calls = new Map();
  return {
    take(backend, now = Date.now()) {
      const rule = rateLimits[backend] ?? { limit: 1, windowMs: 60_000 };
      const existing = (calls.get(backend) ?? []).filter((timestamp) => now - timestamp < rule.windowMs);
      if (existing.length >= rule.limit) {
        calls.set(backend, existing);
        return false;
      }
      existing.push(now);
      calls.set(backend, existing);
      return true;
    },
  };
}

function taskFromOverride(override, context) {
  const result = typeof override === 'function' ? override(context) : override.run(context);
  if (result && typeof result === 'object' && result.promise && typeof result.promise.then === 'function') {
    return { promise: result.promise, terminate: result.terminate };
  }
  return { promise: Promise.resolve(result), terminate: result?.terminate };
}

async function runTaskWithTimeout(task, timeoutMs, killGraceMs = 1200) {
  let timer;
  let timedOut = false;
  const safePromise = Promise.resolve(task.promise);
  safePromise.catch(() => {});
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      try { task.terminate?.(); } catch { /* best effort */ }
      reject(new TimeoutError());
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([safePromise, timeout]);
  } catch (error) {
    if (timedOut) {
      if (typeof task.terminate === 'function') {
        await Promise.race([
          safePromise.catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, killGraceMs)),
        ]);
      }
      throw new TimeoutError();
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function startBridgeServer(options = {}) {
  const port = options.port ?? Number(process.env.PORT ?? 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('invalid port');
  const logPath = options.logPath ?? path.join(PACKAGE_ROOT, 'logs', 'calls.jsonl');
  const workspaceDir = options.workspaceDir ?? path.join(PACKAGE_ROOT, 'workspace');
  const forceMock = Boolean(options.forceMock);
  const ollamaModel = options.ollamaModel ?? process.env.OLLAMA_MODEL ?? DEFAULT_OLLAMA_MODEL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const killGraceMs = options.killGraceMs ?? 1200;
  const ollamaTimeoutMs = options.ollamaTimeoutMs ?? DEFAULT_OLLAMA_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const backendOverrides = options.backendOverrides ?? {};
  const commandOverrides = options.commandOverrides ?? {};
  const rateLimits = { ...DEFAULT_RATE_LIMITS, ...(options.rateLimits ?? {}) };
  const rateLimiter = makeRateLimiter(rateLimits);
  const sourceEnv = options.sourceEnv ?? process.env;
  const childEnv = minimalChildEnv(sourceEnv);
  let agentBusy = false;
  let logQueue = Promise.resolve();

  await mkdir(path.dirname(logPath), { recursive: true });
  await mkdir(workspaceDir, { recursive: true });

  function logCall(entry) {
    const line = `${JSON.stringify({
      ts: new Date().toISOString(),
      id: entry.id ?? null,
      backend: entry.backend ?? null,
      event: entry.event ?? null,
      payload: entry.payload ?? null,
      latency: entry.latency,
      outcome: entry.outcome,
      reply: redactSecrets(entry.reply ?? '', sourceEnv),
    })}\n`;
    logQueue = logQueue.then(() => appendFile(logPath, line, 'utf8')).catch(() => {});
  }

  function send(ws, message) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
  }

  async function handleMessage(ws, rawData) {
    const startedAt = Date.now();
    let request = null;
    try {
      request = JSON.parse(rawData.toString());
    } catch {
      logCall({ id: null, backend: null, event: null, latency: Date.now() - startedAt, outcome: 'bad_request', reply: '' });
      send(ws, { type: 'error', id: null, code: 'bad_request', message: 'invalid JSON' });
      return;
    }

    const id = boundedId(request?.id);
    const requestedBackend = request?.backend;
    const event = request?.payload?.event ?? null;
    const fail = (code, message) => {
      send(ws, { type: 'error', id, code, message });
      logCall({ id, backend: requestedBackend, event, latency: Date.now() - startedAt, outcome: code, reply: '' });
    };

    if (!isRecord(request) || request.type !== 'event' || typeof request.id !== 'string' || request.id.length === 0 ||
      request.id.length > 128 || !BACKENDS.has(requestedBackend)) {
      fail('bad_request', 'event request is invalid');
      return;
    }

    let validatedEvent;
    try {
      validatedEvent = validateEventPayload(request.payload);
    } catch (error) {
      const message = error instanceof PayloadValidationError ? error.message : 'payload is invalid';
      fail('bad_request', message);
      return;
    }

    const backend = forceMock ? 'mock' : requestedBackend;
    if ((backend === 'claude-code' || backend === 'codex') && agentBusy) {
      fail('busy', 'agent backend is busy');
      return;
    }
    if (!rateLimiter.take(backend)) {
      fail('rate_limited', 'backend rate limit exceeded');
      return;
    }

    const prompt = buildPrompt(validatedEvent);
    if (backend === 'claude-code' || backend === 'codex') agentBusy = true;
    try {
      const context = {
        backend,
        requestedBackend,
        event: validatedEvent,
        prompt,
        workspaceDir,
        childEnv: { ...childEnv },
      };
      let task;
      if (backendOverrides[backend]) {
        task = taskFromOverride(backendOverrides[backend], context);
      } else if (backend === 'ollama') {
        task = createOllamaTask({ prompt, model: ollamaModel, fetchImpl });
      } else if (backend === 'mock') {
        task = { promise: runMock({ event: validatedEvent, delayMs: options.mockDelayMs ?? 10 }) };
      } else if (backend === 'random') {
        task = { promise: runRandom({ request: validatedEvent }) };
      } else {
        task = createCommandTask({ backend, prompt, workspaceDir, commandOverrides, env: childEnv });
      }

      const rawReply = await runTaskWithTimeout(task, backend === 'ollama' ? ollamaTimeoutMs : timeoutMs, killGraceMs);
      const parsedReply = validatedEvent.event === 'request' || validatedEvent.event === 'bci'
        ? parseToolReply(redactSecrets(rawReply, sourceEnv), { event: validatedEvent.event })
        : parseJsonOutput(redactSecrets(rawReply, sourceEnv));
      const replyText = redactSecrets(parsedReply.text, sourceEnv);
      const response = {
        type: 'reply',
        id: request.id,
        backend: requestedBackend,
        text: replyText,
        latencyMs: Date.now() - startedAt,
      };
      if (validatedEvent.event === 'request' || validatedEvent.event === 'bci') response.action = parsedReply.action;
      else response.valence = parsedReply.valence;
      send(ws, response);
      logCall({ id: request.id, backend: requestedBackend, event: validatedEvent.event, payload: validatedEvent, latency: Date.now() - startedAt, outcome: 'success', reply: replyText });
    } catch (error) {
      const code = error instanceof TimeoutError ? 'timeout' : 'backend_error';
      send(ws, { type: 'error', id: request.id, code, message: code === 'timeout' ? 'backend timed out' : 'backend failed' });
      logCall({ id: request.id, backend: requestedBackend, event: validatedEvent.event, latency: Date.now() - startedAt, outcome: code, reply: '' });
    } finally {
      if (backend === 'claude-code' || backend === 'codex') agentBusy = false;
    }
  }

  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port,
    verifyClient: ({ origin }) => isAllowedOrigin(origin),
  });
  wss.on('connection', (ws) => {
    ws.on('message', (data) => { void handleMessage(ws, data); });
  });

  await new Promise((resolve, reject) => {
    wss.once('listening', resolve);
    wss.once('error', reject);
  });

  return {
    wss,
    port: wss.address().port,
    logPath,
    workspaceDir,
    async close() {
      for (const client of wss.clients) client.close();
      await new Promise((resolve) => wss.close(resolve));
      await logQueue;
    },
  };
}

export { BACKENDS, DEFAULT_RATE_LIMITS, PACKAGE_ROOT, parseJsonOutput, redactSecrets };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const cli = parseCliArgs(process.argv.slice(2));
    const server = await startBridgeServer({ port: cli.port ?? Number(process.env.PORT ?? 8787), forceMock: cli.mock });
    console.log(`bridge-server listening on ws://127.0.0.1:${server.port}${cli.mock ? ' (mock)' : ''}`);
    const shutdown = async () => {
      await server.close();
      process.exit(0);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'failed to start bridge-server');
    process.exit(1);
  }
}
