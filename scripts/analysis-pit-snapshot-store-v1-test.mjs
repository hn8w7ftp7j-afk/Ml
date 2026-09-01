import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  ANALYSIS_PIT_SNAPSHOT_SCHEMA_VERSION,
  analysisPitProductionPersistenceRequired,
  analysisPitSemanticIdentityHash,
  assertAnalysisPitReplayIdentity,
  assertStoredAnalysisPitIdentity,
  buildAnalysisPitReplayBundle,
  buildAnalysisPitSnapshotRecord,
  buildAnalysisPitSnapshotRecordAsync,
  decodeAnalysisPitPayload,
  encodeAnalysisPitPayload,
  encodeAnalysisPitPayloadAsync,
  persistAnalysisPitSnapshot,
  persistAnalysisPitSnapshotForResponse,
  scheduleAnalysisPitSnapshotPersistence,
  validateAnalysisPitSnapshotRecord,
} from '../lib/analysis-pit-snapshot-store-v1.js';
import { signRepriceSnapshot, verifyRepriceSnapshot } from '../lib/market-integrity-v1.js';

const hash = character => character.repeat(64);
const jsonbLikeRoundTrip = value => {
  if (Array.isArray(value)) return value.map(jsonbLikeRoundTrip);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => Buffer.byteLength(left, 'utf8') - Buffer.byteLength(right, 'utf8')
      || left.localeCompare(right))
    .map(([key, nested]) => [key, jsonbLikeRoundTrip(nested)]));
};
const game = {
  league: 'MLB',
  leagueId: 'MLB',
  gamePk: 990001,
  gameNumber: 1,
  gameDate: '2099-08-25T10:00:00.000Z',
  officialDate: '2099-08-25',
  awayTeamId: 101,
  homeTeamId: 102,
  away: 'Away',
  home: 'Home',
  venueId: 10,
  venue: 'Park',
};
const context = {
  leagueId: 'MLB',
  game,
  fetchedAt: '2099-08-25T08:00:00.000Z',
  modelVersion: 'MODEL-v1',
  rulesVersion: 'RULES-v1',
  dataVersion: 'DATA-v1',
  away: { starter: { name: 'A' } },
  home: { starter: { name: 'B' } },
  featureProvenance: [{
    featureName: 'starters',
    sourceProvider: 'OFFICIAL',
    fetchedAt: '2099-08-25T07:59:00.000Z',
    providerObservedAt: '2099-08-25T07:58:00.000Z',
  }],
};
const versions = {
  modelVersion: 'MODEL-v1',
  rulesVersion: 'RULES-v1',
  dataVersion: 'DATA-v1',
  scoreFormulaVersion: 'SCORE-v1',
  settlementRuleVersion: 'SETTLEMENT-v1',
  uncertaintySetVersion: 'UNCERTAINTY-v1',
};
const analysis = {
  leagueId: 'MLB',
  analysisType: 'FULL',
  analysisMode: 'SHADOW',
  inputHash: hash('a'),
  coreFingerprint: hash('b'),
  priceFingerprint: hash('c'),
  calculationFingerprint: hash('d'),
  auxiliaryFingerprint: hash('e'),
  distributionId: '990001:distribution-one',
  distributionHash: hash('f'),
  dataAsOf: context.fetchedAt,
  lineAsOf: '2099-08-25T08:02:00.000Z',
  analysisAsOf: '2099-08-25T08:03:00.000Z',
  expectedRuns: { full: { away: 4.1, home: 4.2 } },
  results: [{ market: '全場大小', pick: '大8平', weightedEV: 0.02, robustEV: 0.01 }],
};
const distributionSnapshot = {
  distributionId: analysis.distributionId,
  distributionHash: analysis.distributionHash,
  gamePk: game.gamePk,
  modelVersion: versions.modelVersion,
  rulesVersion: versions.rulesVersion,
  scenarios: [{ id: 'central', weight: 1, pmf: [0.2, 0.8] }],
};
const input = {
  league: 'MLB', game, frozenContext: context, analysis, distributionSnapshot, versions,
  markets: [{ market: '全場大小', pick: '大8平', water: 0.94, lineAsOf: analysis.lineAsOf }],
  previousMarkets: [],
};

