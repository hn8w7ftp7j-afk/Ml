import { createHash } from 'node:crypto';
import { validateNhlIdentity, validNhlDate } from './identity.js';

// This module is deliberately independent of the pregame score/market model.
// Its response variable is a goal on an observed, unblocked shot attempt. The
// shot itself is not known before a game, so even held-out results are NOT a
// pregame forecast. No licensed provider's xG/"high danger" metric is reproduced.
export const NHL_SHOT_RESEARCH_VERSION = 'NHL-OFFICIAL-SHOT-RESEARCH-v1.0.0';
export const NHL_SHOT_RESEARCH_SCOPE = 'RETROSPECTIVE_CONDITIONAL_ON_OBSERVED_UNBLOCKED_SHOTS';
const EMBARGO_MS = 48 * 3600_000;
const SHOTS = new Set(['goal', 'shot-on-goal', 'missed-shot']);
const FEATURES = ['distanceFeet', 'angleRadians', 'behindGoalLine', 'shotType'];
const SUPPORTED_STRENGTHS = ['5V5', 'PP', 'PK', 'OTHER_EVEN_STRENGTH'];
const ALL_STRENGTHS = [...SUPPORTED_STRENGTHS, 'BOTH_EMPTY_NETS', 'OPPONENT_EMPTY_NET', 'EXTRA_ATTACKER_OWN_EMPTY_NET'];
const id = value => Number.isSafeInteger(value) && value > 0;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const timestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)
  && validNhlDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (code, fields = {}) => ({ ok: false, status: 'BLOCK', code, issues: [code], rows: [], ...fields });
const throwCode = code => { throw Object.assign(new Error(code), { code }); };
const stable = value => value && typeof value === 'object' ? (Array.isArray(value) ? value.map(stable) : Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]))) : value;
const validFeatures = f => f && Object.keys(f).sort().join('|') === [...FEATURES].sort().join('|')
  && finite(f.distanceFeet) && f.distanceFeet >= 0 && finite(f.angleRadians) && f.angleRadians >= 0 && f.angleRadians <= Math.PI
  && typeof f.behindGoalLine === 'boolean' && typeof f.shotType === 'string' && /^[a-z-]{2,30}$/.test(f.shotType);
const validSource = (source, gameId) => source?.provider === 'NHL'
  && source.url === `https://api-web.nhle.com/v1/gamecenter/${gameId}/play-by-play`
  && timestamp(source.fetchedAt) && /^[a-f0-9]{64}$/.test(source.contentHash || '');

function strength(code, homeShooter) {
  if (typeof code !== 'string' || !/^[01][0-6][0-6][01]$/.test(code)) return null;
  const [awayGoalie, awaySkaters, homeSkaters, homeGoalie] = [...code].map(Number);
  if (awaySkaters < 3 || homeSkaters < 3) return 'PENALTY_SHOT_OR_NONSTANDARD';
  const ownGoalie = homeShooter ? homeGoalie : awayGoalie;
  const opponentGoalie = homeShooter ? awayGoalie : homeGoalie;
  if (!ownGoalie && !opponentGoalie) return 'BOTH_EMPTY_NETS';
  if (!opponentGoalie) return 'OPPONENT_EMPTY_NET';
  if (!ownGoalie) return 'EXTRA_ATTACKER_OWN_EMPTY_NET';
  const own = homeShooter ? homeSkaters : awaySkaters;
  const other = homeShooter ? awaySkaters : homeSkaters;
  return own === 5 && other === 5 ? '5V5' : own > other ? 'PP' : own < other ? 'PK' : 'OTHER_EVEN_STRENGTH';
}

