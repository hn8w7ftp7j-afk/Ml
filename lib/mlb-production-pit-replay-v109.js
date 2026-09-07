import {
  buildDistributionSnapshot,
  evaluateMarketsFromDistribution,
  MODEL_VERSION,
  RULES_VERSION,
  DEFAULT_MODEL_CONFIG,
} from './analysis-v11.js';
import { finalizeDeterministicAnalysis } from './deterministic-finalizer-v10.js';
import { settleTaiwanContract, settlementProfit, TAIWAN_CREDIT_REBATE_RATE } from './taiwan-settlement-v9.js';
import { DATA_VERSION, sha256 } from './snapshot-v9.js';

export const MLB_PRODUCTION_PIT_REPLAY_V109_VERSION = 'MLB-VERSION-VERIFIED-PIT-REPLAY-2026-09-v11.0.1';

const time = value => {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
};
const finite = value => {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
};
const clean = value => typeof value === 'string' ? value.trim() : '';
const observedTime = value => typeof value === 'string' && /(Z|[+-]\d{2}:\d{2})$/.test(value) ? time(value) : null;

function replayCompatibility(input, context, engine = {
  modelVersion: MODEL_VERSION, dataVersion: DATA_VERSION, rulesVersion: RULES_VERSION,
  distributionEngine: DEFAULT_MODEL_CONFIG.engine, archived: false,
}) {
  const modelVersions = [input?.modelVersion, input?.versions?.modelVersion, context?.modelVersion].map(clean).filter(Boolean);
  // context.dataVersion identifies the context builder, not the persisted
  // snapshot schema. Only an explicitly saved snapshot version can prove the
  // latter; never silently substitute today's version for an old record.
  const dataVersions = [input?.dataVersion, input?.versions?.dataVersion].map(clean).filter(Boolean);
  const ruleVersions = [input?.rulesVersion, input?.versions?.rulesVersion, context?.rulesVersion].map(clean).filter(Boolean);
  const distributionEngine = clean(context?.modelConfig?.engine);
  const reasons = [];
  if (!modelVersions.length) reasons.push('ORIGINAL_MODEL_VERSION_MISSING');
  else if (modelVersions.some(version => version !== engine.modelVersion)) reasons.push('ORIGINAL_MODEL_ENGINE_UNAVAILABLE');
  if (!dataVersions.length) reasons.push('ORIGINAL_DATA_VERSION_MISSING');
  else if (dataVersions.some(version => version !== engine.dataVersion)) reasons.push('ORIGINAL_DATA_VERSION_UNAVAILABLE');
  if (ruleVersions.some(version => version !== engine.rulesVersion)) reasons.push('ORIGINAL_RULES_VERSION_UNAVAILABLE');
  if (distributionEngine && distributionEngine !== engine.distributionEngine) reasons.push('ORIGINAL_DISTRIBUTION_ENGINE_UNAVAILABLE');
  return {
    compatible: reasons.length === 0, reasons,
    snapshotModelVersions: [...new Set(modelVersions)], snapshotDataVersions: [...new Set(dataVersions)],
    snapshotRuleVersions: [...new Set(ruleVersions)], snapshotDistributionEngine: distributionEngine || null,
    currentModelVersion: engine.modelVersion, currentDataVersion: engine.dataVersion,
    currentRulesVersion: engine.rulesVersion, currentDistributionEngine: engine.distributionEngine,
    archivedEngineAvailable: engine.archived === true, archivedEngineRevision: engine.revision || null, immutableDistributionReplaySupported: false,
    archiveVerification: 'SOURCE_TIMES_ONLY_ORIGINAL_ARCHIVE_NOT_INDEPENDENTLY_VERIFIED',
    reconstructionMode: 'SAME_VERSION_FROZEN_CONTEXT_ONLY',
  };
}

