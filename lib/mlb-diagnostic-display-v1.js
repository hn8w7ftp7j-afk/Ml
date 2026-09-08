// Presentation only. Never mutate stored evidence or values consumed by scoring.
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;

export function lineupCoverageDisplay(row = {}) {
  const coverage = row.coverage || {};
  const expected = number(coverage.expectedCount) || 9;
  const modelCoverage = number(coverage.modelMetricCoverage);
  const model = modelCoverage == null ? '未提供' : `${Math.round(modelCoverage * expected)}/${expected}`;
  const reported = (row.reportedBattingRates || []).filter(player => player.statistics != null).length;
  return `名單 ${coverage.identityCount ?? '未知'}/${expected} 人；系統回報模型用指標覆蓋 ${model}；${reported ? `逐人打擊率明細已列 ${reported}/${expected} 人` : '本份明細未提供逐人打擊率'}。覆蓋判定與來源仍須核對。`;
}

export function sourceStatusLabel(key, value) {
  return key === 'starterExpectedInnings'
    ? `局數歷史輸入：${value}／預估局數：PROJECTED`
    : null;
}

export function bullpenEvidenceDisplay(row = {}) {
  const dates = values => [...new Set(values.filter(value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)))].sort();
  const players = Array.isArray(row.players) ? row.players : [];
  const roster = dates((row.sources || []).filter(source => source.purpose === 'CURRENT_ROSTER_MEMBERSHIP').map(source => source.asOf));
  const metrics = dates(players.map(player => player.metricAsOf));
  const games = dates((row.coverage?.usage?.games || []).filter(game => game.fetched === true).map(game => game.date));
  return {
    rosterDates: roster.join('、') || '未保存',
    metricDates: metrics.join('、') || '未保存',
    metricDatesIncomplete: !players.length || players.some(player => !dates([player.metricAsOf]).length),
    latestUsageDate: games.at(-1) || '未保存',
    samples: players.map(player => ({ name: player.name || player.id, innings: number(player.metrics?.inningsPitched) })),
  };
}
export function starterInningsDisplay(starter = {}) {
  const value = number(starter.expectedInnings);
  if (value == null) return null;
  return {
    value, estimateStatus: 'PROJECTED',
    historicalInputStatus: starter.expectedInningsStatus || 'UNRECORDED',
    source: starter.source || null,
    inningsPitched: number(starter.inningsPitched),
    gamesStarted: number(starter.gamesStarted),
    gamesPitched: number(starter.gamesPitched),
    rawSeasonInningsPerStart: number(starter.rawSeasonInningsPerStart),
    role: starter.role || null,
    calculation: starter.expectedInningsCalculation || null,
    note: '預估投球局數，不是已確認的未來出賽局數；歷史輸入狀態不代表推估已通過效果驗證。',
  };
}

export function runExplanationDisplay(report) {
  if (!report) return report;
  const copy = structuredClone(report);
  const diagnostics = copy.calculation?.diagnostics;
  if (diagnostics) {
    const teamPitching = {};
    for (const side of ['away', 'home']) {
      const bullpen = diagnostics[`${side}Bullpen`];
      if (!bullpen || !['RELIEF_ONLY_PIT', 'TEAM_PITCHING_AUDIT_ONLY_NEUTRAL'].includes(bullpen.proxy)) continue;
      teamPitching[side] = { season: bullpen.season, recent: bullpen.recent,
        usedInBullpenMean: false, note: '全隊投球參考；不是純後援統計，未用於牛棚得分係數。' };
      delete bullpen.season;
      delete bullpen.recent;
    }
    if (Object.keys(teamPitching).length) diagnostics.teamPitchingReference = teamPitching;
  }
  copy.displayNotes = [
    'OPS 單項敏感度固定其他輸入；本隊 OPS 同時是左右拆分倍率的分母，因此斜率可能為負，不能解讀為打擊變好必然少得分。',
    '斜率是每單位變化的局部估計；OPS 增加 0.01 的估計變化約為斜率乘以 0.01。',
    '直接 FIP 欄位的零敏感度不代表投手無影響；目前得分計算使用 K/9、BB/9、HR/9 推導的 FIP 近似值。',
  ];
  return copy;
}

export function externalVerificationExplanation(verification = {}, fresh = false) {
  if (fresh) return '';
  verification = verification || {};
  if (verification.referencePriorEligible === true) return '保存時標記符合驗證條件，但目前無法確認報價仍在有效期限內；未改動保存結果。';
  const reason = verification.priorIneligibleReason || '';
  if (!reason || /缺少5分鐘內|沒有可安全配對/.test(reason)) {
    return '未取得或未匹配合格價格；這筆結果未保存可區分未配置、請求失敗與價格排除的原因。';
  }
  return `保存的排除原因：${reason}`;
}
