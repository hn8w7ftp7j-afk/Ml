import { ensureSoccerJournal, soccerJournalQuery, soccerJournalTransaction } from './journal.js';
import { soccerDate, validSoccerDate } from './contracts.js';
import { soccerForwardHash } from './forward-validation.js';
import { SOCCER_RETURN_ERROR_VERSION, SOCCER_RETURN_ERROR_CANDIDATE_PROTOCOL } from './return-error-model.js';

export const SOCCER_RETURN_ERROR_VALIDATION_VERSION = 'SOCCER-RETURN-ERROR-PROSPECTIVE-RECEIPTS-v1';
const restrictions = { accepted: false, formalEligible: false, promotionEligible: false, executable: false, W: null, R: null, S: null };
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const instant = value => typeof value === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? Date.parse(value) : NaN;
const iso = value => new Date(value).toISOString();
const fail = code => { throw Error(code); };
const sealed = value => { if (!value) return false; const { contentHash, ...body } = value; return contentHash === soccerForwardHash(body); };
const schema = [
  `CREATE TABLE IF NOT EXISTS sports_soccer_return_error_protocols_v1 (
    protocol_id TEXT PRIMARY KEY CHECK(protocol_id ~ '^[a-f0-9]{64}$'),
    league TEXT NOT NULL CHECK(league IN ('epl','ucl')), plan_hash TEXT NOT NULL, plan JSONB NOT NULL,
    registered_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), UNIQUE(league,plan_hash))`,
  `CREATE TABLE IF NOT EXISTS sports_soccer_return_error_freezes_v1 (
    freeze_id TEXT PRIMARY KEY CHECK(freeze_id ~ '^[a-f0-9]{64}$'),
    protocol_id TEXT NOT NULL REFERENCES sports_soccer_return_error_protocols_v1(protocol_id),
    group_hash TEXT NOT NULL, parameter_hash TEXT NOT NULL, parameters JSONB NOT NULL,
    source_artifact_hash TEXT NOT NULL, frozen_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE(protocol_id,group_hash))`,
  ...['protocols', 'freezes'].map(name => `CREATE OR REPLACE TRIGGER sports_soccer_return_error_immutable_v1
    BEFORE UPDATE OR DELETE ON sports_soccer_return_error_${name}_v1 FOR EACH ROW EXECUTE FUNCTION sports_soccer_immutable_v2()`),
];
let ready;
export async function ensureSoccerReturnErrorValidationStore() {
  return ready ||= (async () => { await ensureSoccerJournal(); await soccerJournalTransaction([
    ['SELECT pg_advisory_xact_lock(221019,2315)'], ...schema.map(sql => [sql]),
  ]); })().catch(error => { ready = null; throw error; });
}

function planFrom(input) {
  if (!input || Object.keys(input).some(key => !['league','from','trainingBefore','calibrationBefore','testBefore','miscoverage'].includes(key))
    || !['epl','ucl'].includes(input.league) || !validSoccerDate(input.from)) fail('RETURN_ERROR_PROTOCOL_SCOPE_INVALID');
  const dates = ['trainingBefore','calibrationBefore','testBefore'].map(key => instant(input[key]));
  const miscoverage = input.miscoverage ?? SOCCER_RETURN_ERROR_CANDIDATE_PROTOCOL.miscoverage;
  if (!dates.every(Number.isFinite) || !(dates[0] < dates[1] && dates[1] < dates[2])
    || input.from > soccerDate(dates[0]) || !Number.isFinite(miscoverage) || !(miscoverage > 0 && miscoverage < 1)) fail('RETURN_ERROR_PROTOCOL_DATES_INVALID');
  return { ...SOCCER_RETURN_ERROR_CANDIDATE_PROTOCOL, league: input.league, from: input.from,
    trainingBefore: iso(dates[0]), calibrationBefore: iso(dates[1]), testBefore: iso(dates[2]), miscoverage };
}
const protocolSelection = `SELECT *,registered_at<(plan->>'trainingBefore')::timestamptz AS prospective_registration
  FROM sports_soccer_return_error_protocols_v1`;
function protocolReceipt(row) {
  if (!row || !row.prospective_registration || !sha(row.plan_hash) || soccerForwardHash(row.plan) !== row.plan_hash
    || row.protocol_id !== soccerForwardHash([SOCCER_RETURN_ERROR_VALIDATION_VERSION,row.league,row.plan_hash]))
    fail('RETURN_ERROR_PROTOCOL_READBACK_INVALID');
  const plan = planFrom(Object.fromEntries(['league','from','trainingBefore','calibrationBefore','testBefore','miscoverage'].map(key => [key,row.plan[key]])));
  if (soccerForwardHash(plan) !== row.plan_hash) fail('RETURN_ERROR_PROTOCOL_READBACK_INVALID');
  const protocol = { ...plan, status: 'REGISTERED_RESEARCH_ONLY', registeredAt: iso(row.registered_at) };
  return { version: SOCCER_RETURN_ERROR_VALIDATION_VERSION, protocolId: row.protocol_id, league: row.league,
    status: 'DATABASE_PROSPECTIVE_PROTOCOL', registeredAt: protocol.registeredAt, protocol,
    protocolHash: soccerForwardHash(protocol), ...restrictions };
}

