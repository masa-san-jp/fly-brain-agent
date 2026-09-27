// Parallel terminal-parameter sweep. Each setting is a separate Node process because MuJoCo and the
// connectome have a large native/WASM footprint. The fly is never modified; only env.agents changes.
// Usage: node scripts/sweep_terminals.mjs [--stage=coarse|final|all] [--workers=2]
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = process.cwd();
const baseline = [
  { id: 'ollama', backend: 'ollama', x: -0.8, y: 0.7, r: 0.22, odor: 'banana', strength: 1.0, sigma: 1.4, sugar: 0.5, cooldownMs: 8000 },
  { id: 'claude', backend: 'claude-code', x: 0.9, y: -0.7, r: 0.22, odor: 'vinegar', strength: 1.0, sigma: 1.4, sugar: 0.5, cooldownMs: 60000 },
];

const clone = value => structuredClone(value);
const withCommon = (overrides = {}) => baseline.map((a, i) => ({ ...a, ...(overrides[i] || {}) }));
const pair = (odor, overrides = {}) => withCommon({ 0: { odor }, 1: { odor, ...overrides } });
const labelled = (name, agents) => ({ name, agents });

function coarseSettings() {
  const settings = [labelled('baseline-current', clone(baseline))];
  for (const odor of ['banana', 'vinegar']) settings.push(labelled(`both-${odor}`, pair(odor)));
  settings.push(labelled('banana-vinegar', withCommon({ 0: { odor: 'banana' }, 1: { odor: 'vinegar' }})));
  settings.push(labelled('vinegar-banana', withCommon({ 0: { odor: 'vinegar' }, 1: { odor: 'banana' }})));
  for (const strength of [0.4, 0.8, 1.2]) settings.push(labelled(`strength-${strength}`, withCommon({ 0: { strength }, 1: { strength }})));
  for (const sigma of [0.5, 0.8, 1.2, 1.6]) settings.push(labelled(`sigma-${sigma}`, withCommon({ 0: { sigma }, 1: { sigma }})));
  for (const sugar of [0.2, 0.4, 0.6, 0.8]) settings.push(labelled(`sugar-${sugar}`, withCommon({ 0: { sugar }, 1: { sugar }})));
  for (const r of [0.16, 0.22, 0.28]) settings.push(labelled(`radius-${r}`, withCommon({ 0: { r }, 1: { r }})));
  const placements = [
    ['near-symmetric', [-0.55, 0.55], [0.55, -0.55]],
    ['mid-symmetric', [-0.7, 0.7], [0.7, -0.7]],
    ['far-symmetric', [-1.1, 1.0], [1.1, -1.0]],
    ['same-side', [-0.9, 0.8], [-0.9, -0.8]],
  ];
  for (const [name, p0, p1] of placements) settings.push(labelled(`placement-${name}`, withCommon({ 0: { x: p0[0], y: p0[1] }, 1: { x: p1[0], y: p1[1] }})));
  return settings;
}

function finalSettings(coarse) {
  const byName = new Map(coarse.map(row => [row.setting.name, row.setting]));
  const targeted = [
    labelled('both-vinegar', clone(byName.get('both-vinegar').agents)),
    labelled('near-both-vinegar', withCommon({
      0: { x: -0.55, y: 0.55, odor: 'vinegar', strength: 1.0, sigma: 1.2 },
      1: { x: 0.55, y: -0.55, odor: 'vinegar', strength: 1.0, sigma: 1.2 },
    })),
    labelled('mid-both-vinegar', withCommon({
      0: { x: -0.7, y: 0.7, odor: 'vinegar', strength: 1.0, sigma: 1.2 },
      1: { x: 0.7, y: -0.7, odor: 'vinegar', strength: 1.0, sigma: 1.2 },
    })),
  ];
  const candidates = [
    labelled('baseline-current', clone(byName.get('baseline-current').agents)),
    ...targeted,
    ...[...coarse].sort((a, b) => b.score - a.score).map(row => labelled(row.setting.name, row.setting.agents)),
  ];
  const unique = new Map(candidates.map(setting => [JSON.stringify(setting.agents), setting]));
  return [...unique.values()].slice(0, 3).map(setting => labelled(`final-${setting.name}`, clone(setting.agents)));
}

function score(report) {
  const qualified = Math.min(...report.summary.map(row => row.dwellQualifiedFraction));
  const visits = report.summary.reduce((sum, row) => sum + row.visitsPerFlyMinute, 0);
  const balance = Math.min(...report.summary.map(row => row.fractionWithin));
  // Both-terminal coverage is the hard requirement; dwell, balance, then throughput break ties.
  return report.bothVisitedFraction * 1000 + qualified * 100 + balance * 10 + visits;
}

function runChild({ setting, flies, seconds, sampleMs, vision, out, replicateStart = 0 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/check_terminals.mjs',
      `--flies=${flies}`, `--seconds=${seconds}`, `--sample-ms=${sampleMs}`, `--vision=${vision ? 1 : 0}`,
      `--replicate-start=${replicateStart}`, `--config-json=${JSON.stringify({ agents: setting.agents })}`, `--out=${out}`], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', async code => {
      if (code !== 0) return reject(new Error(`${setting.name} exited ${code}\n${stderr}\n${stdout}`));
      resolve(JSON.parse(await fs.readFile(out, 'utf8')));
    });
  });
}

