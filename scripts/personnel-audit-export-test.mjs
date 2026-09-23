import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { parsePersonnelAuditQuery, projectPersonnelContext, exportPersonnelAuditRow, buildPersonnelAuditPage } from '../lib/personnel-audit-export.js';

const digest = value => createHash('sha256').update(value).digest('hex');
const until = '2026-09-23T12:00:00.000Z';
const query = parsePersonnelAuditQuery(new URLSearchParams({ until }), Date.parse(until));
assert.equal(query.limit, 100);
for (const values of [{}, { until: '2026-02-30T12:00:00.000Z' }, { until, limit: '101' }, { until, limit: '01' }, { until, after: 'bad' }, { until, leak: 'true' }]) {
  assert.throws(() => parsePersonnelAuditQuery(new URLSearchParams(values), Date.parse(until)));
}
assert.throws(() => parsePersonnelAuditQuery(new URLSearchParams(`until=${until}&until=${until}`), Date.parse(until)));
assert.throws(() => parsePersonnelAuditQuery(new URLSearchParams({ until }), Date.parse(until) - 60_001));

// Inject an integrity-checking decoder to test helper failure semantics without
// starting a DB client. The route below must use the existing production decoder.
const envelope = value => {
  const raw = Buffer.from(JSON.stringify(value)), compressed = gzipSync(raw);
  return { version: 'BASEBALL-PIT-JSON-PAYLOAD-v1.2.0', encoding: 'GZIP_BASE64', rawBytes: raw.length,
    compressedBytes: compressed.length, base64Bytes: compressed.toString('base64').length,
    payloadHash: digest(raw), data: compressed.toString('base64') };
};
const decode = value => {
  if (value.encoding !== 'GZIP_BASE64') throw new Error('encoding');
  const raw = gunzipSync(Buffer.from(value.data, 'base64'));
  assert.equal(raw.length, value.rawBytes); assert.equal(digest(raw), value.payloadHash);
  return JSON.parse(raw.toString());
};
const id = number => `KBO:${number}:FULL:${'a'.repeat(64)}`;
function row(number = 1) {
  const game = { leagueId: 'KBO', gamePk: number, awayTeamId: 1, homeTeamId: 2, gameNumber: 1, gameDate: '2026-09-22T10:00:00.000Z' };
  return { snapshot_id: id(number), league_id: 'KBO', external_game_id: String(number), game_identity: game,
    game_start: game.gameDate, analysis_type: 'FULL', parent_snapshot_id: null, input_hash: 'a'.repeat(64), core_fingerprint: 'b'.repeat(64),
    data_as_of: '2026-09-22T09:00:00.000Z', analysis_as_of: '2026-09-22T09:01:00.000Z', created_at: '2026-09-22T09:01:01.000Z',
    model_version: 'test-version', versions: {}, provider_timestamps: {},
    frozen_context_payload: envelope({ game, leagueId: 'KBO', away: { starter: { id: '11' }, lineup: { players: [{ id: '12', order: 1 }] }, bullpen: { players: [{ id: '13', usageGames: [{ pitches: 12 }] }] } },
      sourceEvidence: { contentHashes: ['saved'], contents: { rawhash: { body: 'do not export' } }, events: [{ id: 'event', fetchedAt: '2026-09-22' }], features: [{ parsedInput: { starter: { id: '11' } } }] },
      extra: { sourceEvidence: { contents: { nested: 'also omit' }, parsedInput: [1, 2] } } }),
    market_analysis_payload: envelope({ leagueId: 'KBO', dataAudit: { rows: [{ id: 'away.starter', usedInMean: true }] }, results: [{ recommendation: 'excluded' }] }) };
}
const original = row(), one = exportPersonnelAuditRow(original, decode);
assert.equal(one.ok, true); assert.equal(one.contextIdentity.status, 'MATCH');
assert.equal(one.contextEnvelopeIntegrity, 'VERIFIED_BY_EXISTING_DECODER'); assert.equal(one.fullSnapshotIntegrity, 'NOT_RECHECKED');
assert.deepEqual(one.frozenContext.away.bullpen.players[0].usageGames, [{ pitches: 12 }]);
assert.deepEqual(one.frozenContext.sourceEvidence.contents, {});
assert.deepEqual(one.frozenContext.sourceEvidence.contentHashes, ['saved', 'rawhash']);
assert.deepEqual(one.frozenContext.extra.sourceEvidence.contents, {});
assert.deepEqual(one.frozenContext.sourceEvidence.features[0].parsedInput, { starter: { id: '11' } });
assert.equal(one.analysisEvidence.results, undefined);
assert.equal(digest(JSON.stringify(one.frozenContext)), one.contextProjectionSha256);
assert.equal(decode(original.frozen_context_payload).sourceEvidence.contents.rawhash.body, 'do not export');
const wrongGame = row(); const altered = decode(wrongGame.frozen_context_payload); altered.game.homeTeamId = 999;
wrongGame.frozen_context_payload = envelope(altered);
assert.deepEqual(exportPersonnelAuditRow(wrongGame, decode).contextIdentity.mismatches, ['homeTeamId']);
const legacy = row(); const legacyContext = decode(legacy.frozen_context_payload); delete legacyContext.game.gameNumber;
legacy.frozen_context_payload = envelope(legacyContext);
assert.equal(exportPersonnelAuditRow(legacy, decode).contextIdentity.status, 'INCOMPLETE');
assert.deepEqual(exportPersonnelAuditRow(legacy, decode).contextIdentity.missingFields, ['gameNumber']);
assert.deepEqual(exportPersonnelAuditRow(legacy, decode).contextIdentity.mismatches, []);
const corrupt = row(2); corrupt.frozen_context_payload.payloadHash = '0'.repeat(64);
assert.equal(exportPersonnelAuditRow(corrupt, decode).ok, false);
const oldVersion = exportPersonnelAuditRow(row(), () => { throw new Error('PIT快照內容編碼版本不相容'); });
assert.equal(oldVersion.diagnostic.reason, 'PAYLOAD_VERSION_UNSUPPORTED');
assert.equal(oldVersion.diagnostic.stage, 'CONTEXT_DECODE');
assert.equal(oldVersion.diagnostic.version, 'BASEBALL-PIT-JSON-PAYLOAD-v1.2.0');
const mismatch = exportPersonnelAuditRow(row(), () => { throw new Error('PIT快照內容雜湊或大小不一致'); });
assert.equal(mismatch.diagnostic.reason, 'PAYLOAD_HASH_OR_RAW_SIZE_MISMATCH');
const sensitiveError = exportPersonnelAuditRow(row(), () => { throw new Error('secret-source-response-do-not-leak'); });
assert.equal(sensitiveError.diagnostic.reason, 'UNCLASSIFIED_READ_OR_DECODE_FAILURE');
assert.ok(!JSON.stringify(sensitiveError).includes('secret-source-response-do-not-leak'));
assert.ok(!JSON.stringify(sensitiveError).includes(original.frozen_context_payload.data));
const wrongId = row(); wrongId.external_game_id = '2';
assert.equal(exportPersonnelAuditRow(wrongId, decode).code, 'ROW_IDENTITY_MISMATCH');
const marketCorrupt = row(); marketCorrupt.market_analysis_payload.payloadHash = '0'.repeat(64);
assert.equal(exportPersonnelAuditRow(marketCorrupt, decode).analysisEvidenceIntegrity, 'FAILED_OR_UNAVAILABLE');
assert.equal(exportPersonnelAuditRow(marketCorrupt, decode).ok, true);
const unpack = packed => {
  const raw = gunzipSync(Buffer.from(packed.payload, 'base64'));
  assert.equal(raw.length, packed.rawBytes); assert.equal(digest(raw), packed.sha256);
  return JSON.parse(raw.toString());
};
const page = unpack(buildPersonnelAuditPage([original, corrupt, row(3)], { ...query, limit: 2 }, { decode }));
assert.equal(page.results.length, 2); assert.equal(page.results[1].ok, false); assert.equal(page.nextAfter, id(2));
assert.equal(unpack(buildPersonnelAuditPage([], query, { decode })).nextAfter, null);
assert.equal(unpack(buildPersonnelAuditPage([original], query, { decode })).nextAfter, null);
const big = row(); const bigContext = decode(big.frozen_context_payload); bigContext.extraRandom = randomBytes(6000).toString('hex'); big.frozen_context_payload = envelope(bigContext);
const bounded = unpack(buildPersonnelAuditPage([big, row(2)], query, { decode, maxPayloadBytes: 1600 }));
assert.equal(bounded.results[0].code, 'PROJECTED_CONTEXT_TOO_LARGE'); assert.equal(bounded.nextAfter, id(1));
const rawBounded = unpack(buildPersonnelAuditPage([original, row(2), row(3)], query, { decode, maxRawBytes: Buffer.byteLength(JSON.stringify(one)) + 100 }));
assert.ok(rawBounded.results.length >= 1); assert.ok(rawBounded.results.length < 3); assert.ok(rawBounded.nextAfter);

