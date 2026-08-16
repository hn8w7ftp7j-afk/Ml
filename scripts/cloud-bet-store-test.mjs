import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sanitizeCloudBet } from '../lib/cloud-bet-store.js';

const bet = sanitizeCloudBet({
  id: 'bet-1', league: 'MLB', date: '2026-08-16', gamePk: 123,
  market: '全場大小', pick: '小9+60', placedAt: '2026-08-16T12:00:00.000Z', water: 0.94,
});
assert.ok(bet);
assert.match(bet.positionIdentity, /^MLB\|\|\|2026-08-16\|\|\|123\|\|\|全場大小\|\|\|under$/);
assert.equal(sanitizeCloudBet({ ...bet, league: 'NFL' }), null);
assert.equal(sanitizeCloudBet({ ...bet, placedAt: 'invalid' }), null);

const route = fs.readFileSync(new URL('../app/api/bets/route.js', import.meta.url), 'utf8');
assert.match(route, /requireApiAuth/);
assert.match(route, /validateSameOrigin/);
assert.match(route, /checkRateLimit/);
assert.match(route, /action === 'merge'/);
assert.match(route, /action === 'upsert'/);
assert.match(route, /action === 'delete'/);
assert.match(route, /action === 'clearLeague'/);

console.log('Cloud bet store validation, stable position identity and authenticated API boundary PASS');