const first = buildAnalysisPitSnapshotRecord(input);
const duplicate = buildAnalysisPitSnapshotRecord(input);
const asyncFirst = await buildAnalysisPitSnapshotRecordAsync(input);
const reverseKeys = value => Object.fromEntries(Object.entries(value).reverse());
assert.equal(first.schemaVersion, ANALYSIS_PIT_SNAPSHOT_SCHEMA_VERSION);
assert.equal(first.snapshotId, duplicate.snapshotId, '相同PIT輸入必須產生相同snapshot id');
assert.equal(first.replayIdentityHash, duplicate.replayIdentityHash, '相同PIT輸入必須冪等');
assert.equal(asyncFirst.snapshotId, first.snapshotId, '非同步壓縮路徑不得改變snapshot id');
assert.equal(asyncFirst.replayIdentityHash, first.replayIdentityHash, '非同步壓縮路徑必須完全可重播');
const retryContext = {
  ...context,
  fetchedAt: '2099-08-25T08:01:00.000Z',
  featureProvenance: context.featureProvenance.map(row => ({ ...row, fetchedAt: '2099-08-25T08:00:30.000Z' })),
};
const retryRecord = buildAnalysisPitSnapshotRecord({
  ...input,
  frozenContext: retryContext,
  analysis: { ...analysis, dataAsOf: retryContext.fetchedAt, analysisAsOf: '2099-08-25T08:04:00.000Z' },
});
assert.notEqual(retryRecord.replayIdentityHash, first.replayIdentityHash, '精確PIT仍須保留不同抓取時間');
assert.equal(
  analysisPitSemanticIdentityHash(retryRecord),
  analysisPitSemanticIdentityHash(first),
  '同一模型輸入只差重試抓取時間時必須可安全辨識為冪等',
);
const changedEvRecord = buildAnalysisPitSnapshotRecord({
  ...input,
  analysis: { ...analysis, results: [{ ...analysis.results[0], weightedEV: 0.03 }] },
});
assert.notEqual(
  analysisPitSemanticIdentityHash(changedEvRecord),
  analysisPitSemanticIdentityHash(first),
  '實際分析數值不同時不得用冪等相容繞過永久PIT衝突',
);
assert.doesNotThrow(() => validateAnalysisPitSnapshotRecord({
  ...first,
  gameIdentity: reverseKeys(first.gameIdentity),
  versions: reverseKeys(first.versions),
}), 'JSONB重新排列巢狀物件欄位後仍必須通過相同重播識別雜湊');
assert.deepEqual(decodeAnalysisPitPayload(first.frozenContextPayload), context);
assert.equal(first.frozenContextPayload.encoding, 'JSON_BASE64');
assert.equal(typeof first.frozenContextPayload.data, 'string', '新內嵌PIT payload必須保存精確UTF-8 bytes的Base64');
assert.equal(Object.hasOwn(first.frozenContextPayload, 'value'), false, '新payload不得再把可重排物件直接寫入JSONB');
assert.equal(decodeAnalysisPitPayload(first.marketAnalysisPayload).results[0].pick, '大8平');
assert.deepEqual(decodeAnalysisPitPayload(first.marketAnalysisPayload).directionSlots, [], '舊輸入仍必須有可重播的八方向槽位容器');
assert.equal(decodeAnalysisPitPayload(first.marketAnalysisPayload).marketCoverage, null);
assert.equal(decodeAnalysisPitPayload(first.distributionPayload).distributionHash, analysis.distributionHash);
assert.equal(first.providerTimestamps.sources[0].provider, 'OFFICIAL');
assert.equal(first.evidenceStatus, 'CURRENT_IMMUTABLE_PIT_CAPTURE');
assert.equal(first.quarantineStatus, 'NOT_QUARANTINED');
assert.equal(first.calibrationEligibility, 'PENDING_SETTLEMENT_AND_LOCKED_OOS_GATE');
assert.throws(() => buildAnalysisPitSnapshotRecord({ ...input, distributionSnapshot: null }), /永久比分分布payload/);
assert.equal(assertAnalysisPitReplayIdentity(first, {
  leagueId: 'MLB', gamePk: game.gamePk, inputHash: analysis.inputHash,
  distributionId: analysis.distributionId, distributionHash: analysis.distributionHash,
}), true);

