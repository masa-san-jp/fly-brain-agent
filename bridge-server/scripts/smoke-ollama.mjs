import { spawn } from 'node:child_process';
import { startBridgeServer } from '../src/server.mjs';
import WebSocket from 'ws';

const ollamaUrl = 'http://127.0.0.1:11434/api/tags';
const timeout = (ms) => AbortSignal.timeout(ms);

async function ollamaReachable() {
  try {
    const response = await fetch(ollamaUrl, { signal: timeout(1000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForOllama() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await ollamaReachable()) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

function roundTrip(port) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: 'http://localhost:5173' });
    const request = {
      type: 'event',
      id: 'smoke-ollama',
      backend: 'ollama',
      payload: {
        event: 'touched_agent',
        agent_id: 0,
        terminal_id: 'ollama',
        t_ms: Date.now(),
        state: { behavior: 'standing', energy: 0.7, pos: [0, 0, 0], yaw: 0, flying: false },
        recent_behaviors: ['walking', 'standing'],
      },
    };
    ws.once('open', () => ws.send(JSON.stringify(request)));
    ws.once('message', (data) => {
      const result = JSON.parse(data.toString());
      ws.close();
      resolve({ result, elapsedMs: Date.now() - startedAt });
    });
    ws.once('error', reject);
  });
}

let startedOllama = null;
let bridge = null;
try {
  if (!(await ollamaReachable())) {
    startedOllama = spawn('ollama', ['serve'], {
      shell: false,
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key === 'PATH' || key === 'HOME')),
      stdio: 'ignore',
    });
    startedOllama.once('error', () => {});
    if (!(await waitForOllama())) throw new Error('Ollama was not reachable after starting ollama serve');
  }
  bridge = await startBridgeServer({ port: 0 });
  const { result, elapsedMs } = await roundTrip(bridge.port);
  console.log(`reply: ${result.text ?? result.message}`);
  console.log(`latency: ${result.latencyMs ?? elapsedMs} ms`);
  if (result.type === 'error') process.exitCode = 1;
} finally {
  if (bridge) await bridge.close();
  if (startedOllama && startedOllama.exitCode === null) {
    startedOllama.kill('SIGTERM');
    await new Promise((resolve) => startedOllama.once('close', resolve));
  }
}