export function extractNhlShotResearch(payload, { source, expectedGame = null } = {}) {
  const game = { leagueId: 'NHL', gameId: String(payload?.id ?? ''), season: payload?.season, gameType: payload?.gameType,
    startTimeUTC: payload?.startTimeUTC, awayTeamId: payload?.awayTeam?.id, homeTeamId: payload?.homeTeam?.id };
  const identity = validateNhlIdentity(game, expectedGame);
  if (!identity.ok) return fail('NHL_SHOT_GAME_IDENTITY_INVALID', { issues: identity.issues });
  if (!validSource(source, game.gameId) || source.contentHash !== digest(payload)) return fail('NHL_SHOT_SOURCE_UNVERIFIED');
  if (!Array.isArray(payload.plays) || !Array.isArray(payload.rosterSpots)) return fail('NHL_SHOT_SCHEMA_INVALID');
  const roster = new Map();
  for (const player of payload.rosterSpots) {
    if (!id(player?.playerId) || ![game.awayTeamId, game.homeTeamId].includes(player.teamId)
      || !['C', 'L', 'R', 'D', 'G'].includes(player.positionCode) || roster.has(player.playerId)) return fail('NHL_SHOT_ROSTER_IDENTITY_CONFLICT');
    roster.set(player.playerId, player);
  }
  const unique = new Map(); const exclusions = {}; const warnings = []; const rows = [];
  const goals = { [game.awayTeamId]: 0, [game.homeTeamId]: 0 }; const sog = { [game.awayTeamId]: 0, [game.homeTeamId]: 0 };
  const exclude = code => { exclusions[code] = (exclusions[code] || 0) + 1; };
  for (const event of payload.plays) {
    if (!id(event?.eventId)) return fail('NHL_SHOT_EVENT_IDENTITY_INVALID');
    const canonical = JSON.stringify(stable(event));
    if (unique.has(event.eventId)) {
      if (unique.get(event.eventId) !== canonical) return fail('NHL_SHOT_EVENT_REVISION_CONFLICT');
      exclude('IDENTICAL_DUPLICATE_EVENT'); continue;
    }
    unique.set(event.eventId, canonical);
    if (event?.periodDescriptor?.periodType === 'SO') { if (SHOTS.has(event.typeDescKey)) exclude('SHOOTOUT'); continue; }
    if (!SHOTS.has(event.typeDescKey)) { if (event.typeDescKey === 'blocked-shot') exclude('BLOCKED_ATTEMPT_NOT_MODEL_DENOMINATOR'); continue; }
    const period = event.periodDescriptor;
    if (!id(period?.number) || !(period.periodType === 'REG' && period.number <= 3 || period.periodType === 'OT' && period.number >= 4)) return fail('NHL_SHOT_PERIOD_IDENTITY_INVALID');
    const match = /^(\d{2}):([0-5]\d)$/.exec(event.timeInPeriod || '');
    const seconds = match ? Number(match[1]) * 60 + Number(match[2]) : null;
    const periodSeconds = period.periodType === 'OT' && game.gameType !== 3 ? 300 : 1200;
    if (seconds === null || seconds > periodSeconds) return fail('NHL_SHOT_EVENT_CLOCK_INVALID');
    const details = event.details || {};
    const teamId = details.eventOwnerTeamId;
    if (![game.awayTeamId, game.homeTeamId].includes(teamId)) return fail('NHL_SHOT_TEAM_IDENTITY_INVALID');
    if (event.typeDescKey === 'goal') goals[teamId] += 1;
    if (event.typeDescKey !== 'missed-shot') sog[teamId] += 1;
    const shooterId = event.typeDescKey === 'goal' ? details.scoringPlayerId : details.shootingPlayerId;
    if (!id(shooterId) || roster.get(shooterId)?.teamId !== teamId
      || details.scoringPlayerId != null && details.shootingPlayerId != null && details.scoringPlayerId !== details.shootingPlayerId) return fail('NHL_SHOT_PLAYER_IDENTITY_INVALID');
    const context = strength(event.situationCode, teamId === game.homeTeamId);
    if (!context) { exclude('SITUATION_MISSING_OR_INVALID'); continue; }
    if (context === 'PENALTY_SHOT_OR_NONSTANDARD') { exclude(context); continue; }
    const goalieId = details.goalieInNetId ?? null;
    const opponentId = teamId === game.homeTeamId ? game.awayTeamId : game.homeTeamId;
    const empty = ['OPPONENT_EMPTY_NET', 'BOTH_EMPTY_NETS'].includes(context);
    if (empty ? goalieId !== null : !id(goalieId) || roster.get(goalieId)?.teamId !== opponentId || roster.get(goalieId)?.positionCode !== 'G') return fail('NHL_SHOT_GOALIE_IDENTITY_INVALID');
    if (!finite(details.xCoord) || !finite(details.yCoord) || Math.abs(details.xCoord) > 100 || Math.abs(details.yCoord) > 42.5) { exclude('SHOT_COORDINATES_MISSING_OR_OUTSIDE_RINK'); continue; }
    if (!['left', 'right'].includes(event.homeTeamDefendingSide)) { exclude('ATTACK_DIRECTION_UNVERIFIED'); continue; }
    const homeAttacksRight = event.homeTeamDefendingSide === 'left';
    const attackSign = (teamId === game.homeTeamId) === homeAttacksRight ? 1 : -1;
    const attackingX = attackSign * details.xCoord;
    // NHL rule 1: 200-foot length, goal line 11 feet from end boards ->
    // goal center x=+89 after verified attack-direction normalization.
    const remainingX = 89 - attackingX;
    const shotType = typeof details.shotType === 'string' && /^[a-z-]{2,30}$/.test(details.shotType) ? details.shotType : 'unspecified';
    rows.push({ leagueId: 'NHL', gameId: game.gameId, eventId: event.eventId, teamId, opponentId,
      shooterId, goalieId, periodNumber: period.number, periodType: period.periodType, secondsInPeriod: seconds,
      strength: context, features: { distanceFeet: Math.hypot(remainingX, details.yCoord),
        angleRadians: Math.atan2(Math.abs(details.yCoord), remainingX), behindGoalLine: remainingX < 0, shotType },
      // Outcomes/score/assist/SOG totals/reasons/highlights never enter features.
      label: { goal: event.typeDescKey === 'goal' ? 1 : 0 },
    });
  }
  if (['OFF', 'FINAL'].includes(payload.gameState)) {
    if (!unique.size || !roster.size) return fail('NHL_SHOT_FINAL_EVENTS_MISSING');
    const endedWithShootout = payload.gameOutcome?.lastPeriodType === 'SO' || payload.periodDescriptor?.periodType === 'SO';
    for (const side of ['away', 'home']) {
      const team = payload[`${side}Team`]; const opponent = payload[`${side === 'away' ? 'home' : 'away'}Team`];
      const awardedShootoutGoal = endedWithShootout && team.score > opponent.score ? 1 : 0;
      if (!Number.isSafeInteger(team.score) || team.score < 0 || !Number.isSafeInteger(team.sog) || team.sog < 0
        || goals[team.id] !== team.score - awardedShootoutGoal || sog[team.id] !== team.sog) return fail('NHL_SHOT_FINAL_EVENT_TOTALS_MISMATCH');
    }
  }
  if (Object.keys(exclusions).some(code => !['SHOOTOUT', 'BLOCKED_ATTEMPT_NOT_MODEL_DENOMINATOR', 'IDENTICAL_DUPLICATE_EVENT', 'PENALTY_SHOT_OR_NONSTANDARD'].includes(code))) warnings.push('NHL_SHOT_INCOMPLETE_FEATURE_COVERAGE');
  return { ok: true, status: warnings.length ? 'WARNING' : 'OK', version: NHL_SHOT_RESEARCH_VERSION,
    scope: NHL_SHOT_RESEARCH_SCOPE, game, final: ['OFF', 'FINAL'].includes(payload.gameState), rows,
    rowHash: digest(rows), rosterIdentity: [...roster.values()].map(player => ({ playerId: player.playerId, teamId: player.teamId, positionCode: player.positionCode })),
    source: structuredClone(source), warnings, exclusions,
    pointInTimeVerified: false, pregameFeatures: false, productionCalibrated: false, providerXg: false,
    highDangerDefinition: null, highDangerXg: null,
  };
}

