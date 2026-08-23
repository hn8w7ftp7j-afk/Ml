import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import readline from 'node:readline';
import { Readable } from 'node:stream';
import { createGunzip, createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { buildAdvancedOosValidationV2 } from '../lib/mlb-advanced-oos-validation-v2.js';
import { buildHistoricalWindFeatureV2 } from '../lib/mlb-historical-weather-v2.js';

const VERSION = 'MLB-ADVANCED-PIT-RECONSTRUCTION-2026-08-v2.1.0';
const root = process.argv[2] || '/workspace/mlb-pit-data';
const outputRoot = process.argv[3] || `${root}/reconstructed-v2`;
const indexPath = `${root}/normalized/game-index.jsonl`;
const finalStatuses = new Set(['Final', 'Completed Early', 'Game Over']);
const featureNames = ['fielding', 'injury', 'pitchMatchup', 'catcherUmpireZone', 'windOrientation'];
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const finite = (value, fallback = null) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const previousDate = value => {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
};

function parseCsvLine(line) {
  const fields = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') { value += '"'; index += 1; }
      else quoted = !quoted;
    } else if (character === ',' && !quoted) {
      fields.push(value);
      value = '';
    } else value += character;
  }
  fields.push(value);
  return fields;
}

const boundedPush = (values, value, maximum) => {
  values.push(value);
  if (values.length > maximum) values.splice(0, values.length - maximum);
};

function newGameAggregate(game) {
  return {
    game,
    pitchCounts: new Map(),
    batterPitch: new Map(),
    batters: new Map(),
    catchers: new Map(),
    teamFielding: new Map(),
    umpireTaken: { residual: 0, count: 0 },
  };
}

const nested = (map, key, factory) => {
  if (!map.has(key)) map.set(key, factory());
  return map.get(key);
};

function calledStrikeExpectation(row, columns) {
  const plateX = finite(row[columns.plate_x]);
  const plateZ = finite(row[columns.plate_z]);
  const top = finite(row[columns.sz_top]);
  const bottom = finite(row[columns.sz_bot]);
  if ([plateX, plateZ, top, bottom].some(value => value == null) || top <= bottom) {
    const zone = finite(row[columns.zone]);
    return zone != null && zone >= 1 && zone <= 9 ? 0.88 : 0.08;
  }
  const horizontalOutside = Math.max(0, Math.abs(plateX) - 0.83);
  const verticalOutside = Math.max(0, bottom - plateZ, plateZ - top);
  const outside = Math.max(horizontalOutside / 0.28, verticalOutside / 0.32);
  if (outside <= 0) {
    const edge = Math.min(0.83 - Math.abs(plateX), plateZ - bottom, top - plateZ);
    return clamp(0.58 + edge * 0.65, 0.58, 0.94);
  }
  return clamp(0.46 * Math.exp(-1.75 * outside), 0.015, 0.46);
}

