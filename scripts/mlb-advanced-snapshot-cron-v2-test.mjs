import assert from 'node:assert/strict';
import fs from 'node:fs';

const route = fs.readFileSync(new URL('../app/api/cron/mlb-advanced-snapshots/route.js', import.meta.url), 'utf8');
const betSettlementRoute = fs.readFileSync(new URL('../app/api/cron/bet-settlements/route.js', import.meta.url), 'utf8');
const middleware = fs.readFileSync(new URL('../middleware.js', import.meta.url), 'utf8');
const vercel = JSON.parse(fs.readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
assert.match(route, /process\.env\.CRON_SECRET/);
assert.match(route, /Bearer \$\{secret\}/);
assert.match(route, /filterLeaguePrestartGames\('MLB'/);
assert.match(route, /persistMlbAdvancedSnapshotBestEffort/);
assert.match(middleware, /\/api\/cron\/mlb-advanced-snapshots/);
assert.match(betSettlementRoute, /process\.env\.CRON_SECRET/);
assert.match(betSettlementRoute, /Bearer \$\{secret\}/);
assert.match(betSettlementRoute, /settleOpenCloudBets/);
assert.deepEqual(vercel.crons, [
  { path: '/api/cron/mlb-advanced-snapshots', schedule: '0 0 * * *' },
  { path: '/api/cron/analysis-direction-settlements', schedule: '30 21 * * *' },
  { path: '/api/cron/bet-settlements', schedule: '15 * * * *' },
]);
console.log('Authenticated MLB snapshot and automatic bet settlement crons PASS');
