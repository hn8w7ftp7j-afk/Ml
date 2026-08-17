import assert from 'node:assert/strict';
import fs from 'node:fs';
import { cloudBetCandidateCanWrite, cloudBetLeagueCanWrite, sanitizeCloudBet, upsertCloudBet } from '../lib/cloud-bet-store.js';

const bet = sanitizeCloudBet({
  id: 'bet-1', league: 'MLB', date: '2026-08-16', gamePk: 123,
  market: '全場大小', pick: '小9+60', placedAt: '2026-08-16T12:00:00.000Z', water: 0.94,
});
assert.ok(bet);
assert.match(bet.positionIdentity, /^MLB\|\|\|2026-08-16\|\|\|123\|\|\|全場大小\|\|\|under$/);
assert.equal(sanitizeCloudBet({ ...bet, league: 'NFL' }), null);
assert.equal(sanitizeCloudBet({ ...bet, placedAt: 'invalid' }), null);
assert.equal(cloudBetLeagueCanWrite('MLB'), true);
for (const league of ['NPB', 'KBO', 'CPBL']) assert.equal(cloudBetLeagueCanWrite(league), false, `${league} shadow 不得寫入正式下注紀錄`);
assert.equal(cloudBetCandidateCanWrite({ ...bet, league: 'MLB' }), true);
assert.equal(cloudBetCandidateCanWrite({ ...bet, league: 'NPB' }), false);
assert.equal(cloudBetCandidateCanWrite({ ...bet, league: undefined }), false, '新寫入不得利用 legacy MLB default');
await assert.rejects(() => upsertCloudBet({ ...bet, league: 'NPB' }), /影子分析，不可寫入正式下注紀錄/);
await assert.rejects(() => upsertCloudBet({ ...bet, league: undefined }), /必須明確提供有效聯盟/);

const route = fs.readFileSync(new URL('../app/api/bets/route.js', import.meta.url), 'utf8');
const store = fs.readFileSync(new URL('../lib/cloud-bet-store.js', import.meta.url), 'utf8');
assert.match(store, /if \(!databaseConfigured\(\)\) return readCachedBets\(\)/, '未設定資料庫時必須使用 Vercel 雲端快取，不得直接報錯');
assert.match(store, /cache\.set\(CACHE_KEY/);
assert.match(store, /if \(!cloudBetLeagueCanWrite\(bet\.league\)\) throw new Error/, '單筆 upsert 必須在 store 層阻擋 shadow 聯盟');
assert.match(store, /filter\(cloudBetCandidateCanWrite\)/, 'merge 必須先拒絕缺 league 與 shadow 聯盟紀錄');
assert.doesNotMatch(store, /if \(!process\.env\.DATABASE_URL\) throw new Error\('DATABASE_URL is not configured'\)/);
assert.match(route, /requireApiAuth/);
assert.match(route, /validateSameOrigin/);
assert.match(route, /checkRateLimit/);
assert.match(route, /action === 'merge'/);
assert.match(route, /action === 'upsert'/);
assert.match(route, /action === 'delete'/);
assert.match(route, /action === 'clearLeague'/);

console.log('Cloud bet store validation, stable position identity and authenticated API boundary PASS');
