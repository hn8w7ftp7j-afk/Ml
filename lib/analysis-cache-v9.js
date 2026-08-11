import { sha256 } from './snapshot-v9.js';

export const ANALYSIS_CACHE_VERSION = 'MLB-ANALYSIS-CACHE-GAME-CONTRACT-v2.1.0';

export function analysisContractSignature(game, markets) {
  return sha256({
    gamePk: Number(game?.gamePk) || null,
    officialDate: game?.officialDate || null,
    gameNumber: Number(game?.gameNumber) || 1,
    contracts: (Array.isArray(markets) ? markets : []).map(row => ({
      market: row?.market || null,
      pick: row?.pick || null,
      water: row?.water ?? null,
      waterEstimated: Boolean(row?.waterEstimated),
      waterMissing: Boolean(row?.waterMissing),
      sourceType: row?.sourceType || null,
      lineAsOf: row?.lineAsOf || null,
      executable: row?.executable !== false,
    })).sort((left, right) => `${left.market}|${left.pick}`.localeCompare(`${right.market}|${right.pick}`)),
  });
}

export function analysisCacheKey(gamePk, inputHash) {
  const id = Number(gamePk);
  if (!Number.isInteger(id) || id <= 0 || !inputHash) throw new Error('分析快取鍵缺少gamePk或inputHash');
  return `${ANALYSIS_CACHE_VERSION}:${id}:${inputHash}`;
}

export function analysisCachePayloadMatches(entry, { game, fingerprints, signature }) {
  const payload = entry?.payload;
  if (!payload || !fingerprints?.inputHash || !signature) return false;
  return Number(payload?.game?.gamePk) === Number(game?.gamePk)
    && Number(payload?.context?.game?.gamePk) === Number(game?.gamePk)
    && payload?.analysis?.inputHash === fingerprints.inputHash
    && payload?.repriceSnapshot?.inputHash === fingerprints.inputHash
    && entry.signature === signature;
}
