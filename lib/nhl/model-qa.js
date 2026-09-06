import { createHash } from 'node:crypto';

// NHL-specific data and probability invariants. No baseball identity/model fallback.
export const NHL_MODEL_QA_VERSION = 'NHL-LINKED-PATH-QA-2026-09-v1';
export const NHL_PROBABILITY_TOLERANCE = 1e-10;

export function nhlModelError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, status: 422, details });
}

export function finiteNhlNumber(value) {
  if (!['number', 'string'].includes(typeof value) || (typeof value === 'string' && value.trim() === '')) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

export function nhlTimestamp(value) {
  if (typeof value !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function scorePair(value = {}) {
  return { away: finiteNhlNumber(value.away ?? value.awayGoals), home: finiteNhlNumber(value.home ?? value.homeGoals) };
}

function validScore(score) {
  return ['away', 'home'].every(side => Number.isSafeInteger(score?.[side]) && score[side] >= 0);
}

export function normalizeNhlModelGame(raw = {}) {
  const leagueId = String(raw.leagueId || raw.league || '').toUpperCase();
  const gameId = String(raw.gameId ?? raw.officialGameId ?? '').trim();
  const awayTeamId = String(raw.awayTeamId ?? raw.awayTeam?.id ?? '').trim();
  const homeTeamId = String(raw.homeTeamId ?? raw.homeTeam?.id ?? '').trim();
  const gameType = Number(raw.gameType);
  if (leagueId !== 'NHL' || !gameId || !awayTeamId || !homeTeamId || awayTeamId === homeTeamId || ![1, 2, 3].includes(gameType)) {
    throw nhlModelError('NHL_IDENTITY_INVALID', 'NHL history requires unique official game/team IDs and an explicit game type.', { gameId });
  }
  const start = nhlTimestamp(raw.startTimeUTC);
  if (start == null) throw nhlModelError('NHL_TIME_INVALID', 'NHL start time requires an explicit UTC offset.', { gameId });
  const startTimeUTC = new Date(start).toISOString();
  const periods = raw.periodScores ?? raw.periods;
  if (!Array.isArray(periods) || periods.length !== 3) {
    throw nhlModelError('NHL_PERIOD_DATA_MISSING', 'Three observed regulation periods are required; final goals cannot be split into invented periods.', { gameId });
  }
  const periodScores = periods.map((period, index) => ({ period: period.period ?? index + 1, ...scorePair(period) }));
  const regulation = scorePair(raw.regulation);
  const final = scorePair(raw.final);
  const outcomeType = String(raw.outcomeType || (raw.outcome?.shootout ? 'SO' : raw.outcome?.overtime ? 'OT' : raw.outcome?.winner ? 'REG' : '')).toUpperCase();
  if (!['REG', 'OT', 'SO'].includes(outcomeType)) throw nhlModelError('NHL_OUTCOME_TYPE_MISSING', 'Observed REG/OT/SO outcome is required.', { gameId });
  const winner = final.away > final.home ? 'away' : final.home > final.away ? 'home' : null;
  const path = {
    probability: 1,
    sourceGameId: gameId,
    periodScores,
    regulation,
    final,
    outcome: { winner, overtime: outcomeType === 'OT' || outcomeType === 'SO', shootout: outcomeType === 'SO' },
  };
  const audit = validateNhlPath(path, { gameType });
  if (!audit.passed) throw nhlModelError('NHL_RESULT_PATH_INVALID', audit.errors.join('; '), { gameId });
  const outcomeAvailableAt = raw.outcomeAvailableAt ?? raw.finishedAt ?? raw.source?.fetchedAt ?? null;
  const outcomeTimestamp = nhlTimestamp(outcomeAvailableAt);
  if (outcomeAvailableAt != null && (outcomeTimestamp == null || outcomeTimestamp < start)) {
    throw nhlModelError('NHL_OUTCOME_TIME_INVALID', 'Outcome availability must be a valid timestamp after game start.', { gameId });
  }
  const sourceUrl = typeof raw.source?.url === 'string' ? raw.source.url : '';
  const synthetic = raw.synthetic === true || raw.sourceType === 'SYNTHETIC_FIXTURE' || sourceUrl.startsWith('fixture://');
  const sourceKind = synthetic ? 'SYNTHETIC_FIXTURE'
    : raw.source?.provider === 'NHL' && /^https:\/\/(api-web\.nhle\.com|api\.nhl\.com|www\.nhl\.com)\//.test(sourceUrl) ? 'OFFICIAL_NHL_RECORD'
      : raw.source?.provider && /^https:\/\//.test(sourceUrl) ? 'EXTERNAL_SOURCED_RECORD' : 'UNVERIFIED_RECORD';
  return {
    gameId, leagueId, season: String(raw.season ?? ''), gameType, startTimeUTC, awayTeamId, homeTeamId,
    outcomeAvailableAt, outcomeAvailabilityVerified: outcomeTimestamp != null,
    source: raw.source == null ? null : structuredClone(raw.source), sourceType: raw.sourceType ?? null, sourceKind, synthetic,
    features: raw.features && typeof raw.features === 'object' ? structuredClone(raw.features) : {},
    featureAvailableAt: raw.featureAvailableAt ?? null,
    path,
  };
}

export function validateNhlPath(path, { gameType = 2 } = {}) {
  const errors = [];
  if (!Array.isArray(path?.periodScores) || path.periodScores.length !== 3) errors.push('Exactly three regulation periods are required');
  else {
    path.periodScores.forEach((score, index) => {
      if (score.period !== index + 1 || !validScore(score)) errors.push(`Invalid regulation period ${index + 1}`);
    });
  }
  if (!validScore(path?.regulation) || !validScore(path?.final)) errors.push('Goals must be finite non-negative integers');
  if (!errors.length) {
    for (const side of ['away', 'home']) {
      if (path.periodScores.reduce((sum, period) => sum + period[side], 0) !== path.regulation[side]) errors.push(`${side} regulation total disagrees with periods`);
    }
    const tied = path.regulation.away === path.regulation.home;
    const extraTime = path.outcome?.overtime === true;
    const shootout = path.outcome?.shootout === true;
    if (typeof path.outcome?.overtime !== 'boolean' || typeof path.outcome?.shootout !== 'boolean') errors.push('Explicit overtime and shootout flags are required');
    if (tied !== extraTime) errors.push('Only a regulation tie may enter overtime/shootout');
    if (shootout && (!extraTime || gameType === 3)) errors.push('Invalid shootout path for game type');
    const winner = path.final.away > path.final.home ? 'away' : path.final.home > path.final.away ? 'home' : null;
    if (!winner || path.outcome?.winner !== winner) errors.push('Final score must have one matching winner');
    for (const side of ['away', 'home']) {
      const expectedIncrement = extraTime && side === winner ? 1 : 0;
      if (path.final[side] !== path.regulation[side] + expectedIncrement) errors.push('OT sudden-death/SO awarded goal does not match the official final score');
    }
  }
  return { passed: errors.length === 0, errors, version: NHL_MODEL_QA_VERSION };
}

export function auditNhlDistribution(snapshot, { tolerance = NHL_PROBABILITY_TOLERANCE } = {}) {
  const errors = [];
  const warnings = [...(Array.isArray(snapshot?.diagnostics) ? snapshot.diagnostics : [])];
  if (snapshot?.leagueId !== 'NHL') errors.push('Distribution league is not NHL');
  const game = snapshot?.game || {};
  const gameLeague = game.leagueId ?? game.league;
  if (gameLeague !== 'NHL' || !game.gameId || !game.awayTeamId || !game.homeTeamId || String(game.awayTeamId) === String(game.homeTeamId)) errors.push('Distribution NHL game identity is invalid');
  if (![1, 2, 3].includes(game.gameType) || snapshot?.gameType !== game.gameType) errors.push('Distribution NHL game type is inconsistent');
  const asOf = nhlTimestamp(snapshot?.asOf);
  const start = nhlTimestamp(game.startTimeUTC);
  const trainingCutoff = nhlTimestamp(snapshot?.trainingCutoff);
  if (asOf == null || start == null || trainingCutoff == null || trainingCutoff > asOf || asOf > start) errors.push('Distribution time provenance is invalid');
  if (!snapshot?.modelArtifactId) errors.push('Distribution fitted artifact provenance is missing');
  const { distributionHash, distributionId, qa, ...content } = snapshot || {};
  const expectedHash = createHash('sha256').update(JSON.stringify(content)).digest('hex');
  if (distributionHash !== expectedHash || distributionId !== `nhl-${expectedHash.slice(0, 24)}`) errors.push('Distribution content hash or ID does not match its frozen payload');
  const scenarios = snapshot?.scenarios;
  if (!Array.isArray(scenarios) || !scenarios.length) errors.push('NHL model scenarios are missing');
  let scenarioMass = 0;
  let weightedPathMass = 0;
  for (const scenario of Array.isArray(scenarios) ? scenarios : []) {
    if (typeof scenario.weight !== 'number' || !Number.isFinite(scenario.weight) || scenario.weight < 0) errors.push('Invalid scenario weight');
    else scenarioMass += scenario.weight;
    let mass = 0;
    if (!Array.isArray(scenario.paths) || !scenario.paths.length) errors.push('Scenario has no linked paths');
    for (const path of Array.isArray(scenario.paths) ? scenario.paths : []) {
      if (typeof path.probability !== 'number' || !Number.isFinite(path.probability) || path.probability < 0) errors.push('Invalid path probability');
      else mass += path.probability;
      errors.push(...validateNhlPath(path, { gameType: snapshot?.gameType ?? snapshot?.game?.gameType ?? 2 }).errors);
    }
    if (Math.abs(mass - 1) > tolerance) errors.push(`Scenario ${scenario.id} probability mass is ${mass}`);
    weightedPathMass += mass * scenario.weight;
  }
  if (Math.abs(scenarioMass - 1) > tolerance) errors.push(`Scenario weights sum to ${scenarioMass}`);
  if (!Number.isFinite(weightedPathMass) || Math.abs(weightedPathMass - 1) > tolerance) errors.push('Mixture probability mass is not one');
  return {
    passed: errors.length === 0, status: errors.length ? 'BLOCK' : warnings.length ? 'WARNING' : 'PASS',
    errors: [...new Set(errors)], warnings: [...new Set(warnings)], scenarioMass, weightedPathMass,
    version: NHL_MODEL_QA_VERSION,
  };
}
