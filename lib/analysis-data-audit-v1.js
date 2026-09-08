// Client-safe receipt of the supplied context and engine usage declarations.
// It performs no fetching, scoring, historical reconstruction, or clock reads.
import { starterInningsDisplay } from './mlb-diagnostic-display-v1.js';
export const ANALYSIS_DATA_AUDIT_V1_VERSION = 'analysis-data-audit-v1';

const text = value => typeof value === 'string' ? value.trim() : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
const numeric = value => {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
};
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const list = value => Array.isArray(value) ? value : [];
const unique = values => [...new Set(values.filter(value => value != null && value !== ''))];
const stamp = value => {
  const valueText = text(value);
  if (!valueText) return null;
  const time = Date.parse(valueText);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};
const metric = (data, names) => Object.fromEntries(names.map(name => [name, numeric(data?.[name])]));
const sourceName = data => text(data?.source || data?.sourceProvider || data?.performanceSource || data?.metricSource || data?.battingStatsSource) || null;
const observedTime = data => stamp(data?.observedAt || data?.performanceObservedAt || data?.battingStatsObservedAt || data?.fetchedAt);
const isProjected = data => data?.projected === true || data?.projectionBased === true
  || /PROJECT|SCENARIO|NEUTRAL|FALLBACK|PROXY|預測|預估|可信情境/i.test([data?.status, data?.projectionMode, data?.source].join(' '));
const explicitMissing = data => /MISSING|UNAVAILABLE|REJECTED|缺失/i.test(text(data?.status)) || data?.available === false;
const credibleSource = source => Boolean(source && !/^(MISSING|UNAVAILABLE|UNKNOWN)$/i.test(source) && !/PLACEHOLDER|NEUTRAL|FALLBACK|PROXY|SCENARIO/i.test(source));
const categories = [
  ['starter', '先發投手', ['starter', 'starterExpectedInnings', 'starterHandedness', '先發身分', '先發能力']],
  ['lineup', '打線', ['lineup', 'lineups', '打線']],
  ['bullpen', '牛棚', ['bullpen', 'reliefOnlyBullpen', 'pureReliefBullpen', '牛棚']],
  ['splits', '左右投拆分', ['platoonSplits', 'vsLeft', 'vsRight']],
  ['injuries', '傷病', ['injuries', 'injuryRunValue']],
];

function provenanceRows(context, side, category, aliases) {
  return list(context.featureProvenance).filter(row => {
    const name = text(row?.featureName || row?.feature || row?.name);
    const other = side === 'away' ? 'home' : 'away';
    if (name.toLowerCase().startsWith(other)) return false;
    return name === `${side}.${category}` || aliases.some(alias => name.toLowerCase() === alias.toLowerCase()
      || name.toLowerCase() === `${side}${alias}`.toLowerCase());
  });
}

function sourceReceipt(data) {
  const value = object(data);
  return {
    source: sourceName(value), sourceRecord: text(value.sourceRecord || value.url) || null,
    observedAt: observedTime(value), asOf: text(value.asOf || value.endDate) || null,
    rawPayloadHash: text(value.rawPayloadHash) || null,
    temporalContract: text(value.temporalContract) || null,
    fetchStatus: text(value.fetchStatus) || null, error: text(value.error) || null,
    purpose: text(value.purpose) || null,
    sourceGameId: text(value.sourceGameId) || null, sourceGameDate: text(value.sourceGameDate) || null,
  };
}