const kboGame = { ...game, league: 'KBO', leagueId: 'KBO' };
const kboContext = { ...context, leagueId: 'KBO', game: kboGame };
const kboRecord = buildAnalysisPitSnapshotRecord({
  ...input,
  league: 'KBO',
  game: kboGame,
  frozenContext: kboContext,
  analysis: { ...analysis, leagueId: 'KBO' },
});
assert.notEqual(kboRecord.snapshotId, first.snapshotId, '相同gamePk/input hash也必須按聯盟隔離');
assert.throws(() => buildAnalysisPitSnapshotRecord({ ...input, league: 'KBO' }), /聯盟/);
assert.throws(() => assertAnalysisPitReplayIdentity(first, { leagueId: 'KBO' }), /leagueId/);
const allLeagueRecords = ['MLB', 'NPB', 'KBO', 'CPBL'].map(leagueId => {
  const leagueGame = { ...game, league: leagueId, leagueId };
  return buildAnalysisPitSnapshotRecord({
    ...input,
    league: leagueId,
    game: leagueGame,
    frozenContext: { ...context, leagueId, game: leagueGame },
    analysis: { ...analysis, leagueId },
  });
});
assert.equal(new Set(allLeagueRecords.map(record => record.snapshotId)).size, 4);
assert.deepEqual(allLeagueRecords.map(record => record.leagueId), ['MLB', 'NPB', 'KBO', 'CPBL']);

const repriceAnalysis = {
  ...analysis,
  analysisType: 'PRICE_ONLY_REPRICE',
  inputHash: hash('1'),
  priceFingerprint: hash('2'),
  calculationFingerprint: hash('3'),
  auxiliaryFingerprint: hash('4'),
  parentInputHash: analysis.inputHash,
  parentDistributionId: analysis.distributionId,
  lineAsOf: '2099-08-25T08:04:00.000Z',
  analysisAsOf: '2099-08-25T08:05:00.000Z',
};
const repriceRecord = buildAnalysisPitSnapshotRecord({
  ...input,
  analysis: repriceAnalysis,
  distributionSnapshot: null,
  versions: { ...versions, repriceVersion: 'REPRICE-v1' },
});
assert.equal(repriceRecord.parentInputHash, first.inputHash);
assert.equal(repriceRecord.parentAnalysisType, 'FULL');
assert.equal(repriceRecord.parentSnapshotId, first.snapshotId);
assert.equal(repriceRecord.parentDistributionId, first.distributionId);
assert.equal(repriceRecord.parentDistributionHash, first.distributionHash);
assert.equal(repriceRecord.distributionStorage, 'HASH_ONLY_REBUILDABLE');
assert.equal(decodeAnalysisPitPayload(repriceRecord.distributionPayload), null);
assert.throws(() => validateAnalysisPitSnapshotRecord({ ...repriceRecord, parentDistributionId: 'different' }), /父比分分布|重播/);
assert.throws(() => validateAnalysisPitSnapshotRecord({
  ...repriceRecord,
  parentSnapshotId: repriceRecord.snapshotId,
  parentAnalysisType: 'PRICE_ONLY_REPRICE',
  parentInputHash: repriceRecord.inputHash,
}), /self-parent|無變更/, '快速重算不得建立self-parent/no-op快照');