function validDataset(dataset) {
  if (dataset?.ok !== true || dataset.version !== NHL_SHOT_RESEARCH_VERSION || !validateNhlIdentity(dataset.game).ok
    || !Array.isArray(dataset.rows) || dataset.rowHash !== digest(dataset.rows) || dataset.final !== true
    || !validSource(dataset.source, dataset.game.gameId) || !Array.isArray(dataset.rosterIdentity)) throwCode('NHL_SHOT_DATASET_INVALID');
  const teams = [dataset.game.awayTeamId, dataset.game.homeTeamId]; const roster = new Map(); const events = new Set();
  for (const player of dataset.rosterIdentity) {
    if (!id(player?.playerId) || !teams.includes(player.teamId) || roster.has(player.playerId)
      || !['C', 'L', 'R', 'D', 'G'].includes(player.positionCode)) throwCode('NHL_SHOT_DATASET_ROSTER_INVALID');
    roster.set(player.playerId, player);
  }
  for (const row of dataset.rows) {
    const f = row.features;
    if (row.gameId !== dataset.game.gameId || row.leagueId !== 'NHL' || !id(row.eventId) || ![0, 1].includes(row.label?.goal)
      || !validFeatures(f)) throwCode('NHL_SHOT_FEATURE_OR_LABEL_INVALID');
    if (events.has(row.eventId) || !teams.includes(row.teamId) || !teams.includes(row.opponentId) || row.teamId === row.opponentId
      || roster.get(row.shooterId)?.teamId !== row.teamId || !ALL_STRENGTHS.includes(row.strength)
      || !id(row.periodNumber) || !(row.periodType === 'REG' && row.periodNumber <= 3 || row.periodType === 'OT' && row.periodNumber >= 4)
      || !Number.isSafeInteger(row.secondsInPeriod) || row.secondsInPeriod < 0
      || row.secondsInPeriod > (row.periodType === 'OT' && dataset.game.gameType !== 3 ? 300 : 1200)) throwCode('NHL_SHOT_DATASET_EVENT_IDENTITY_INVALID');
    const empty = ['OPPONENT_EMPTY_NET', 'BOTH_EMPTY_NETS'].includes(row.strength);
    if (empty ? row.goalieId !== null : roster.get(row.goalieId)?.teamId !== row.opponentId || roster.get(row.goalieId)?.positionCode !== 'G') throwCode('NHL_SHOT_DATASET_GOALIE_INVALID');
    events.add(row.eventId);
  }
  return dataset;
}
const sigmoid = z => z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));
const softplus = z => z > 0 ? z + Math.log1p(Math.exp(-z)) : Math.log1p(Math.exp(z));
const dot = (a, b) => a.reduce((total, value, index) => total + value * b[index], 0);
const vector = (features, shotTypes) => [1, features.distanceFeet / 100, features.angleRadians / Math.PI, Number(features.behindGoalLine), ...shotTypes.slice(1).map(type => Number(features.shotType === type))];