function classify(category, data, team) {
  const source = sourceName(data);
  if (data?.identityMismatch === true) return ['missing', 'IDENTITY_MISMATCH'];
  if (category === 'splits' && data.observationStatus === 'CONFIRMED' && data.available === true
    && numeric(data.ops) != null && numeric(data.plateAppearances) > 0 && credibleSource(source)) {
    return ['observed', 'OBSERVED_SEASON_SPLIT_MODEL_RELIABILITY_REMAINS_PROJECTED'];
  }
  if (isProjected(data)) return ['projected', 'PROJECTED_ASSIGNMENT_OR_SUBSTITUTE'];
  if (explicitMissing(data)) return ['missing', 'SOURCE_OR_MEASUREMENT_MISSING'];
  if (category === 'lineup') {
    const coverage = numeric(data.metricCoverage ?? data.statsCoverage);
    const modelCoverage = numeric(data.modelMetricCoverage);
    if (!Object.keys(data).length || (data.official !== true && data.available !== true && !list(data.players).length)) return ['missing', 'LINEUP_AND_METRICS_UNVERIFIED'];
    if (coverage === 0 || modelCoverage === 0 || data.metricsStatus === 'MISSING') return ['missing', 'LINEUP_IDENTITY_DOES_NOT_PROVE_BATTING_METRICS'];
    if ((coverage != null && coverage < 1) || (modelCoverage != null && modelCoverage < 1) || data.official !== true) return ['projected', 'LINEUP_ASSIGNMENT_OR_METRICS_INCOMPLETE'];
    if (coverage === 1 && data.official === true && credibleSource(source)) return ['observed', 'OFFICIAL_LINEUP_WITH_MEASURED_METRICS'];
    return ['missing', 'BATTING_METRIC_COVERAGE_UNVERIFIED'];
  }
  if (category === 'starter') {
    const hasMetric = ['era', 'fip', 'whip', 'woba'].some(key => numeric(data[key] ?? data.season?.[key]) != null);
    const measured = data.performanceAvailable === true || data.individualPitcherStatsAvailable === true
      || (data.available === true && numeric(data.inningsPitched ?? data.season?.inningsPitched) > 0);
    if (data.performanceAvailable === false || data.individualPitcherStatsAvailable === false) return ['missing', 'INDIVIDUAL_STARTER_METRICS_MISSING'];
    return measured && hasMetric && credibleSource(source)
      ? ['observed', 'INDIVIDUAL_STARTER_METRICS_REPORTED'] : ['missing', 'INDIVIDUAL_STARTER_METRICS_UNVERIFIED'];
  }
  if (category === 'bullpen') {
    const hasQuality = numeric(data.qualityFactor) != null;
    const confirmed = /CONFIRMED|OBSERVED/.test(text(data.status));
    if (confirmed && numeric(data.qualityCoverage) != null && numeric(data.qualityCoverage) < 1) return ['projected', 'BULLPEN_QUALITY_COVERAGE_INCOMPLETE'];
    if (hasQuality && data.pureRelief === true && confirmed && credibleSource(source)) return ['observed', 'PURE_RELIEF_ROSTER_AND_QUALITY_REPORTED'];
    return ['missing', 'PURE_RELIEF_ROSTER_OR_QUALITY_UNVERIFIED'];
  }
  if (category === 'injuries') {
    if (team.injuriesAvailable === true && !source) return ['observed', 'INJURY_LIST_FETCH_REPORTED_SOURCE_UNRECORDED'];
    if (credibleSource(source) && /CONFIRMED|OBSERVED/.test(text(data.status))) return ['observed', 'INJURY_SOURCE_REPORTED'];
    return ['missing', 'EMPTY_LIST_OR_ZERO_IMPACT_DOES_NOT_PROVE_NO_INJURIES'];
  }
  return data.available === true && numeric(data.ops) != null && numeric(data.plateAppearances ?? data.atBats) > 0 && (credibleSource(source) || text(data.sourceRecord))
    ? ['observed', 'MEASURED_PLATOON_SPLIT_REPORTED'] : ['missing', 'PLATOON_SPLIT_UNVERIFIED'];
}