const chainedRepriceRecord = buildAnalysisPitSnapshotRecord({
  ...input,
  analysis: {
    ...repriceAnalysis,
    inputHash: hash('5'),
    parentInputHash: repriceRecord.inputHash,
    parentAnalysisType: 'PRICE_ONLY_REPRICE',
    parentPitSnapshotId: repriceRecord.snapshotId,
    analysisAsOf: '2099-08-25T08:06:00.000Z',
    lineAsOf: '2099-08-25T08:06:00.000Z',
  },
  distributionSnapshot: null,
  versions: { ...versions, repriceVersion: 'REPRICE-v1' },
});
assert.equal(chainedRepriceRecord.parentSnapshotId, repriceRecord.snapshotId, '連續快速重算必須連到直接父快照');
assert.equal(chainedRepriceRecord.parentAnalysisType, 'PRICE_ONLY_REPRICE');
const fullReplay = buildAnalysisPitReplayBundle(first);
assert.equal(fullReplay.distributionSourceSnapshotId, first.snapshotId);
assert.deepEqual(fullReplay.parentChain, [first.snapshotId]);
assert.equal(fullReplay.inputHash, first.inputHash);
assert.equal(fullReplay.coreFingerprint, first.coreFingerprint);
assert.equal(fullReplay.distributionHash, first.distributionHash);
assert.equal(fullReplay.analysisAsOf, first.analysisAsOf);
assert.equal(fullReplay.dataAsOf, first.dataAsOf);
const repriceReplay = buildAnalysisPitReplayBundle(repriceRecord, { parentRecords: [first] });
assert.equal(repriceReplay.distributionSourceSnapshotId, first.snapshotId);
assert.deepEqual(repriceReplay.parentChain, [repriceRecord.snapshotId, first.snapshotId]);
const chainedReplay = buildAnalysisPitReplayBundle(chainedRepriceRecord, { parentRecords: [first, repriceRecord] });
assert.deepEqual(chainedReplay.parentChain, [chainedRepriceRecord.snapshotId, repriceRecord.snapshotId, first.snapshotId]);
assert.throws(() => buildAnalysisPitReplayBundle(repriceRecord, { parentRecords: [] }), /缺少父快照/);
assert.throws(() => buildAnalysisPitReplayBundle(repriceRecord, {
  parentRecords: [{ ...first, distributionHash: hash('9') }],
}), /重播識別|父快照身分|比分分布/);

const legacyRecord = buildAnalysisPitSnapshotRecord({
  ...input,
  frozenContext: { ...context, legacyContextUsed: true },
  analysis: { ...analysis, inputHash: hash('6') },
});
assert.equal(legacyRecord.quarantineContract.status, 'QUARANTINED');
assert.equal(legacyRecord.quarantineContract.calibrationEligibility, 'EXCLUDED_UNVERIFIABLE_LEGACY');
assert.equal(legacyRecord.quarantineContract.mayEnterCalibration, false);
assert.equal(legacyRecord.evidenceStatus, 'EXCLUDED_UNVERIFIABLE_LEGACY');
assert.equal(legacyRecord.calibrationEligibility, 'EXCLUDED_UNVERIFIABLE_LEGACY');

const integrityEnv = { SESSION_SECRET: 'pit-snapshot-identity-test-secret-1234567890' };
const signedIdentitySnapshot = await signRepriceSnapshot('MLB', game, {
  frozenContext: context,
  inputHash: analysis.inputHash,
  distributionId: analysis.distributionId,
  distributionHash: analysis.distributionHash,
}, integrityEnv);
assert.equal(await verifyRepriceSnapshot('MLB', game, signedIdentitySnapshot, integrityEnv), true);
const alteredIdentityGame = { ...game, gameDate: '2099-08-25T11:00:00.000Z' };
const alteredIdentitySnapshot = {
  ...signedIdentitySnapshot,
  frozenContext: { ...context, game: alteredIdentityGame },
};
assert.equal(
  await verifyRepriceSnapshot('MLB', alteredIdentityGame, alteredIdentitySnapshot, integrityEnv),
  false,
  '即使同時修改凍結game與外層game，HMAC仍必須拒絕開打時間／賽事身分變造',
);