function calibrationEvidence(predictions, reliability) {
  if (!predictions.length) return { status: 'NO_HELD_OUT_EVIDENCE', expectedCalibrationError: null, observedMinusPredictedGoalRate: null,
    gameClusterBootstrap: null, productionCalibrationCertified: false };
  const groups = new Map();
  for (const row of predictions) {
    if (!groups.has(row.gameId)) groups.set(row.gameId, { n: 0, delta: 0, brierDelta: 0 });
    const game = groups.get(row.gameId); game.n += 1; game.delta += row.observedGoal - row.probability;
    game.brierDelta += row.brier - row.baselineBrier;
  }
  const games = [...groups.values()]; const bootstraps = []; let state = 0x4e484c;
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 2 ** 32; };
  if (games.length >= 2) for (let replicate = 0; replicate < 500; replicate += 1) {
    let n = 0; let delta = 0; let brierDelta = 0;
    for (let index = 0; index < games.length; index += 1) {
      const game = games[Math.floor(random() * games.length)]; n += game.n; delta += game.delta; brierDelta += game.brierDelta;
    }
    bootstraps.push({ delta: delta / n, brierDelta: brierDelta / n });
  }
  const interval = key => {
    const values = bootstraps.map(row => row[key]).sort((a, b) => a - b);
    const percentile = p => { const position = (values.length - 1) * p; const index = Math.floor(position); return values[index] + (values[Math.ceil(position)] - values[index]) * (position - index); };
    return values.length ? { lower: percentile(0.025), upper: percentile(0.975) } : null;
  };
  return { status: 'HELD_OUT_CALIBRATION_RESEARCH', evaluatedGames: games.length,
    expectedCalibrationError: reliability.reduce((sum, bin) => sum + (bin.count ? bin.count * Math.abs(bin.meanProbability - bin.observedGoalRate) : 0), 0) / predictions.length,
    observedMinusPredictedGoalRate: games.reduce((sum, game) => sum + game.delta, 0) / predictions.length,
    gameClusterBootstrap: bootstraps.length ? { method: 'PAIRED_GAME_CLUSTER_PERCENTILE_BOOTSTRAP', replicates: 500, seed: '0x4e484c',
      nominalInterval: 0.95, observedMinusPredictedGoalRate: interval('delta'), modelMinusBaselineBrier: interval('brierDelta'),
      assumption: 'Exploratory held-out game resampling; does not certify future-season stationarity' } : null,
    probabilitiesRemapped: false, productionCalibrationCertified: false };
}

function solve(matrix, target) {
  const n = target.length; const rows = matrix.map((row, i) => [...row, target[i]]);
  for (let column = 0; column < n; column += 1) {
    let pivot = column;
    for (let i = column + 1; i < n; i += 1) if (Math.abs(rows[i][column]) > Math.abs(rows[pivot][column])) pivot = i;
    if (!finite(rows[pivot][column]) || Math.abs(rows[pivot][column]) < Number.EPSILON) throwCode('NHL_SHOT_FIT_SINGULAR');
    [rows[column], rows[pivot]] = [rows[pivot], rows[column]];
    const divisor = rows[column][column];
    for (let j = column; j <= n; j += 1) rows[column][j] /= divisor;
    for (let i = 0; i < n; i += 1) if (i !== column) {
      const multiplier = rows[i][column];
      for (let j = column; j <= n; j += 1) rows[i][j] -= multiplier * rows[column][j];
    }
  }
  return rows.map(row => row[n]);
}

