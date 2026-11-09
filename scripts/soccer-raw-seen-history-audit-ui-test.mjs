import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAuditHarness } from './lib/history-audit-ui-harness.mjs';
import { auditFlags } from '../app/market-line-history/history-audit-validation.js';

const componentPath = 'app/market-line-history/raw-seen-history-audit-panel.js';
const factory = await createAuditHarness(componentPath, 'RawSeenHistoryAuditPanel');
const instant = '2026-11-09T04:00:00.000Z';
function fixture() {
  const captureId = 'a'.repeat(64), siblingId = 'b'.repeat(64);
  return { ok: true, schema: 'soccer-raw-history-audit-v1', ...auditFlags, status: 'BOUNDED_SAMPLE', until: instant,
    filters: { league: null, limit: 4 }, sampleCompletenessVerified: false, siblingCoverageVerified: false,
    budget: { sourceBytesRead: 1024, sourceBytesReserved: 1024, sourceByteBasis: 'ORIGINAL_EVIDENCE_JSON_UTF8',
      maxSourceBytes: 10485760, timeBudgetMs: 25000, budgetKind: 'SOFT_DEADLINE', hardDeadlineEnforced: false },
    samples: [{ league: 'EPL', captureId, captureBatchId: captureId, sourceObservedAt: instant,
      attemptReason: 'RAW_SEEN_RECOVERY_UNSUPPORTED_FORMAT', status: 'VERIFIED_SOURCE', reason: null, classification: 'STRUCTURED_ROWS',
      fragmentCount: 1, fragmentManifest: [{ captureId, evidenceHash: 'c'.repeat(64), partIndex: null, partCount: null, receivedAt: instant, persistedAt: instant }],
      headers: [{ values: ['全場', '上半', '<script>raw header</script>'], tables: 1, contentHash: 'd'.repeat(64), truncated: false }], headersTruncated: false,
      rowWidths: [{ cells: 10, rows: 3 }], rowCount: 3, cellCount: 30,
      sectionScopeSummary: { basis: 'SOURCE_SECTION_LABELS_NOT_OFFICIAL_IDENTITY', matchingStandardTables: 1, matchingStandardRows: 3,
        excludedTables: 0, excludedRows: 0, unknownTables: 0, unknownRows: 0 },
      replay: { status: 'RECOVERABLE', reason: null, gameCount: 3, marketCount: 12 },
      siblings: [{ captureId: siblingId, observedAt: instant, rowCount: 4, cellCount: 40, partCount: null, partIndex: null }],
      siblingStatus: 'VERIFIED_METADATA_ONLY',
      siblingScopeBasis: 'NEARBY_SAME_LEAGUE_READER_TIME_WINDOW', pageFrameVerified: false, sameCaptureVerified: false }] };
}
function unknownFixture() {
  const value = fixture(), sample = value.samples[0];
  Object.assign(sample, { status: 'UNKNOWN', reason: 'RAW_HISTORY_AUDIT_BUDGET_EXHAUSTED', classification: 'UNKNOWN',
    fragmentCount: null, fragmentManifest: [], headers: [], rowWidths: [], rowCount: null, cellCount: null,
    sectionScopeSummary: null,
    siblings: [], siblingStatus: 'UNKNOWN',
    replay: { status: 'UNKNOWN', reason: 'RAW_HISTORY_AUDIT_BUDGET_EXHAUSTED', gameCount: null, marketCount: null } });
  return value;
}
const h = factory(); h.render();
assert.equal(h.calls.length, 0, 'audit is idle on mount');
assert.match(h.markup, /抽查結果：未確認/);
assert.equal(h.scope.validateRawSeenHistoryAudit(fixture()).samples.length, 1);
assert.equal(h.scope.validateRawSeenHistoryAudit(unknownFixture()).samples[0].fragmentCount, null);
for (const mutate of [
  value => { value.ok = false; }, value => { value.schema = 'wrong'; }, value => { value.until = '2026-11-09T24:00:00.000Z'; },
  value => { value.until = '2026-02-30T04:00:00.000Z'; }, value => { value.filters.league = 'NBA'; }, value => { value.filters.limit = 100; },
  value => { value.status = 'COMPLETE'; }, value => { value.budget.hardDeadlineEnforced = true; }, value => { value.budget.timeBudgetMs = 60000; },
  value => { delete value.budget.sourceBytesReserved; }, value => { value.budget.sourceBytesReserved = -1; },
  value => { value.budget.sourceBytesReserved = 1023; }, value => { value.budget.sourceBytesReserved = value.budget.maxSourceBytes + 1; },
  value => { value.budget.sourceByteBasis = 'NORMALIZED_OUTPUT_BYTES'; },
  value => { value.samples[0].league = 'constructor'; }, value => { value.samples[0].captureId = 'raw'; },
  value => { value.samples[0].captureBatchId = 'different'; }, value => { value.samples[0].sourceObservedAt = 'now'; },
  value => { value.samples[0].fragmentManifest[0].evidenceHash = null; }, value => { value.samples[0].headers[0].values = [1]; },
  value => { value.samples[0].headers[0].contentHash = 'missing'; }, value => { value.samples[0].rowWidths[0].rows = -1; },
  value => { value.samples[0].rowCount++; }, value => { value.samples[0].cellCount++; },
  value => { delete value.samples[0].sectionScopeSummary; }, value => { value.samples[0].sectionScopeSummary = null; },
  value => { value.samples[0].sectionScopeSummary.basis = 'VERIFIED_OFFICIAL_GAMES'; },
  value => { value.samples[0].sectionScopeSummary.matchingStandardTables = 0; },
  value => { value.samples[0].sectionScopeSummary.matchingStandardTables = 2; },
  value => { value.samples[0].sectionScopeSummary.matchingStandardRows--; },
  value => { value.samples[0].sectionScopeSummary.unknownRows = 1; },
  value => { value.samples[0].sectionScopeSummary.excludedTables = -1; },
  value => { value.samples[0].sectionScopeSummary.excludedRows = '0'; },
  value => { value.samples[0].sectionScopeSummary.unknownTables = 0.5; },
  value => { value.samples[0].sectionScopeSummary.formalEligible = true; },
  value => { value.samples[0].sectionScopeSummary.excludedTables = Number.MAX_SAFE_INTEGER; },
  value => { value.samples[0].fragmentManifest.push(structuredClone(value.samples[0].fragmentManifest[0])); value.samples[0].fragmentCount++; },
  value => { value.samples[0].rowWidths.push(structuredClone(value.samples[0].rowWidths[0])); value.samples[0].rowCount *= 2; value.samples[0].cellCount *= 2; },
  value => { value.samples[0].replay.gameCount = null; }, value => { value.samples[0].sameCaptureVerified = true; },
  value => { value.samples[0].replay = { status: 'SOURCE_UNINDEXED', reason: null, gameCount: null, marketCount: null }; },
  value => { value.samples[0].replay = { status: 'SOURCE_UNINDEXED', reason: 'RAW_SEEN_RECOVERY_UNSUPPORTED_FORMAT', gameCount: 0, marketCount: null }; },
  value => { value.samples[0].replay = { status: 'SOURCE_UNINDEXED', reason: 'RAW_SEEN_RECOVERY_UNSUPPORTED_FORMAT', gameCount: null, marketCount: 0 }; },
  value => { value.samples[0].pageFrameVerified = true; }, value => { value.samples[0].siblingScopeBasis = 'EXACT_STORED_SOURCE_SCOPE_HASH'; },
  value => { value.samples[0].siblings[0].captureId = value.samples[0].captureId; },
  value => { value.samples[0].executable = true; }, value => { value.samples[0].replay.historicalAvailabilityVerified = true; },
  ...Object.keys(auditFlags).map(key => value => { value[key] = typeof auditFlags[key] === 'boolean' ? !auditFlags[key] : 'COMPLETE'; }),
]) { const value = fixture(); mutate(value); assert.throws(() => h.scope.validateRawSeenHistoryAudit(value), /未通過核對/); }
const falseZero = unknownFixture(); falseZero.samples[0].rowCount = 0;
assert.throws(() => h.scope.validateRawSeenHistoryAudit(falseZero), /未通過核對/);
const inferredRows = unknownFixture(); inferredRows.samples[0].rowWidths = [{ cells: 0, rows: 0 }];
assert.throws(() => h.scope.validateRawSeenHistoryAudit(inferredRows), /未通過核對/);
for (const scope of [undefined, {}, fixture().samples[0].sectionScopeSummary]) {
  const unverifiedScope = unknownFixture(); unverifiedScope.samples[0].sectionScopeSummary = scope;
  assert.throws(() => h.scope.validateRawSeenHistoryAudit(unverifiedScope), /未通過核對/, 'unverified source cannot publish scope counts');
}
const truncatedHeaders = fixture(); truncatedHeaders.samples[0].headersTruncated = true;
truncatedHeaders.samples[0].sectionScopeSummary.unknownTables = 2;
assert.equal(h.scope.validateRawSeenHistoryAudit(truncatedHeaders).samples[0].sectionScopeSummary.unknownTables, 2);
truncatedHeaders.samples[0].headers[0].tables = 4;
assert.throws(() => h.scope.validateRawSeenHistoryAudit(truncatedHeaders), /未通過核對/, 'summary cannot contain fewer tables than exposed header groups');
const emptySource = fixture(), emptySample = emptySource.samples[0];
Object.assign(emptySample, { classification: 'UNKNOWN', headers: [], rowWidths: [], rowCount: 0, cellCount: 0,
  sectionScopeSummary: { basis: 'SOURCE_SECTION_LABELS_NOT_OFFICIAL_IDENTITY', matchingStandardTables: 0, matchingStandardRows: 0,
    excludedTables: 0, excludedRows: 0, unknownTables: 0, unknownRows: 0 },
  replay: { status: 'SOURCE_UNINDEXED', reason: 'RAW_SEEN_RECOVERY_UNSUPPORTED_FORMAT', gameCount: null, marketCount: null } });
