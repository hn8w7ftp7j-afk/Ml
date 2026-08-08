import { roofNameZh, statusNameZh, teamNameZh, venueNameZh } from './i18n.js';

const MLB = 'https://statsapi.mlb.com/api';
const OPEN_METEO = 'https://api.open-meteo.com/v1/forecast';

const PARKS = {
  1:{lat:33.8003,lon:-117.8827,runFactor:1.00,roof:'open'},2:{lat:39.2839,lon:-76.6217,runFactor:1.02,roof:'open'},3:{lat:42.3467,lon:-71.0972,runFactor:1.04,roof:'open'},
  5:{lat:41.4962,lon:-81.6852,runFactor:0.98,roof:'open'},6:{lat:42.339,lon:-83.0485,runFactor:0.98,roof:'open'},7:{lat:39.0517,lon:-94.4803,runFactor:0.97,roof:'open'},
  8:{lat:40.8296,lon:-73.9262,runFactor:1.03,roof:'open'},10:{lat:47.5914,lon:-122.3325,runFactor:0.96,roof:'retractable'},12:{lat:32.7473,lon:-97.0848,runFactor:1.00,roof:'retractable'},
  13:{lat:43.6414,lon:-79.3894,runFactor:1.01,roof:'retractable'},14:{lat:44.9817,lon:-93.2776,runFactor:0.99,roof:'open'},15:{lat:25.7781,lon:-80.2197,runFactor:0.97,roof:'retractable'},
  16:{lat:33.8908,lon:-84.4678,runFactor:1.01,roof:'open'},17:{lat:41.9484,lon:-87.6553,runFactor:1.01,roof:'open'},18:{lat:39.0979,lon:-84.5082,runFactor:1.06,roof:'open'},
  19:{lat:34.1683,lon:-118.3259,runFactor:1.00,roof:'open'},20:{lat:34.0739,lon:-118.24,runFactor:0.98,roof:'open'},21:{lat:43.028,lon:-87.9712,runFactor:1.00,roof:'retractable'},
  22:{lat:40.7571,lon:-73.8458,runFactor:0.97,roof:'open'},23:{lat:39.9061,lon:-75.1665,runFactor:1.04,roof:'open'},24:{lat:40.4469,lon:-80.0057,runFactor:0.97,roof:'open'},
  25:{lat:32.7073,lon:-117.1573,runFactor:0.96,roof:'open'},26:{lat:37.7786,lon:-122.3893,runFactor:0.95,roof:'open'},27:{lat:38.6226,lon:-90.1928,runFactor:0.99,roof:'open'},
  28:{lat:39.7559,lon:-104.9942,runFactor:1.20,roof:'open'},29:{lat:33.4453,lon:-112.0667,runFactor:1.04,roof:'retractable'},30:{lat:38.873,lon:-77.0074,runFactor:1.00,roof:'open'},
  2394:{lat:38.5802,lon:-121.4997,runFactor:1.00,roof:'open'}
};

const cache = new Map();
const cacheGet = key => {
  const value = cache.get(key);
  return value && value.expires > Date.now() ? value.value : null;
};
const cacheSet = (key, value, ttl = 300000) => {
  cache.set(key, { value, expires: Date.now() + ttl });
  return value;
};
const safe = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

async function json(url, fallback = null, ttl = 300000) {
  const key = String(url);
  const hit = cacheGet(key);
  if (hit) return hit;
  try {
    const response = await fetch(url, { cache: 'no-store', headers: { 'User-Agent': 'MLB-Positive-EV/6.0' } });
    if (!response.ok) return fallback;
    return cacheSet(key, await response.json(), ttl);
  } catch {
    return fallback;
  }
}

export function taipeiDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function isoDate(date) { return new Date(date).toISOString().slice(0, 10); }
function dateBefore(value, days = 1) {
  const date = new Date(value || Date.now());
  date.setUTCDate(date.getUTCDate() - days);
  return isoDate(date);
}

async function statsEndpoint(path, params, ttl = 300000) {
  const url = new URL(`${MLB}${path}`);
  Object.entries(params || {}).forEach(([key, value]) => value != null && url.searchParams.set(key, String(value)));
  return json(url, null, ttl);
}