export function fitNhlShotResearch(datasets, { asOf, strength: selectedStrength = '5V5', gameType = 2, l2 = 1, maxIterations = 100 } = {}) {
  if (!Array.isArray(datasets) || !timestamp(asOf) || !SUPPORTED_STRENGTHS.includes(selectedStrength) || gameType !== 2
    || !finite(l2) || l2 <= 0 || !Number.isSafeInteger(maxIterations) || maxIterations < 1 || maxIterations > 1000) throwCode('NHL_SHOT_FIT_OPTIONS_INVALID');
  const seen = new Set(); const training = [];
  for (const dataset of datasets) {
    validDataset(dataset);
    if (seen.has(dataset.game.gameId)) throwCode('NHL_SHOT_TRAINING_GAME_DUPLICATE');
    seen.add(dataset.game.gameId);
    if (dataset.game.gameType === gameType && Date.parse(dataset.game.startTimeUTC) + EMBARGO_MS <= Date.parse(asOf)) training.push(dataset);
  }
  training.sort((a, b) => Date.parse(a.game.startTimeUTC) - Date.parse(b.game.startTimeUTC) || a.game.gameId.localeCompare(b.game.gameId));
  const shots = training.flatMap(dataset => dataset.rows.filter(row => row.strength === selectedStrength));
  const base = { version: NHL_SHOT_RESEARCH_VERSION, scope: NHL_SHOT_RESEARCH_SCOPE, strength: selectedStrength,
    asOf, gameType, trainingGameIds: training.map(dataset => dataset.game.gameId), trainingShots: shots.length,
    trainingGoals: shots.reduce((sum, row) => sum + row.label.goal, 0), trainingSources: training.map(dataset => structuredClone(dataset.source)),
    availabilityMode: 'RETROSPECTIVE_48H_EMBARGO', pointInTimeVerified: false, embargoHours: 48,
    productionCalibrated: false, pregameModel: false, l2, l2Purpose: 'EXPLICIT_TRAINING_REGULARIZATION_NOT_PROBABILITY_CAP',
  };
  if (training.length < 2 || !shots.length || new Set(shots.map(row => row.label.goal)).size !== 2) return { ...base, ok: false, status: 'INSUFFICIENT_TRAINING_VARIATION', coefficients: null };
  const shotTypes = [...new Set(shots.map(row => row.features.shotType))].sort();
  const x = shots.map(row => vector(row.features, shotTypes)); const y = shots.map(row => row.label.goal);
  const n = x[0].length; let coefficients = Array(n).fill(0);
  coefficients[0] = Math.log(base.trainingGoals / (shots.length - base.trainingGoals));
  const loss = beta => x.reduce((sum, row, i) => { const z = dot(row, beta); return sum + softplus(z) - y[i] * z; }, 0)
    + l2 / 2 * beta.slice(1).reduce((sum, value) => sum + value * value, 0);
  // Compute a loss difference directly. Subtracting two O(number-of-shots)
  // totals can erase the O(step²) Newton improvement near the optimum.
  // This is the same penalized objective, not a looser convergence tolerance.
  const lossDifference = (beta, displacement) => {
    let total = 0; let correction = 0;
    const add = value => { const adjusted = value - correction; const next = total + adjusted; correction = (next - total) - adjusted; total = next; };
    for (let k = 0; k < x.length; k++) {
      const z = dot(x[k], beta); const d = dot(x[k], displacement);
      add(Math.abs(d) < 0.5 ? Math.log1p(sigmoid(z) * Math.expm1(d)) - y[k] * d : softplus(z + d) - softplus(z) - y[k] * d);
    }
    for (let j = 1; j < beta.length; j++) add(l2 * displacement[j] * (beta[j] + displacement[j] / 2));
    return total;
  };
  let converged = false; let iterations = 0; let objective = loss(coefficients); let gradientInfinityNorm = null;
  for (; iterations < maxIterations; iterations += 1) {
    const gradient = coefficients.map((value, i) => i ? l2 * value : 0);
    const hessian = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => i === j && i ? l2 : 0));
    for (let k = 0; k < x.length; k += 1) {
      const p = sigmoid(dot(x[k], coefficients)); const weight = p * (1 - p);
      for (let i = 0; i < n; i += 1) {
        gradient[i] += (p - y[k]) * x[k][i];
        for (let j = 0; j < n; j += 1) hessian[i][j] += weight * x[k][i] * x[k][j];
      }
    }
    gradientInfinityNorm = Math.max(...gradient.map(Math.abs));
    if (gradientInfinityNorm < 1e-8) { converged = true; break; }
    const step = solve(hessian, gradient); let scale = 1; let accepted = false;
    while (scale >= 1e-10) {
      const displacement = step.map(value => -scale * value);
      const candidate = coefficients.map((value, i) => value + displacement[i]); const delta = lossDifference(coefficients, displacement);
      if (finite(delta) && delta <= 0) { coefficients = candidate; objective = loss(candidate); accepted = true; break; }
      scale /= 2;
    }
    if (!accepted) break;
  }
  return { ...base, ok: converged, status: converged ? 'RESEARCH_FIT_CONVERGED' : 'FIT_NOT_CONVERGED', coefficients: converged ? coefficients : null,
    shotTypes, featureNames: ['intercept', 'distanceFeet/100', 'angleRadians/pi', 'behindGoalLine', ...shotTypes.slice(1).map(type => `shotType:${type}`)],
    iterations, gradientInfinityNorm, convergenceTolerance: 1e-8, lossComparison: 'DIRECT_STABLE_DIFFERENCE', penalizedNegativeLogLikelihood: objective, fittedFamily: 'REGULARIZED_BINOMIAL_LOGISTIC',
    modelHash: digest({ training: training.map(dataset => dataset.rowHash), selectedStrength, asOf, l2, coefficients }),
  };
}

export function predictNhlShotResearch(model, row) {
  if (model?.ok !== true || model.version !== NHL_SHOT_RESEARCH_VERSION || !Array.isArray(model.coefficients) || model.coefficients.some(value => !finite(value))) throwCode('NHL_SHOT_MODEL_INVALID');
  if (row?.strength !== model.strength || !row?.features || Object.keys(row.features).sort().join('|') !== [...FEATURES].sort().join('|')) throwCode('NHL_SHOT_PREDICTION_SCOPE_INVALID');
  if (!validFeatures(row.features)) throwCode('NHL_SHOT_PREDICTION_FEATURE_INVALID');
  if (!model.shotTypes.includes(row.features.shotType)) return { ok: false, status: 'UNSEEN_SHOT_TYPE', probability: null, logit: null };
  const values = vector(row.features, model.shotTypes);
  if (values.some(value => !finite(value)) || values.length !== model.coefficients.length) throwCode('NHL_SHOT_PREDICTION_FEATURE_INVALID');
  const logit = dot(values, model.coefficients);
  if (!finite(logit)) throwCode('NHL_SHOT_PREDICTION_NUMERICAL_FAILURE');
  return { ok: true, probability: sigmoid(logit), logit, scope: NHL_SHOT_RESEARCH_SCOPE, productionCalibrated: false };
}