function rowReceipt(context, profile, side, category, label, aliases) {
  const team = object(context[side]);
  const game = object(context.game);
  const data = category === 'injuries' ? object(team.injuryReport || team.advanced?.injuryRunValue)
    : category === 'splits' ? {} : object(team[category]);
  const members = category === 'splits' ? [object(team.vsLeft), object(team.vsRight)] : [data];
  const provenance = provenanceRows(context, side, category, aliases);
  const classified = members.map(member => classify(category, member, team));
  const states = classified.map(item => item[0]);
  let status = states.every(state => state === 'observed') ? 'observed'
    : states.every(state => state === 'missing') ? 'missing' : 'projected';
  const statusReasons = unique(classified.map(item => item[1]));
  const referenceTime = stamp(context.fetchedAt || context.observedAt);
  const stale = [...members, ...provenance].some(item => item.stale === true || item.freshness?.stale === true
    || /STALE|EXPIRED/.test(text(item.status)) || (referenceTime && stamp(item.expiresAt) && stamp(item.expiresAt) <= referenceTime));
  if (stale) { status = 'stale'; statusReasons.unshift('EXPLICITLY_STALE_OR_EXPIRED'); }
  const players = category === 'starter' ? [data, ...list(data.candidates || data.rotationCandidates)]
    : category === 'bullpen' ? list(data.relievers) : category === 'lineup' ? list(data.players)
      : category === 'injuries' ? list(data.absentPlayers).length ? list(data.absentPlayers) : list(team.injuries) : [];
  const playerIds = unique([...players.map(player => text(player.officialPlayerId || player.id || player.person?.id)), ...list(data.pitcherIds).map(text)]);
  const sources = [...members, ...provenance, ...players.flatMap(player => [player.metricProvenance, player])]
    .flatMap(item => [item, ...list(item?.sourceReceipts)])
    .filter(Boolean).map(sourceReceipt).filter(item => Object.values(item).some(Boolean));
  const uniqueSources = [...new Map(sources.map(item => [JSON.stringify(item), item])).values()];
  const prefixes = category === 'splits' ? [`${side}.vsLeft`, `${side}.vsRight`] : [`${side}.${category}`];
  const usage = list(profile.dataUsage).filter(item => prefixes.some(prefix => item?.key === prefix || item?.key?.startsWith(`${prefix}.`)))
    .map(item => ({ key: text(item.key), usedInMean: typeof item.usedInMean === 'boolean' ? item.usedInMean : null, usedInUncertainty: typeof item.usedInUncertainty === 'boolean' ? item.usedInUncertainty : null, reason: text(item.reason) }));
  const aggregateUsage = key => usage.some(item => item[key] === true) ? true : usage.length && usage.every(item => item[key] === false) ? false : null;
  const usedInMean = aggregateUsage('usedInMean');
  const usedInUncertainty = aggregateUsage('usedInUncertainty');
  const substitutions = unique([
    ...list(data.incompleteReasons), text(data.projectionMode), text(data.offensiveIndexMethod), text(data.uncertaintyMethod), text(data.modelUsage), text(data.rejectedReason),
    ...(data.offensiveIndexIsFallback === true ? ['NEUTRAL_LINEUP_INDEX_MISSING_MEASURED_BATTING'] : []),
    ...(category === 'lineup' && (numeric(data.metricCoverage ?? data.statsCoverage) ?? 0) < 1 ? ['MISSING_BATTER_METRICS_DO_NOT_REPRESENT_MEASURED_NEUTRAL_ABILITY'] : []),
    ...(data.teamPitchingProxyRejected === true ? ['TEAM_PITCHING_REJECTED_AS_INDIVIDUAL_STARTER'] : []),
    ...(data.appliedValue?.reason ? [text(data.appliedValue.reason)] : []),
  ]);
  const coverage = category === 'lineup' ? {
    identityCount: players.length, expectedCount: 9,
    metricCount: numeric(data.metricCount) ?? (numeric(data.statsCoverage) != null ? numeric(data.statsCoverage) * 9 : null),
    metricCoverage: numeric(data.metricCoverage ?? data.statsCoverage), modelMetricCoverage: numeric(data.modelMetricCoverage),
    identityStatus: text(data.identityStatus || data.assignmentStatus) || null, metricsStatus: text(data.metricsStatus) || null,
  } : category === 'bullpen' ? { rosterCount: numeric(data.rosterCount) ?? playerIds.length, rosterComplete: data.rosterComplete === true, qualityCoverage: numeric(data.qualityCoverage), qualityCount: numeric(data.qualityCoverage) == null ? null : Math.round(data.qualityCoverage * (numeric(data.rosterCount) ?? players.length)), usageAvailable: data.usageAvailable === true, usage: data.usageCoverage || null } : null;
  const metrics = category === 'starter' ? { ...metric({ ...object(data.season), ...data }, ['era', 'fip', 'whip', 'woba', 'leagueWoba', 'inningsPitched', 'battersFaced', 'estimatedInningsPitched', 'expectedInnings', 'expectedInningsSampleGames', 'qualityFactor']), performanceMetric: text(data.performanceMetric) || null, expectedInningsSource: data.expectedInningsSource || null, expectedInningsEvidence: data.expectedInningsEvidence || null }
    : category === 'lineup' ? metric(data, ['offensiveIndex', 'offensiveIndexBaselineOps', 'observedAtBats', 'observedHits', 'observedBattingAverage'])
      : category === 'bullpen' ? metric(data, ['qualityFactor', 'observedEra', 'sampleInnings', 'fatigueIndex', 'highLeverageAvailability'])
        : category === 'splits' ? { vsLeft: metric(team.vsLeft, ['ops', 'plateAppearances', 'atBats']), vsRight: metric(team.vsRight, ['ops', 'plateAppearances', 'atBats']) }
          : { listedPlayers: players.length, injuryImpact: numeric(team.injuryImpact), replacementRunDeltaPerGame: numeric(data.replacementRunDeltaPerGame) };
  return {
    id: `${side}.${category}`, key: `${side}.${category}`, side, category, label: `${side === 'away' ? '客隊' : '主隊'}${label}`,
    status, statusReason: statusReasons.join(';'),
    modelStatuses: unique(members.map(member => text(member.modelStatus || member.status))),
    temporalNote: category === 'splits' ? '本季實測資料；來源未證實統計截止日，不能重建歷史賽前拆分。模型收縮與既有不確定性設定維持不變。' : null,
    source: unique(uniqueSources.map(item => item.source)).join(' / ') || null,
    observedAt: unique(uniqueSources.map(item => item.observedAt)).sort().at(-1) || null,
    asOf: category === 'splits' ? null : text(data.asOf) || uniqueSources.find(item => item.asOf)?.asOf || null,
    identity: { teamId: text(team.teamId || game[`${side}TeamId`]) || null, teamName: text(team.name || game[side]) || null, playerIds, playerNames: unique(players.map(player => text(player.name || player.person?.fullName))), assignmentStatus: text(data.identityStatus || data.assignmentStatus || data.status) || null },
    sources: uniqueSources, coverage, metrics, substitutions,
    ...(category === 'starter' ? { inningsEstimate: starterInningsDisplay(data) } : {}),
    featureDefinition: category === 'lineup' ? {
      basis: data.offensiveIndexBasis || null,
      baselineOps: numeric(data.offensiveIndexBaselineOps),
      description: data.offensiveIndexIsFallback === true || data.offensiveIndexMethod === 'ROSTER_ONLY_NO_UNVERIFIED_RUN_DELTA' ? '中性替代值，未取得個人實測打擊統計；未產生打線能力調整' : data.offensiveIndexBasis === 'TEAM_SEASON_OPS' ? '打線指數比較基準：本隊本季 OPS（非聯盟平均）' : '打線指數比較基準未保存',
      method: data.offensiveIndexMethod || null,
    } : null,
    evidenceStatus: { acquisition: status, statisticalCutoff: text(data.asOf) || null,
      pregameAvailability: 'NOT_VERIFIED_BY_THIS_RECEIPT',
      note: '統計截止日、取得時間與永久保存為不同證據；本表不將 asOf 當作賽前可得性證明。' },
    ...(category === 'bullpen' ? { modelUsageInputs: data.modelUsageInputs || null, qualityFactorCalculation: data.qualityFactorCalculation || null } : {}),
    ...(category === 'bullpen' ? { players: players.map(player => ({ id: text(player.id), name: text(player.name), metrics: metric(player, ['inningsPitched', 'era', 'whip', 'strikeOuts', 'baseOnBalls', 'homeRuns']), metricSource: sourceName(player), metricAsOf: text(player.metricAsOf || player.metricProvenance?.asOf) || null, metricProvenance: player.metricProvenance || null, metricScope: player.metricScope || null, usageComplete: player.usageComplete ?? null, availability: numeric(player.availability), modelAvailability: numeric(player.modelAvailability), usageGames: player.usageGames || null, availabilityCalculation: player.availabilityCalculation || null, pitchesLast1: numeric(player.pitchesLast1), pitchesLast2: numeric(player.pitchesLast2), qualityComplete: numeric(player.inningsPitched) > 0 && ['era', 'whip', 'strikeOuts', 'baseOnBalls', 'homeRuns'].every(key => numeric(player[key]) != null) })), exclusions: list(data.historicalOnlyRelievers) } : {}),
    ...(category === 'injuries' ? { diagnostic: team.advanced?.injuryRunValue || null } : {}),
    usedInMean, usedInUncertainty, usageStatus: usedInMean == null || usedInUncertainty == null ? 'UNVERIFIED' : 'REPORTED',
    reason: usage.length ? unique(usage.map(item => item.reason)).join(';') : 'MODEL_USAGE_NOT_REPORTED', usage,
  };
}

