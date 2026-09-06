import { createHash } from 'node:crypto';

export const NHL_CONTEXT_VERSION = 'NHL-CONTEXT-PIT-v1';
const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const ratio = (numerator, denominator) => finite(numerator) != null && finite(denominator) != null && denominator > 0 ? numerator / denominator : null;
const iso = value => typeof value === 'string' && /(Z|[+-]\d{2}:\d{2})$/.test(value)
  && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const sourceUrl = value => { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; } };
const gameIdentity = game => game?.league === 'NHL' && /^\d{10}$/.test(String(game.gameId))
  && Number.isSafeInteger(game.awayTeamId) && game.awayTeamId > 0 && Number.isSafeInteger(game.homeTeamId)
  && game.homeTeamId > 0 && game.awayTeamId !== game.homeTeamId;
export const nhlContentHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function nhlMetric(value, source = null, reason = '來源尚未提供') {
  const number = finite(value);
  return { value: number, status: number == null ? 'MISSING' : 'OBSERVED', source, reason: number == null ? reason : null };
}

export function deriveNhlStatistics(raw = {}, source = null) {
  const errors = [];
  const invalid = new Set();
  const statisticalFields = new Set(['games', 'shots', 'shotsOnGoal', 'shotsOnGoalAgainst', 'goals', 'xG', 'xGF', 'xGA',
    'highDangerChances', 'highDangerXG', 'saves', 'powerPlayGoals', 'powerPlayOpportunities', 'powerPlayGoalsAgainst', 'timesShorthanded']);
  for (const [key, value] of Object.entries(raw)) {
    if (statisticalFields.has(key) && value != null && (finite(value) == null || value < 0)) { errors.push(`INVALID_STAT_${key}`); invalid.add(key); }
  }
  for (const [numerator, denominator] of [['saves', 'shotsOnGoalAgainst'], ['goals', 'shotsOnGoal'],
    ['powerPlayGoals', 'powerPlayOpportunities'], ['powerPlayGoalsAgainst', 'timesShorthanded']]) {
    if (finite(raw[numerator]) != null && finite(raw[denominator]) != null && raw[numerator] > raw[denominator]) {
      errors.push(`STAT_NUMERATOR_EXCEEDS_DENOMINATOR_${numerator}`); invalid.add(numerator);
    }
  }
  // Preserve raw evidence in QA. Invalid input is neither capped nor represented
  // as an observed statistic; the mathematical inconsistency stays visible.
  const original = raw;
  raw = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, invalid.has(key) ? null : value]));
  const xGF = finite(raw.xGF);
  const xGA = finite(raw.xGA);
  const saves = finite(raw.saves);
  const shotsAgainst = finite(raw.shotsOnGoalAgainst);
  const goals = finite(raw.goals);
  const shots = finite(raw.shotsOnGoal);
  const result = {
    scope: ['ALL', '5V5', 'PP', 'PK'].includes(raw.scope) ? raw.scope : 'UNKNOWN',
    games: nhlMetric(raw.games, source), shots: nhlMetric(raw.shots, source),
    shotsOnGoal: nhlMetric(shots, source), shotsOnGoalAgainst: nhlMetric(shotsAgainst, source),
    goals: nhlMetric(goals, source), xG: nhlMetric(raw.xG, source), xGF: nhlMetric(xGF, source), xGA: nhlMetric(xGA, source),
    xGFPercent: nhlMetric(xGF != null && xGA != null ? ratio(xGF, xGF + xGA) : null, source),
    highDangerChances: nhlMetric(raw.highDangerChances, source), highDangerXG: nhlMetric(raw.highDangerXG, source),
    savePercent: nhlMetric(ratio(saves, shotsAgainst), source), shootingPercent: nhlMetric(ratio(goals, shots), source),
    powerPlayPercent: nhlMetric(ratio(raw.powerPlayGoals, raw.powerPlayOpportunities), source),
    penaltyKillPercent: nhlMetric(finite(raw.powerPlayGoalsAgainst) != null && finite(raw.timesShorthanded) != null && raw.timesShorthanded > 0 ? 1 - raw.powerPlayGoalsAgainst / raw.timesShorthanded : null, source),
  };
  result.qa = { status: errors.length ? 'BLOCK' : result.scope === 'UNKNOWN' || Object.values(result).some(row => row?.status === 'MISSING') ? 'WARNING' : 'PASS', errors,
    warnings: result.scope === 'UNKNOWN' ? ['STAT_SCOPE_UNKNOWN'] : [],
    invalidInputs: Object.fromEntries([...invalid].map(key => [key, original[key]])) };
  return result;
}