// Explicit calendar boundaries are chosen before the training window closes.
// There is no automatic date selection, backdating, or acceptance operation.
export async function registerSoccerReturnErrorProtocol(input) {
  const plan = planFrom(input), planHash = soccerForwardHash(plan);
  const protocolId = soccerForwardHash([SOCCER_RETURN_ERROR_VALIDATION_VERSION,plan.league,planHash]);
  await ensureSoccerReturnErrorValidationStore();
  await soccerJournalQuery(`INSERT INTO sports_soccer_return_error_protocols_v1(protocol_id,league,plan_hash,plan)
    SELECT $1,$2,$3,$4::jsonb WHERE clock_timestamp()<$5::timestamptz ON CONFLICT DO NOTHING`,
  [protocolId,plan.league,planHash,JSON.stringify(plan),plan.trainingBefore]);
  const rows = await soccerJournalQuery(`${protocolSelection} WHERE protocol_id=$1`,[protocolId]);
  if (rows.length !== 1) fail('RETURN_ERROR_PROTOCOL_REGISTRATION_TOO_LATE');
  return protocolReceipt(rows[0]);
}
export async function loadSoccerReturnErrorProtocol(protocolId) {
  if (!sha(protocolId)) fail('RETURN_ERROR_PROTOCOL_ID_INVALID');
  await ensureSoccerReturnErrorValidationStore();
  const rows = await soccerJournalQuery(`${protocolSelection} WHERE protocol_id=$1`,[protocolId]);
  if (rows.length !== 1) fail('RETURN_ERROR_PROTOCOL_NOT_REGISTERED');
  return protocolReceipt(rows[0]);
}
export async function soccerReturnErrorDatabaseNow() {
  await ensureSoccerReturnErrorValidationStore();
  const rows = await soccerJournalQuery('SELECT clock_timestamp() AS database_now');
  const now = new Date(rows[0]?.database_now).getTime();
  if (!Number.isFinite(now)) fail('RETURN_ERROR_DATABASE_TIME_UNAVAILABLE');
  return now;
}

function fitBody(group, receipt) {
  const keys = ['groupHash','biasCorrection','realizedReturnBandRadius','calibrationRank','calibrationGames',
    'trainingObservationHashes','calibrationObservationHashes','protocolHash'];
  const body = Object.fromEntries(keys.map(key => [key,group?.[key]]));
  const scope = group?.scope;
  if (!scope || scope.league !== receipt.league || !['FT','HT'].includes(scope.period)
    || !sha(scope.modelHash) || !sha(scope.settlementRuleFamilyHash)
    || !Number.isFinite(body.biasCorrection) || !Number.isFinite(body.realizedReturnBandRadius) || body.realizedReturnBandRadius < 0
    || !Number.isSafeInteger(body.calibrationGames) || body.calibrationGames < 1
    || body.calibrationRank !== Math.ceil((body.calibrationGames+1)*(1-receipt.protocol.miscoverage))
    || body.calibrationRank > body.calibrationGames
    || body.protocolHash !== receipt.protocolHash || soccerForwardHash(body) !== group.parameterHash
    || ['trainingObservationHashes','calibrationObservationHashes'].some(key => !Array.isArray(body[key]) || !body[key].length
      || !body[key].every(sha) || new Set(body[key]).size !== body[key].length)
    || body.groupHash !== soccerForwardHash(['league','period','variant','modelHash','settlementRuleFamilyHash','kind','side'].map(key => scope[key])))
    fail('RETURN_ERROR_FREEZE_PARAMETERS_INVALID');
  return body;
}
const freezeSelection = `SELECT f.*,round(extract(epoch from frozen_at)*1000000)::text AS frozen_epoch_micros,
  frozen_at >= (SELECT (plan->>'calibrationBefore')::timestamptz FROM sports_soccer_return_error_protocols_v1 p WHERE p.protocol_id=f.protocol_id)
    AND frozen_at < (SELECT (plan->>'testBefore')::timestamptz FROM sports_soccer_return_error_protocols_v1 p WHERE p.protocol_id=f.protocol_id) AS valid_window
  FROM sports_soccer_return_error_freezes_v1 f`;
