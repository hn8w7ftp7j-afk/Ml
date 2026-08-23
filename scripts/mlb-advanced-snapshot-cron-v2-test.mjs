import assert from 'node:assert/strict';
import fs from 'node:fs';

const route = fs.readFileSync(new URL('../app/api/cron/mlb-advanced-snapshots/route.js', import.meta.url), 'utf8');
const middleware = fs.readFileSync(new URL('../middleware.js', import.meta.url), 'utf8');
const vercel = JSON.parse(fs.readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
assert.match(route, /process\.env\.CRON_SECRET/);
assert.match(route, /Bearer \$\{secret\}/);
assert.match(route, /filterLeaguePrestartGames\('MLB'/);
assert.match(route, /persistMlbAdvancedSnapshotBestEffort/);
assert.match(middleware, /\/api\/cron\/mlb-advanced-snapshots/);
assert.deepEqual(vercel.crons, [{ path: '/api/cron/mlb-advanced-snapshots', schedule: '0 0 * * *' }]);
console.log('Authenticated daily MLB advanced snapshot cron PASS');