function updateAggregate(aggregate, row, columns) {
  const pitchType = String(row[columns.pitch_type] || 'UN');
  const pitcher = Number(row[columns.pitcher] || 0);
  const batter = Number(row[columns.batter] || 0);
  const top = String(row[columns.inning_topbot] || '') === 'Top';
  const battingTeam = top ? aggregate.game.awayTeamId : aggregate.game.homeTeamId;
  const fieldingTeam = top ? aggregate.game.homeTeamId : aggregate.game.awayTeamId;
  const runDelta = finite(row[columns.delta_run_exp], 0);
  if (pitcher) {
    const counts = nested(aggregate.pitchCounts, pitcher, () => ({ total: 0, byType: new Map() }));
    counts.total += 1;
    counts.byType.set(pitchType, (counts.byType.get(pitchType) || 0) + 1);
  }
  if (batter) {
    const byPitch = nested(aggregate.batterPitch, batter, () => new Map());
    const pitch = nested(byPitch, pitchType, () => ({ count: 0, runs: 0 }));
    pitch.count += 1;
    pitch.runs += runDelta;
  }
  const event = String(row[columns.events] || '');
  if (event && batter) {
    const batting = nested(aggregate.batters, batter, () => ({ teamId: battingTeam, pa: 0, runs: 0 }));
    batting.pa += 1;
    batting.runs += runDelta;
  }
  const estimatedWoba = finite(row[columns.estimated_woba_using_speedangle]);
  const actualWoba = finite(row[columns.woba_value]);
  if (event && estimatedWoba != null && actualWoba != null) {
    const fielding = nested(aggregate.teamFielding, fieldingTeam, () => ({ bip: 0, preventedWoba: 0 }));
    fielding.bip += 1;
    fielding.preventedWoba += estimatedWoba - actualWoba;
  }
  const description = String(row[columns.description] || '');
  if (description === 'called_strike' || description === 'ball') {
    const catcher = Number(row[columns.fielder_2] || 0);
    const residual = (description === 'called_strike' ? 1 : 0) - calledStrikeExpectation(row, columns);
    aggregate.umpireTaken.residual += residual;
    aggregate.umpireTaken.count += 1;
    if (catcher) {
      const catcherRow = nested(aggregate.catchers, catcher, () => ({ teamId: fieldingTeam, residual: 0, count: 0 }));
      catcherRow.residual += residual;
      catcherRow.count += 1;
    }
  }
}

async function readDay(path, games) {
  const byGame = new Map(games.map(game => [game.gamePk, newGameAggregate(game)]));
  const input = createReadStream(path).pipe(createGunzip());
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let columns = null;
  for await (const rawLine of lines) {
    const line = rawLine.replace(/^\uFEFF/, '');
    const row = parseCsvLine(line);
    if (!columns) {
      columns = Object.fromEntries(row.map((name, index) => [name, index]));
      continue;
    }
    const gamePk = Number(row[columns.game_pk] || 0);
    const aggregate = byGame.get(gamePk);
    if (aggregate) updateAggregate(aggregate, row, columns);
  }
  return byGame;
}

function playerState(map, id) {
  return nested(map, id, () => ({ pitchTotal: 0, pitches: new Map(), battingPitches: new Map(), pa: 0, battingRuns: 0, lastSeason: null, lastTeamGame: 0 }));
}

function decayPlayer(player, season) {
  if (player.lastSeason == null || player.lastSeason === season) { player.lastSeason = season; return; }
  player.pitchTotal *= 0.35;
  for (const [key, value] of player.pitches) player.pitches.set(key, value * 0.35);
  for (const value of player.battingPitches.values()) { value.count *= 0.35; value.runs *= 0.35; }
  player.pa *= 0.35;
  player.battingRuns *= 0.35;
  player.lastSeason = season;
}

function initialState() {
  return {
    leagueScores: [], homeMargins: [],
    teamScores: new Map(), teamGames: new Map(), teamFielding: new Map(), teamBatters: new Map(), teamCatchers: new Map(),
    players: new Map(), umpires: new Map(), leaguePitch: new Map(),
  };
}

function baselineForGame(game, state) {
  const league = state.leagueScores.length >= 200 ? mean(state.leagueScores) : 4.45;
  const homeEdge = state.homeMargins.length >= 200 ? clamp(mean(state.homeMargins) / 2, -0.05, 0.32) : 0.12;
  const side = (teamId, opponentId, home) => {
    const team = state.teamScores.get(teamId) || { scored: [], allowed: [] };
    const opponent = state.teamScores.get(opponentId) || { scored: [], allowed: [] };
    const offenseSample = team.scored.slice(-60);
    const defenseSample = opponent.allowed.slice(-60);
    const offenseWeight = offenseSample.length / (offenseSample.length + 30);
    const defenseWeight = defenseSample.length / (defenseSample.length + 45);
    const offense = offenseSample.length ? mean(offenseSample) : league;
    const defense = defenseSample.length ? mean(defenseSample) : league;
    return clamp(league + (offense - league) * offenseWeight + (defense - league) * defenseWeight + (home ? homeEdge : -homeEdge), 2.6, 6.6);
  };
  return { away: side(game.awayTeamId, game.homeTeamId, false), home: side(game.homeTeamId, game.awayTeamId, true), league };
}

