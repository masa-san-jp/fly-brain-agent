import { spawn } from 'node:child_process';

export const DEFAULT_OLLAMA_MODEL = 'gemma4:e4b';

export function minimalChildEnv(sourceEnv = process.env) {
  const env = {};
  if (typeof sourceEnv.PATH === 'string') env.PATH = sourceEnv.PATH;
  if (typeof sourceEnv.HOME === 'string') env.HOME = sourceEnv.HOME;
  return env;
}

export function runOllama({ prompt, model, signal, fetchImpl = fetch }) {
  return fetchImpl('http://127.0.0.1:11434/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      format: 'json',
      think: false,
    }),
    signal,
  }).then(async (response) => {
    if (!response.ok) throw new Error(`ollama returned ${response.status}`);
    const body = await response.json();
    const content = body?.message?.content;
    if (typeof content !== 'string') throw new Error('ollama response had no message content');
    return content;
  });
}

export function spawnCommand({ command, args, cwd, env = minimalChildEnv() }) {
  const child = spawn(command, args, {
    cwd,
    env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  const promise = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`child exited (${code ?? 'null'}, ${signal ?? 'unknown'}): ${stderr.slice(0, 200)}`));
    });
  });

  let killTimer;
  const terminate = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 1000);
    killTimer.unref?.();
  };

  promise.finally(() => clearTimeout(killTimer)).catch(() => {});
  return { promise, terminate, child };
}

export function createOllamaTask({ prompt, model, fetchImpl = fetch }) {
  const controller = new AbortController();
  return {
    promise: runOllama({ prompt, model, signal: controller.signal, fetchImpl }),
    terminate: () => controller.abort(),
  };
}

export function createCommandTask({ backend, prompt, workspaceDir, commandOverrides = {}, env = minimalChildEnv() }) {
  const override = commandOverrides[backend];
  let command;
  let args;

  if (override) {
    command = override.command;
    args = typeof override.args === 'function' ? override.args(prompt) : override.args;
  } else if (backend === 'claude-code') {
    command = 'claude';
    args = ['-p', prompt, '--output-format', 'text', '--tools', ''];
  } else if (backend === 'codex') {
    command = 'codex';
    args = ['exec', '--sandbox', 'read-only', '-C', workspaceDir, '--skip-git-repo-check', prompt];
  } else {
    throw new Error(`unsupported command backend: ${backend}`);
  }

  if (typeof command !== 'string' || !Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    throw new Error('invalid command configuration');
  }
  return spawnCommand({ command, args, cwd: workspaceDir, env });
}

export const MOCK_REPLIES = Object.freeze({
  touched_agent: ['こんにちは、ここにいるよ。', 'positive'],
  startled: ['びっくりした、落ち着こう。', 'notify'],
  hungry: ['おなかがすいたよ。', 'negative'],
  found_food: ['甘くてうれしい！', 'positive'],
  grooming: ['身だしなみを整えよう。', 'notify'],
  idle_long: ['少し退屈だな。', 'notify'],
  died: ['さようなら、またね。', 'negative'],
});

export async function runMock({ event, delayMs = 10 }) {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  const [text, valence] = MOCK_REPLIES[event] ?? ['見ているよ。', 'notify'];
  return JSON.stringify({ text, valence });
}