function mergeReports(setting, reports, seconds, sampleMs, vision) {
  const runs = reports.flatMap(report => report.runs);
  const summary = setting.agents.map(agent => {
    const rows = runs.map(run => run.terminals.find(t => t.agentId === agent.id));
    const arrivals = rows.filter(row => row.firstArrival !== null).map(row => row.firstArrival);
    return { agentId: agent.id,
      fractionWithin: rows.reduce((sum, row) => sum + row.fractionWithin, 0) / rows.length,
      visits: rows.reduce((sum, row) => sum + row.visits, 0) / rows.length,
      visitsPerFlyMinute: rows.reduce((sum, row) => sum + row.visitsPerFlyMinute, 0) / rows.length,
      firstArrival: arrivals.length ? arrivals.reduce((sum, value) => sum + value, 0) / arrivals.length : null,
      arrivedFraction: arrivals.length / rows.length,
      dwellQualifiedFraction: rows.filter(row => row.visits > 0).length / rows.length,
    };
  });
  return { parameters: { flies: runs.length, simulatedSeconds: seconds, sampleMs, dwellMs: 300, vision, terminalConfig: setting.agents }, runs, summary,
    bothVisitedFraction: runs.filter(run => run.bothVisited).length / runs.length };
}

async function parallelMap(items, limit, fn) {
  const result = new Array(items.length); let next = 0;
  async function worker() {
    while (true) { const i = next++; if (i >= items.length) return; result[i] = await fn(items[i], i); }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return result;
}

function printRows(rows, title) {
  console.log(`\n${title}`);
  console.log('setting                         both   terminal-1 dwell  terminal-2 dwell  min fraction  visits/fly-min');
  for (const row of [...rows].sort((a, b) => b.score - a.score)) {
    const [a, b] = row.report.summary;
    console.log(`${row.setting.name.padEnd(31)} ${(row.report.bothVisitedFraction * 100).toFixed(0).padStart(5)}% ${(a.dwellQualifiedFraction * 100).toFixed(0).padStart(17)}% ${(b.dwellQualifiedFraction * 100).toFixed(0).padStart(17)}% ${(Math.min(a.fractionWithin, b.fractionWithin) * 100).toFixed(1).padStart(12)} ${(a.visitsPerFlyMinute + b.visitsPerFlyMinute).toFixed(2).padStart(16)}`);
  }
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map(value => {
    const [key, ...rest] = value.replace(/^--/, '').split('='); return [key, rest.join('=') || 'true'];
  }));
  const stage = args.stage || 'all';
  const workers = Math.max(1, Math.min(Number(args.workers || Math.max(1, Math.min(4, os.availableParallelism?.() || 2))), 8));
  const vision = !['0', 'false', 'off'].includes(String(args.vision || '1').toLowerCase());
  const sampleMs = Number(args['sample-ms'] || 20);
  const dir = await fs.mkdtemp(path.join('/tmp', 'fly-terminal-sweep-'));
  const started = Date.now();
  const coarse = coarseSettings();
  let coarseRows = [];
  if (stage === 'coarse' || stage === 'all') {
    console.log(`Coarse sweep: ${coarse.length} settings, N=1, T=4s, workers=${workers}, vision=${vision ? 'ON' : 'OFF'}`);
    coarseRows = await parallelMap(coarse, workers, async (setting, i) => {
      const out = path.join(dir, `coarse-${i}.json`);
      const report = await runChild({ setting, flies: 1, seconds: 4, sampleMs, vision, out });
      return { setting, report, score: score(report) };
    });
    printRows(coarseRows, 'Coarse results');
  }
  let finalRows = [];
  if (stage === 'final' || stage === 'all') {
    if (stage === 'final') {
      const input = JSON.parse(await fs.readFile(args.input || 'scratch/terminal-sweep-coarse.json', 'utf8'));
      coarseRows = input.coarse;
    }
    const finalists = finalSettings(coarseRows);
    console.log(`\nFinalist sweep: ${finalists.length} settings, N=4, T=30s, workers=${workers}, vision=${vision ? 'ON' : 'OFF'}`);
    const tasks = finalists.flatMap((setting, settingIndex) => Array.from({ length: 4 }, (_, replicate) => ({ setting, settingIndex, replicate })));
    const taskReports = await parallelMap(tasks, workers, async (task, i) => {
      const out = path.join(dir, `final-${i}.json`);
      return { task, report: await runChild({ setting: task.setting, flies: 1, seconds: 30, sampleMs, vision, out, replicateStart: task.replicate }) };
    });
    finalRows = finalists.map((setting, settingIndex) => {
      const reports = taskReports.filter(row => row.task.settingIndex === settingIndex).map(row => row.report);
      const report = mergeReports(setting, reports, 30, sampleMs, vision);
      return { setting, report, score: score(report) };
    });
    printRows(finalRows, 'Final results');
  }
  const output = { parameters: { stage, workers, vision, sampleMs, coarseSeconds: 4, finalFlies: 4, finalSeconds: 30, wallSeconds: (Date.now() - started) / 1000 }, coarse: coarseRows, final: finalRows };
  const out = args.out || 'scratch/terminal-sweep.json';
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`\nSweep JSON ${out}`);
  console.log(`Wall time ${(output.parameters.wallSeconds / 60).toFixed(1)} min; temp ${dir}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