function fieldingFeature(teamId, state) {
  const sample = state.teamFielding.get(teamId) || { bip: 0, preventedWoba: 0 };
  const weight = sample.bip / (sample.bip + 650);
  const runsPrevented = sample.bip ? sample.preventedWoba / sample.bip * 25 / 1.15 * weight : 0;
  return { raw: sample.bip ? sample.preventedWoba / sample.bip : 0, regressed: runsPrevented, sample: sample.bip, available: sample.bip >= 250 };
}

function projectedBatters(teamId, state) {
  const roster = state.teamBatters.get(teamId) || new Map();
  const teamGame = state.teamGames.get(teamId) || 0;
  return [...roster.entries()]
    .map(([id, row]) => ({ id, ...row, gap: Math.max(0, teamGame - row.lastTeamGame) }))
    .filter(row => row.pa >= 12 && row.gap <= 12)
    .sort((left, right) => (right.pa * Math.exp(-right.gap / 5)) - (left.pa * Math.exp(-left.gap / 5)))
    .slice(0, 13);
}

function injuryFeature(teamId, state) {
  const batters = projectedBatters(teamId, state).sort((left, right) => right.pa - left.pa).slice(0, 9);
  if (batters.length < 7) return { raw: 0, regressed: 0, sample: batters.length, available: false };
  let loss = 0;
  let missing = 0;
  for (const batter of batters) {
    if (batter.gap < 2) continue;
    const rate = batter.pa ? batter.runs / batter.pa : 0;
    const absenceProbability = clamp((batter.gap - 1) / 5, 0.2, 0.92);
    const aboveReplacement = Math.max(0, rate + 0.035);
    loss += aboveReplacement * 4.2 * absenceProbability;
    missing += 1;
  }
  return { raw: loss, regressed: -loss, sample: batters.reduce((sum, row) => sum + row.pa, 0), projectedMissing: missing, available: true, proxyOnly: true };
}

function pitchMatchupFeature(teamId, pitcherId, state) {
  const pitcher = state.players.get(Number(pitcherId || 0));
  const batters = projectedBatters(teamId, state).slice(0, 9);
  if (!pitcher || pitcher.pitchTotal < 180 || batters.length < 7) return { raw: 0, regressed: 0, sample: pitcher?.pitchTotal || 0, available: false };
  let centered = 0;
  let coverage = 0;
  for (const [pitchType, count] of pitcher.pitches) {
    const usage = count / pitcher.pitchTotal;
    if (usage < 0.03) continue;
    let batterRuns = 0;
    let batterPitches = 0;
    for (const batter of batters) {
      const value = state.players.get(batter.id)?.battingPitches?.get(pitchType);
      if (!value) continue;
      batterRuns += value.runs;
      batterPitches += value.count;
    }
    const league = state.leaguePitch.get(pitchType) || { runs: 0, count: 0 };
    if (batterPitches < 80 || league.count < 1000) continue;
    const shrink = batterPitches / (batterPitches + 900);
    centered += usage * ((batterRuns / batterPitches) - (league.runs / league.count)) * shrink;
    coverage += usage;
  }
  const runDelta = centered * 95;
  return { raw: centered * 100, regressed: runDelta, sample: pitcher.pitchTotal, lineupCoverage: batters.length / 9, pitchMixCoverage: coverage, available: coverage >= 0.55 };
}

