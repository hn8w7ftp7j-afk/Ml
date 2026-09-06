import { analyzeNbaHistory } from './research.js';
import { deriveNbaBoxscore } from './basketball.js';

export const NBA_SHADOW_VERSION = 'nba-possession-efficiency-ridge-v1';
const FEATURES = ['pace', 'offensiveRating', 'defensiveRating', 'recentPace', 'recentOffense', 'recentDefense', 'home', 'restDays', 'backToBack', 'gamesLast7Days', 'venueChanged', 'opponentOffense', 'opponentDefense'];
const LAMBDAS = [0.1, 1, 10, 100];
const MIN_TRAINING = 12;
const mean = xs => xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
const metric = xs => ({ samples: xs.length, mae: mean(xs.map(Math.abs)), rmse: xs.length ? Math.sqrt(mean(xs.map(x => x * x))) : null, bias: mean(xs) });
const day = value => Date.parse(`${value}T00:00:00Z`) / 86400000;

// Schedule-derived context, not a claim about actual travel itineraries.
export function nbaScheduleContext(game, teamId, history) {
  const earlier = history.filter(g => g.league === 'NBA' && g.season.year === game.season.year && g.seasonType === game.seasonType && g.taipeiDate < game.taipeiDate && [g.home.id, g.away.id].includes(teamId)).sort((a, b) => a.startTime.localeCompare(b.startTime));
  const last = earlier.at(-1);
  const gap = last ? day(game.taipeiDate) - day(last.taipeiDate) : null;
  return { restDays: gap === null ? null : gap - 1, backToBack: gap === null ? null : gap === 1 ? 1 : 0,
    gamesLast7Days: earlier.filter(g => day(game.taipeiDate) - day(g.taipeiDate) <= 7).length,
    venueChanged: last?.venue && game.venue ? Number(last.venue !== game.venue) : null,
    priorGameId: last?.id || null, temporalBasis: 'earlier_dates_in_supplied_schedule', travelDistanceKm: null, actualTravelVerified: false };
}

function solve(matrix, vector) {
  const a = matrix.map((row, i) => [...row, vector[i]]); const n = a.length;
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    if (!Number.isFinite(a[pivot][col]) || Math.abs(a[pivot][col]) < 1e-12) throw new Error('SINGULAR_FIT');
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const scale = a[col][col]; for (let k = col; k <= n; k += 1) a[col][k] /= scale;
    for (let row = 0; row < n; row += 1) if (row !== col) {
      const weight = a[row][col]; for (let k = col; k <= n; k += 1) a[row][k] -= weight * a[col][k];
    }
  }
  return a.map(row => row[n]);
}
// All imputation/scaling is fitted on training rows only. Raw missing data stays
// null; every imputed feature gets a separate missingness indicator.
function fit(rows, lambda) {
  const centers = FEATURES.map((_, j) => mean(rows.map(r => r.x[j]).filter(Number.isFinite)) ?? 0);
  const scales = centers.map((m, j) => Math.sqrt(mean(rows.map(r => Number.isFinite(r.x[j]) ? (r.x[j] - m) ** 2 : 0))) || 1);
  const transform = values => [1, ...values.map((v, j) => Number.isFinite(v) ? (v - centers[j]) / scales[j] : 0), ...values.map(v => Number.isFinite(v) ? 0 : 1)];
  const x = rows.map(r => transform(r.x)); const n = x[0].length;
  const gram = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => x.reduce((s, r) => s + r[i] * r[j], 0) + (i === j && i !== 0 ? lambda : 0)));
  const coefficients = [0, 1, 2].map(k => solve(gram, Array.from({ length: n }, (_, j) => rows.reduce((s, row, i) => s + x[i][j] * row.y[k], 0))));
  return values => {
    const input = transform(values);
    const targets = coefficients.map(c => Math.exp(c.reduce((s, v, j) => s + v * input[j], 0)));
    if (!targets.every(v => Number.isFinite(v) && v > 0)) throw new Error('NONFINITE_MODEL_OUTPUT');
    return { possessions: targets[0], own: targets[0] * targets[1] / 100, opponent: targets[0] * targets[2] / 100 };
  };
}

function selectLambda(rows) {
  const dates = [...new Set(rows.map(r => r.date))];
  const cut = dates[Math.floor(dates.length * 0.75)];
  const training = rows.filter(r => r.date < cut); const validation = rows.filter(r => r.date >= cut);
  if (training.length < MIN_TRAINING || !validation.length) return { lambda: 1, basis: 'declared_default_before_inner_validation' };
  const scores = LAMBDAS.map(lambda => {
    const predict = fit(training, lambda);
    return { lambda, mse: mean(validation.map(row => { const p = predict(row.x); return ((p.own - row.own) ** 2 + (p.opponent - row.opponent) ** 2) / 2; })) };
  });
  scores.sort((a, b) => a.mse - b.mse || a.lambda - b.lambda);
  return { lambda: scores[0].lambda, basis: 'inner_chronological_holdout', scores };
}