const postStartAnalysis = { ...analysis, analysisAsOf: game.gameDate };
assert.throws(() => buildAnalysisPitSnapshotRecord({ ...input, analysis: postStartAnalysis }), /賽前point-in-time/);
assert.throws(() => buildAnalysisPitSnapshotRecord({
  ...input,
  analysis: { ...analysis, lineAsOf: '2099-08-25T08:04:00.000Z', analysisAsOf: '2099-08-25T08:03:00.000Z' },
}), /賽前point-in-time/);

assert.equal(assertStoredAnalysisPitIdentity(first, {
  snapshot_id: first.snapshotId,
  league_id: first.leagueId,
  external_game_id: first.gameIdentity.gamePk,
  analysis_type: first.analysisType,
  input_hash: first.inputHash,
  core_fingerprint: first.coreFingerprint,
  distribution_id: first.distributionId,
  distribution_hash: first.distributionHash,
  parent_input_hash: null,
  parent_distribution_id: null,
  replay_identity_hash: first.replayIdentityHash,
}), true);
assert.throws(() => assertStoredAnalysisPitIdentity(first, {
  snapshot_id: first.snapshotId,
  league_id: 'NPB',
  external_game_id: first.gameIdentity.gamePk,
}), /衝突/);

const compressed = encodeAnalysisPitPayload({ text: 'z'.repeat(2_000) }, {
  label: '壓縮測試', inlineLimitBytes: 100, rawLimitBytes: 5_000, compressedLimitBytes: 1_000,
});
assert.equal(compressed.encoding, 'GZIP_BASE64');
assert.equal(decodeAnalysisPitPayload(compressed).text.length, 2_000);
assert.equal(compressed.base64Bytes, Buffer.byteLength(compressed.data, 'ascii'));
const inlineSource = { longerKey: { zebra: 1, a: 2 }, a: 'JSONB-safe' };
const inline = encodeAnalysisPitPayload(inlineSource, {
  label: 'JSONB鍵序測試', inlineLimitBytes: 10_000, rawLimitBytes: 10_000, compressedLimitBytes: 1_000,
});
assert.equal(inline.encoding, 'JSON_BASE64', '小型payload也必須保存原始UTF-8 bytes，不得把物件直接嵌入JSONB');
assert.deepEqual(
  decodeAnalysisPitPayload(jsonbLikeRoundTrip(inline)),
  inlineSource,
  'JSONB重新排列envelope鍵序後仍必須通過原始byte hash與大小驗證',
);
const adaptiveCompressedSource = {
  leagueId: 'KBO',
  repeatedFrozenContext: Array.from({ length: 600 }, (_, index) => ({
    feature: `feature-${index % 12}`,
    provider: 'OFFICIAL_PROVIDER',
    status: 'CONFIRMED',
  })),
};
const adaptiveCompressed = encodeAnalysisPitPayload(adaptiveCompressedSource, {
  label: '中型凍結情境壓縮測試',
  inlineLimitBytes: 256_000,
  rawLimitBytes: 1_000_000,
  compressedLimitBytes: 500_000,
});
assert.equal(adaptiveCompressed.encoding, 'GZIP_BASE64', '中型重複JSON不得因低於舊inline門檻而以Base64膨脹保存');
assert.ok(adaptiveCompressed.base64Bytes < adaptiveCompressed.rawBytes, '自適應gzip必須實際降低資料庫payload大小');
assert.deepEqual(decodeAnalysisPitPayload(adaptiveCompressed), adaptiveCompressedSource, '自適應gzip後仍必須byte-exact重播');
const adaptiveAsyncCompressed = await encodeAnalysisPitPayloadAsync(adaptiveCompressedSource, {
  label: '非同步中型凍結情境壓縮測試',
  inlineLimitBytes: 256_000,
  rawLimitBytes: 1_000_000,
  compressedLimitBytes: 500_000,
});
assert.equal(adaptiveAsyncCompressed.encoding, 'GZIP_BASE64');
assert.equal(adaptiveAsyncCompressed.payloadHash, adaptiveCompressed.payloadHash, '同步／非同步壓縮不得改變PIT原始內容hash');
assert.deepEqual(decodeAnalysisPitPayload(adaptiveAsyncCompressed), adaptiveCompressedSource);
const tamperedInline = {
  ...inline,
  data: `${inline.data[0] === 'A' ? 'B' : 'A'}${inline.data.slice(1)}`,
};
assert.throws(
  () => decodeAnalysisPitPayload(tamperedInline),
  error => error?.code === 'PIT_PAYLOAD_INTEGRITY_FAILED',
  '原始JSON Base64被修改時必須維持fail-closed',
);
const legacyInlineText = JSON.stringify(inlineSource);
const legacyInline = {
  version: 'BASEBALL-PIT-JSON-PAYLOAD-v1.0.0',
  encoding: 'JSON',
  rawBytes: Buffer.byteLength(legacyInlineText, 'utf8'),
  compressedBytes: null,
  payloadHash: inline.payloadHash,
  value: inlineSource,
};
assert.deepEqual(decodeAnalysisPitPayload(legacyInline), inlineSource, '未經JSONB改序的舊格式仍須可讀');
assert.throws(
  () => decodeAnalysisPitPayload(jsonbLikeRoundTrip(legacyInline)),
  error => error?.code === 'PIT_PAYLOAD_INTEGRITY_FAILED' && /雜湊|大小/.test(error.message),
  '已失去原始鍵序的舊JSONB payload不得在無法證明hash時假裝通過',
);
const asyncCompressed = await encodeAnalysisPitPayloadAsync({ text: 'y'.repeat(2_000) }, {
  label: '非同步壓縮測試', inlineLimitBytes: 100, rawLimitBytes: 5_000, compressedLimitBytes: 1_000,
});
assert.equal(asyncCompressed.encoding, 'GZIP_BASE64');
assert.equal(decodeAnalysisPitPayload(asyncCompressed).text.length, 2_000);
assert.throws(() => decodeAnalysisPitPayload({
  ...compressed,
  compressedBytes: compressed.compressedBytes + 1,
}), /Base64|gzip|壓縮大小/, '壓縮byte宣告必須與payload一致');
assert.throws(() => decodeAnalysisPitPayload({
  ...compressed,
  base64Bytes: compressed.base64Bytes + 1,
}), /Base64大小/, 'Base64字串大小宣告必須一致');
const omitted = encodeAnalysisPitPayload({ text: 'z'.repeat(2_000) }, {
  label: '省略測試', inlineLimitBytes: 100, rawLimitBytes: 500, compressedLimitBytes: 1,
  allowOmit: true,
});
assert.equal(omitted.encoding, 'OMITTED_HASH_ONLY');
assert.equal(decodeAnalysisPitPayload(omitted), null);
assert.throws(() => decodeAnalysisPitPayload({ ...compressed, payloadHash: hash('0') }), /雜湊/);