export function validateProductionPitSnapshotV109(input = {}, { engine } = {}) {
  const errors = [];
  const context = input.context || {};
  const gameStart = time(context?.game?.gameDate || input.gameStart);
  const snapshotAsOf = time(input.snapshotAsOf || context?.fetchedAt);
  if (gameStart == null || snapshotAsOf == null) errors.push('PIT_TIME_MISSING');
  if (gameStart != null && snapshotAsOf != null && snapshotAsOf >= gameStart) errors.push('SNAPSHOT_NOT_PIT');
  const contextFetchedAt = observedTime(context?.fetchedAt);
  if (contextFetchedAt == null) errors.push('CONTEXT_FETCH_TIME_MISSING');
  else if (snapshotAsOf != null && contextFetchedAt > snapshotAsOf) errors.push('CONTEXT_FROM_FUTURE');
  if (String(context?.leagueId || context?.game?.leagueId || 'MLB').toUpperCase() !== 'MLB') errors.push('LEAGUE_NOT_MLB');
  if (!context?.game?.gamePk || !context?.away || !context?.home || !context?.league) errors.push('PRODUCTION_CONTEXT_INCOMPLETE');
  const provenance = Array.isArray(context?.featureProvenance) ? context.featureProvenance : [];
  if (!provenance.length) errors.push('FEATURE_PROVENANCE_MISSING');
  for (const row of provenance) {
    const name = clean(row?.featureName) || 'unknown';
    // A season/date-range end (asOf) is not evidence of when the data was
    // actually known. Both recorded observation and fetch times must precede
    // the frozen cutoff; a backdated period cannot hide a later live fetch.
    const receipts = [...(Array.isArray(row?.sourceReceipts) ? row.sourceReceipts : []),
      ...(Array.isArray(row?.dependencyReceipts) ? row.dependencyReceipts : [])];
    const observations = [row?.observedAt, row?.fetchedAt].filter(value => value != null);
    for (const receipt of receipts) {
      if (observedTime(receipt?.fetchedAt) == null) errors.push(`FEATURE_RECEIPT_TIME_MISSING:${name}`);
      else if (snapshotAsOf != null && observedTime(receipt.fetchedAt) > snapshotAsOf) errors.push(`FEATURE_FROM_FUTURE:${name}`);
    }
    const observed = observations.map(observedTime);
    if (!observed.length || observed.some(value => value == null)) errors.push(`FEATURE_TIME_MISSING:${name}`);
    if (snapshotAsOf != null && observed.some(value => value != null && value > snapshotAsOf)) errors.push(`FEATURE_FROM_FUTURE:${name}`);
    if (![row?.sourceProvider, row?.source, row?.sourceRecord].some(value => clean(value))) errors.push(`FEATURE_SOURCE_MISSING:${name}`);
    // Provider archive availability is not the same as whether this specific
    // contemporaneous receipt was saved. Generic provider quality flags alone
    // cannot invalidate a legitimately frozen pregame record.
    if (row?.historicalReplayEligible === false) {
      errors.push(`FEATURE_NOT_HISTORICAL_REPLAY_ELIGIBLE:${name}`);
    }
  }
  const markets = Array.isArray(input.markets) ? input.markets : [];
  for (const row of markets) {
    const lineAsOf = time(row?.lineAsOf);
    if (!row?.market || !row?.pick || finite(row?.water) == null) errors.push('MARKET_INCOMPLETE');
    if (lineAsOf == null) errors.push('LINE_TIME_MISSING');
    else if (gameStart != null && lineAsOf >= gameStart) errors.push('LINE_NOT_PIT');
    else if (snapshotAsOf != null && lineAsOf > snapshotAsOf) errors.push('LINE_FROM_FUTURE');
  }
  if (!markets.length) errors.push('MARKETS_MISSING');
  const compatibility = replayCompatibility(input, context, engine);
  errors.push(...compatibility.reasons);
  return { ok: errors.length === 0, errors: [...new Set(errors)], compatibility };
}

function realizedReturn(row, game, actual, rebateRate) {
  const first5 = /上半|前五|first\s*5/i.test(String(row.market || ''));
  const awayRuns = finite(first5 ? actual?.awayFirst5 : actual?.awayRuns);
  const homeRuns = finite(first5 ? actual?.homeFirst5 : actual?.homeRuns);
  if (awayRuns == null || homeRuns == null || ![awayRuns, homeRuns].every(value => Number.isSafeInteger(value) && value >= 0)
    || (first5 && actual?.first5Complete === false)) return null;
  const settlement = settleTaiwanContract(row.pick, awayRuns, homeRuns, game?.away || '', game?.home || '');
  if (!settlement) return null;
  return settlementProfit({ stake: 1, water: row.water, settlement, rebateRate }).profit;
}

export function replayProductionPitSnapshotV109(input = {}) {
  const checked = validateProductionPitSnapshotV109(input);
  if (!checked.ok) return {
    ok: false,
    status: checked.compatibility.compatible ? 'PIT_SNAPSHOT_REJECTED' : 'PIT_SNAPSHOT_UNRECONSTRUCTABLE',
    errors: checked.errors, compatibility: checked.compatibility,
    version: MLB_PRODUCTION_PIT_REPLAY_V109_VERSION,
    gamePk: input?.context?.game?.gamePk || null,
    snapshotAsOf: input.snapshotAsOf || input?.context?.fetchedAt || null,
    inputEvidenceHash: sha256(JSON.stringify(input)),
    originalSnapshotModified: false,
  };
  const context = input.context;
  const settings = {
    rebateRate: finite(input?.settings?.rebateRate) ?? TAIWAN_CREDIT_REBATE_RATE,
    candidateThreshold: finite(input?.settings?.candidateThreshold) ?? 7.2,
    strongestThreshold: finite(input?.settings?.strongestThreshold) ?? 8.5,
    expertMode: 'off',
  };
  const distributionSnapshot = buildDistributionSnapshot({ context });
  const preliminary = evaluateMarketsFromDistribution({
    context,
    markets: input.markets,
    previousMarkets: input.previousMarkets || [],
    settings,
    distributionSnapshot,
  });
  const finalized = finalizeDeterministicAnalysis({ analysis: preliminary, game: context.game, settings });
  const results = finalized.results.map(row => ({
    market: row.market,
    pick: row.pick,
    water: row.water,
    modelProbability: row.modelProbability,
    rawWeightedEv: row.rawWeightedEV,
    rawRobustEv: row.rawRobustEV,
    realizedNetReturn: realizedReturn(row, context.game, input.actual, settings.rebateRate),
    scoreStatus: row.scoreStatus,
  }));
  return {
    ok: true,
    status: 'PRODUCTION_EXACT_REPLAY_COMPLETE',
    version: MLB_PRODUCTION_PIT_REPLAY_V109_VERSION,
    compatibility: checked.compatibility,
    gamePk: context.game.gamePk,
    snapshotAsOf: input.snapshotAsOf || context.fetchedAt,
    modelVersion: MODEL_VERSION,
    dataVersion: DATA_VERSION,
    distributionId: distributionSnapshot.distributionId,
    distributionHash: distributionSnapshot.distributionHash,
    inputHash: sha256({ context, markets: input.markets, settings }),
    results,
  };
}
