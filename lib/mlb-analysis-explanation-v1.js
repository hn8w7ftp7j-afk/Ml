import { estimateRunProfileV13 } from './joint-score-v13.js';
import { standardFipEvidence } from './mlb-run-model-v103.js';

// Diagnostic only: does not change the frozen context, model, or terminal PMF.
const cache = new WeakMap();
const fields = [
  ['hitting.runsPerGame', 0.1], ['hitting.ops', 0.01],
  ['recentHitting.runsPerGame', 0.1], ['lineup.offensiveIndex', 0.01],
  ['starter.era', 0.1], ['starter.fip', 0.1], ['starter.expectedInnings', 0.1],
  ['bullpen.qualityFactor', 0.01],
];
const read = (value, path) => path.split('.').reduce((v, key) => v?.[key], value);
const write = (value, path, number) => { const keys = path.split('.'); const last = keys.pop(); keys.reduce((v, key) => v[key], value)[last] = number; };
export function explainMlbRunProfile(context, profile) {
  if (cache.has(context) && cache.get(context).profile === profile) return cache.get(context).report;
  const components = profile?.components || {};
  const sensitivity = [];
  const paths = ['away', 'home'].flatMap(side => fields.map(([field, step]) => [`${side}.${field}`, step]));
  paths.push(['park.runFactor', 0.01], ['weather.meanRunFactor', 0.01]);
  const reference = estimateRunProfileV13(context);
  const baselineCompatible = ['away', 'home'].every(side => Math.abs(reference.scheduledFull[side] - profile.scheduledFull[side]) <= 1e-12);
  for (const [path, step] of baselineCompatible ? paths : []) {
    const original = read(context, path);
    if (!Number.isFinite(original) || original < step) continue;
    const low = structuredClone(context); const high = structuredClone(context);
    write(low, path, original - step); write(high, path, original + step);
    const a = estimateRunProfileV13(low); const b = estimateRunProfileV13(high);
    sensitivity.push({ path, original, step, method: 'CENTRAL_FINITE_DIFFERENCE',
      scheduledFullSlope: { away: (b.scheduledFull.away - a.scheduledFull.away) / (2 * step), home: (b.scheduledFull.home - a.scheduledFull.home) / (2 * step) },
      first5Slope: { away: (b.first5.away - a.first5.away) / (2 * step), home: (b.first5.home - a.first5.home) / (2 * step) } });
  }
  const report = {
    version: 'MLB-RUN-EXPLANATION-v2', scope: 'SCHEDULED_SEGMENT_MEANS_BEFORE_TERMINATION',
    starterFipEvidence: Object.fromEntries(['away', 'home'].map(side => [side,
      profile.diagnostics?.[`${side}Starter`]?.fipSource === 'STANDARD_RATE_FIP_WITH_LEAGUE_ERA_CONSTANT_NO_HBP'
        ? standardFipEvidence(context[side]?.starter, context.league) : { status: 'NOT_APPLICABLE_OR_UNRECORDED' }])),
    calculation: { baseline: profile.baseline, components, diagnostics: profile.diagnostics,
      first5: profile.first5, middle3: profile.middle3, ninth: profile.ninth, scheduledFull: profile.scheduledFull,
      segmentFormula: 'baseline * innings/9 * offense * opponentPitching * environment * homeCoefficient; then existing segment bounds',
      attribution: 'CALCULATION_TRACE_NOT_ADDITIVE_FEATURE_ATTRIBUTION' },
    sensitivityStatus: baselineCompatible ? 'AVAILABLE' : 'SKIPPED_DIFFERENT_PROMOTION_POLICY',
    sensitivity, limitations: [
      '局部敏感度不是各項特徵貢獻分數；有限差分在截斷邊界不是精確導數。',
      '顯示既定局數得分中心，未重新估算終局比分分布或 EV。',
      '單項微擾固定其他欄位，不代表真實球員替換；離散情境須另提供合法名單與完整統計。',
      '未執行全特徵交互作用或歷史校準。',
    ],
  };
  cache.set(context, { profile, report });
  return report;
}