export async function fetchSchedule(date) {
  const url = new URL(`${MLB}/v1/schedule`);
  url.searchParams.set('sportId', '1');
  url.searchParams.set('date', date);
  url.searchParams.set('hydrate', 'probablePitcher,team,venue,linescore');
  const payload = await json(url, { dates: [] }, 60000);
  return (payload?.dates || []).flatMap(day => day.games || []).map(game => {
    const awayEnglish = game.teams?.away?.team?.name || '';
    const homeEnglish = game.teams?.home?.team?.name || '';
    const venueEnglish = game.venue?.name || '';
    const statusEnglish = game.status?.detailedState || '';
    return {
      gamePk: game.gamePk,
      gameDate: game.gameDate,
      officialDate: game.officialDate || date,
      status: statusNameZh(statusEnglish),
      statusEnglish,
      statusCode: game.status?.statusCode || '',
      doubleHeader: game.doubleHeader || 'N',
      gameNumber: Number(game.gameNumber || 1),
      scheduledInnings: Number(game.scheduledInnings || 9),
      away: teamNameZh(awayEnglish),
      home: teamNameZh(homeEnglish),
      awayEnglish,
      homeEnglish,
      awayTeamId: game.teams?.away?.team?.id,
      homeTeamId: game.teams?.home?.team?.id,
      awayProbable: game.teams?.away?.probablePitcher?.fullName || '',
      homeProbable: game.teams?.home?.probablePitcher?.fullName || '',
      awayProbableId: game.teams?.away?.probablePitcher?.id || null,
      homeProbableId: game.teams?.home?.probablePitcher?.id || null,
      venue: venueNameZh(venueEnglish),
      venueEnglish,
      venueId: game.venue?.id || null,
      awayScore: game.teams?.away?.score ?? null,
      homeScore: game.teams?.home?.score ?? null,
      innings: game.linescore?.currentInning || null,
    };
  });
}

function firstSplit(payload, group) {
  const blocks = (payload?.stats || []).filter(item => !group || item.group?.displayName?.toLowerCase() === group || item.group?.displayName === group);
  return blocks.flatMap(item => item.splits || [])[0] || null;
}

function statBlock(payload, group) {
  const split = firstSplit(payload, group);
  const stat = split?.stat || {};
  const games = safe(stat.gamesPlayed || stat.gamesPitched, 0);
  const inningsPitched = Number.parseFloat(stat.inningsPitched || 0) || 0;
  const plateAppearances = safe(stat.plateAppearances || stat.atBats, 0);
  const battersFaced = safe(stat.battersFaced, 0);
  const strikeOuts = safe(stat.strikeOuts, 0);
  const baseOnBalls = safe(stat.baseOnBalls, 0);
  const homeRuns = safe(stat.homeRuns, 0);
  const hits = safe(stat.hits, 0);
  const doubles = safe(stat.doubles, 0);
  const triples = safe(stat.triples, 0);
  const atBats = safe(stat.atBats, 0);
  const avg = safe(stat.avg, 0.25);
  const obp = safe(stat.obp, 0.32);
  const slg = safe(stat.slg, 0.40);
  return {
    available: Boolean(split),
    gamesPlayed: games,
    gamesStarted: safe(stat.gamesStarted, 0),
    inningsPitched,
    runsPerGame: games ? safe(stat.runs, 0) / games : 4.35,
    ops: safe(stat.ops, obp + slg) || 0.72,
    avg,
    obp,
    slg,
    iso: slg - avg,
    babip: safe(stat.babip, 0.30),
    plateAppearances,
    atBats,
    hits,
    doubles,
    triples,
    homeRuns,
    strikeOuts,
    baseOnBalls,
    stolenBases: safe(stat.stolenBases, 0),
    caughtStealing: safe(stat.caughtStealing, 0),
    kRate: plateAppearances ? strikeOuts / plateAppearances : battersFaced ? strikeOuts / battersFaced : 0.225,
    bbRate: plateAppearances ? baseOnBalls / plateAppearances : battersFaced ? baseOnBalls / battersFaced : 0.085,
    era: safe(stat.era, 4.2) || 4.2,
    fip: safe(stat.fip || stat.xera, safe(stat.era, 4.2)) || 4.2,
    whip: safe(stat.whip, 1.3) || 1.3,
    battersFaced,
    kMinusBB: battersFaced ? (strikeOuts - baseOnBalls) / battersFaced : 0.14,
    kPer9: inningsPitched ? strikeOuts * 9 / inningsPitched : 8.5,
    bbPer9: inningsPitched ? baseOnBalls * 9 / inningsPitched : 3.2,
    hrPer9: inningsPitched ? homeRuns * 9 / inningsPitched : 1.15,
  };
}

