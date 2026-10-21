import { normalizeGame } from './data.js';
import { ESPN_NBA_TEAMS } from './identity.js';

// Research-only retrospective results. These sources never prove historical
// pregame availability, official NBA verification, odds, injuries or starters.
export const OPENING_ACQUISITION_VERSION = 'nba-opening-history-acquisition-v1';
export const OPENING_ARCHIVE_SOURCE_ROLE = 'ESPN_secondary_scoreboard_quarters_crosschecked_against_all_30_team_schedules_not_historical_pregame_capture';
const equalFields = ['gameId', 'date', 'startTime', 'year', 'seasonType', 'homeId', 'awayId', 'homeScore', 'awayScore', 'neutralSite'];
const check = (ok, message) => { if (!ok) throw Error(message); };

export function nbaScoreboardDate(startTime) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(startTime));
  return ['year', 'month', 'day'].map(type => parts.find(p => p.type === type)?.value).join('-');
}

export function parseResearchTeamSchedule(body, year, team) {
  check(String(body.team?.id) === String(team) && body.requestedSeason?.year === year && body.requestedSeason?.type === 2 && Array.isArray(body.events) && body.events.length < 1000, `Schedule scope/truncation mismatch ${year}/${team}`);
  const rows = [], excluded = [], seen = new Set();
  for (const event of body.events) {
    const game = normalizeGame(event, body.requestedSeason);
    check(game.season.year === year && game.seasonType === 'regular', `Schedule season mismatch ${event.id}`);
    check([game.home.sourceId, game.away.sourceId].includes(String(team)), `Schedule team mismatch ${event.id}`);
    check(ESPN_NBA_TEAMS[game.home.sourceId] && ESPN_NBA_TEAMS[game.away.sourceId], `Non-NBA schedule opponent ${event.id}`);
    check(!seen.has(game.id), `Duplicate game in team schedule ${game.id}`); seen.add(game.id);
    if (!game.completed) { excluded.push({ gameId: game.id, year, date: game.taipeiDate, reason: `not_completed:${game.status}`, team: String(team) }); continue; }
    rows.push({ gameId: game.id, date: game.taipeiDate, startTime: game.startTime, year, seasonType: 'regular', homeId: game.home.id, awayId: game.away.id, homeScore: game.home.score, awayScore: game.away.score, neutralSite: game.neutralSite });
  }
  check(rows.length > 0, `Empty completed team schedule ${year}/${team}`);
  return { rows, excluded };
}

export function researchScheduleOracle(records, years) {
  const expected = new Map(), scheduleTeams = new Map(), occurrences = new Map(), excluded = [];
  for (const record of records) {
    check(years.includes(record.year), `Unexpected schedule year ${record.year}`);
    const teams = scheduleTeams.get(record.year) ?? new Set();
    check(!teams.has(String(record.team)), `Duplicate schedule source ${record.year}/${record.team}`);
    teams.add(String(record.team)); scheduleTeams.set(record.year, teams);
    const parsed = parseResearchTeamSchedule(record.body, record.year, record.team);
    excluded.push(...parsed.excluded);
    for (const row of parsed.rows) {
      const prior = expected.get(row.gameId);
      check(!prior || equalFields.every(key => prior[key] === row[key]), `Conflicting schedule result ${row.gameId}`);
      expected.set(row.gameId, row);
      const seen = occurrences.get(row.gameId) ?? new Set(); seen.add(String(record.team)); occurrences.set(row.gameId, seen);
    }
  }
  for (const year of years) check(scheduleTeams.get(year)?.size === 30, `Incomplete 30-team schedule coverage ${year}`);
  for (const row of expected.values()) {
    const teams = occurrences.get(row.gameId);
    check(teams?.size === 2 && teams.has(row.homeId.split(':').at(-1)) && teams.has(row.awayId.split(':').at(-1)), `Game absent from both team schedules ${row.gameId}`);
  }
  // Calendar is derived from actual completed source events, not guessed season
  // start/end dates or a fixed 82-game assumption (COVID seasons differ).
  const days = [...new Set([...expected.values()].map(row => nbaScoreboardDate(row.startTime)))].sort();
  return { expected, days, excluded, scheduleTeams };
}

