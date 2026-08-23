import {
  buildDistributionSnapshot,
  evaluateMarketsFromDistribution,
} from './analysis-v11.js';
import { finalizeDeterministicAnalysis } from './deterministic-finalizer-v10.js';
import { settleTaiwanContract, settlementProfit, TAIWAN_CREDIT_REBATE_RATE } from './taiwan-settlement-v9.js';
import { sha256 } from './snapshot-v9.js';

export const MLB_PRODUCTION_PIT_REPLAY_V109_VERSION = 'MLB-PRODUCTION-EXACT-PIT-REPLAY-2026-08-v10.9.0';

const time = value => {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
};
const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;

export function validateProductionPitSnapshotV109(input = {}) {
  const errors = [];
  const context = input.context || {};
  const gameStart = time(context?.game?.gameDate || input.gameStart);
  const snapshotAsOf = time(input.snapshotAsOf || context?.fetchedAt);
  if (!gameStart || !snapshotAsOf) errors.push('PIT_TIME_MISSING');
  if (gameStart && snapshotAsOf && snapshotAsOf >= gameStart) errors.push('SNAPSHOT_NOT_PIT');
  if (String(context?.leagueId || context?.game?.leagueId || 'MLB').toUpperCase() !== 'MLB') errors.push('LEAGUE_NOT_MLB');
  if (!context?.game?.gamePk || !context?.away || !context?.home || !context?.league) errors.push('PRODUCTION_CONTEXT_INCOMPLETE');
  for (const row of context?.featureProvenance || []) {
    const observed = time(row?.observedAt || row?.asOf);
    if (observed == null) errors.push(`FEATURE_TIME_MISSING:${row?.featureName || 'unknown'}`);
    else if (snapshotAsOf && observed > snapshotAsOf) errors.push(`FEATURE_FROM_FUTURE:${row?.featureName || 'unknown'}`);
  }
  for (const row of input.markets || []) {
    const lineAsOf = time(row?.lineAsOf);
    if (!row?.market || !row?.pick || finite(row?.water) == null) errors.push('MARKET_INCOMPLETE');
    if (!lineAsOf) errors.push('LINE_TIME_MISSING');
    else if (gameStart && lineAsOf >= gameStart) errors.push('LINE_NOT_PIT');
  }
  if (!(input.markets || []).length) errors.push('MARKETS_MISSING');
  return { ok: errors.length === 0, errors };
}

function realizedReturn(row, game, actual, rebateRate) {
  const first5 = /上半|前五|first\s*5/i.test(String(row.market || ''));
  const awayRuns = finite(first5 ? actual?.awayFirst5 : actual?.awayRuns);
  const homeRuns = finite(first5 ? actual?.homeFirst5 : actual?.homeRuns);
  if (awayRuns == null || homeRuns == null) return null;
  const settlement = settleTaiwanContract(row.pick, awayRuns, homeRuns, game?.away || '', game?.home || '');
  if (!settlement) return null;
  return settlementProfit({ stake: 1, water: row.water, settlement, rebateRate }).profit;
}

export function replayProductionPitSnapshotV109(input = {}) {
  const checked = validateProductionPitSnapshotV109(input);
  if (!checked.ok) return { ok: false, status: 'PIT_SNAPSHOT_REJECTED', errors: checked.errors };
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
    gamePk: context.game.gamePk,
    snapshotAsOf: input.snapshotAsOf || context.fetchedAt,
    modelVersion: context.modelVersion || finalized.modelVersion || null,
    distributionId: distributionSnapshot.distributionId,
    distributionHash: distributionSnapshot.distributionHash,
    inputHash: sha256({ context, markets: input.markets, settings }),
    results,
  };
}