const oldDatabaseUrl = process.env.DATABASE_URL;
const oldDatabaseV2Url = process.env.DATABASE_V2_URL;
const oldVercelEnvironment = process.env.VERCEL_ENV;
const oldVercel = process.env.VERCEL;
delete process.env.DATABASE_URL;
delete process.env.DATABASE_V2_URL;
delete process.env.VERCEL_ENV;
delete process.env.VERCEL;
assert.equal(analysisPitProductionPersistenceRequired({ VERCEL_ENV: 'preview', NODE_ENV: 'production' }), false);
assert.equal(analysisPitProductionPersistenceRequired({ VERCEL_ENV: 'production' }), true);
assert.equal(analysisPitProductionPersistenceRequired({ NODE_ENV: 'production', VERCEL: '1' }), true);
assert.deepEqual(await persistAnalysisPitSnapshot(first), {
  stored: false, reason: 'DATABASE_NOT_CONFIGURED', snapshotId: first.snapshotId,
});
const unavailableForResponse = await persistAnalysisPitSnapshotForResponse(input);
assert.equal(unavailableForResponse.status, 'UNAVAILABLE');
assert.equal(unavailableForResponse.confirmed, false);
assert.equal(unavailableForResponse.required, false);
assert.equal(unavailableForResponse.reason, 'DATABASE_NOT_CONFIGURED');
let scheduledPromise;
const scheduled = scheduleAnalysisPitSnapshotPersistence(input, { waitUntilFn: promise => { scheduledPromise = promise; } });
assert.equal(scheduled.scheduled, true);
assert.equal(scheduled.snapshotId, first.snapshotId);
assert.equal((await scheduledPromise).reason, 'DATABASE_NOT_CONFIGURED');
process.env.VERCEL_ENV = 'production';
const productionDatabaseMissing = await persistAnalysisPitSnapshotForResponse(input);
assert.equal(productionDatabaseMissing.status, 'FAILED');
assert.equal(productionDatabaseMissing.confirmed, false);
assert.equal(productionDatabaseMissing.required, true);
assert.equal(productionDatabaseMissing.reason, 'DATABASE_NOT_CONFIGURED');
if (oldDatabaseUrl) process.env.DATABASE_URL = oldDatabaseUrl;
if (oldDatabaseV2Url == null) delete process.env.DATABASE_V2_URL;
else process.env.DATABASE_V2_URL = oldDatabaseV2Url;
if (oldVercelEnvironment == null) delete process.env.VERCEL_ENV;
else process.env.VERCEL_ENV = oldVercelEnvironment;
if (oldVercel == null) delete process.env.VERCEL;
else process.env.VERCEL = oldVercel;