function supportingReceipts(context, profile) {
  const usageFor = key => list(profile.dataUsage).filter(row => row?.key === key || row?.key?.startsWith(`${key}.`));
  const rows = ['away', 'home'].flatMap(side => [
    ['hitting', '本季打擊'], ['recentHitting', '近十四日打擊'], ['pitching', '本季投球'], ['recentPitching', '近十四日投球'],
  ].map(([key, label]) => {
    const data = object(context[side]?.[key]);
    return { key: `${side}.${key}`, label: `${side === 'away' ? '客隊' : '主隊'}${['NPB', 'KBO', 'CPBL'].includes(context.leagueId) ? (key.startsWith('recent') ? '最近10場' : '當月及前兩月樣本') + (key.toLowerCase().includes('hitting') ? '打擊' : '投球') : label}`,
      observationStatus: data.observationStatus || 'UNVERIFIED', modelStatus: data.modelStatus || data.status || 'UNVERIFIED',
      teamId: text(data.teamId) || null, startDate: text(data.startDate) || null, endDate: text(data.endDate) || null,
      metrics: metric({ ...data, games: data.games ?? data.gamesPlayed, gamesPitched: data.gamesPitched ?? data.gamesPlayed }, key.toLowerCase().includes('hitting') ? ['games', 'plateAppearances', 'runs', 'runsPerGame', 'ops'] : ['gamesPitched', 'inningsPitched', 'era', 'whip', 'fip']),
      sources: (list(data.sourceReceipts).length ? list(data.sourceReceipts) : data.source ? [{ source: data.source }] : []).map(sourceReceipt), usage: usageFor(`${side}.${key}`),
    };
  }));
  if (context.weather) rows.push({ key: 'weather', label: '開賽時段天氣與屋頂', ...object(context.weather), usage: usageFor('weather') });
  if (context.umpire) rows.push({ key: 'umpire', label: '主審身分（不等於主審效果已驗證）', ...object(context.umpire), usage: usageFor('umpire') });
  return rows;
}