assert.equal(h.scope.validateRawSeenHistoryAudit(emptySource).samples[0].sectionScopeSummary.unknownTables, 0,
  'a hash-verified capture with no tables remains a known empty layout, not official coverage');

const query = h.click('抽查尚未辨識來源'); h.click('抽查尚未辨識來源');
assert.equal(h.calls.length, 1, 'synchronous in-flight guard prevents double click');
const call = h.calls[0]; assert.equal(call.url, '/api/soccer/raw-seen-history-audit?limit=4');
assert.equal(call.options.method, 'GET'); assert.equal(call.options.credentials, 'same-origin'); assert.equal(call.options.cache, 'no-store');
assert.equal(call.options.body, undefined);
call.respond(fixture()); await query; await h.settle();
assert.match(h.markup, /本次返回 1 筆樣本/); assert.match(h.markup, /英超 EPL/); assert.match(h.markup, /有結構化資料列/);
assert.match(h.markup, /10 欄 × 3 列/); assert.match(h.markup, /3 場、12 個盤口/);
assert.match(h.markup, /&lt;script&gt;raw header&lt;\/script&gt;/); assert.doesNotMatch(h.markup, /<script>/);
assert.match(h.markup, /同次擷取與同一頁框皆未確認/); assert.match(h.markup, /不能替代本筆/);
assert.match(h.markup, /來源區段標題：符合既定範圍 1 表／3 列；明確排除 0 表／0 列；未確認 0 表／0 列/);
assert.match(h.markup, /未核對官方場次身分/); assert.match(h.markup, /標題符合範圍也不代表盤口已通過解析/);
assert.equal(h.calls.length, 1, 'no automatic follow-up or pagination');