export function chronologicalNhlShotValidation(datasets, { strength: selectedStrength = '5V5', initialTrainingGames = 3, holdoutBlockGames = 1, l2 = 1 } = {}) {
  if (!Array.isArray(datasets) || !Number.isSafeInteger(initialTrainingGames) || initialTrainingGames < 2
    || !Number.isSafeInteger(holdoutBlockGames) || holdoutBlockGames < 1 || !SUPPORTED_STRENGTHS.includes(selectedStrength)) throwCode('NHL_SHOT_VALIDATION_OPTIONS_INVALID');
  const unique = new Set();
  const corpus = datasets.map(validDataset).filter(dataset => dataset.game.gameType === 2).sort((a, b) => Date.parse(a.game.startTimeUTC) - Date.parse(b.game.startTimeUTC) || a.game.gameId.localeCompare(b.game.gameId));
  for (const dataset of corpus) { if (unique.has(dataset.game.gameId)) throwCode('NHL_SHOT_VALIDATION_GAME_DUPLICATE'); unique.add(dataset.game.gameId); }
  const folds = []; const skipped = []; const predictions = []; const fittedBlocks = new Map();
  for (let targetIndex = 0; targetIndex < corpus.length; targetIndex += 1) {
    const target = corpus[targetIndex];
    // Freeze each block's fit before its first game. Later games in that block
    // cannot leak outcomes back into their own or their peers' fitted model.
    const trainingCutoff = new Date(corpus[Math.floor(targetIndex / holdoutBlockGames) * holdoutBlockGames].game.startTimeUTC).toISOString();
    if (Date.parse(trainingCutoff) > Date.parse(target.game.startTimeUTC)) throwCode('NHL_SHOT_BLOCK_CUTOFF_AFTER_TARGET');
    const training = corpus.filter(dataset => Date.parse(dataset.game.startTimeUTC) + EMBARGO_MS <= Date.parse(trainingCutoff));
    if (training.length < initialTrainingGames) { skipped.push({ gameId: target.game.gameId, reason: 'INSUFFICIENT_PRIOR_GAMES' }); continue; }
    if (!fittedBlocks.has(trainingCutoff)) fittedBlocks.set(trainingCutoff, fitNhlShotResearch(training, { asOf: trainingCutoff, strength: selectedStrength, l2 }));
    const model = fittedBlocks.get(trainingCutoff);
    if (!model.ok) { skipped.push({ gameId: target.game.gameId, reason: model.status }); continue; }
    const evaluated = []; const excluded = []; const baseline = model.trainingGoals / model.trainingShots;
    for (const row of target.rows.filter(candidate => candidate.strength === selectedStrength)) {
      const prediction = predictNhlShotResearch(model, row);
      if (!prediction.ok) { excluded.push({ eventId: row.eventId, reason: prediction.status }); continue; }
      const y = row.label.goal; const p = prediction.probability;
      evaluated.push({ gameId: row.gameId, eventId: row.eventId, teamId: row.teamId, probability: p, observedGoal: y,
        brier: (p - y) ** 2, logLoss: softplus(prediction.logit) - y * prediction.logit,
        baselineBrier: (baseline - y) ** 2, baselineLogLoss: -y * Math.log(baseline) - (1 - y) * Math.log1p(-baseline) });
    }
    if (!evaluated.length) { skipped.push({ gameId: target.game.gameId, reason: 'NO_ELIGIBLE_HELD_OUT_SHOTS', excluded }); continue; }
    predictions.push(...evaluated);
    const teamResearch = selectedStrength === '5V5' ? [target.game.awayTeamId, target.game.homeTeamId].map(teamId => {
      const own = evaluated.filter(row => row.teamId === teamId); const against = evaluated.filter(row => row.teamId !== teamId);
      const researchXGF = own.reduce((sum, row) => sum + row.probability, 0); const researchXGA = against.reduce((sum, row) => sum + row.probability, 0);
      return { teamId, strength: '5V5', researchXGF, researchXGA,
        researchXGFShare: researchXGF + researchXGA > 0 ? researchXGF / (researchXGF + researchXGA) : null,
        coveredShotsFor: own.length, coveredShotsAgainst: against.length,
        eligibleShotsFor: target.rows.filter(row => row.strength === '5V5' && row.teamId === teamId).length,
        eligibleShotsAgainst: target.rows.filter(row => row.strength === '5V5' && row.teamId !== teamId).length,
        pregameForecast: false, scope: NHL_SHOT_RESEARCH_SCOPE };
    }) : null;
    folds.push({ gameId: target.game.gameId, asOf: target.game.startTimeUTC, trainingCutoff, trainingGameIds: model.trainingGameIds,
      trainingShots: model.trainingShots, trainingGoals: model.trainingGoals, trainingGradientInfinityNorm: model.gradientInfinityNorm, testedShots: evaluated.length,
      brier: evaluated.reduce((sum, row) => sum + row.brier, 0) / evaluated.length,
      logLoss: evaluated.reduce((sum, row) => sum + row.logLoss, 0) / evaluated.length,
      expectedGoalsConditionalOnObservedShots: evaluated.reduce((sum, row) => sum + row.probability, 0),
      observedGoalsOnCoveredShots: evaluated.reduce((sum, row) => sum + row.observedGoal, 0), excluded, modelHash: model.modelHash,
      teamResearch, sourceFeatureExclusions: target.exclusions });
  }
  const mean = key => predictions.length ? predictions.reduce((sum, row) => sum + row[key], 0) / predictions.length : null;
  const reliability = Array.from({ length: 10 }, (_, index) => {
    const rows = predictions.filter(row => Math.min(9, Math.floor(row.probability * 10)) === index);
    return { lower: index / 10, upper: (index + 1) / 10, count: rows.length,
      meanProbability: rows.length ? rows.reduce((sum, row) => sum + row.probability, 0) / rows.length : null,
      observedGoalRate: rows.length ? rows.reduce((sum, row) => sum + row.observedGoal, 0) / rows.length : null };
  });
  return { ok: true, status: folds.length ? 'RETROSPECTIVE_HELD_OUT_RESEARCH_EVALUATED' : 'NO_ELIGIBLE_FOLDS',
    leagueId: 'NHL', version: NHL_SHOT_RESEARCH_VERSION, scope: NHL_SHOT_RESEARCH_SCOPE, strength: selectedStrength,
    corpusGames: corpus.length, corpusShots: corpus.reduce((sum, dataset) => sum + dataset.rows.filter(row => row.strength === selectedStrength).length, 0),
    foldCount: folds.length, modelFitCount: fittedBlocks.size, holdoutBlockGames, initialTrainingGames,
    evaluatedShots: predictions.length, brier: mean('brier'), logLoss: mean('logLoss'),
    baselineBrier: mean('baselineBrier'), baselineLogLoss: mean('baselineLogLoss'), reliability,
    calibration: calibrationEvidence(predictions, reliability), folds, skipped,
    availabilityMode: 'RETROSPECTIVE_48H_EMBARGO', embargoHours: 48, pointInTimeVerified: false,
    productionCalibrated: false, pregameModel: false, completeSeasonCoverage: false,
    limitations: ['Observed shot locations are not pregame features', 'Historical endpoint revisions are not archived event-time snapshots',
      'No provider high-danger definition or high-danger xG', 'No 5v5 exposure or per-60 estimate', 'No shot-volume forecast or pregame score distribution',
      'Reliability bins describe held-out evidence; they do not certify calibration'],
  };
}