function fieldingBlock(payload) {
  const splits = (payload?.stats || []).flatMap(item => item.splits || []);
  if (!splits.length) return { available: false };
  const stats = splits.map(split => split.stat || {});
  const errors = stats.reduce((sum, stat) => sum + safe(stat.errors, 0), 0);
  const chances = stats.reduce((sum, stat) => sum + safe(stat.chances, 0), 0);
  const games = Math.max(...stats.map(stat => safe(stat.gamesPlayed || stat.games, 0)), 0);
  const percentages = stats.map(stat => safe(stat.fieldingPercentage, NaN)).filter(Number.isFinite);
  const fieldingPercentage = percentages.length
    ? percentages.reduce((sum, value) => sum + value, 0) / percentages.length
    : chances ? 1 - errors / chances : 0.985;
  return {
    available: true,
    errors,
    chances,
    gamesPlayed: games,
    fieldingPercentage,
    errorsPerGame: games ? errors / games : 0.55,
  };
}

function baserunningBlock(hitting) {
  const attempts = safe(hitting.stolenBases, 0) + safe(hitting.caughtStealing, 0);
  const success = attempts ? safe(hitting.stolenBases, 0) / attempts : 0.75;
  const volume = safe(hitting.gamesPlayed, 0) ? attempts / hitting.gamesPlayed : 0;
  return { runIndex: clamp(1 + (success - 0.75) * 0.04 + Math.min(volume, 1.2) * 0.008, 0.96, 1.04) };
}

export async function fetchLeagueData(season) {
  const payload = await statsEndpoint('/v1/stats', { stats: 'season', group: 'hitting', leagueIds: '103,104', season }, 3600000);
  const splits = (payload?.stats || []).flatMap(item => item.splits || []);
  const totalRuns = splits.reduce((sum, split) => sum + safe(split.stat?.runs, 0), 0);
  const totalGames = splits.reduce((sum, split) => sum + safe(split.stat?.gamesPlayed, 0), 0);
  return {
    available: totalGames > 0,
    runsPerTeamGame: totalGames ? totalRuns / totalGames : 4.35,
    source: 'MLB league season hitting stats',
  };
}

export async function fetchTeamData(teamId, season, gameDate) {
  const recentStart = dateBefore(gameDate, 15);
  const recentEnd = dateBefore(gameDate, 1);
  const [seasonH, seasonP, recentH, recentP, vsL, vsR, fielding, injuries] = await Promise.all([
    statsEndpoint(`/v1/teams/${teamId}/stats`, { stats: 'season', group: 'hitting', season }),
    statsEndpoint(`/v1/teams/${teamId}/stats`, { stats: 'season', group: 'pitching', season }),
    statsEndpoint(`/v1/teams/${teamId}/stats`, { stats: 'byDateRange', group: 'hitting', startDate: recentStart, endDate: recentEnd, season }),
    statsEndpoint(`/v1/teams/${teamId}/stats`, { stats: 'byDateRange', group: 'pitching', startDate: recentStart, endDate: recentEnd, season }),
    statsEndpoint(`/v1/teams/${teamId}/stats`, { stats: 'season', group: 'hitting', sitCodes: 'vl', season }),
    statsEndpoint(`/v1/teams/${teamId}/stats`, { stats: 'season', group: 'hitting', sitCodes: 'vr', season }),
    statsEndpoint(`/v1/teams/${teamId}/stats`, { stats: 'season', group: 'fielding', season }),
    statsEndpoint('/v1/injuries', { teamId }),
  ]);
  const seasonHitting = statBlock(seasonH, 'hitting');
  const injuryRows = Array.isArray(injuries?.injuries) ? injuries.injuries : [];
  const injuriesMapped = injuryRows.map(item => ({
    player: item.player?.fullName || '',
    status: item.status || item.description || '',
    date: item.date || '',
  }));
  return {
    seasonHitting,
    seasonPitching: statBlock(seasonP, 'pitching'),
    recentHitting: statBlock(recentH, 'hitting'),
    recentPitching: statBlock(recentP, 'pitching'),
    vsLeft: statBlock(vsL, 'hitting'),
    vsRight: statBlock(vsR, 'hitting'),
    defense: fieldingBlock(fielding),
    baserunning: baserunningBlock(seasonHitting),
    injuriesAvailable: Array.isArray(injuries?.injuries),
    injuries: injuriesMapped,
    injuryImpact: Math.min(0.045, injuriesMapped.length * 0.004),
  };
}