const unknownQuery = h.click('抽查尚未辨識來源'); h.calls[1].respond(unknownFixture()); await unknownQuery; await h.settle();
assert.match(h.markup, /片段 未確認、資料列 未確認、儲存格 未確認/); assert.match(h.markup, /原始表頭：未確認/);
assert.match(h.markup, /列寬：未確認/); assert.match(h.markup, /重播可用性：未確認/);
assert.doesNotMatch(h.markup, /片段 0、資料列 0/);
assert.doesNotMatch(h.markup, /來源區段標題：符合既定範圍/);
const emptyQuery = h.click('抽查尚未辨識來源'); const empty = fixture(); empty.samples = [];
h.calls[2].respond(empty); await emptyQuery; await h.settle(); assert.match(h.markup, /本次沒有返回樣本，不能據此判定沒有缺漏/);

for (const status of [401, 403, 429, 503]) {
  const request = h.click('抽查尚未辨識來源'); const index = h.calls.length - 1;
  h.calls[index].respond({ private: 'db-secret-error' }, status); await request; await h.settle();
  assert.match(h.markup, status === 401 || status === 403 ? /沒有查閱權限/ : status === 429 ? /查詢較密集/ : /暫時無法查詢/);
  assert.match(h.markup, /抽查結果：未確認/); assert.doesNotMatch(h.markup, /db-secret-error|本次返回/);
}
const invalid = h.click('抽查尚未辨識來源'); const invalidBody = fixture(); invalidBody.archiveOnly = false;
h.calls.at(-1).respond(invalidBody); await invalid; await h.settle(); assert.match(h.markup, /回應未通過核對/); assert.doesNotMatch(h.markup, /本次返回/);
const timed = h.click('抽查尚未辨識來源'); const stale = h.calls.at(-1); h.expire(); await h.settle();
assert.equal(stale.options.signal.aborted, true); assert.match(h.markup, /查詢逾時，結果仍未確認/);
const fresh = h.click('抽查尚未辨識來源'); h.calls.at(-1).respond(unknownFixture()); await fresh; await h.settle();
const freshMarkup = h.markup; stale.respond(fixture()); await timed; await h.settle(); assert.equal(h.markup, freshMarkup, 'late timed-out response cannot replace new result');
const unresolved = h.click('抽查尚未辨識來源'); const last = h.calls.at(-1); h.unmount();
assert.equal(last.options.signal.aborted, true); last.respond(fixture()); await unresolved; await h.settle();
assert.equal(h.afterUnmountMutations, 0); assert.equal(h.timers.size, 0);

