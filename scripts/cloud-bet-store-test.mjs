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
const legacyMlbBet = sanitizeCloudBet({ ...bet, id: 'legacy-mlb-no-league', league: undefined });
assert.equal(legacyMlbBet?.league, 'MLB', 'legacy records created before multi-league support must migrate as MLB');
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
const page = fs.readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');
assert.match(store, /baseball_private_bets_v2/);
assert.match(store, /LEGACY_CACHE_KEY/);
assert.match(store, /function requireDurableDatabase\(\)[\s\S]*DATABASE_URL/, '未設定資料庫時正式寫入必須失敗關閉');
assert.doesNotMatch(store, /await cache\.set\(CACHE_KEY/, 'Runtime Cache不得作為正式帳本寫入真值');
assert.match(store, /crypto\.randomUUID\(\)/, '下注ID必須由伺服器產生');
assert.match(store, /status: 'OPEN'/, '新下注初始狀態必須由伺服器鎖定');
assert.match(store, /ON CONFLICT \(id\) DO NOTHING/, '每張下注單仍須保留不可變id');
assert.match(store, /WHERE position_key = \$\{bet\.positionIdentity\} LIMIT 1/, '同場同市場同方向只允許一筆下注，盤口或水位變動不得加注');
const v2Schema = store.match(/CREATE TABLE IF NOT EXISTS baseball_private_bets_v2\s*\(([\s\S]*?)\n\s*\)\n\s*`;/)?.[1] || '';
assert.ok(v2Schema, '必須找到v2正式帳本schema');
assert.match(v2Schema, /position_key TEXT NOT NULL/);
assert.doesNotMatch(v2Schema, /position_key TEXT NOT NULL UNIQUE/, '既有多筆歷史下注不得因新增唯一索引造成資料庫遷移失敗');
assert.match(store, /bet\.status === 'OPEN'/, '只重試真正待賽果的OPEN下注，人工確認不得阻塞舊單');
assert.match(store, /Date\.parse\(left\?\.placedAt/, '待結算必須由最舊下注開始補，避免新賽事餓死歷史下注');
assert.match(store, /Math\.min\(500/, '單次補結算上限必須足以涵蓋歷史帳本');
assert.match(route, /limit: 500/, '前端舊版即使送limit=40，伺服器也必須完整補結算');
assert.match(store, /settleOpenCloudBets/);
assert.match(store, /summarizeBetLedger/);
assert.match(route, /requireApiAuth/);
assert.match(route, /validateSameOrigin/);
assert.match(route, /checkRateLimit/);
assert.match(route, /action === 'merge'/);
assert.match(route, /action === 'upsert'/);
assert.doesNotMatch(route, /action === 'delete'/);
assert.doesNotMatch(route, /action === 'clearLeague'/);
assert.match(route, /action === 'settleOpen'/);

const mergeFunction = store.match(/export async function mergeCloudBets\(values\) \{([\s\S]*?)\n\}\n\nexport async function deleteCloudBet/)?.[1] || '';
assert.ok(mergeFunction, 'mergeCloudBets implementation missing');
const legacyDefaultIndex = mergeFunction.indexOf("? { ...value, league: 'MLB' }");
const candidateGateIndex = mergeFunction.indexOf('.filter(cloudBetCandidateCanWrite)');
const sanitizeIndex = mergeFunction.indexOf('.map(sanitizeCloudBet)');
assert.ok(legacyDefaultIndex >= 0, 'cloud merge must explicitly default pre-multi-league records to MLB');
assert.ok(
  legacyDefaultIndex < candidateGateIndex && candidateGateIndex < sanitizeIndex,
  'legacy MLB defaulting must occur before the strict new-write league gate and final sanitization',
);
assert.match(mergeFunction, /\.filter\(bet => bet && cloudBetLeagueCanWrite\(bet\.league\)\)/, 'migrated bets must still pass the normal league capability gate');

assert.match(page, /const migratedBets = migrateLegacyLocalBets\(initial\.bets\)/, 'initial local ledger must normalize missing league before cloud migration');
assert.match(page, /bets: cloudBetMigrationComplete\(\) \? primaryBets : recoverLocalBetCopies\(primaryBets, backupBets\)/, 'before cloud migration succeeds, primary and emergency backup ledgers must both be recovered');
assert.match(page, /if \(!cloudBetMigrationComplete\(\) && backupBets\.length\)/, 'an intact emergency backup must recover even when the primary compact store is missing or corrupt');
assert.match(page, /else if \(cloudBetMigrationComplete\(\)\) window\.localStorage\.removeItem\(BET_BACKUP_STORAGE\)/, 'an empty local state must not delete the emergency backup until cloud migration is confirmed');
const deleteFlow = page.match(/async function deleteBet\(bet\) \{([\s\S]*?)\n  \}/)?.[1] || '';
const clearFlow = page.match(/async function clearLeagueBets\(\) \{([\s\S]*?)\n  \}/)?.[1] || '';
assert.match(deleteFlow, /!cloudBetMigrationComplete\(\) \|\| cloudSyncBusyRef\.current/, 'delete must be blocked while the one-time legacy merge can still be in flight');
assert.match(clearFlow, /!cloudBetMigrationComplete\(\) \|\| cloudSyncBusyRef\.current/, 'clearLeague must be blocked while the one-time legacy merge can still be in flight');
const initialMergeStart = page.indexOf("body: JSON.stringify({ action: 'merge', bets: migratedBets })");
const initialMergeEnd = page.indexOf('}, []);', initialMergeStart);
assert.ok(initialMergeStart >= 0 && initialMergeEnd > initialMergeStart, 'initial cloud merge flow missing');
const initialMergeFlow = page.slice(initialMergeStart, initialMergeEnd);
assert.match(initialMergeFlow, /setBets\((?:data\.bets|Array\.isArray\(data\.bets\)\s*\?\s*data\.bets\s*:\s*\[\])\)/, 'the normalized server merge response must replace local state as the ledger truth');
assert.doesNotMatch(initialMergeFlow, /mergeBetCollections/, 'initial server response must not be re-merged with rejected or stale local records');

console.log('Immutable multi-league actual bet ledger, non-starving settlement backfill and authenticated API boundary PASS');