// Run the route with injected boundary services. Authentication and throttling
// must happen before DB access; SQL must remain parameterized and read-only.
const routeSource = fs.readFileSync(new URL('../app/api/personnel-audit-export/route.js', import.meta.url), 'utf8');
assert.match(routeSource, /import \{ decodeAnalysisPitPayload \} from/);
assert.doesNotMatch(routeSource, /SELECT\s+\*|distribution_payload|\b(?:INSERT INTO|UPDATE|DELETE FROM|CREATE TABLE|ALTER TABLE)\b/);
const routeBody = routeSource.replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
let dbCalls = 0, captured;
const route = (auth = null, allowed = true) => new Function('NextResponse', 'neon', 'durableDatabaseUrl', 'requireApiAuth', 'checkRateLimit', 'rateLimitResponse', 'decodeAnalysisPitPayload', 'parsePersonnelAuditQuery', 'buildPersonnelAuditPage', `${routeBody};return GET;`)(
  { json: (body, options) => ({ body, options }) }, () => async (parts, ...values) => { dbCalls += 1; captured = { parts: [...parts], values }; return [original]; },
  () => 'configured', async () => auth, () => ({ allowed }), () => ({ status: 429 }), decode,
  p => parsePersonnelAuditQuery(p, Date.parse(until)), buildPersonnelAuditPage);