const excluded = factory(); excluded.render();
const excludedBody = fixture(), excludedSample = excludedBody.samples[0];
excludedSample.sectionScopeSummary = { basis: 'SOURCE_SECTION_LABELS_NOT_OFFICIAL_IDENTITY', matchingStandardTables: 0, matchingStandardRows: 0,
  excludedTables: 1, excludedRows: 3, unknownTables: 0, unknownRows: 0 };
excludedSample.replay = { status: 'SOURCE_UNINDEXED', reason: 'RAW_SEEN_RECOVERY_UNSUPPORTED_FORMAT', gameCount: null, marketCount: null };
const excludedQuery = excluded.click('抽查尚未辨識來源'); excluded.calls[0].respond(excludedBody); await excludedQuery; await excluded.settle();
assert.match(excluded.markup, /有結構化資料列/); assert.match(excluded.markup, /符合既定範圍 0 表／0 列；明確排除 1 表／3 列/);
assert.match(excluded.markup, /本次仍未辨識出可查閱盤口/); assert.doesNotMatch(excluded.markup, /可產生查閱內容|已確認成人|可下注|來源版面尚待支援/);
excluded.unmount();

const aborted = factory(); aborted.render(); const abortedQuery = aborted.click('抽查尚未辨識來源');
aborted.calls[0].reject(Object.assign(new Error('private abort'), { name: 'AbortError' })); await abortedQuery; await aborted.settle();
assert.match(aborted.markup, /查詢已中止，結果仍未確認/); assert.doesNotMatch(aborted.markup, /private abort/); aborted.unmount();
const source = fs.readFileSync(componentPath, 'utf8'), page = fs.readFileSync('app/market-line-history/page.js', 'utf8');
assert.match(page, /<RawSeenHistoryAuditPanel\/>/); assert.match(page, /<RawHistoryMaintenancePanel\/>/); assert.match(page, /<RawSeenHistoryIndexPanel\/>/); assert.match(page, /<ArchivePanel\/>/);
assert.doesNotMatch(source, /dangerouslySetInnerHTML|method:\s*['"]POST|\/api\/(?:analy|bets)/);
for (const path of process.argv.slice(2).map(value => value === '--contract-fixture' ? join(tmpdir(), 'raw-history-audit-contract-fixtures.json') : value)) {
  const actual = JSON.parse(fs.readFileSync(path, 'utf8'));
  for (const entry of actual.cases) {
    const value = entry.value;
    if (value.ok) h.scope.validateRawSeenHistoryAudit(value, value.filters);
    else assert.throws(() => h.scope.validateRawSeenHistoryAudit(value, value.filters), /未通過核對/);
  }
  console.log('PASS raw audit UI validates actual database sample response contract');
}
console.log('PASS shipped raw source audit UI: on-demand bounded read-only GET, no auto fetch, source/header/width/replay validation, truthful unknown, nearby candidates never exact capture, protected flags, authentication/errors, double-click/30s timeout/abort/unmount/late-response fencing; Production NOT VERIFIED');