// Only timestamped provider reports can confirm a goalie. A historical starter
// from the final boxscore is not pre-game confirmation.
export function validateNhlPersonnel(value, game, { asOf = new Date().toISOString() } = {}) {
  const errors = [];
  const warnings = [];
  if (!gameIdentity(game)) errors.push('NHL_GAME_IDENTITY_INVALID');
  if (!iso(asOf)) errors.push('PERSONNEL_AS_OF_INVALID');
  if (value?.players != null && !Array.isArray(value.players)) errors.push('PERSONNEL_PLAYERS_INVALID');
  const rows = Array.isArray(value?.players) ? value.players : [];
  const seen = new Set();
  for (const player of rows) {
    if (!Number.isSafeInteger(player?.playerId) || player.playerId <= 0 || ![game?.awayTeamId, game?.homeTeamId].includes(player?.teamId)
      || seen.has(player.playerId)) errors.push('PLAYER_IDENTITY_CONFLICT');
    seen.add(player?.playerId);
    if (!sourceUrl(player?.sourceUrl) || !iso(player?.sourcePublishedAt) || !iso(player?.observedAt)
      || Date.parse(player?.sourcePublishedAt) > Date.parse(player?.observedAt)
      || Date.parse(player?.sourcePublishedAt) > Date.parse(asOf) || Date.parse(player?.observedAt) > Date.parse(asOf)) errors.push('PERSONNEL_NOT_POINT_IN_TIME');
  }
  for (const side of ['away', 'home']) {
    const goalie = value?.goalies?.[side];
    if (!goalie || goalie.status === 'UNKNOWN') { warnings.push(`${side}:GOALIE_NOT_CONFIRMED`); continue; }
    if (!['PROJECTED', 'CONFIRMED'].includes(goalie.status) || goalie.teamId !== game?.[`${side}TeamId`]
      || !rows.some(player => player?.playerId === goalie.playerId && player?.teamId === goalie.teamId && player?.position === 'G')) errors.push('GOALIE_IDENTITY_CONFLICT');
    if (goalie.gameId != null && String(goalie.gameId) !== String(game?.gameId)) errors.push('GOALIE_GAME_IDENTITY_CONFLICT');
    if (goalie.status === 'CONFIRMED' && goalie.confirmationExplicit !== true) errors.push('GOALIE_CONFIRMATION_NOT_EXPLICIT');
    if (!sourceUrl(goalie.sourceUrl) || !iso(goalie.sourcePublishedAt) || !iso(goalie.observedAt)
      || Date.parse(goalie.sourcePublishedAt) > Date.parse(goalie.observedAt)
      || Date.parse(goalie.sourcePublishedAt) > Date.parse(asOf) || Date.parse(goalie.observedAt) > Date.parse(asOf)) errors.push('GOALIE_NOT_POINT_IN_TIME');
  }
  return { ok: errors.length === 0, status: errors.length ? 'BLOCK' : warnings.length ? 'WARNING' : 'PASS', errors: [...new Set(errors)], warnings, asOf };
}