function freezeReceipt(row, receipt) {
  const parameters = row.parameters;
  if (!row || !row.valid_window || row.protocol_id !== receipt.protocolId || !sha(row.source_artifact_hash)
    || !/^\d+$/.test(row.frozen_epoch_micros || '') || parameters.protocolHash !== receipt.protocolHash
    || soccerForwardHash(parameters) !== row.parameter_hash || parameters.groupHash !== row.group_hash
    || row.freeze_id !== soccerForwardHash([SOCCER_RETURN_ERROR_VALIDATION_VERSION,receipt.protocolId,row.group_hash,row.parameter_hash]))
    fail('RETURN_ERROR_FREEZE_READBACK_INVALID');
  return { version: SOCCER_RETURN_ERROR_VALIDATION_VERSION, status: 'DATABASE_FROZEN_RESEARCH_PARAMETERS',
    freezeId: row.freeze_id, protocolId: row.protocol_id, protocolHash: receipt.protocolHash, groupHash: row.group_hash,
    parameterHash: row.parameter_hash, parameters, frozenAt: iso(row.frozen_at), frozenEpochMicros: row.frozen_epoch_micros,
    sourceArtifactHash: row.source_artifact_hash, ...restrictions };
}

// Private server integration. The companion service constructs this artifact
// by replaying the fixed registered scope from original database evidence.
// A receipt proves existence/time only; it is not source or model approval.
export async function freezeSoccerReturnErrorParameters(protocolId, artifact) {
  const receipt = await loadSoccerReturnErrorProtocol(protocolId);
  if (!sealed(artifact) || artifact.version !== SOCCER_RETURN_ERROR_VERSION || artifact.type !== 'RETURN_ERROR_RESEARCH_ARTIFACT'
    || artifact.protocolHash !== receipt.protocolHash || soccerForwardHash(artifact.protocol) !== receipt.protocolHash
    || artifact.requestedScopeComplete !== true || !Array.isArray(artifact.groups) || !artifact.groups.length
    || artifact.groups.some(group => group?.test?.games !== 0)
    || ['accepted','formalEligible','promotionEligible','executable'].some(key => artifact[key] !== false)
    || ['W','R','S'].some(key => artifact[key] !== null) || !Number.isFinite(instant(artifact.generatedAt)))
    fail('RETURN_ERROR_FREEZE_ARTIFACT_INVALID');
  const groups = artifact.groups.filter(group => Number.isFinite(group.biasCorrection) && Number.isFinite(group.realizedReturnBandRadius));
  if (!groups.length) fail('RETURN_ERROR_FREEZE_NO_SUPPORTED_PARAMETERS');
  const frozen = [];
  for (const group of groups) {
    const body = fitBody(group,receipt), freezeId = soccerForwardHash([SOCCER_RETURN_ERROR_VALIDATION_VERSION,protocolId,group.groupHash,group.parameterHash]);
    await soccerJournalQuery(`INSERT INTO sports_soccer_return_error_freezes_v1
      (freeze_id,protocol_id,group_hash,parameter_hash,parameters,source_artifact_hash)
      SELECT $1,$2,$3,$4,$5::jsonb,$6 WHERE clock_timestamp()>=$7::timestamptz
        AND clock_timestamp()<$8::timestamptz AND $9::timestamptz<=clock_timestamp() AND $9::timestamptz>=$7::timestamptz
      ON CONFLICT DO NOTHING`,
    [freezeId,protocolId,group.groupHash,group.parameterHash,JSON.stringify(body),artifact.contentHash,
      receipt.protocol.calibrationBefore,receipt.protocol.testBefore,artifact.generatedAt]);
    const rows = await soccerJournalQuery(`${freezeSelection} WHERE protocol_id=$1 AND group_hash=$2`,[protocolId,group.groupHash]);
    if (rows.length !== 1) fail('RETURN_ERROR_FREEZE_WINDOW_INVALID');
    const saved = freezeReceipt(rows[0],receipt);
    if (saved.parameterHash !== group.parameterHash) fail('RETURN_ERROR_PARAMETERS_ALREADY_FROZEN_DIFFERENTLY');
    frozen.push(saved);
  }
  return { protocol: receipt, freezes: frozen, ...restrictions };
}

export async function loadSoccerReturnErrorFreezeVerifier(protocolId) {
  const receipt = await loadSoccerReturnErrorProtocol(protocolId);
  const rows = await soccerJournalQuery(`${freezeSelection} WHERE protocol_id=$1`,[protocolId]);
  const freezes = rows.map(row => freezeReceipt(row,receipt));
  const trustedProtocolHash = receipt.protocolHash, trustedCalibrationBefore = receipt.protocol.calibrationBefore;
  // Do not retain aliases to objects returned for display/serialization. A
  // caller mutating its detached receipt cannot alter this private authority.
  const byParameter = new Map(freezes.map(value => [value.parameterHash,value.frozenEpochMicros]));
  return { protocol: receipt, freezes, verifyFrozenModelReceipt({ parameterHash, protocolHash, calibrationBefore, before }) {
    const frozenEpochMicros = byParameter.get(parameterHash);
    // Existing fitter supplies canonical millisecond UTC ISO. Compare against
    // the original PostgreSQL microseconds, never a rounded-down JS Date.
    return Boolean(frozenEpochMicros && protocolHash === trustedProtocolHash && calibrationBefore === trustedCalibrationBefore
      && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(before || '') && Number.isFinite(instant(before))
      && BigInt(frozenEpochMicros) <= BigInt(instant(before))*1000n);
  } };
}