function pitchArsenalBlock(payload) {
  const splits = (payload?.stats || []).flatMap(item => item.splits || []);
  if (!splits.length) return { available: false, runFactor: 1, pitches: [] };
  const pitches = splits.map(split => ({
    type: split.stat?.type?.description || split.stat?.type?.code || split.split?.code || '',
    percentage: safe(split.stat?.percentage, 0),
    averageSpeed: safe(split.stat?.averageSpeed, 0),
    spinRate: safe(split.stat?.averageSpinRate, 0),
  }));
  const velocity = pitches.filter(pitch => pitch.averageSpeed > 0).reduce((sum, pitch) => sum + pitch.averageSpeed * Math.max(0.05, pitch.percentage || 0.1), 0);
  const weight = pitches.filter(pitch => pitch.averageSpeed > 0).reduce((sum, pitch) => sum + Math.max(0.05, pitch.percentage || 0.1), 0);
  const averageVelocity = weight ? velocity / weight : 0;
  const runFactor = averageVelocity ? clamp(1 - (averageVelocity - 91.5) * 0.004, 0.92, 1.08) : 1;
  return { available: true, runFactor, averageVelocity, pitches };
}

export async function fetchPitcherData(personId, season, gameDate, confirmed = true) {
  if (!personId) return { available: false, confirmed: false };
  const recentStart = dateBefore(gameDate, 36);
  const recentEnd = dateBefore(gameDate, 1);
  const [person, seasonStats, recentStats, arsenal] = await Promise.all([
    json(`${MLB}/v1/people/${personId}`, null, 3600000),
    statsEndpoint(`/v1/people/${personId}/stats`, { stats: 'season', group: 'pitching', season }),
    statsEndpoint(`/v1/people/${personId}/stats`, { stats: 'byDateRange', group: 'pitching', startDate: recentStart, endDate: recentEnd, season }),
    statsEndpoint(`/v1/people/${personId}/stats`, { stats: 'pitchArsenal', group: 'pitching', season }),
  ]);
  const player = person?.people?.[0] || {};
  const seasonBlock = statBlock(seasonStats, 'pitching');
  const recentBlock = statBlock(recentStats, 'pitching');
  const gamesStarted = Math.max(1, seasonBlock.gamesStarted || recentBlock.gamesStarted || 1);
  return {
    available: true,
    confirmed,
    id: personId,
    name: player.fullName || '',
    throws: player.pitchHand?.code || '',
    season: seasonBlock,
    recent: recentBlock,
    expectedInnings: clamp(seasonBlock.inningsPitched / gamesStarted || 5.2, 3.2, 7.2),
    pitchQuality: pitchArsenalBlock(arsenal),
  };
}

export async function fetchFeed(gamePk) {
  if (!gamePk) return null;
  return json(`${MLB}/v1.1/game/${gamePk}/feed/live`, null, 30000);
}

function parseLineup(feed, side) {
  const team = feed?.liveData?.boxscore?.teams?.[side];
  const players = team?.players || {};
  const rows = Object.values(players)
    .filter(player => player?.battingOrder)
    .sort((left, right) => Number(left.battingOrder) - Number(right.battingOrder));
  const catcher = Object.values(players).find(player => player?.position?.abbreviation === 'C' && player?.battingOrder);
  const official = rows.length >= 8;
  return {
    official,
    projected: !official,
    players: rows.map(player => ({
      id: player.person?.id || null,
      name: player.person?.fullName || '',
      position: player.position?.abbreviation || '',
      battingOrder: Number(player.battingOrder),
    })),
    catcher: catcher?.person?.fullName || '',
    offensiveIndex: 1,
    missingCoreCount: 0,
  };
}

function parseUmpire(feed) {
  const row = (feed?.liveData?.boxscore?.officials || []).find(item => item.officialType === 'Home Plate');
  return row ? { name: row.official?.fullName || '', id: row.official?.id || null, status: '已確認' } : { name: '', id: null, status: '未知' };
}

