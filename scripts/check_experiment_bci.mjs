import { spawnSync } from 'node:child_process';

const result = spawnSync(process.execPath, ['scripts/experiment_bci.mjs', '--seconds=0.01', '--flies=1', '--conditions=none', '--workers=1', '--vision=0', '--out=/tmp/fly-bci-smoke.jsonl'], { stdio: 'inherit' });
process.exit(result.status ?? 1);