// The complete replayable audit stays with the source checkpoints. The API
// receives bounded display evidence, never a multi-megabyte training-ID dump.
export function compactNhlShotResearchEvidence(full) {
  if (full?.leagueId !== 'NHL' || full.version !== NHL_SHOT_RESEARCH_VERSION || !Array.isArray(full.coverage)
    || !Array.isArray(full.sources) || !Array.isArray(full.requestedGameIds) || !full.reports) throwCode('NHL_SHOT_EVIDENCE_INVALID');
  const { requestedGameIds, coverage, sources, reports, attempts, acquisition, ...summary } = structuredClone(full);
  return { ...summary, requestedGames: new Set(requestedGameIds).size, fullReportHash: digest(full),
    fullReportPath: 'scripts/fixtures/nhl/xg-research/research-report.json', displayLimit: 10,
    coverageGameCount: coverage.length, coverage: coverage.slice(-10), sourceCount: sources.length, sources: sources.slice(-10),
    attemptCount: attempts.length, attempts: attempts.slice(-10),
    acquisition: acquisition ? { ...acquisition, failureCount: acquisition.failures.length, failures: acquisition.failures.slice(-10) } : null,
    reports: Object.fromEntries(Object.entries(reports).map(([strength, report]) => {
      const { folds, skipped, ...metrics } = report;
      return [strength, { ...metrics, skippedGameCount: skipped.length, skipped: skipped.slice(-10),
        displayedFoldCount: Math.min(10, folds.length), folds: folds.slice(-10).map(fold => {
          const { trainingGameIds, ...evidence } = fold;
          return { ...evidence, trainingGames: trainingGameIds.length, trainingGameIdsHash: digest(trainingGameIds) };
        }) }];
    })),
  };
}

export function freezeNhlShotResearchArtifacts(datasets, { asOf, generatedAt, completeSeasonCoverage = false, l2 = 1 } = {}) {
  if (!timestamp(generatedAt) || !timestamp(asOf) || Date.parse(generatedAt) < Date.parse(asOf) || typeof completeSeasonCoverage !== 'boolean') throwCode('NHL_SHOT_ARTIFACT_TIME_INVALID');
  const models = {};
  for (const strength of SUPPORTED_STRENGTHS) {
    const fitted = fitNhlShotResearch(datasets, { asOf, strength, l2 });
    const { trainingSources, trainingGameIds, ...compact } = fitted;
    const included = datasets.filter(dataset => trainingGameIds.includes(dataset.game.gameId));
    const latest = included.length ? Math.max(...included.map(dataset => Date.parse(dataset.game.startTimeUTC))) : null;
    models[strength] = { ...compact, trainingGames: trainingGameIds.length, trainingGameIdsHash: digest(trainingGameIds),
      trainingSourceHash: digest(trainingSources), latestTrainingGameStart: latest === null ? null : new Date(latest).toISOString(),
      completeSeasonCoverage };
  }
  const artifact = { leagueId: 'NHL', version: NHL_SHOT_RESEARCH_VERSION, scope: NHL_SHOT_RESEARCH_SCOPE,
    generatedAt, asOf, completeSeasonCoverage, productionCalibrated: false, pregameModel: false, pointInTimeVerified: false, models };
  return { ...artifact, contentHash: digest(artifact) };
}