function zoneFeature(defenseTeamId, umpireId, season, state) {
  const catchers = state.teamCatchers.get(defenseTeamId) || new Map();
  const teamGame = state.teamGames.get(defenseTeamId) || 0;
  const catcher = [...catchers.entries()]
    .filter(([, row]) => teamGame - row.lastTeamGame <= 12)
    .sort((left, right) => right[1].count - left[1].count)[0];
  const umpire = state.umpires.get(Number(umpireId || 0));
  const catcherWeight = catcher ? catcher[1].count / (catcher[1].count + 1200) : 0;
  // 2026 ABS challenge rules change the umpire regime; historical umpire residual is intentionally neutral.
  const umpireWeight = season >= 2026 ? 0 : (umpire ? umpire.count / (umpire.count + 2200) : 0);
  const catcherResidual = catcher ? catcher[1].residual / catcher[1].count * catcherWeight : 0;
  const umpireResidual = umpire && umpireWeight ? umpire.residual / umpire.count * umpireWeight : 0;
  const runsPrevented = (catcherResidual + umpireResidual) * 62 * 0.125;
  return {
    raw: catcherResidual + umpireResidual,
    regressed: -runsPrevented,
    catcherSample: catcher?.[1]?.count || 0,
    umpireSample: umpire?.count || 0,
    available: Boolean(catcher && catcher[1].count >= 300 && (season >= 2026 || (umpire && umpire.count >= 500))),
    abs2026UmpireNeutral: season >= 2026,
  };
}

function featuresForGame(game, state) {
  const awayDefense = fieldingFeature(game.homeTeamId, state);
  const homeDefense = fieldingFeature(game.awayTeamId, state);
  const awayInjury = injuryFeature(game.awayTeamId, state);
  const homeInjury = injuryFeature(game.homeTeamId, state);
  const awayPitch = pitchMatchupFeature(game.awayTeamId, game.homeProbablePitcherId, state);
  const homePitch = pitchMatchupFeature(game.homeTeamId, game.awayProbablePitcherId, state);
  const awayZone = zoneFeature(game.homeTeamId, game.umpireId, game.season, state);
  const homeZone = zoneFeature(game.awayTeamId, game.umpireId, game.season, state);
  const wind = buildHistoricalWindFeatureV2(game?.weather);
  return {
    away: { fielding: { ...awayDefense, regressed: -awayDefense.regressed }, injury: awayInjury, pitchMatchup: awayPitch, catcherUmpireZone: awayZone, windOrientation: wind },
    home: { fielding: { ...homeDefense, regressed: -homeDefense.regressed }, injury: homeInjury, pitchMatchup: homePitch, catcherUmpireZone: homeZone, windOrientation: wind },
  };
}