const request = { url: `https://example.test/api/personnel-audit-export?until=${until}&limit=10` };
assert.deepEqual(await route({ status: 401 })(request), { status: 401 }); assert.equal(dbCalls, 0);
assert.deepEqual(await route(null, false)(request), { status: 429 }); assert.equal(dbCalls, 0);
assert.equal((await route()({ url: 'https://example.test/?limit=0' })).options.status, 400); assert.equal(dbCalls, 0);
const response = await route()(request); assert.equal(dbCalls, 1); assert.equal(response.options.headers['Cache-Control'], 'private, no-store');
assert.deepEqual(captured.values, [until, '', 11]); assert.match(captured.parts.join('?'), /analysis_type = 'FULL'/);
assert.equal(unpack(response.body).results[0].snapshotId, id(1));

if (process.argv[2]) {
  const actual = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).results[0];
  const record = actual.record;
  const actualRow = { snapshot_id: record.snapshotId, league_id: record.leagueId, external_game_id: String(record.gameIdentity.gamePk),
    game_identity: record.gameIdentity, game_start: record.gameStart, data_as_of: record.dataAsOf, analysis_as_of: record.analysisAsOf,
    created_at: record.databasePersistedAt, analysis_type: record.analysisType, parent_snapshot_id: record.parentSnapshotId,
    input_hash: record.inputHash, core_fingerprint: record.coreFingerprint, model_version: record.versions?.modelVersion,
    versions: record.versions, provider_timestamps: record.providerTimestamps,
    frozen_context_payload: record.frozenContextPayload, market_analysis_payload: record.marketAnalysisPayload };
  const actualExport = exportPersonnelAuditRow(actualRow, decode);
  assert.equal(actualExport.ok, true);
  assert.equal(actualExport.contextEnvelopeIntegrity, 'VERIFIED_BY_EXISTING_DECODER');
  assert.notEqual(actualExport.contextIdentity.status, 'MISMATCH');
  assert.equal(unpack(buildPersonnelAuditPage([actualRow], query, { decode })).results[0].snapshotId, record.snapshotId);
  const projected = projectPersonnelContext(actual.hydratedContext || actual.bundle.frozenContext);
  assert.deepEqual(projected.context.away, (actual.hydratedContext || actual.bundle.frozenContext).away);
  assert.deepEqual(projected.context.home, (actual.hydratedContext || actual.bundle.frozenContext).home);
  assert.deepEqual(projected.context.sourceEvidence.contents, {});
  console.log(JSON.stringify({ realSample: actual.snapshotId, identity: actualExport.contextIdentity.status, originalBytes: Buffer.byteLength(JSON.stringify(actual.hydratedContext)), projectedBytes: Buffer.byteLength(JSON.stringify(projected.context)), rawBodyOmissions: projected.omitted.length }));
}
console.log('personnel-audit-export: PASS (query, integrity, identity, projection, pagination, bounds, auth, rate limit, read-only SQL)');
