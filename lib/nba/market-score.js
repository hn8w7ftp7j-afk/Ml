import { deterministicScore } from '../deterministic-score.js';
export const NBA_SCORE_EVIDENCE_VERSION = 'nba-preseason-season-stress-v1';
// Reuse the production S mapping, with explicitly scoped NBA stress evidence.
// A stress estimate is not a confidence interval or a certified betting EV.
export function nbaMarketScore(side) {
  if(side?.scoreEvidence?.version==='nba-regular-calendar-stress-v1')return regularScore(side);
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

function regularScore(side) {
 const e=side.scoreEvidence,b=e.blocks,date=e.targetDate,valid=d=>typeof d==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d)&&Number.isFinite(Date.parse(d))&&new Date(d).toISOString().slice(0,10)===d;
 if(!Number.isFinite(side.expectedNet)||!Number.isFinite(side.robustExpectedNet)||e.basis!=='minimum_three_prior_nonoverlapping_30_day_blocks'||!valid(date)||!Array.isArray(b)||b.length!==3)return null;
 for(let i=0;i<3;i++){const row=b[i];if(!valid(row.start)||!valid(row.end)||row.end>date||Date.parse(row.end)-Date.parse(row.start)!==30*86400000||!Number.isInteger(row.samples)||row.samples<30||!Number.isFinite(row.expectedNet)||i&&b[i-1].end!==row.start)return null;}
 if(b.at(-1).end!==date||Math.abs(Math.min(side.expectedNet,...b.map(x=>x.expectedNet))-side.robustExpectedNet)>1e-8)return null;
 return deterministicScore({weightedEV:side.expectedNet/100,robustEV:side.robustExpectedNet/100,actualWater:true,qaPassed:true,executable:false});
}