export function validatedResearchScoreboard(body, expected, sourceHash) {
  check(body.leagues?.length === 1 && body.leagues[0].id === '46' && Array.isArray(body.events) && body.events.length < 1000, 'Scoreboard league/schema/truncation mismatch');
  check(/^[a-f0-9]{64}$/.test(sourceHash), 'Invalid scoreboard checkpoint hash');
  const rows = [], seen = new Set();
  for (const event of body.events) {
    const gameId = `nba:espn:game:${event.id}`, archived = expected.get(gameId);
    if (!archived) continue;
    check(!seen.has(gameId), `Duplicate scoreboard game ${gameId}`); seen.add(gameId);
    check(event.uid === `s:40~l:46~e:${event.id}`, `Scoreboard UID mismatch ${gameId}`);
    const game = normalizeGame(event);
    check(game.completed, `Unfinished scoreboard result ${gameId}`);
    const row = { gameId: game.id, date: game.taipeiDate, startTime: game.startTime, year: game.season.year, seasonType: game.seasonType, homeId: game.home.id, awayId: game.away.id, homeScore: game.home.score, awayScore: game.away.score, neutralSite: game.neutralSite };
    check(equalFields.every(key => row[key] === archived[key]), `Schedule/scoreboard identity mismatch ${gameId}`);
    for (const side of ['home', 'away']) {
      const raw = event.competitions[0].competitors.find(value => value.homeAway === side)?.linescores;
      check(Array.isArray(raw) && raw.length >= 4 && raw.every((value, index) => value.period === index + 1 && Number.isSafeInteger(value.value) && value.value >= 0), `Missing/invalid quarter scores ${gameId}/${side}`);
      check(raw.reduce((sum, value) => sum + value.value, 0) === row[`${side}Score`], `Quarter checksum mismatch ${gameId}/${side}`);
      row[`${side}Half`] = raw[0].value + raw[1].value;
    }
    rows.push({ ...row, checkpointSha256: sourceHash });
  }
  return rows;
}

export function researchArchiveCoverage(oracle, history, years) {
  const unique = new Set(history.map(row => row.gameId));
  check(unique.size === history.length, 'Duplicate archive game');
  check(history.every(row => oracle.expected.has(row.gameId)), 'Unexpected archive game');
  for (const row of history) {
    const expected = oracle.expected.get(row.gameId);
    check(equalFields.every(key => row[key] === expected[key]), `Archive identity mismatch ${row.gameId}`);
    check(['home', 'away'].every(side => Number.isSafeInteger(row[`${side}Half`]) && row[`${side}Half`] >= 0 && row[`${side}Half`] <= row[`${side}Score`]) && /^[a-f0-9]{64}$/.test(row.checkpointSha256), `Unverified archive quarters ${row.gameId}`);
  }
  const missing = [...oracle.expected.keys()].filter(id => !unique.has(id));
  const byYear = Object.fromEntries(years.map(year => {
    const expected = [...oracle.expected.values()].filter(row => row.year === year), observed = history.filter(row => row.year === year);
    return [year, { expectedGames: expected.length, observedGames: observed.length, teamSchedulesChecked: oracle.scheduleTeams.get(year)?.size ?? 0, quarterCrosscheckedGames: observed.length, missingGames: expected.length - observed.length, firstSourceGameDate: expected.map(row => row.date).sort()[0] ?? null, lastSourceGameDate: expected.map(row => row.date).sort().at(-1) ?? null }];
  }));
  return { status: missing.length ? 'incomplete' : 'complete', calendarBasis: 'completed_event_dates_from_all_30_team_schedules_America_New_York_not_fixed_game_count', years: byYear, missing };
}
