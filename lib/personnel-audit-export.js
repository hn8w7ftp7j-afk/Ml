import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

export const PERSONNEL_AUDIT_EXPORT_VERSION = 'personnel-audit-export-v1';
export const PERSONNEL_EXPORT_MAX_BASE64_BYTES = 2_800_000;
const MAX_RAW_BYTES = 20_000_000;
const SNAPSHOT_ID = /^(MLB|NPB|KBO|CPBL):([1-9]\d{0,15}):(FULL|PRICE_ONLY_REPRICE):([a-f0-9]{64})$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const jsonColumn = value => typeof value === 'string' ? JSON.parse(value) : value;
const instant = value => {
  const date = new Date(value);
  return value != null && Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

export function parsePersonnelAuditQuery(params, now = Date.now()) {
  if ([...params.keys()].some(key => !['until', 'after', 'limit'].includes(key))
    || ['until', 'after', 'limit'].some(key => params.getAll(key).length > 1)) throw new Error('INVALID_QUERY');
  const until = params.get('until'), after = params.get('after') || '', rawLimit = params.get('limit') ?? '100';
  const match = after ? SNAPSHOT_ID.exec(after) : null;
  if (!until || !ISO.test(until) || instant(until) !== until || Date.parse(until) > now + 60_000
    || after && (!match || !Number.isSafeInteger(Number(match[2])))
    || !/^(?:[1-9]\d?|100)$/.test(rawLimit)) throw new Error('INVALID_QUERY');
  return { until, after, limit: Number(rawLimit) };
}

// Keep every normalized field, including all personnel, usage declarations and
// source parsedInput values. Only raw source response bodies are excluded.
export function projectPersonnelContext(context) {
  if (!object(context)) throw new Error('CONTEXT_UNAVAILABLE');
  const omitted = [];
  function walk(value, path = '$', evidence = false) {
    if (Array.isArray(value)) return value.map((item, index) => walk(item, `${path}[${index}]`, evidence));
    if (!object(value)) return value;
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      const childPath = `${path}.${key}`;
      const inEvidence = evidence || key === 'sourceEvidence';
      if (inEvidence && ['contents', 'rawBody', 'rawPayload', 'responseBody', 'rawResponseBody'].includes(key)) {
        omitted.push({ path: childPath, reason: 'RAW_SOURCE_BODY_EXCLUDED',
          ...(key === 'contents' && object(item) ? { contentHashes: Object.keys(item) } : {}) });
        if (key === 'contents') {
          result.contents = {};
          result.contentHashes = [...new Set([...(Array.isArray(value.contentHashes) ? value.contentHashes : []), ...Object.keys(object(item) ? item : {})])];
        }
      } else if (key === 'contentHashes' && result.contentHashes) {
        result.contentHashes = [...new Set([...result.contentHashes, ...(Array.isArray(item) ? item : [])])];
      } else result[key] = walk(item, childPath, inEvidence);
    }
    return result;
  }
  return { context: walk(context), omitted };
}

function contextIdentity(row, context, gameIdentity) {
  const mismatches = [], missingFields = [];
  const game = context.game || {};
  const league = context.leagueId || game.leagueId || game.league;
  if (!league) missingFields.push('leagueId');
  else if (String(league) !== String(row.league_id)) mismatches.push('leagueId');
  if (game.gamePk == null || game.gamePk === '') missingFields.push('gamePk');
  else if (String(game.gamePk) !== String(row.external_game_id)) mismatches.push('gamePk');
  for (const key of ['awayTeamId', 'homeTeamId', 'gameNumber']) {
    if (gameIdentity[key] == null) continue;
    if (game[key] == null || game[key] === '') missingFields.push(key);
    else if (String(game[key]) !== String(gameIdentity[key])) mismatches.push(key);
  }
  if (game.gameDate == null || game.gameDate === '') missingFields.push('gameDate');
  else if (instant(game.gameDate) !== instant(row.game_start)) mismatches.push('gameDate');
  if (context.coreFingerprint && context.coreFingerprint !== row.core_fingerprint) mismatches.push('coreFingerprint');
  return { status: mismatches.length ? 'MISMATCH' : missingFields.length ? 'INCOMPLETE' : 'MATCH', mismatches, missingFields,
    scope: 'STORED_ROW_VS_DECODED_CONTEXT_ONLY_NOT_OFFICIAL_SOURCE_VERIFICATION' };
}

