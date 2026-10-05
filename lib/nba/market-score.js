import { deterministicScore } from '../deterministic-score.js';
export const NBA_SCORE_EVIDENCE_VERSION = 'nba-preseason-season-stress-v1';
// Reuse the production S mapping, with explicitly scoped NBA stress evidence.
// A stress estimate is not a confidence interval or a certified betting EV.
export function nbaMarketScore(side) {
  if (!Number.isFinite(side?.expectedNet) || !Number.isFinite(side?.robustExpectedNet)
    || side.robustExpectedNet > side.expectedNet + 1e-8 || side.scoreEvidence?.version !== NBA_SCORE_EVIDENCE_VERSION
    || side.scoreEvidence?.basis !== 'minimum_prior_preseason_season_expected_net'
    || !Array.isArray(side.scoreEvidence.seasons) || side.scoreEvidence.seasons.length < 2
    || new Set(side.scoreEvidence.seasons.map(row => row.year)).size !== side.scoreEvidence.seasons.length
    || side.scoreEvidence.seasons.some(row => !Number.isInteger(row.year) || row.samples < 30 || !Number.isFinite(row.expectedNet))) return null;
  const minimum = Math.min(side.expectedNet, ...side.scoreEvidence.seasons.map(row => row.expectedNet));
  if (Math.abs(minimum - side.robustExpectedNet) > 1e-8) return null;
  return deterministicScore({ weightedEV: side.expectedNet / 100, robustEV: side.robustExpectedNet / 100,
    actualWater: true, qaPassed: true, executable: false });
}