/** Completed historical games only. No callable future prediction is exported. */
export function analyzeNbaShadow(games, { teamId, seasonType = 'regular' } = {}) {
  const structural = analyzeNbaHistory(games, { seasonType });
  const issues = [...structural.qa.issues];
  const report = { version: NBA_SHADOW_VERSION, status: 'insufficient_data', teamId, seasonType,
    method: { inputs: FEATURES, targets: ['log_estimated_possessions', 'log_own_offensive_rating', 'log_opponent_offensive_rating'],
      training: 'expanding_window_strictly_earlier_taipei_dates', scaling: 'training_only_with_missing_indicators', lambdaCandidates: LAMBDAS, minimumTrainingRows: MIN_TRAINING,
      output: 'completed_history_aggregate_diagnostics', pointInTimeReplay: false, scoreInterpretation: 'product_of_conditional_log_scale_centers_not_bias_corrected_mean', jointErrors: 'paired_same_game_own_and_opponent_residuals' },
    counts: { input: games?.length || 0, features: 0, missing: 0, overtime: 0, validation: 0, warmup: 0 },
    validation: null, featureSummary: null, folds: [], excluded: [], promotionEligible: false, researchVerdict: 'insufficient_evidence', qa: { status: 'WARNING', issues },
    limitations: ['只研究所選歷史資料，不輸出未開賽預測或投注建議。', '回合數、效率與 Usage 為估算，並非官方逐回合計數。', '對手資料只來自本次歷史集合，可能不完整；缺值使用訓練集平均與缺值指示，不冒充原始數據。', '傷病、先發、On/Off、實際旅行距離與賽前發布快照尚未納入；不得宣稱完整 NBA 模型。', '區間涵蓋率為逐時驗證結果，不保證未來校準；同場兩隊使用成對誤差，沒有独立拼接市場機率。'] };
  const block = (code, message) => { issues.push({ code, severity: 'BLOCK', message }); report.qa.status = 'BLOCK'; report.status = 'blocked'; report.validation = null; return report; };
  if (structural.qa.status === 'BLOCK') return block('HISTORY_BLOCKED', '歷史身分或日期未通過 QA。');
  if (!/^nba:espn:team:[1-9]\d*$/.test(teamId || '')) return block('TEAM_IDENTITY_MISMATCH', '必須指定已核對的 NBA 研究球隊。');
  const unique = [...new Map(games.map(g => [g.id, g])).values()].filter(g => g.completed && g.status === 'final' && g.seasonType === seasonType).sort((a, b) => a.taipeiDate.localeCompare(b.taipeiDate) || a.id.localeCompare(b.id));
  if (unique.some(g => ![g.home.id, g.away.id].includes(teamId))) return block('DATASET_SCOPE_MISMATCH', '單隊研究不可混入與指定球隊無關的比賽。');
  const valid = [];
  for (const game of unique) {
    const box = deriveNbaBoxscore(game);
    if (box.status === 'blocked') return block('BOX_SCORE_BLOCKED', `${game.id} 的 box score 完整性檢查失敗。`);
    if (box.status !== 'ready' || box.pace === null) { report.excluded.push({ gameId: game.id, reason: 'missing_verified_boxscore_or_duration' }); report.counts.missing += 1; continue; }
    const side = game.home.id === teamId ? 'home' : 'away';
    valid.push({ game, box, side }); report.counts.features += 1;
    if (box.minutes > 48) report.counts.overtime += 1;
  }
  if (report.counts.missing) issues.push({ code: 'INCOMPLETE_BOX_HISTORY', severity: 'WARNING', message: `${report.counts.missing} 場缺少完整 box score，已明列排除，不冒充完整球季。` });
  const rows = [];
  for (const item of valid) {
    const { game, box, side } = item;
    const past = valid.filter(r => r.game.season.year === game.season.year && r.game.taipeiDate < game.taipeiDate);
    if (past.length < 3) { report.counts.warmup += 1; continue; }
    const recent = past.slice(-5);
    const ownAverage = (set, name) => mean(set.map(r => r.box[r.side][name]));
    const opponentId = game[side === 'home' ? 'away' : 'home'].id;
    const opponentHistory = past.filter(r => [r.game.home.id, r.game.away.id].includes(opponentId));
    const oppAverage = name => mean(opponentHistory.map(r => r.box[r.game.home.id === opponentId ? 'home' : 'away'][name]));
    const context = nbaScheduleContext(game, teamId, unique);
    const x = [mean(past.map(r => r.box.pace)), ownAverage(past, 'offensiveRating'), ownAverage(past, 'defensiveRating'), mean(recent.map(r => r.box.pace)), ownAverage(recent, 'offensiveRating'), ownAverage(recent, 'defensiveRating'), game.neutralSite ? 0 : side === 'home' ? 1 : -1,
      context.restDays, context.backToBack, context.gamesLast7Days, context.venueChanged, oppAverage('offensiveRating'), oppAverage('defensiveRating')];
    const other = side === 'home' ? 'away' : 'home';
    if (box[side].offensiveRating <= 0 || box[other].offensiveRating <= 0) return block('NONPOSITIVE_TARGET', 'Log-efficiency 模型遇到非正數目標，未硬調數字。');
    rows.push({ id: game.id, date: game.taipeiDate, year: game.season.year, x, y: [box.possessions, box[side].offensiveRating, box[other].offensiveRating].map(Math.log), own: game[side].score, opponent: game[other].score, possessions: box.possessions,
      baselineOwn: mean(past.map(r => r.game[r.side].score)), baselineOpponent: mean(past.map(r => r.game[r.side === 'home' ? 'away' : 'home'].score)) });
  }
  const errors = []; const baselineErrors = []; const possessionErrors = []; const paired = []; const intervalRows = [];
  try {
    for (const row of rows) {
      const training = rows.filter(r => r.year === row.year && r.date < row.date);
      if (training.length < MIN_TRAINING) { report.counts.warmup += 1; continue; }
      const selected = selectLambda(training); const p = fit(training, selected.lambda)(row.x);
      const own = p.own - row.own; const opponent = p.opponent - row.opponent;
      const earlierErrors = paired.filter(r => r.year === row.year && r.date < row.date);
      if (earlierErrors.length >= 20) {
        const sorted = earlierErrors.map(r => Math.max(Math.abs(r.own), Math.abs(r.opponent))).sort((a, b) => a - b);
        for (const nominal of [0.5, 0.8, 0.9]) {
          const rank = Math.ceil((sorted.length + 1) * nominal);
          if (rank <= sorted.length) intervalRows.push({ nominal, covered: Math.max(Math.abs(own), Math.abs(opponent)) <= sorted[rank - 1], width: 2 * sorted[rank - 1] });
        }
      }
      errors.push(own, opponent); baselineErrors.push(row.baselineOwn - row.own, row.baselineOpponent - row.opponent); possessionErrors.push(p.possessions - row.possessions);
      paired.push({ year: row.year, date: row.date, own, opponent });
      report.folds.push({ gameId: row.id, date: row.date, trainingRows: training.length, trainingThrough: training.at(-1).date, lambda: selected.lambda, selection: selected.basis });
    }
  } catch (error) { return block('MODEL_NUMERIC_FAILURE', `研究模型數值失敗：${error.message}；未封頂或改值。`); }
  report.counts.validation = paired.length;
  if (paired.length) {
    const a = mean(paired.map(r => r.own)); const b = mean(paired.map(r => r.opponent));
    const covariance = paired.length > 1 ? [[mean(paired.map(r => (r.own - a) ** 2)), mean(paired.map(r => (r.own - a) * (r.opponent - b)))], [mean(paired.map(r => (r.own - a) * (r.opponent - b))), mean(paired.map(r => (r.opponent - b) ** 2))]].map(row => row.map(v => v * paired.length / (paired.length - 1))) : null;
    report.validation = { ...metric(errors), baselineSameFolds: metric(baselineErrors), possessions: metric(possessionErrors), pairedResidualCovariance: covariance,
      jointCoverage: [0.5, 0.8, 0.9].map(nominal => { const set = intervalRows.filter(r => r.nominal === nominal); return { nominal, samples: set.length, observed: mean(set.map(r => Number(r.covered))), meanWidth: mean(set.map(r => r.width)), method: 'past_paired_max_absolute_error_rectangle' }; }) };
    report.status = report.counts.missing ? 'partial' : 'ready';
    report.researchVerdict = report.validation.mae < report.validation.baselineSameFolds.mae ? 'lower_mae_in_this_sample_only' : 'not_better_than_baseline';
    if (report.researchVerdict === 'not_better_than_baseline') issues.push({ code: 'MODEL_BASELINE_UNDERPERFORMANCE', severity: 'WARNING', message: '此樣本的模型 MAE 未優於同場簡單基準；研究完成不等於模型通過正式使用驗收。' });
  }
  report.featureSummary = { games: valid.length, meanPace: mean(valid.map(r => r.box.pace)), meanOffensiveRating: mean(valid.map(r => r.box[r.side].offensiveRating)), meanDefensiveRating: mean(valid.map(r => r.box[r.side].defensiveRating)), meanNetRating: mean(valid.map(r => r.box[r.side].netRating)) };
  return report;
}
