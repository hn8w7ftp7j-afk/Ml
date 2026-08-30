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
const uniquenessMigration = fs.readFileSync(new URL('../database/0006_cloud_bet_position_uniqueness.sql', import.meta.url), 'utf8');
assert.match(store, /baseball_private_bets_v2/);
assert.match(store, /function requireDurableDatabase\(\)[\s\S]*DATABASE_URL/, '未設定資料庫時正式寫入必須失敗關閉');
assert.match(store, /export async function listCloudBets\(\)\s*\{\s*requireDurableDatabase\(\);/, '正式帳本讀取缺少資料庫時也必須失敗關閉');
assert.match(store, /export async function listCloudBetsByIds\(values\)[\s\S]*WHERE id = ANY\(\$\{ids\}::text\[\]\)/, 'Reader盤口比較只可讀取要求的下注ID，不得每次下載完整帳本');
assert.match(store, /export async function updateOpenCloudBetClosingSnapshots/, '正式帳本必須支援開賽前最新盤覆蓋');
assert.match(store, /WHERE status = 'OPEN'[\s\S]*game_pk = ANY\(\$\{gameIds\}::bigint\[\]\)/, '最後盤更新只可查詢同聯盟同場未開賽下注');
assert.match(store, /payload = payload \|\| JSONB_BUILD_OBJECT\([\s\S]*'closingContractSnapshot'/, '跳盤必須覆蓋單一closing欄位，不得新增無限歷史列');
assert.match(store, /status = 'OPEN'[\s\S]*COALESCE\(payload->'closingContractSnapshot'->>'lineAsOf'/, '開賽後或較舊Reader盤不得覆蓋最後盤');
assert.doesNotMatch(store, /readCachedBets|runtimeCache|LEGACY_CACHE_KEY|CACHE_KEY/, 'Runtime Cache不得冒充永久帳本讀取真值');
assert.match(store, /crypto\.randomUUID\(\)/, '下注ID必須由伺服器產生');
assert.match(store, /Date\.now\(\) >= Date\.parse\(verification\?\.officialGame\?\.gameDate/, 'PIT查核後、資料庫寫入前必須再次阻擋已開打賽事');
assert.match(store, /if \(!prediction\.ok\)/, '不完整PIT prediction不得先寫入再由讀取時隔離');
assert.match(store, /status: 'OPEN'/, '新下注初始狀態必須由伺服器鎖定');
assert.match(store, /ON CONFLICT \(position_key\) DO NOTHING/, '新下注必須以資料庫唯一索引原子阻擋同方向競態加注');
assert.doesNotMatch(store, /SELECT id FROM baseball_private_bets_v2 WHERE (?:id = [^\n]+ OR )?position_key =/, '不得使用會產生TOCTOU競態的先查再寫');
assert.match(store, /ON CONFLICT DO NOTHING/, '歷史合併同時以id與position_key的資料庫約束原子去重');
const v2Schema = store.match(/CREATE TABLE IF NOT EXISTS baseball_private_bets_v2\s*\(([\s\S]*?)\n\s*\)\n\s*`;/)?.[1] || '';
assert.ok(v2Schema, '必須找到v2正式帳本schema');
assert.match(v2Schema, /position_key TEXT NOT NULL/);
assert.doesNotMatch(v2Schema, /position_key TEXT NOT NULL UNIQUE/, '唯一約束必須在歷史重複資料隔離後才建立，不可直接改建表DDL');
const schemaTransactionStart = store.indexOf('database.transaction(transaction => [');
const schemaLockIndex = store.indexOf('LOCK TABLE baseball_private_bets_v2 IN SHARE ROW EXCLUSIVE MODE', schemaTransactionStart);
const quarantineIndex = store.indexOf('baseball_private_bets_v2_position_quarantine', schemaLockIndex);
const deterministicRankIndex = store.indexOf('ORDER BY placed_at ASC, updated_at ASC, id ASC', quarantineIndex);
const uniqueIndex = store.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS uq_baseball_private_bets_v2_position_key_v110', deterministicRankIndex);
assert.ok(
  schemaTransactionStart >= 0
    && schemaLockIndex > schemaTransactionStart
    && quarantineIndex > schemaLockIndex
    && deterministicRankIndex > quarantineIndex
    && uniqueIndex > deterministicRankIndex,
  '既有重複必須在同一個上鎖交易中依時間與id決定保留單、完整隔離後才建唯一索引',
);
assert.match(store, /TO_JSONB\(ranked\) - 'duplicate_rank' - 'canonical_bet_id'/, '隔離表必須保存重複列的原始完整內容');
assert.match(store, /EXCLUDED_DUPLICATE_POSITION_QUARANTINE/, '歷史重複單必須失敗關閉，不可進入校準');
assert.match(uniquenessMigration, /^\s*--[\s\S]*?begin;/i, '唯一性遷移必須使用交易');
assert.match(uniquenessMigration, /lock table baseball_private_bets_v2 in share row exclusive mode/i);
assert.match(uniquenessMigration, /row_number\(\) over[\s\S]*order by placed_at asc, updated_at asc, id asc/i);
assert.match(uniquenessMigration, /create unique index if not exists uq_baseball_private_bets_v2_position_key_v110/i);
assert.doesNotMatch(uniquenessMigration, /\b(?:delete|truncate|drop)\b/i, '遷移不得刪除或捨棄任何歷史下注資料');
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
assert.match(route, /action === 'cancel'/, '尚未開賽的OPEN下注必須可改標為CANCELLED');
assert.match(route, /verification\.pitVerified !== true/, 'PIT未驗證的UI下注不得寫入永久帳本');
assert.match(route, /PIT_EVIDENCE_REQUIRED/, 'PIT缺失必須回明確fail-closed狀態');
assert.doesNotMatch(route, /action === 'delete'/);
assert.doesNotMatch(route, /action === 'clearLeague'/);
assert.match(route, /action === 'settleOpen'/);
assert.match(store, /export async function cancelOpenCloudBet/);
assert.match(store, /SET status = 'CANCELLED'[\s\S]*AND status = 'OPEN'[\s\S]*gameDate[\s\S]*> NOW\(\)/, '取消必須由資料庫原子限制為尚未開賽的OPEN下注');
assert.match(store, /USER_CANCELLED_PRESTART/, '取消必須保留伺服器時間與原因，不得硬刪除');
assert.match(store, /async function persistBetUpdates[\s\S]*WHERE id = \$\{bet\.id\} AND status = 'OPEN'/, '結算寫入不得把競態中已取消的下注覆蓋回SETTLED');
assert.match(route, /settlePendingAnalysisDirections/, '自動結算必須覆蓋所有CALCULATED分析方向，不只是真實下注');

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
assert.match(mergeFunction, /status: 'MANUAL_REVIEW'/, 'client legacy merge must never preserve a spoofed SETTLED performance status');
assert.match(mergeFunction, /settlement: null/, 'client legacy settlement/PnL must be quarantined');
assert.match(store, /function enforceTrustedLedgerEvidence/, 'database reads must quarantine pre-verification historical performance');
assert.match(store, /performanceEligibility: 'EXCLUDED_UNVERIFIABLE_LEGACY'/, 'unverified history must be excluded from performance truth');

assert.match(page, /const migratedBets = migrateLegacyLocalBets\(initial\.bets\)/, 'initial local ledger must normalize missing league before cloud migration');
assert.match(page, /bets: cloudBetMigrationComplete\(\) \? primaryBets : recoverLocalBetCopies\(primaryBets, backupBets\)/, 'before cloud migration succeeds, primary and emergency backup ledgers must both be recovered');
assert.match(page, /if \(!cloudBetMigrationComplete\(\) && backupBets\.length\)/, 'an intact emergency backup must recover even when the primary compact store is missing or corrupt');
assert.match(page, /else if \(cloudBetMigrationComplete\(\)\) window\.localStorage\.removeItem\(BET_BACKUP_STORAGE\)/, 'an empty local state must not delete the emergency backup until cloud migration is confirmed');
assert.doesNotMatch(page, /async function deleteBet|async function clearLeagueBets|action: 'delete'|action: 'clearLeague'/, '不可變帳本不得顯示或呼叫硬刪除／清空操作');
assert.match(page, /async function cancelBet/, '前端必須能取消尚未開賽的OPEN下注');
assert.match(page, /action: 'cancel'/, '取消必須呼叫保留證據的狀態轉換API');
assert.match(page, /不可變帳本/, '帳本UI必須揭露不可變證據政策');
assert.match(page, /下注證據永久保留；取消只變更狀態，不會刪除/, '帳本UI必須說明取消不會刪除原始證據');
const initialMergeStart = page.indexOf("body: JSON.stringify({ action: 'merge', bets: migratedBets })");
const initialMergeEnd = page.indexOf('}, []);', initialMergeStart);
assert.ok(initialMergeStart >= 0 && initialMergeEnd > initialMergeStart, 'initial cloud merge flow missing');
const initialMergeFlow = page.slice(initialMergeStart, initialMergeEnd);
assert.match(initialMergeFlow, /setBets\((?:data\.bets|Array\.isArray\(data\.bets\)\s*\?\s*data\.bets\s*:\s*\[\])\)/, 'the normalized server merge response must replace local state as the ledger truth');
assert.doesNotMatch(initialMergeFlow, /mergeBetCollections/, 'initial server response must not be re-merged with rejected or stale local records');

console.log('Immutable multi-league actual bet ledger, non-starving settlement backfill and authenticated API boundary PASS');
