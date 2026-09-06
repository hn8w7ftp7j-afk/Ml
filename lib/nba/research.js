/**
 * Descriptive, scores-only retrospective NBA research.
 *
 * This function never produces a prediction for an unplayed game. Its expanding
 * historical baseline is an evaluation reference, not a fitted basketball model.
 * Reconstructed final scores are not a replay of information available pregame.
 */
const TYPES = new Set(['preseason', 'regular', 'postseason', 'unknown']);
const GAME_ID = /^nba:(espn|nba):game:(\d+)$/;
const TEAM_ID = /^nba:(espn|nba):team:(\d+)$/;
const NOMINAL_COVERAGE = 0.9;
// A reported diagnostic interval needs 20 earlier errors. This is a reporting
// sample convention, not a cap, a probability adjustment or a calibration claim.
const MIN_INTERVAL_RESIDUALS = 20;
const taipeiFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
});

function dateInTaipei(timestamp) {
  const parts = Object.fromEntries(taipeiFormatter.formatToParts(new Date(timestamp))
    .filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function metrics(errors) {
  return {
    samples: errors.length,
    mae: average(errors.map(Math.abs)),
    rmse: errors.length ? Math.sqrt(average(errors.map((value) => value * value))) : null,
    // Positive bias means the historical baseline overestimated observed scores.
    bias: average(errors),
  };
}

/**
 * @param {Array<object>} games Normalized NBA season schedule observations.
 * @param {{seasonType?: 'regular'|'preseason'|'postseason'}} options
 * @returns {object} Aggregate historical observations and evaluation diagnostics.
 */
export function analyzeNbaHistory(games, { seasonType = 'regular' } = {}) {
  const issues = [];
  const issue = (code, severity, message, gameId = null) => {
    issues.push({ code, severity, message, ...(gameId ? { gameId } : {}) });
  };
  const counts = {
    input: Array.isArray(games) ? games.length : 0,
    valid: 0, eligible: 0, included: 0, excluded: 0, duplicatesIgnored: 0,
    validationGames: 0, warmupGames: 0, validationTeamScores: 0, warmupTeamScores: 0,
    seasons: 0,
  };
  const method = {
    id: 'nba-scores-expanding-history-v1',
    description: '同球季、同賽事類型的球隊歷次得分平均；僅評估已完賽的歷史比分。',
    inputs: ['completed_game_scores', 'team_identity', 'season', 'season_type', 'taipei_date'],
    datasetScope: 'supplied_history_only',
    trainingCutoff: 'strictly_earlier_taipei_date',
    pointInTimeReplay: false,
    outputScope: 'aggregate_historical_errors_only',
    biasConvention: 'baseline_minus_observed',
  };
  const limitations = [
    '僅使用本次提供的歷史賽程；單隊賽程中的對手資料通常不完整，不能當成全聯盟樣本。',
    '這是重建最終比分的回顧性基準驗證，並非賽前時間點資料重播，也不是完整 NBA 模型或已校準模型。',
    '每次評估只使用同球季、同賽事類型且台灣日期更早的資料；同日比賽不互相提供訓練資料。',
    '未使用回填傷病、先發或賽後球員資料；未取得的 Pace、回合數與延長賽資訊不以比分推造。',
    '歷史殘差區間僅作描述性診斷；標稱涵蓋率不是已證實的未來涵蓋率。',
  ];
  const result = (summary = null, validation = null) => {
    // Canonical issue order makes output independent of upstream array order.
    issues.sort((a, b) => `${a.code}:${a.gameId || ''}:${a.message}`
      .localeCompare(`${b.code}:${b.gameId || ''}:${b.message}`));
    const blocked = issues.some((entry) => entry.severity === 'BLOCK');
    return {
      status: blocked ? 'blocked' : counts.validationTeamScores ? 'ready' : 'insufficient_data',
      method, seasonType, counts, summary: blocked ? null : summary,
      validation: blocked ? null : validation,
      qa: { status: blocked ? 'BLOCK' : issues.length ? 'WARNING' : 'PASS', issues },
      limitations,
    };
  };

  if (!Array.isArray(games)) {
    issue('INVALID_HISTORY', 'BLOCK', '歷史資料必須是賽事陣列。');
    return result();
  }
  if (!TYPES.has(seasonType) || seasonType === 'unknown') {
    issue('INVALID_SEASON_TYPE', 'BLOCK', '必須明確選擇例行賽、季前賽或季後賽。');
    return result();
  }

  const unique = new Map();
  for (const raw of games) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      counts.excluded += 1;
      issue('INVALID_GAME', 'BLOCK', '賽事不是有效物件。');
      continue;
    }
    const gameMatch = typeof raw.id === 'string' ? raw.id.match(GAME_ID) : null;
    const homeMatch = typeof raw.home?.id === 'string' ? raw.home.id.match(TEAM_ID) : null;
    const awayMatch = typeof raw.away?.id === 'string' ? raw.away.id.match(TEAM_ID) : null;
    if (raw.league !== 'NBA' || !gameMatch || !homeMatch || !awayMatch
        || gameMatch[1] !== homeMatch[1] || gameMatch[1] !== awayMatch[1]
        || raw.home.id === raw.away.id || String(raw.sourceId) !== gameMatch[2]) {
      counts.excluded += 1;
      issue('IDENTITY_MISMATCH', 'BLOCK', 'NBA 聯盟、來源賽事 ID 或主客隊身分不一致。', raw.id);
      continue;
    }
    const timestamp = typeof raw.startTime === 'string' ? Date.parse(raw.startTime) : NaN;
    const localDate = typeof raw.startTime === 'string' ? raw.startTime.slice(0, 10) : '';
    const calendarTimestamp = Date.parse(`${localDate}T00:00:00Z`);
    if (!Number.isFinite(timestamp) || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(raw.startTime)
        || !Number.isFinite(calendarTimestamp) || new Date(calendarTimestamp).toISOString().slice(0, 10) !== localDate
        || raw.taipeiDate !== dateInTaipei(timestamp)) {
      counts.excluded += 1;
      issue('DATE_IDENTITY_MISMATCH', 'BLOCK', '開賽時間缺少明確時區，或與台灣日期不一致。', raw.id);
      continue;
    }
    const season = typeof raw.season === 'object' && raw.season !== null ? raw.season.year : raw.season;
    const type = raw.seasonType;
    if (!Number.isInteger(season) || season <= 0 || !TYPES.has(type)
        || (raw.season?.type && raw.season.type !== type)) {
      counts.excluded += 1;
      issue('SEASON_IDENTITY_MISMATCH', 'BLOCK', '球季或賽事類型缺漏／衝突，不能混入歷史樣本。', raw.id);
      continue;
    }
    const game = {
      id: raw.id, sourceId: String(raw.sourceId), timestamp, date: raw.taipeiDate,
      season, type, status: raw.status, completed: raw.completed,
      home: { id: raw.home.id, score: raw.home.score },
      away: { id: raw.away.id, score: raw.away.score },
    };
    const signature = JSON.stringify(game);
    const group = unique.get(game.id) || { observations: 0, versions: new Map() };
    group.observations += 1;
    group.versions.set(signature, game);
    unique.set(game.id, group);
  }
  const observations = [];
  for (const [id, group] of unique) {
    if (group.versions.size > 1) {
      counts.excluded += group.observations;
      issue('DUPLICATE_GAME_CONFLICT', 'BLOCK', '同一來源賽事的球隊、日期、賽季、狀態或比分互相衝突。', id);
    } else {
      counts.duplicatesIgnored += group.observations - 1;
      observations.push(group.versions.values().next().value);
    }
  }
  if (issues.some((entry) => entry.severity === 'BLOCK')) return result();

  const eligible = [];
  for (const game of observations) {
    if (game.status !== 'final' || game.completed !== true) {
      counts.excluded += 1;
      continue;
    }
    if (![game.home.score, game.away.score].every((score) => Number.isInteger(score) && score >= 0)) {
      counts.excluded += 1;
      issue('MISSING_FINAL_SCORE', 'WARNING', '已完賽紀錄缺少有效整數比分，未納入統計或驗證。', game.id);
      continue;
    }
    counts.valid += 1;
    if (game.type === 'unknown') {
      counts.excluded += 1;
      issue('UNKNOWN_SEASON_TYPE', 'WARNING', '賽事類型尚未確認，未納入歷史驗證。', game.id);
      continue;
    }
    if (game.type !== seasonType) {
      counts.excluded += 1;
      continue;
    }
    eligible.push(game);
  }
  // Sort a new array. Never mutate the caller's shared schedule cache.
  eligible.sort((a, b) => a.date.localeCompare(b.date) || a.timestamp - b.timestamp || a.id.localeCompare(b.id));
  counts.eligible = eligible.length;
  counts.included = eligible.length;
  counts.seasons = new Set(eligible.map((game) => game.season)).size;
  if (!eligible.length) {
    issue('NO_ELIGIBLE_HISTORY', 'WARNING', '目前没有所選賽事類型的有效完賽樣本。');
    return result();
  }

  const teamHistory = new Map();
  const errorsBySeason = new Map();
  const allErrors = [];
  const homeErrors = [];
  const awayErrors = [];
  const intervalWidths = [];
  let covered = 0;
  let intervalSamples = 0;
  let cursor = 0;
  while (cursor < eligible.length) {
    const date = eligible[cursor].date;
    let end = cursor;
    while (end < eligible.length && eligible[end].date === date) end += 1;
    const pendingErrors = [];
    for (const game of eligible.slice(cursor, end)) {
      const seasonKey = `${game.season}:${game.type}`;
      const pastErrors = errorsBySeason.get(seasonKey) || [];
      const sortedAbsoluteErrors = pastErrors.length >= MIN_INTERVAL_RESIDUALS
        ? pastErrors.map(Math.abs).sort((a, b) => a - b) : null;
      const rank = sortedAbsoluteErrors ? Math.ceil((pastErrors.length + 1) * NOMINAL_COVERAGE) : null;
      const radius = rank !== null && rank <= sortedAbsoluteErrors.length ? sortedAbsoluteErrors[rank - 1] : null;
      let evaluated = 0;
      for (const side of ['home', 'away']) {
        const team = game[side];
        const previous = teamHistory.get(`${seasonKey}:${team.id}`);
        if (!previous?.games) {
          counts.warmupTeamScores += 1;
          continue;
        }
        const baseline = previous.total / previous.games;
        const error = baseline - team.score;
        allErrors.push(error);
        (side === 'home' ? homeErrors : awayErrors).push(error);
        pendingErrors.push({ seasonKey, error });
        counts.validationTeamScores += 1;
        evaluated += 1;
        if (radius !== null) {
          intervalSamples += 1;
          covered += Math.abs(error) <= radius ? 1 : 0;
          intervalWidths.push(radius * 2);
        }
      }
      if (evaluated) counts.validationGames += 1;
      else counts.warmupGames += 1;
    }
    // Commit observations and residuals only after all games on this date have
    // been evaluated. A later tipoff on the same date cannot leak into training.
    for (const game of eligible.slice(cursor, end)) {
      for (const side of ['home', 'away']) {
        const team = game[side];
        const key = `${game.season}:${game.type}:${team.id}`;
        const old = teamHistory.get(key) || { games: 0, total: 0 };
        teamHistory.set(key, { games: old.games + 1, total: old.total + team.score });
      }
    }
    for (const { seasonKey, error } of pendingErrors) {
      const old = errorsBySeason.get(seasonKey) || [];
      old.push(error);
      errorsBySeason.set(seasonKey, old);
    }
    cursor = end;
  }

  if (!allErrors.length) issue('INSUFFICIENT_PRIOR_HISTORY', 'WARNING', '沒有更早台灣日期的同隊樣本，無法計算歷史基準誤差。');
  if (!intervalSamples) issue('INSUFFICIENT_RESIDUAL_HISTORY', 'WARNING', '先前殘差樣本不足，未產生區間涵蓋率或校準成功宣告。');
  const summary = {
    games: eligible.length,
    teamScoreMean: average(eligible.flatMap((game) => [game.home.score, game.away.score])),
    totalScoreMean: average(eligible.map((game) => game.home.score + game.away.score)),
    homeMarginMean: average(eligible.map((game) => game.home.score - game.away.score)),
    firstTaipeiDate: eligible[0].date,
    lastTaipeiDate: eligible.at(-1).date,
    possessions: null,
    pace: null,
    overtimeClassification: 'not_available',
  };
  const validation = {
    scoreSamples: allErrors.length,
    ...metrics(allErrors),
    homeScores: metrics(homeErrors),
    awayScores: metrics(awayErrors),
    residualIntervals: intervalSamples ? {
      method: 'expanding_absolute_residual_order_statistic',
      nominalCoverage: NOMINAL_COVERAGE,
      empiricalCoverage: covered / intervalSamples,
      coveredSamples: covered,
      evaluatedSamples: intervalSamples,
      meanWidth: average(intervalWidths),
      minimumPriorResiduals: MIN_INTERVAL_RESIDUALS,
      sampleUnit: 'team_score',
      calibrated: false,
    } : null,
    pointInTimeReplay: false,
  };
  return result(summary, validation);
}