export function exportPersonnelAuditRow(row, decode) {
  const snapshotId = row.snapshot_id;
  const status = { contextEnvelopeIntegrity: 'NOT_VERIFIED', fullSnapshotIntegrity: 'NOT_RECHECKED',
    sourceNormalization: 'NOT_INDEPENDENTLY_VERIFIED' };
  try {
    const match = SNAPSHOT_ID.exec(snapshotId || '');
    if (!match || match[1] !== row.league_id || match[2] !== String(row.external_game_id)
      || match[3] !== 'FULL' || row.analysis_type !== 'FULL' || row.parent_snapshot_id != null
      || match[4] !== String(row.input_hash).trim()) throw new Error('ROW_IDENTITY_MISMATCH');
    const gameIdentity = jsonColumn(row.game_identity);
    if (!object(gameIdentity) || String(gameIdentity.gamePk) !== String(row.external_game_id)
      || gameIdentity.leagueId !== row.league_id || instant(gameIdentity.gameDate) !== instant(row.game_start)) throw new Error('ROW_GAME_IDENTITY_MISMATCH');
    const envelope = jsonColumn(row.frozen_context_payload);
    const decoded = decode(envelope);
    if (!object(decoded)) throw new Error('CONTEXT_UNAVAILABLE');
    status.contextEnvelopeIntegrity = 'VERIFIED_BY_EXISTING_DECODER';
    const projected = projectPersonnelContext(decoded);
    const projectionSha256 = hash(Buffer.from(JSON.stringify(projected.context)));
    const identity = contextIdentity(row, decoded, gameIdentity);
    let analysisEvidence = null, analysisEvidenceIntegrity = 'NOT_AVAILABLE';
    if (row.market_analysis_payload != null) {
      try {
        const saved = decode(jsonColumn(row.market_analysis_payload));
        if (!object(saved)) throw new Error('ANALYSIS_UNAVAILABLE');
        const selected = ['leagueId', 'analysisType', 'analysisMode', 'dataAudit', 'dataUsage', 'dataQualityReceipt',
          'dataGateV10', 'expectedRuns', 'runExplanation', 'alignmentAudit', 'calculationSettings'];
        analysisEvidence = Object.fromEntries(selected.filter(key => key in saved).map(key => [key, saved[key]]));
        analysisEvidenceIntegrity = 'VERIFIED_BY_EXISTING_DECODER';
      } catch { analysisEvidenceIntegrity = 'FAILED_OR_UNAVAILABLE'; }
    }
    return { snapshotId, ok: true, leagueId: row.league_id, externalGameId: String(row.external_game_id),
      gameIdentity, gameStart: instant(row.game_start), dataAsOf: instant(row.data_as_of),
      analysisAsOf: instant(row.analysis_as_of), createdAt: instant(row.created_at),
      inputHash: row.input_hash, coreFingerprint: row.core_fingerprint, modelVersion: row.model_version,
      versions: jsonColumn(row.versions), providerTimestamps: jsonColumn(row.provider_timestamps),
      contextPayloadHash: envelope.payloadHash, contextProjectionSha256: projectionSha256,
      ...status, contextIdentity: identity, frozenContext: projected.context,
      omitted: projected.omitted, analysisEvidence, analysisEvidenceIntegrity,
      analysisUsageStatus: analysisEvidence?.dataAudit || analysisEvidence?.dataUsage ? 'SAVED_DECLARATIONS_ONLY' : 'NOT_SAVED',
      productionWrites: false };
  } catch (error) {
    const known = new Set(['ROW_IDENTITY_MISMATCH', 'ROW_GAME_IDENTITY_MISMATCH', 'CONTEXT_UNAVAILABLE']);
    return { snapshotId, ok: false, ...status,
      code: known.has(error?.message) ? error.message : 'CONTEXT_READ_OR_ENVELOPE_INTEGRITY_FAILED', productionWrites: false };
  }
}

function encode(value) {
  const raw = Buffer.from(JSON.stringify(value));
  return { ok: true, encoding: 'gzip-base64', sha256: hash(raw), rawBytes: raw.length,
    payload: gzipSync(raw).toString('base64') };
}

export function buildPersonnelAuditPage(rows, query, { decode, maxPayloadBytes = PERSONNEL_EXPORT_MAX_BASE64_BYTES, maxRawBytes = MAX_RAW_BYTES } = {}) {
  if (typeof decode !== 'function' || !Array.isArray(rows)) throw new Error('INVALID_EXPORT_DEPENDENCIES');
  const results = [];
  let rawBytes = 0, consumed = 0;
  // Decode and release one context at a time; never decode a distribution.
  for (const row of rows.slice(0, query.limit)) {
    const result = exportPersonnelAuditRow(row, decode);
    const bytes = Buffer.byteLength(JSON.stringify(result));
    if (results.length && rawBytes + bytes > maxRawBytes) break;
    if (bytes > maxRawBytes) results.push({ snapshotId: row.snapshot_id, ok: false, code: 'PROJECTED_CONTEXT_TOO_LARGE',
      contextEnvelopeIntegrity: result.contextEnvelopeIntegrity, fullSnapshotIntegrity: 'NOT_RECHECKED', sourceNormalization: 'NOT_INDEPENDENTLY_VERIFIED' });
    else { results.push(result); rawBytes += bytes; }
    consumed += 1;
  }
  const page = () => ({ schema: PERSONNEL_AUDIT_EXPORT_VERSION, until: query.until, after: query.after,
    scope: 'FULL_SNAPSHOTS_ONLY', results, scanned: results.length,
    nextAfter: rows.length > consumed ? rows[consumed - 1]?.snapshot_id || null : null,
    fullSnapshotIntegrity: 'NOT_RECHECKED', sourceNormalization: 'NOT_INDEPENDENTLY_VERIFIED', productionWrites: false });
  let packed = encode(page());
  while (packed.payload.length > maxPayloadBytes && results.length > 1) {
    results.pop(); consumed -= 1; packed = encode(page());
  }
  if (packed.payload.length > maxPayloadBytes && results.length === 1) {
    results[0] = { snapshotId: results[0].snapshotId, ok: false, code: 'PROJECTED_CONTEXT_TOO_LARGE',
      fullSnapshotIntegrity: 'NOT_RECHECKED', sourceNormalization: 'NOT_INDEPENDENTLY_VERIFIED' };
    packed = encode(page());
  }
  if (packed.payload.length > maxPayloadBytes) throw new Error('EXPORT_ENVELOPE_TOO_LARGE');
  return packed;
}