export function buildAnalysisDataAudit(context = {}, profile = {}) {
  context = object(context); profile = object(profile);
  const game = object(context.game);
  const rows = ['away', 'home'].flatMap(side => categories.map(([category, label, aliases]) => rowReceipt(context, profile, side, category, label, aliases)));
  const consumedKeys = new Set(rows.flatMap(row => row.usage.map(item => item.key)));
  // Preserve declarations outside the personnel groups without inventing a
  // source-completeness classification for park, weather, rules, or advanced data.
  const otherUsage = list(profile.dataUsage).filter(item => !consumedKeys.has(text(item?.key)))
    .map(item => ({ ...object(item) }));
  return {
    schemaVersion: ANALYSIS_DATA_AUDIT_V1_VERSION,
    sourceTimeAudit: context.sourceTimeAudit || (['NPB', 'KBO', 'CPBL'].includes(context.leagueId) ? { status: 'PENDING', rows: [], inputCutoffAt: null } : null),
    leagueLimitations: [
      ...(['NPB', 'KBO', 'CPBL'].includes(context.leagueId) ? ['影子模型尚未通過獨立成效驗收（UNVALIDATED_SHADOW）。'] : []),
      ...(context.leagueId === 'NPB' && [context.away?.lineup, context.home?.lineup].some(row => row?.projected || row?.official === false) ? ['打線含最近可用歷史名單推估；不是當日官方確認。'] : []),
      ...(context.leagueRuleState?.kbo?.doubleheader?.secondGame && !context.leagueRuleState.kbo.doubleheader.usageEvidenceVerified ? ['雙重賽第二場：尚無證據確認牛棚用量已納入第一場出賽，維持診斷用途。'] : []),
      ...(context.leagueId === 'KBO' ? ['天氣取得狀態不代表得分增減效果已通過驗證。'] : []),
      ...(context.leagueId === 'CPBL' ? ['洋將調度與洋投退場後接手轉換尚未建模。'] : []),
    ],
    coverageScope: 'CORE_PERSONNEL',
    gameId: text(game.gamePk || game.gameId || game.id || context.gamePk) || null,
    league: text(context.leagueId || game.leagueId || game.league || context.league?.id) || null,
    date: text(game.gameDate || game.date) || null,
    fetchedAt: stamp(context.fetchedAt || context.observedAt),
    temporal: { status: 'CURRENT_CONTEXT_RECEIPT', historicalReconstruction: false, pitVerified: false, limitation: '列出本次提供的資料與模型使用聲明；取得時間不等於賽前已知時間，未據此重建或驗證歷史賽前資料。' },
    summary: {
      total: rows.length, ...Object.fromEntries(['observed', 'projected', 'missing', 'stale'].map(status => [status, rows.filter(row => row.status === status).length])),
      usedInMean: rows.filter(row => row.usedInMean === true).length,
      usedInUncertainty: rows.filter(row => row.usedInUncertainty === true).length,
      usageUnverified: rows.filter(row => row.usageStatus === 'UNVERIFIED').length,
      label: '核心人員資料取得概況',
      otherUsageCount: otherUsage.length,
      notes: ['狀態數量僅涵蓋雙方先發、打線、牛棚、左右投拆分與傷病。', '其餘模型使用聲明另列；未以本表判定球場、天氣、進階資料或聯盟規則的取得完整度。'],
    },
    rows, otherUsage, supportingData: supportingReceipts(context, profile),
  };
}