function updateState(game, aggregate, state) {
  const season = game.season;
  for (const teamId of [game.awayTeamId, game.homeTeamId]) {
    const roster = state.teamBatters.get(teamId);
    if (roster) for (const row of roster.values()) { row.pa *= 0.985; row.runs *= 0.985; }
    const catchers = state.teamCatchers.get(teamId);
    if (catchers) for (const row of catchers.values()) { row.count *= 0.985; row.residual *= 0.985; }
    const fielding = state.teamFielding.get(teamId);
    if (fielding) { fielding.bip *= 0.985; fielding.preventedWoba *= 0.985; }
    state.teamGames.set(teamId, (state.teamGames.get(teamId) || 0) + 1);
  }
  if (game.awayRuns != null && game.homeRuns != null && finalStatuses.has(game.status)) {
    boundedPush(state.leagueScores, game.awayRuns, 3000);
    boundedPush(state.leagueScores, game.homeRuns, 3000);
    boundedPush(state.homeMargins, game.homeRuns - game.awayRuns, 1500);
    const away = nested(state.teamScores, game.awayTeamId, () => ({ scored: [], allowed: [] }));
    const home = nested(state.teamScores, game.homeTeamId, () => ({ scored: [], allowed: [] }));
    boundedPush(away.scored, game.awayRuns, 80); boundedPush(away.allowed, game.homeRuns, 80);
    boundedPush(home.scored, game.homeRuns, 80); boundedPush(home.allowed, game.awayRuns, 80);
  }
  for (const [pitcherId, counts] of aggregate.pitchCounts) {
    const player = playerState(state.players, pitcherId); decayPlayer(player, season);
    player.pitchTotal += counts.total;
    for (const [pitchType, count] of counts.byType) player.pitches.set(pitchType, (player.pitches.get(pitchType) || 0) + count);
  }
  for (const [batterId, values] of aggregate.batterPitch) {
    const player = playerState(state.players, batterId); decayPlayer(player, season);
    for (const [pitchType, value] of values) {
      const target = nested(player.battingPitches, pitchType, () => ({ count: 0, runs: 0 }));
      target.count += value.count; target.runs += value.runs;
      const league = nested(state.leaguePitch, pitchType, () => ({ count: 0, runs: 0 }));
      league.count += value.count; league.runs += value.runs;
    }
  }
  for (const [batterId, batting] of aggregate.batters) {
    const player = playerState(state.players, batterId); decayPlayer(player, season);
    player.pa += batting.pa; player.battingRuns += batting.runs;
    const roster = nested(state.teamBatters, batting.teamId, () => new Map());
    const teamGame = state.teamGames.get(batting.teamId) || 0;
    const row = nested(roster, batterId, () => ({ pa: 0, runs: 0, lastTeamGame: teamGame }));
    row.pa += batting.pa; row.runs += batting.runs; row.lastTeamGame = teamGame;
  }
  for (const [teamId, fielding] of aggregate.teamFielding) {
    const row = nested(state.teamFielding, teamId, () => ({ bip: 0, preventedWoba: 0 }));
    row.bip += fielding.bip; row.preventedWoba += fielding.preventedWoba;
  }
  for (const [catcherId, catcher] of aggregate.catchers) {
    const team = nested(state.teamCatchers, catcher.teamId, () => new Map());
    const row = nested(team, catcherId, () => ({ residual: 0, count: 0, lastTeamGame: 0 }));
    row.residual += catcher.residual; row.count += catcher.count; row.lastTeamGame = state.teamGames.get(catcher.teamId) || 0;
  }
  if (game.umpireId && aggregate.umpireTaken.count) {
    const umpire = nested(state.umpires, game.umpireId, () => ({ residual: 0, count: 0 }));
    umpire.residual += aggregate.umpireTaken.residual; umpire.count += aggregate.umpireTaken.count;
  }
}

function solveRidge(samples, names, lambda = 18) {
  const size = names.length;
  const matrix = Array.from({ length: size }, () => Array(size).fill(0));
  const vector = Array(size).fill(0);
  for (const sample of samples) {
    for (let row = 0; row < size; row += 1) {
      const x = finite(sample.features[names[row]], 0);
      vector[row] += x * sample.residual;
      for (let column = 0; column < size; column += 1) matrix[row][column] += x * finite(sample.features[names[column]], 0);
    }
  }
  for (let index = 0; index < size; index += 1) matrix[index][index] += lambda;
  for (let pivot = 0; pivot < size; pivot += 1) {
    let best = pivot;
    for (let row = pivot + 1; row < size; row += 1) if (Math.abs(matrix[row][pivot]) > Math.abs(matrix[best][pivot])) best = row;
    [matrix[pivot], matrix[best]] = [matrix[best], matrix[pivot]];
    [vector[pivot], vector[best]] = [vector[best], vector[pivot]];
    const divisor = matrix[pivot][pivot] || 1e-12;
    for (let column = pivot; column < size; column += 1) matrix[pivot][column] /= divisor;
    vector[pivot] /= divisor;
    for (let row = 0; row < size; row += 1) {
      if (row === pivot) continue;
      const factor = matrix[row][pivot];
      for (let column = pivot; column < size; column += 1) matrix[row][column] -= factor * matrix[pivot][column];
      vector[row] -= factor * vector[pivot];
    }
  }
  return Object.fromEntries(names.map((name, index) => [name, vector[index]]));
}