const migration = fs.readFileSync(new URL('../database/0005_analysis_pit_snapshots.sql', import.meta.url), 'utf8');
assert.match(migration, /league_id text not null check \(league_id in \('MLB', 'NPB', 'KBO', 'CPBL'\)\)/i);
assert.match(migration, /unique \(league_id, analysis_type, input_hash\)/i);
assert.match(migration, /analysis_as_of < game_start/i);
assert.match(migration, /created_at < game_start/i);
assert.match(migration, /before update or delete/i);
assert.match(migration, /parent_distribution_id = distribution_id/i);
assert.match(migration, /parent_snapshot_id text references baseball_analysis_pit_snapshots\(snapshot_id\)/i);
assert.match(migration, /feature_contract jsonb not null/i);
assert.match(migration, /calibration_contract jsonb not null/i);
assert.match(migration, /quarantine_contract jsonb not null/i);
assert.match(migration, /calibration_eligibility text not null/i);
assert.match(migration, /analysis_pit_reprice_not_self/i);
assert.match(migration, /pg_advisory_xact_lock/i);
assert.doesNotMatch(migration, /drop trigger/i, 'immutable trigger migration不得留下DROP/CREATE競態窗');

const storeSource = fs.readFileSync(new URL('../lib/analysis-pit-snapshot-store-v1.js', import.meta.url), 'utf8');
assert.match(storeSource, /WHERE \$\{record\.gameStart\}::timestamptz > NOW\(\)/, '資料庫寫入時也必須拒絕已開打賽事');
assert.match(storeSource, /ON CONFLICT DO NOTHING/, '相同PIT快照必須冪等寫入');
assert.match(storeSource, /waitUntilFn\(persistence\)/, '資料庫寫入不得阻塞API回應');
assert.match(storeSource, /parentWrite[\s\S]*await parentWrite/, '同一Runtime的子快照必須等待父快照寫入');
assert.match(storeSource, /PARENT_SNAPSHOT_NOT_STORED/, '跨Runtime父快照尚未出現時必須重試後明確拒絕，不能留下孤兒');
assert.match(storeSource, /ALTER TABLE baseball_analysis_pit_snapshots[\s\S]*ADD COLUMN IF NOT EXISTS quarantine_contract/, 'rolling Production必須能演進既有schema');
assert.match(storeSource, /buildAnalysisPitSnapshotRecordAsync\(input\)/, 'waitUntil備援路徑也不得同步gzip大型payload');
assert.match(storeSource, /maxOutputLength: DISTRIBUTION_RAW_LIMIT_BYTES \+ 1/, 'gzip解碼必須限制輸出大小');
assert.doesNotMatch(storeSource, /allowLegacyJsonbReordered/, '無法證明原始hash的舊JSONB內容不得繞過完整性驗證');
assert.match(storeSource, /pg_advisory_xact_lock/, 'runtime schema migration必須序列化trigger/constraint建立');
assert.doesNotMatch(storeSource, /DROP TRIGGER/i, 'runtime不得先刪immutable trigger再重建');