export function goalieRevision(previous, incoming, game, { now = Date.now(), maxAgeMs = 15 * 60_000 } = {}) {
  const observed = iso(incoming?.observedAt);
  const published = iso(incoming?.sourcePublishedAt);
  const errors = [];
  if (!gameIdentity(game) || (incoming?.gameId != null && String(incoming.gameId) !== String(game?.gameId))) errors.push('GOALIE_GAME_IDENTITY_CONFLICT');
  if (!Number.isFinite(now) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) errors.push('GOALIE_CLOCK_INVALID');
  if (!['away', 'home'].includes(incoming?.side) || incoming?.teamId !== game?.[`${incoming?.side}TeamId`]
    || !Number.isSafeInteger(incoming?.playerId) || incoming.playerId <= 0) errors.push('GOALIE_IDENTITY_CONFLICT');
  if (!observed || !published || Date.parse(published) > Date.parse(observed) || Date.parse(observed) > now || !sourceUrl(incoming?.sourceUrl)) errors.push('GOALIE_SOURCE_INVALID');
  if (!['PROJECTED', 'CONFIRMED', 'WITHDRAWN'].includes(incoming?.status)) errors.push('GOALIE_STATUS_INVALID');
  if (incoming?.status === 'CONFIRMED' && incoming.confirmationExplicit !== true) errors.push('GOALIE_CONFIRMATION_NOT_EXPLICIT');
  if (previous && (String(previous.gameId) !== String(game?.gameId) || previous.side !== incoming?.side
    || previous.teamId !== incoming?.teamId || !iso(previous.sourcePublishedAt) || !iso(previous.observedAt))) errors.push('GOALIE_PREVIOUS_IDENTITY_INVALID');
  if (previous && (Date.parse(published) < Date.parse(previous.sourcePublishedAt)
    || Date.parse(observed) < Date.parse(previous.observedAt))) errors.push('GOALIE_REVISION_OUT_OF_ORDER');
  if (errors.length) return { ok: false, errors, current: previous || null, changed: false };
  const core = { gameId: String(game.gameId), side: incoming.side, playerId: incoming.playerId, teamId: incoming.teamId,
    status: incoming.status, confirmationExplicit: incoming.status === 'CONFIRMED' && incoming.confirmationExplicit === true,
    sourcePublishedAt: published, sourceUrl: incoming.sourceUrl };
  const revision = nhlContentHash(core);
  return { ok: true, errors: [], changed: Boolean(previous && previous.revision !== revision),
    playerChanged: Boolean(previous && previous.playerId !== incoming.playerId),
    current: { ...core, observedAt: observed, revision, previousRevision: previous?.revision || null,
      fresh: now - Date.parse(published) <= maxAgeMs, ageSeconds: Math.floor((now - Date.parse(published)) / 1000) } };
}