function sideSamples(rows, throughSeason) {
  return rows.filter(row => row.season <= throughSeason).flatMap(row => ['away', 'home'].map(side => ({
    residual: row.actual[side] - row.baseline[side],
    features: Object.fromEntries(featureNames.map(name => [name, row.features[side][name].available ? row.features[side][name].regressed : 0])),
  })));
}

function applyCoefficients(row, coefficients, onlyFeature = null) {
  const candidate = {};
  for (const side of ['away', 'home']) {
    let delta = 0;
    for (const name of featureNames) {
      if (onlyFeature && name !== onlyFeature) continue;
      const feature = row.features[side][name];
      if (feature.available) delta += finite(coefficients[name], 0) * finite(feature.regressed, 0);
    }
    candidate[side] = Math.max(0.05, row.baseline[side] + delta);
  }
  return candidate;
}

const indexLines = (await readFile(indexPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
const games = indexLines.filter(game => finalStatuses.has(game.status) && game.awayRuns != null && game.homeRuns != null && game.statcastFile);
const byDate = new Map();
for (const game of games) nested(byDate, game.officialDate, () => []).push(game);
const dates = [...byDate.keys()].sort();
const state = initialState();
const reconstructed = [];
await mkdir(outputRoot, { recursive: true });

for (let dateIndex = 0; dateIndex < dates.length; dateIndex += 1) {
  const date = dates[dateIndex];
  const dayGames = byDate.get(date);
  const file = `${root}/${dayGames[0].statcastFile}`;
  const aggregates = await readDay(file, dayGames);
  for (const game of dayGames) {
    const baseline = baselineForGame(game, state);
    const features = featuresForGame(game, state);
    const observedAt = new Date(Math.min(Date.parse(game.gameStart) - 1, Date.parse(`${date}T00:00:00Z`) - 1)).toISOString();
    reconstructed.push({
      observationId: `mlb-${game.gamePk}`,
      gamePk: game.gamePk,
      gameStart: game.gameStart,
      officialDate: game.officialDate,
      season: game.season,
      coefficientTrainedThrough: game.season - 1,
      featureObservedAts: Object.fromEntries(featureNames.map(name => [name, observedAt])),
      provenance: {
        reconstructedThrough: previousDate(date),
        statcastSource: game.statcastFile,
        scheduleSource: `schedule/${game.season}.json.gz`,
        actualLineupUsedForPrediction: false,
        sameDayResultsUsedForPrediction: false,
        weatherSource: 'MLB_STATSAPI_SCHEDULE_WEATHER_ARCHIVE_RECONSTRUCTED',
        injurySource: 'TRAILING_ROSTER_AVAILABILITY_PROXY_NOT_OFFICIAL_IL',
      },
      baseline: { away: baseline.away, home: baseline.home },
      actual: { away: game.awayRuns, home: game.homeRuns },
      features,
    });
  }
  for (const game of dayGames) updateState(game, aggregates.get(game.gamePk) || newGameAggregate(game), state);
  if ((dateIndex + 1) % 50 === 0 || dateIndex + 1 === dates.length) process.stdout.write(`RECONSTRUCT ${dateIndex + 1}/${dates.length} ${date} games=${reconstructed.length}\n`);
}

const validationRows = [];
const coefficientsByFold = {};
for (const validationSeason of [2022, 2023, 2024, 2025, 2026]) {
  const trainedThrough = validationSeason - 1;
  const coefficients = solveRidge(sideSamples(reconstructed, trainedThrough), featureNames);
  coefficientsByFold[validationSeason] = coefficients;
  for (const row of reconstructed.filter(value => value.season === validationSeason)) {
    const candidate = applyCoefficients(row, coefficients);
    validationRows.push({
      observationId: row.observationId,
      gameStart: row.gameStart,
      coefficientTrainedThrough: trainedThrough,
      featureObservedAts: row.featureObservedAts,
      actualAway: row.actual.away, actualHome: row.actual.home,
      baselineAway: row.baseline.away, baselineHome: row.baseline.home,
      candidateAway: candidate.away, candidateHome: candidate.home,
    });
  }
}

const oos = buildAdvancedOosValidationV2(validationRows.filter(row => Number(row.gameStart.slice(0, 4)) <= 2025));
const familyOos = {};
for (const name of featureNames) {
  const rows = [];
  for (const validationSeason of [2022, 2023, 2024, 2025]) {
    const coefficients = coefficientsByFold[validationSeason];
    for (const row of reconstructed.filter(value => value.season === validationSeason)) {
      const candidate = applyCoefficients(row, coefficients, name);
      rows.push({
        observationId: `${row.observationId}-${name}`, gameStart: row.gameStart, coefficientTrainedThrough: validationSeason - 1,
        featureObservedAts: row.featureObservedAts,
        actualAway: row.actual.away, actualHome: row.actual.home,
        baselineAway: row.baseline.away, baselineHome: row.baseline.home,
        candidateAway: candidate.away, candidateHome: candidate.home,
      });
    }
  }
  familyOos[name] = buildAdvancedOosValidationV2(rows);
}
const shadow2026 = buildAdvancedOosValidationV2(validationRows.filter(row => Number(row.gameStart.slice(0, 4)) === 2026), { minimumGamesPerSeason: 200, requiredSeasons: [2026] });
const familyDecisions = Object.fromEntries(featureNames.map(name => {
  if (name === 'windOrientation' && !familyOos[name].eligibleForManualPromotion) return [name, { decision: 'DIAGNOSTIC_ONLY', reason: 'OOS_FOLD_CRITERIA_NOT_MET' }];
  if (name === 'injury') return [name, { decision: 'DIAGNOSTIC_PROXY_ONLY', reason: 'TRAILING_AVAILABILITY_IS_NOT_OFFICIAL_POINT_IN_TIME_IL_DATA', oosEligible: familyOos[name].eligibleForManualPromotion }];
  return [name, { decision: familyOos[name].eligibleForManualPromotion ? 'ELIGIBLE_FOR_MANUAL_PROMOTION' : 'DIAGNOSTIC_ONLY', reason: familyOos[name].eligibleForManualPromotion ? 'ALL_OOS_FOLDS_PASSED' : 'OOS_FOLD_CRITERIA_NOT_MET' }];
}));

const featurePayload = reconstructed.map(row => `${JSON.stringify(row)}\n`).join('');
const featureGzip = `${outputRoot}/pit-feature-rows.jsonl.gz`;
const featureTemporary = `${featureGzip}.${process.pid}.tmp`;
await pipeline(Readable.from([featurePayload]), createGzip({ level: 9 }), createWriteStream(featureTemporary));
await rename(featureTemporary, featureGzip);
const featureHash = sha256(featurePayload);
const artifact = {
  version: VERSION,
  createdAt: new Date().toISOString(),
  sourceIndex: indexPath,
  sourceIndexSha256: sha256(await readFile(indexPath)),
  featureRows: reconstructed.length,
  seasons: Object.fromEntries([...new Set(reconstructed.map(row => row.season))].map(season => [season, reconstructed.filter(row => row.season === season).length])),
  coefficientsByFold,
  oos2022Through2025: oos,
  featureFamilyOos: familyOos,
  shadow2026,
  featureFamilyDecisions: familyDecisions,
  activation: { automatic: false, productionAppliedValuesRemainNeutral: true },
  featureRowsSha256: featureHash,
};
artifact.artifactHash = sha256(JSON.stringify(artifact));
await writeFile(`${outputRoot}/validation-artifact.json`, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(JSON.stringify({ version: VERSION, featureRows: reconstructed.length, artifactHash: artifact.artifactHash, decisions: familyDecisions, oosEligible: oos.eligibleForManualPromotion, shadow2026Eligible: shadow2026.eligibleForManualPromotion }, null, 2));