async function fetchRecentSchedule(teamId, beforeDate, days = 7) {
  const end = new Date(beforeDate);
  end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - days);
  const url = new URL(`${MLB}/v1/schedule`);
  url.searchParams.set('sportId', '1');
  url.searchParams.set('teamId', teamId);
  url.searchParams.set('startDate', isoDate(start));
  url.searchParams.set('endDate', isoDate(end));
  url.searchParams.set('hydrate', 'venue,linescore');
  const payload = await json(url, { dates: [] }, 120000);
  return (payload?.dates || []).flatMap(day => day.games || [])
    .filter(game => game.status?.abstractGameState === 'Final')
    .sort((left, right) => new Date(right.gameDate) - new Date(left.gameDate));
}

function haversine(first, second) {
  if (!first || !second) return 0;
  const radius = 6371;
  const radians = value => value * Math.PI / 180;
  const dLat = radians(second.lat - first.lat);
  const dLon = radians(second.lon - first.lon);
  const value = Math.sin(dLat / 2) ** 2 + Math.cos(radians(first.lat)) * Math.cos(radians(second.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.asin(Math.sqrt(value));
}

async function restData(teamId, gameDate, venueId) {
  const rows = await fetchRecentSchedule(teamId, gameDate, 7);
  const previous = rows[0];
  if (!previous) return { available: false, days: 2, travelKm: 0, previousExtraInnings: false, lastGame: null };
  const days = Math.max(0, Math.floor((new Date(gameDate) - new Date(previous.gameDate)) / 86400000));
  const from = PARKS[Number(previous.venue?.id)];
  const to = PARKS[Number(venueId)];
  const venueEnglish = previous.venue?.name || '';
  return {
    available: true,
    days,
    travelKm: Math.round(haversine(from, to)),
    previousExtraInnings: Number(previous.linescore?.currentInning || 9) > 9,
    dayNightTransition: false,
    lastGame: { gamePk: previous.gamePk, venue: venueNameZh(venueEnglish), innings: previous.linescore?.currentInning || 9 },
  };
}

function parsePitchingUsage(feed, teamId) {
  const awayId = feed?.gameData?.teams?.away?.id;
  const side = Number(awayId) === Number(teamId) ? 'away' : 'home';
  const team = feed?.liveData?.boxscore?.teams?.[side];
  const pitcherIds = team?.pitchers || [];
  if (!pitcherIds.length) return null;
  const players = team?.players || {};
  const starterId = pitcherIds[0];
  const relievers = pitcherIds.slice(1).map(id => {
    const row = players[`ID${id}`] || {};
    const pitching = row.stats?.pitching || {};
    return {
      id,
      name: row.person?.fullName || '',
      pitches: safe(pitching.numberOfPitches, 0),
      innings: Number.parseFloat(pitching.inningsPitched || 0) || 0,
    };
  });
  return { starterId, relievers };
}

async function bullpenUsage(teamId, gameDate) {
  const rows = (await fetchRecentSchedule(teamId, gameDate, 4)).slice(0, 4);
  if (!rows.length) return { usageAvailable: false, fatigueIndex: 0.2, highLeverageAvailability: 0.75, daily: [] };
  const feeds = await Promise.all(rows.map(game => fetchFeed(game.gamePk)));
  const target = new Date(gameDate).getTime();
  const daily = [];
  const pitcherUse = new Map();
  feeds.forEach((feed, index) => {
    const usage = parsePitchingUsage(feed, teamId);
    if (!usage) return;
    const daysAgo = Math.max(1, Math.round((target - new Date(rows[index].gameDate).getTime()) / 86400000));
    const weight = daysAgo <= 1 ? 1 : daysAgo === 2 ? 0.65 : daysAgo === 3 ? 0.35 : 0.18;
    const pitches = usage.relievers.reduce((sum, reliever) => sum + reliever.pitches, 0);
    const innings = usage.relievers.reduce((sum, reliever) => sum + reliever.innings, 0);
    daily.push({ gamePk: rows[index].gamePk, daysAgo, pitches, innings, relievers: usage.relievers });
    for (const reliever of usage.relievers) {
      const previous = pitcherUse.get(reliever.id) || { name: reliever.name, weightedPitches: 0, appearances: 0, lastDayPitches: 0 };
      previous.weightedPitches += reliever.pitches * weight;
      previous.appearances += 1;
      if (daysAgo <= 1) previous.lastDayPitches += reliever.pitches;
      pitcherUse.set(reliever.id, previous);
    }
  });
  if (!daily.length) return { usageAvailable: false, fatigueIndex: 0.2, highLeverageAvailability: 0.75, daily: [] };
  const relievers = [...pitcherUse.values()];
  const totalWeightedPitches = relievers.reduce((sum, row) => sum + row.weightedPitches, 0);
  const consecutiveHeavy = relievers.filter(row => row.appearances >= 2 && row.weightedPitches >= 35).length;
  const lastDayHeavy = relievers.filter(row => row.lastDayPitches >= 25).length;
  const fatigueIndex = clamp(totalWeightedPitches / 260 + consecutiveHeavy * 0.08 + lastDayHeavy * 0.06, 0, 1);
  const highLeverageAvailability = clamp(1 - consecutiveHeavy * 0.12 - lastDayHeavy * 0.10, 0.35, 1);
  return { usageAvailable: true, fatigueIndex, highLeverageAvailability, daily, relievers };
}

export async function fetchWeather(game) {
  const park = PARKS[Number(game.venueId)];
  if (!park) return { available: false, roofClosedProbability: park?.roof === 'dome' ? 1 : 0.35, roofConfirmed: false };
  const url = new URL(OPEN_METEO);
  url.searchParams.set('latitude', park.lat);
  url.searchParams.set('longitude', park.lon);
  url.searchParams.set('hourly', 'temperature_2m,precipitation_probability,wind_speed_10m,wind_direction_10m');
  url.searchParams.set('forecast_days', '3');
  url.searchParams.set('timezone', 'UTC');
  const payload = await json(url, null, 900000);
  if (!payload?.hourly?.time) return { available: false, roofClosedProbability: park.roof === 'dome' ? 1 : park.roof === 'open' ? 0 : 0.35, roofConfirmed: false };
  const target = new Date(game.gameDate).getTime();
  let best = 0;
  let difference = Infinity;
  payload.hourly.time.forEach((value, index) => {
    const current = Math.abs(new Date(`${value}Z`).getTime() - target);
    if (current < difference) { difference = current; best = index; }
  });
  const temperature = payload.hourly.temperature_2m?.[best] ?? null;
  const precipitationProbability = payload.hourly.precipitation_probability?.[best] ?? null;
  const windSpeed = payload.hourly.wind_speed_10m?.[best] ?? null;
  const roofClosedProbability = park.roof === 'dome'
    ? 1
    : park.roof === 'open'
      ? 0
      : clamp((safe(precipitationProbability, 0) >= 40 ? 0.75 : 0.22) + (safe(temperature, 21) < 10 || safe(temperature, 21) > 33 ? 0.15 : 0), 0.1, 0.95);
  return {
    available: true,
    temperature,
    precipitationProbability,
    windSpeed,
    windDirection: payload.hourly.wind_direction_10m?.[best] ?? null,
    time: payload.hourly.time?.[best] || '',
    roofClosedProbability,
    roofConfirmed: park.roof === 'dome' || park.roof === 'open',
  };
}

function feature(featureName, status, source) {
  return { feature: featureName, status, source };
}

export async function buildGameContext(game) {
  const season = new Date(game.gameDate || Date.now()).getUTCFullYear();
  const [league, awayTeam, homeTeam, awayStarter, homeStarter, feed, weather, awayRest, homeRest, awayBullpen, homeBullpen] = await Promise.all([
    fetchLeagueData(season),
    fetchTeamData(game.awayTeamId, season, game.gameDate),
    fetchTeamData(game.homeTeamId, season, game.gameDate),
    fetchPitcherData(game.awayProbableId, season, game.gameDate, Boolean(game.awayProbableId)),
    fetchPitcherData(game.homeProbableId, season, game.gameDate, Boolean(game.homeProbableId)),
    fetchFeed(game.gamePk),
    fetchWeather(game),
    restData(game.awayTeamId, game.gameDate, game.venueId),
    restData(game.homeTeamId, game.gameDate, game.venueId),
    bullpenUsage(game.awayTeamId, game.gameDate),
    bullpenUsage(game.homeTeamId, game.gameDate),
  ]);

  const parkBase = PARKS[Number(game.venueId)] || { runFactor: 1, roof: 'unknown' };
  const park = {
    ...parkBase,
    name: game.venue || venueNameZh(game.venueEnglish),
    nameEnglish: game.venueEnglish || '',
    roofZh: roofNameZh(parkBase.roof),
  };
  const awayLineup = parseLineup(feed, 'away');
  const homeLineup = parseLineup(feed, 'home');
  const away = { ...awayTeam, starter: awayStarter, lineup: awayLineup, rest: awayRest, bullpen: awayBullpen };
  const home = { ...homeTeam, starter: homeStarter, lineup: homeLineup, rest: homeRest, bullpen: homeBullpen };
  const umpire = parseUmpire(feed);

  const warnings = [];
  if (!awayStarter.available || !homeStarter.available) warnings.push('先發投手資料未完整；只有雙方核心球隊資料仍可信時才繼續建模');
  if (!awayLineup.official || !homeLineup.official) warnings.push('正式打線尚未完整公布，已擴大輪休／打線聯合情境');
  if (!awayLineup.catcher || !homeLineup.catcher) warnings.push('捕手尚未完整確認，採中性捕手分布');
  if (!umpire.name) warnings.push('主審尚未公布，採中性主審分布');
  if (!weather.available) warnings.push('天氣資料暫時無法取得，已擴大環境情境');
  if (!awayBullpen.usageAvailable || !homeBullpen.usageAvailable) warnings.push('牛棚逐投手近況未完整取得，採範圍情境');

  const coreTeamData = away.seasonHitting.available && home.seasonHitting.available && away.seasonPitching.available && home.seasonPitching.available;
  const coreStarterData = awayStarter.available && homeStarter.available;
  const coreModelable = Boolean(game?.awayTeamId && game?.homeTeamId && coreTeamData && coreStarterData);

  const featureProvenance = [
    feature('聯盟得分基準', league.available ? '已確認' : '預估', league.source || 'MLB Stats API'),
    feature('客隊球季／近期打擊', away.seasonHitting.available && away.recentHitting.available ? '已確認' : '預估', 'MLB team stats'),
    feature('主隊球季／近期打擊', home.seasonHitting.available && home.recentHitting.available ? '已確認' : '預估', 'MLB team stats'),
    feature('先發投手與球種', coreStarterData ? (awayStarter.pitchQuality.available && homeStarter.pitchQuality.available ? '已確認' : '預估') : '未知', 'MLB people/stats/pitchArsenal'),
    feature('左右投拆分', away.vsLeft.available && away.vsRight.available && home.vsLeft.available && home.vsRight.available ? '已確認' : '預估', 'MLB situational team stats'),
    feature('正式／預估打線', awayLineup.official && homeLineup.official ? '已確認' : '預估', 'MLB live feed'),
    feature('捕手', awayLineup.catcher && homeLineup.catcher ? '已確認' : '預估', 'MLB live feed'),
    feature('牛棚逐投手可用性', awayBullpen.usageAvailable && homeBullpen.usageAvailable ? '已確認' : '預估', 'MLB recent game feeds'),
    feature('守備／跑壘', away.defense.available && home.defense.available ? '已確認' : '預估', 'MLB fielding/hitting stats'),
    feature('旅行／休息', awayRest.available && homeRest.available ? '已確認' : '預估', 'MLB recent schedule'),
    feature('天氣／屋頂', weather.available ? (weather.roofConfirmed ? '已確認' : '預估') : '未知', 'Open-Meteo + park roof metadata'),
    feature('主審', umpire.name ? '已確認' : '未知', 'MLB live feed / neutral distribution'),
  ];

  return {
    game,
    league,
    away,
    home,
    weather,
    park,
    umpire,
    warnings,
    featureProvenance,
    coreModelable,
    fetchedAt: new Date().toISOString(),
  };
}

export async function fetchFinalResult(gamePk) {
  const feed = await fetchFeed(gamePk);
  const state = feed?.gameData?.status?.abstractGameState || '';
  const away = feed?.liveData?.linescore?.teams?.away?.runs;
  const home = feed?.liveData?.linescore?.teams?.home?.runs;
  const innings = feed?.liveData?.linescore?.innings || [];
  const awayFirst5 = innings.slice(0, 5).reduce((sum, inning) => sum + Number(inning?.away?.runs || 0), 0);
  const homeFirst5 = innings.slice(0, 5).reduce((sum, inning) => sum + Number(inning?.home?.runs || 0), 0);
  const statusEnglish = feed?.gameData?.status?.detailedState || state;
  return {
    final: state === 'Final' && Number.isFinite(Number(away)) && Number.isFinite(Number(home)),
    awayRuns: Number(away),
    homeRuns: Number(home),
    awayFirst5,
    homeFirst5,
    status: statusNameZh(statusEnglish),
    statusEnglish,
  };
}