export function nhlScheduleContext(game, priorGames = [], { asOf = game?.startTimeUTC, scheduleCoverage = null, includeScheduled = false } = {}) {
  const cutoff = Date.parse(asOf);
  const start = Date.parse(game?.startTimeUTC);
  const errors = [];
  if (!gameIdentity(game) || !iso(asOf) || !iso(game?.startTimeUTC) || cutoff > start) errors.push('SCHEDULE_IDENTITY_OR_TIME_INVALID');
  if (!Array.isArray(priorGames)) errors.push('SCHEDULE_ROWS_INVALID');
  if (typeof includeScheduled !== 'boolean') errors.push('SCHEDULE_OPTIONS_INVALID');
  const completed = row => ['OFF', 'FINAL'].includes(row.status ?? row.gameState);
  const scheduled = row => ['FUT', 'PRE'].includes(row.status ?? row.gameState) && row.gameScheduleState === 'OK';
  const canceled = row => ['CANCELED', 'CANCELLED', 'CANC', 'PPD', 'POSTPONED', 'SUSP', 'SUSPENDED'].includes(row.status ?? row.gameState)
    || ['CANCELED', 'CANCELLED', 'CANC', 'PPD', 'POSTPONED', 'SUSP', 'SUSPENDED'].includes(row.gameScheduleState);
  const unique = new Map();
  for (const row of Array.isArray(priorGames) ? priorGames : []) {
    if (!gameIdentity(row) || !iso(row.startTimeUTC) || canceled(row)
      || !(completed(row) || (includeScheduled && scheduled(row)))) continue;
    const key = String(row.gameId);
    const previous = unique.get(key);
    if (previous && (previous.startTimeUTC !== row.startTimeUTC || previous.awayTeamId !== row.awayTeamId
      || previous.homeTeamId !== row.homeTeamId)) errors.push('SCHEDULE_DUPLICATE_IDENTITY_CONFLICT');
    // Repeated schedule pages can contain an old FUT copy and its final result.
    // A stale scheduled copy must not downgrade an observed completed game.
    else if (!previous || !completed(previous) || completed(row)) unique.set(key, row);
  }
  const calendarDay = date => {
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    const timestamp = Date.parse(`${date}T00:00:00Z`);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === date ? timestamp / 86400000 : null;
  };
  const targetDay = calendarDay(game?.northAmericaDate);
  const coveredFrom = calendarDay(scheduleCoverage?.from);
  const coveredTo = calendarDay(scheduleCoverage?.to);
  const hasCoverage = scheduleCoverage?.complete === true && coveredFrom != null && coveredTo != null
    && targetDay != null && coveredFrom <= coveredTo && coveredTo >= targetDay;
  const empty = () => ({ restDays: null, backToBack: null, gamesIn7Days: null,
    observedRestDays: null, observedBackToBack: null, observedGamesIn7Days: null, travelKm: null, source: null,
    estimated: false, estimatedFields: [], precedingGameId: null, precedingGameStatus: null });
  const forSide = side => {
    if (errors.length) return empty();
    const teamId = game?.[`${side}TeamId`];
    const games = [...unique.values()].filter(row => String(row.gameId) !== String(game.gameId)
      && [row.awayTeamId, row.homeTeamId].includes(teamId) && Date.parse(row.startTimeUTC) < start
      && (completed(row) ? Date.parse(row.startTimeUTC) < cutoff : true))
      .sort((a, b) => Date.parse(b.startTimeUTC) - Date.parse(a.startTimeUTC));
    const last = games[0];
    if (!last) return empty();
    const lastDay = calendarDay(last.northAmericaDate);
    const officialGap = targetDay != null && lastDay != null && targetDay >= lastDay ? targetDay - lastDay : null;
    const restCovered = hasCoverage && lastDay != null && coveredFrom <= lastDay;
    const densityCovered = hasCoverage && coveredFrom <= targetDay - 6;
    const a = last.venueCoordinates; const b = game.venueCoordinates;
    let travelKm = null;
    if (restCovered && [a?.latitude, a?.longitude, b?.latitude, b?.longitude].every(value => finite(value) != null)
      && Math.abs(a.latitude) <= 90 && Math.abs(b.latitude) <= 90 && Math.abs(a.longitude) <= 180 && Math.abs(b.longitude) <= 180) {
      const radians = degrees => degrees * Math.PI / 180;
      const dLat = radians(b.latitude - a.latitude); const dLon = radians(b.longitude - a.longitude);
      const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(dLon / 2) ** 2;
      travelKm = 6371 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
    }
    const inSevenDays = row => { const day = calendarDay(row.northAmericaDate); return day != null && targetDay != null && day >= targetDay - 6 && day <= targetDay; };
    const recent = games.filter(inSevenDays);
    const lastCompleted = games.find(completed);
    const lastCompletedDay = calendarDay(lastCompleted?.northAmericaDate);
    const observedGap = targetDay != null && lastCompletedDay != null && targetDay >= lastCompletedDay ? targetDay - lastCompletedDay : null;
    const observedRestDays = observedGap == null ? null : Math.max(0, observedGap - 1);
    const observedBackToBack = observedGap == null ? null : observedGap === 1;
    const observedGamesIn7Days = recent.filter(completed).length + 1;
    const estimatedFields = [];
    if (!completed(last)) {
      if (restCovered && officialGap != null) estimatedFields.push('restDays', 'backToBack');
      if (travelKm != null) estimatedFields.push('travelKm');
    }
    if (densityCovered && recent.some(row => !completed(row))) estimatedFields.push('gamesIn7Days');
    return { restDays: restCovered && officialGap != null ? Math.max(0, officialGap - 1) : null,
      backToBack: restCovered && officialGap != null ? officialGap === 1 : null,
      gamesIn7Days: densityCovered ? recent.length + 1 : null, observedRestDays, observedBackToBack, observedGamesIn7Days,
      estimated: !completed(last) || recent.some(row => !completed(row)), estimatedFields,
      precedingGameId: String(last.gameId), precedingGameStatus: last.status ?? last.gameState,
      travelKm, travelBasis: travelKm == null ? null : 'VENUE_TO_VENUE_GREAT_CIRCLE_NOT_ACTUAL_ITINERARY', source: last.source || null };
  };
  const away = forSide('away');
  const home = forSide('home');
  const estimated = away.estimated || home.estimated;
  const warnings = [
    ...(hasCoverage ? [] : ['SCHEDULE_COVERAGE_UNVERIFIED']),
    ...(estimated ? ['PROJECTED_SCHEDULE_CONTAINS_UNPLAYED_GAMES'] : []),
  ];
  return { league: 'NHL', gameId: game?.gameId ?? null, asOf,
    qa: { status: errors.length ? 'BLOCK' : warnings.length ? 'WARNING' : 'PASS', errors: [...new Set(errors)], warnings },
    scheduleCoverage, includeScheduled, estimated, away, home };
}
