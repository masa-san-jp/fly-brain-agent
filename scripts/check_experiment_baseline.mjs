// Separate runner smoke check; intentionally tiny and vision-off for CI/developer use.
import { spawnSync } from 'node:child_process';
const result = spawnSync(process.execPath, ['scripts/experiment_baseline.mjs', '--seconds=0.01', '--flies=1', '--conditions=none', '--workers=1', '--vision=0', '--out=/tmp/fly-baseline-smoke.jsonl'], { stdio: 'inherit' });
process.exit(result.status ?? 1);