const analyzeRoute = fs.readFileSync(new URL('../app/api/analyze/route.js', import.meta.url), 'utf8');
const repriceRoute = fs.readFileSync(new URL('../app/api/reprice/route.js', import.meta.url), 'utf8');
assert.match(analyzeRoute, /await persistAnalysisPitSnapshotForResponse\(/, '完整分析必須等待永久PIT確認');
assert.match(repriceRoute, /await persistAnalysisPitSnapshotForResponse\(/, '快速重算必須等待父快照鏈結保存');
assert.match(analyzeRoute, /enforceUnconfirmedPitShadowSafety/, 'DB寫入失敗時完整分析只能降級為不排名、不下注的唯讀影子輸出');
assert.match(repriceRoute, /enforceUnconfirmedPitShadowSafety/, 'DB寫入失敗時快速重算只能降級為不排名、不下注的唯讀影子輸出');
assert.match(analyzeRoute, /X-PIT-Persistence.*UNCONFIRMED-SHADOW-ONLY/s, '降級完整分析必須明確標示PIT未確認');
assert.match(repriceRoute, /X-PIT-Persistence.*UNCONFIRMED-SHADOW-ONLY/s, '降級快速重算必須明確標示PIT未確認');
assert.match(analyzeRoute, /analysisPitDatabaseConfigured\(\)/, '未確認的response cache必須在DB恢復後重試PIT');
assert.match(analyzeRoute, /analysisPitProductionPersistenceRequired\(\)/, 'Production缺少DB時完整分析必須提早fail closed');
assert.match(repriceRoute, /analysisPitProductionPersistenceRequired\(\)/, 'Production缺少DB時快速重算必須提早fail closed');
assert.match(analyzeRoute, /pitPayloadEncodingVersion:\s*ANALYSIS_PIT_PAYLOAD_ENCODING_VERSION/, '新payload編碼必須進入FULL input hash並建立新PIT快照');
assert.match(repriceRoute, /pitPayloadEncodingVersion:\s*ANALYSIS_PIT_PAYLOAD_ENCODING_VERSION/, '新payload編碼必須進入reprice input hash並建立新PIT快照');
assert.match(repriceRoute, /NO_OP_REPRICE/, '快速重算必須拒絕無變更/self-parent請求');
assert.ok((analyzeRoute.match(/assertLeagueGamePrestart\(league, game\)/g) || []).length >= 6, '完整分析必須在finalize、persist與response前重查開賽');
assert.ok((repriceRoute.match(/assertLeagueGamePrestart\(league, game\)/g) || []).length >= 5, '快速重算必須在finalize、persist與response前重查開賽');
assert.doesNotMatch(repriceRoute, /resolveLeagueGame\(/, '價格快速重算不得重新取得官方賽程或上游棒球資料');
assert.match(repriceRoute, /noCoreDataFetch: true/);
assert.match(repriceRoute, /noGpt: true/);

console.log('Four-league immutable PIT analysis snapshot storage: schema, validation, isolation, idempotence and replay identity PASS');
