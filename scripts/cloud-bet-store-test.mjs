import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  cloudBetCandidateCanWrite,
  cloudBetLeagueCanWrite,
  sanitizeCloudBet,
  upsertCloudBet,
} from '../lib/cloud-bet-store.js';

const bet = sanitizeCloudBet({
  id: 'bet-1',
  league: 'MLB',
  date: '2026-08-16',
  gamePk: 123,
  market: '全場大小',
  pick: '小9+60',
  placedAt: '2026-08-16T12:00:00.000Z',
  water: 0.94,
  stake: 10000,
  score: 8.8,
  scoreStatus: 'LEGACY_INVALID',
});
assert.ok(bet);
assert.match(bet.positionIdentity, /^MLB\|\|\|2026-08-16\|\|\|123\|\|\|全場大小\|\|\|under$/);
assert.match(bet.priceIdentity, /under:9:positive:60\|\|\|0\.940000$/);
assert.equal(bet.score, null, '舊版或Shadow分數不得混入正式下注績效');
assert.equal(bet.status, 'OPEN');
assert.equal(bet.rebateRate, 0.015);
assert.equal(sanitizeCloudBet({ ...bet, league: 'NFL' }), null);
assert.equal(sanitizeCloudBet({ ...bet, placedAt: 'invalid' }), null);
assert.equal(sanitizeCloudBet({ ...bet, stake: 0 }), null);
assert.equal(sanitizeCloudBet({ ...bet, water: null }), null);

for (const league of ['MLB', 'NPB', 'KBO', 'CPBL']) {
  assert.equal(cloudBetLeagueCanWrite(league), true, `${league} Shadow仍須能記錄使用者真實下注`);
  assert.equal(cloudBetCandidateCanWrite({ ...bet, league }), true);
}
assert.equal(cloudBetCandidateCanWrite({ ...bet, league: undefined }), false, '新寫入不得利用legacy MLB default');
await assert.rejects(() => upsertCloudBet({ ...bet, league: undefined }), /必須明確提供有效聯盟/);

const formal = sanitizeCloudBet({ ...bet, id: 'formal-1', score: 8.2, scoreStatus: 'FORMAL_VALIDATED' });
assert.equal(formal.score, 8.2);

const route = fs.readFileSync(new URL('../app/api/bets/route.js', import.meta.url), 'utf8');
const store = fs.readFileSync(new URL('../lib/cloud-bet-store.js', import.meta.url), 'utf8');
assert.match(store, /baseball_private_bets_v2/);
assert.match(store, /LEGACY_CACHE_KEY/);
assert.match(store, /if \(!databaseConfigured\(\)\) return readCachedBets\(\)/, '未設定資料庫時必須使用Vercel雲端快取');
assert.match(store, /cache\.set\(CACHE_KEY/);
assert.match(store, /ON CONFLICT \(id\) DO NOTHING/, '每張下注單以不可變id去重，不得以方向覆蓋');
assert.doesNotMatch(store, /position_key TEXT NOT NULL UNIQUE/, 'v2正式帳本不得把同方向限制成只能一筆');
assert.match(store, /settleOpenCloudBets/);
assert.match(store, /summarizeBetLedger/);
assert.match(route, /requireApiAuth/);
assert.match(route, /validateSameOrigin/);
assert.match(route, /checkRateLimit/);
assert.match(route, /action === 'merge'/);
assert.match(route, /action === 'upsert'/);
assert.match(route, /action === 'delete'/);
assert.match(route, /action === 'clearLeague'/);
assert.match(route, /action === 'settleOpen'/);

console.log('Immutable multi-league actual bet ledger, settlement action and authenticated API boundary PASS');
