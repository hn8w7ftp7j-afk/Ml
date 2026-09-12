// Display-only helpers. These never change model outputs or selection rules.
export function numberText(value, digits = 3) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '未提供';
}
export function percentText(value, digits = 2) {
  return typeof value === 'number' && Number.isFinite(value) ? `${(100 * value).toFixed(digits)}%` : '未提供';
}
export function valueText(value) {
  if (value == null) return '未提供';
  if (value === true) return '是';
  if (value === false) return '否';
  if (typeof value === 'number') return numberText(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
export function field(row, path) {
  return path.split('.').reduce((value, key) => value?.[key], row);
}
export function csvText(rows) {
  if (!rows.length) return '';
  const keys = [...new Set(rows.flatMap(row => Object.keys(row)))];
  const escape = value => {
    let text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    if (typeof value === 'string' && /^[\s]*[=+@-]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  return '\uFEFF' + [keys.map(escape).join(','), ...rows.map(row => keys.map(key => escape(row[key])).join(','))].join('\r\n');
}
export function sourceStateText(value) {
  const label = { MISSING: '缺失', PROJECTED: '預估', CONFIRMED: '來源已確認', OBSERVED: '觀測', NOT_CONNECTED: '未接入', UNKNOWN: '未知' };
  return label[value] || valueText(value);
}

const stageLabels = { VALID_COMPUTABLE: '0 · 全部可計算大分', W_POSITIVE: '1 · W > 0', W_AND_R_POSITIVE: '2 · W > 0、R > 0', SCORE_CANDIDATE: '3 · 加上 S ≥ 7.2', SIMULATED_SELECTED: '4 · 最終模擬選中' };
const interpretationLabels = { SIGNED_BIAS_INCREASE_EXPLORATORY: '留下樣本的帶正負號偏差較高（探索性）', SIGNED_BIAS_DECREASE_EXPLORATORY: '留下樣本的帶正負號偏差較低（探索性）', INCONCLUSIVE: '區間包含 0，證據不足', SAME_MEMBERS: '同一批樣本，差值固定為 0' };
export function diagnosticView(raw) {
  const games = (raw.games || []).map(row => ({ ...row, matchup: `${row.away ?? '未提供'} @ ${row.home ?? '未提供'}`, batch: row.cohort, S: row.score }));
  const calculationChain = games.flatMap(game => ['away', 'home'].map(side => {
    const opponent = side === 'away' ? 'home' : 'away';
    return {
      gameId: game.gameId, gameDate: game.gameDate, matchup: game.matchup, selected: game.selected, side: `${side === 'away' ? '客隊' : '主隊'}進攻`,
      baselineRuns: game.baselineRuns, baselineVersion: game.baselineVersion, baselineDataVersion: game.baselineDataVersion, baselineDataHash: game.baselineDataHash,
      baselineAsOf: game.baselineAsOf, baselineSource: game.baselineSource, baselineNumerator: game.baselineNumerator, baselineDenominator: game.baselineDenominator,
      inputCutoffAt: game.inputCutoffAt, inputTimeMode: game.inputTimeMode, W: game.W, R: game.R, S: game.score, net: game.net, actual: game.actual, bias: game.bias, pick: game.pick,
      offenseMultiplier: game.offense?.[side]?.finalFactor,
      starterMultiplier: game.pitching?.[opponent]?.starterFactor,
      bullpenMultiplier: game.pitching?.[opponent]?.bullpenAppliedFactor,
      park: game.environment?.park, weather: game.environment?.weather,
      scheduledMean: game[side === 'away' ? 'scheduledAwayMean' : 'scheduledHomeMean'] ?? null,
      terminatedMean: game[side === 'away' ? 'terminatedAwayMean' : 'terminatedHomeMean'] ?? null,
      scheduledGameMean: game.scheduledMean, terminatedGameMean: game.terminatedMean,
      offense: game.offense?.[side], opposingPitching: game.pitching?.[opponent], segments: game.segments, clamps: game.clamps, traceStatus: game.traceStatus, detailsAvailable: game.detailsAvailable,
    };
  }));
  const pitchingAllocation = games.flatMap(game => ['away', 'home'].map(side => {
    const pitching = game.pitching?.[side] || {};
    return {
      gameId: game.gameId, gameDate: game.gameDate, matchup: game.matchup, selected: game.selected,
      ...pitching, defendingSide: `${side === 'away' ? '客隊' : '主隊'}防守`,
      bullpenExpectedOuts: pitching.scheduledBullpenOuts,
      starterContribution: pitching.starterRunsDiagnostic, bullpenContribution: pitching.bullpenRunsDiagnostic,
    };
  }));
  const stages = (raw.funnel?.stages || []).map(row => ({ ...row, label: stageLabels[row.label] || row.label, evaluatedN: row.nEvaluated, missingOutcomeN: row.nMissingOutcome, meanNetProfit: row.meanNet }));
  const transitions = (raw.funnel?.transitions || []).map(row => ({ ...row, label: `${stageLabels[row.fromLabel] || row.fromLabel} → ${stageLabels[row.toLabel] || row.toLabel}`, deltaBias: row.biasDifference, ciLow: row.ci?.low, ciHigh: row.ci?.high, validDraws: row.ci?.validDraws, interpretation: interpretationLabels[row.interpretation] || row.interpretation }));
  const groups = (raw.crossTabs || []).map(row => ({ ...row, group: (row.dimensions || []).map((key, i) => `${key}=${row.keys?.[i] ?? '未提供'}`).join(' · '), selectionRate: row.selectedRate }));
  return { ...raw, games, calculationChain, pitchingAllocation, funnel: { ...raw.funnel, stages, transitions }, coverage: { groups } };
}