// No fit runs in the request path. These frozen coefficients only score the
// location/type of a shot that has already occurred. Targets within or before
// the artifact's training range must use their recorded held-out fold instead.
export function scoreNhlObservedGameResearch(artifacts, payload, options = {}) {
  const { contentHash, ...unsigned } = artifacts || {};
  if (artifacts?.leagueId !== 'NHL' || artifacts.version !== NHL_SHOT_RESEARCH_VERSION || !timestamp(artifacts.generatedAt)
    || contentHash !== digest(unsigned) || !artifacts.models || artifacts.productionCalibrated !== false || artifacts.pregameModel !== false) return fail('NHL_SHOT_FROZEN_ARTIFACT_INVALID');
  const dataset = extractNhlShotResearch(payload, options);
  if (!dataset.ok) return dataset;
  const results = {};
  for (const strength of SUPPORTED_STRENGTHS) {
    const model = artifacts.models[strength];
    if (!model?.ok) { results[strength] = { ok: false, status: model?.status || 'MODEL_UNAVAILABLE', teamResearch: null }; continue; }
    if (dataset.game.gameType !== model.gameType) { results[strength] = { ok: false, status: 'SEASON_PHASE_NOT_TRAINED', teamResearch: null }; continue; }
    if (!timestamp(model.latestTrainingGameStart) || !timestamp(model.asOf)
      || Date.parse(dataset.game.startTimeUTC) <= Date.parse(model.latestTrainingGameStart) + EMBARGO_MS
      || Date.parse(dataset.game.startTimeUTC) < Date.parse(model.asOf)) {
      results[strength] = { ok: false, status: 'HISTORICAL_GAME_REQUIRES_HELD_OUT_ARTIFACT', teamResearch: null }; continue;
    }
    const evaluated = []; const exclusions = [];
    for (const row of dataset.rows.filter(row => row.strength === strength)) {
      const prediction = predictNhlShotResearch(model, row);
      if (!prediction.ok) { exclusions.push({ eventId: row.eventId, reason: prediction.status }); continue; }
      evaluated.push({ eventId: row.eventId, teamId: row.teamId, probability: prediction.probability });
    }
    const teamResearch = strength === '5V5' && evaluated.length ? [dataset.game.awayTeamId, dataset.game.homeTeamId].map(teamId => {
      const own = evaluated.filter(row => row.teamId === teamId); const against = evaluated.filter(row => row.teamId !== teamId);
      const researchXGF = own.reduce((sum, row) => sum + row.probability, 0); const researchXGA = against.reduce((sum, row) => sum + row.probability, 0);
      return { teamId, strength, researchXGF, researchXGA, researchXGFShare: researchXGF + researchXGA > 0 ? researchXGF / (researchXGF + researchXGA) : null,
        coveredShotsFor: own.length, coveredShotsAgainst: against.length,
        eligibleShotsFor: dataset.rows.filter(row => row.strength === strength && row.teamId === teamId).length,
        eligibleShotsAgainst: dataset.rows.filter(row => row.strength === strength && row.teamId !== teamId).length,
        pregameForecast: false, scope: NHL_SHOT_RESEARCH_SCOPE };
    }) : null;
    results[strength] = { ok: true, status: evaluated.length ? 'OBSERVED_SHOT_RESEARCH_SCORED' : 'NO_ELIGIBLE_OBSERVED_SHOTS',
      modelHash: model.modelHash, trainingCutoff: model.asOf, testedShots: evaluated.length,
      expectedGoalsConditionalOnObservedShots: evaluated.length ? evaluated.reduce((sum, row) => sum + row.probability, 0) : null,
      teamResearch, exclusions };
  }
  return { ok: true, leagueId: 'NHL', version: NHL_SHOT_RESEARCH_VERSION, game: dataset.game, scope: NHL_SHOT_RESEARCH_SCOPE,
    source: dataset.source, sourceFeatureExclusions: dataset.exclusions, status: Object.values(results).some(row => row.ok) ? 'OBSERVED_SHOT_RESEARCH' : 'NO_ELIGIBLE_FROZEN_MODEL',
    strengths: results, artifactHash: artifacts.contentHash, artifactGeneratedAt: artifacts.generatedAt,
    productionCalibrated: false, pregameModel: false, pointInTimeVerified: false, highDangerDefinition: null, highDangerXg: null };
}
