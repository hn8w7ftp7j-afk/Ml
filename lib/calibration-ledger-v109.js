import { parseTaiwanLine } from './markets.js';
import { sha256 } from './snapshot-v9.js';
import {
  PIT_PREDICTION_SCHEMA_V109,
  buildContinuousOosCalibrationV109,
  validatePitPredictionV109,
} from './pit-continuous-calibration-v109.js';

export const CALIBRATION_LEDGER_V109_VERSION = 'BASEBALL-IMMUTABLE-FORWARD-CALIBRATION-LEDGER-v10.9.0';
const statusCache = globalThis.__BASEBALL_CALIBRATION_STATUS_V109__ || { signature: '', value: null };
globalThis.__BASEBALL_CALIBRATION_STATUS_V109__ = statusCache;

const clean = value => String(value || '').trim();
const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;

export function marketFamilyV109(market) {
  const value = clean(market);
  const first5 = /上半|前五|first\s*5/i.test(value);
  const total = /大小|total/i.test(value);
  return `${first5 ? 'FIRST5' : 'FULL'}_${total ? 'TOTAL' : 'SIDE'}`;
}

export function contractTypeV109(pick) {
  const parsed = parseTaiwanLine(pick);
  if (!parsed?.valid) return 'UNKNOWN';
  if (parsed.isTotal) return parsed.isOver ? 'TOTAL_OVER' : 'TOTAL_UNDER';
  return parsed.isGiving ? 'SIDE_GIVING' : 'SIDE_RECEIVING';
}

export function featureObservedAtsFromContextV109(context = {}) {
  const fallback = clean(context?.fetchedAt) || null;
  const output = {};
  for (const row of context?.featureProvenance || []) {
    const name = clean(row?.featureName);
    const observedAt = clean(row?.observedAt || row?.asOf || fallback);
    if (name && Number.isFinite(Date.parse(observedAt))) output[name] = new Date(observedAt).toISOString();
  }
  if (!Object.keys(output).length && Number.isFinite(Date.parse(fallback))) output.coreSnapshot = new Date(fallback).toISOString();
  return output;
}

function normalizedHash(value) {
  const candidate = clean(value).toLowerCase();
  return /^[a-f0-9]{64}$/.test(candidate) ? candidate : '';
}

export function buildPitPredictionFromBetV109(bet = {}) {
  if (bet?.pitEvidenceVerified !== true) {
    return { ok: false, prediction: null, errors: ['SERVER_VERIFIED_PIT_EVIDENCE_REQUIRED'] };
  }
  const decisionAsOf = clean(bet.placedAt);
  const modelAsOf = clean(bet.analysisAsOf || bet.dataAsOf || decisionAsOf);
  const lineAsOf = clean(bet.lineAsOf || bet.placedContractSnapshot?.lineAsOf || decisionAsOf);
  const sourcePayloadHash = normalizedHash(bet.readerPayloadHash);
  const modelInputHash = normalizedHash(bet.inputHash);
  const prediction = {
    schemaVersion: PIT_PREDICTION_SCHEMA_V109,
    observationId: clean(bet.id),
    league: clean(bet.league).toUpperCase(),
    gameId: clean(bet.gamePk),
    gameStart: clean(bet.gameDate),
    lineAsOf,
    modelAsOf,
    decisionAsOf,
    marketFamily: marketFamilyV109(bet.market),
    contractType: contractTypeV109(bet.pick),
    rawWeightedEv: finite(bet.rawModelWeightedEV ?? bet.weightedEV),
    rawRobustEv: finite(bet.rawModelRobustEV ?? bet.robustEV),
    water: finite(bet.water),
    sourcePayloadHash,
    modelInputHash,
    featureObservedAts: bet.featureObservedAts || {},
    modelVersion: clean(bet.modelVersion),
    settlementRuleVersion: clean(bet.settlementRuleVersion),
  };
  const checked = validatePitPredictionV109(prediction);
  return checked.ok
    ? { ok: true, prediction: checked.value, errors: [] }
    : { ok: false, prediction: null, errors: checked.errors };
}

export function settledBetToPitObservationV109(bet = {}) {
  if (bet?.pitPredictionStatus !== 'IMMUTABLE_PIT_VERIFIED'
    || bet?.pitEvidenceVerified !== true
    || bet?.calibrationEligibility !== 'PENDING_SETTLEMENT_AND_LOCKED_OOS_GATE') return null;
  const prediction = bet.pitPrediction;
  const realizedNetReturn = finite(bet?.settlement?.roi);
  const settledAt = clean(bet?.settlement?.settledAt);
  if (!prediction || realizedNetReturn == null || !settledAt || clean(bet.status).toUpperCase() !== 'SETTLED') return null;
  return { ...prediction, settledAt, realizedNetReturn };
}

export function buildCalibrationStatusFromBetsV109(bets = [], options = {}) {
  const signature = sha256((bets || []).map(bet => [bet?.id, bet?.status, bet?.settlement?.settledAt, bet?.settlement?.roi, bet?.pitPredictionStatus]));
  if (statusCache.signature === signature && statusCache.value) return statusCache.value;
  const observations = (bets || []).map(settledBetToPitObservationV109).filter(Boolean);
  const result = buildContinuousOosCalibrationV109(observations, options);
  const value = {
    version: CALIBRATION_LEDGER_V109_VERSION,
    settledPredictionRows: observations.length,
    status: result.status,
    releaseEligible: result.artifact?.releaseEligible === true,
    sampleSize: result.artifact?.sampleSize || result.acceptedRows || observations.length,
    oosSampleSize: result.artifact?.oosSampleSize || result.oosSampleSize || 0,
    trainedThrough: result.artifact?.trainedThrough || null,
    artifactHash: result.artifact?.artifactHash || null,
    releaseChecks: result.artifact?.releaseChecks || null,
    diagnostics: result.artifact?.diagnostics || null,
    rejectedRows: result.rejected?.length || 0,
    automaticActivation: false,
  };
  statusCache.signature = signature;
  statusCache.value = value;
  return value;
}
