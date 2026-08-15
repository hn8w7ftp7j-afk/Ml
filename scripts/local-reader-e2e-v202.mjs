import assert from 'node:assert/strict';

const BASE = String(process.env.LOCAL_E2E_URL || 'http://localhost:3000').replace(/\/$/, '');
const APP_PASSWORD = process.env.APP_PASSWORD || 'local-app-password';
const PAIR_PASSWORD = process.env.READER_PAIR_SECRET || 'local-reader-password';
const EXTENSION_ORIGIN = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const READER_VERSION = '2.0.3';

const TEAM_CODE_BY_ID = Object.freeze({
  108: 'LAA', 109: 'ARI', 110: 'BAL', 111: 'BOS', 112: 'CHC', 113: 'CIN',
  114: 'CLE', 115: 'COL', 116: 'DET', 117: 'HOU', 118: 'KC', 119: 'LAD',
  120: 'WSH', 121: 'NYM', 133: 'OAK', 134: 'PIT', 135: 'SD', 136: 'SEA',
  137: 'SF', 138: 'STL', 139: 'TB', 140: 'TEX', 141: 'TOR', 142: 'MIN',
  143: 'PHI', 144: 'ATL', 145: 'CWS', 146: 'MIA', 147: 'NYY', 158: 'MIL',
});

function taipeiDate(offset = 0) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(Date.now() + offset * 86400000));
}

function taipeiDateTime(value) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(value));
  const get = type => parts.find(part => part.type === type)?.value || '';
  const hour = get('hour') === '24' ? '00' : get('hour');
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${hour}:${get('minute')}` };
}

async function raw(path, options = {}, timeout = 120000) {
  return fetch(`${BASE}${path}`, { ...options, redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(timeout) });
}

async function json(path, options = {}, timeout = 120000) {
  const response = await raw(path, options, timeout);
  const text = await response.text();
  let value;
  try { value = JSON.parse(text); }
  catch { throw new Error(`${path} non-JSON ${response.status}: ${text.slice(0, 500)}`); }
  if (!response.ok || value.ok === false) {
    throw new Error(`${path} failed ${response.status}: ${value.error || text.slice(0, 500)}`);
  }
  return { response, value };
}

async function waitUntilReady() {
  let last = '';
  for (let index = 0; index < 60; index += 1) {
    try {
      const { value } = await json('/api/health?t=' + Date.now(), {}, 20000);
      if (value.ok && value.version === '9.4.4') return value;
      last = JSON.stringify(value);
    } catch (error) { last = String(error?.message || error); }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`local app not ready: ${last}`);
}

async function officialTaipeiSlate(boardDate, cookie) {
  const { value } = await json(`/api/mlb?date=${boardDate}&t=${Date.now()}`, {
    headers: { Cookie: cookie },
  }, 30000);
  assert.equal(value.date, boardDate, 'production schedule route must preserve the requested Taipei board date');
  const games = Array.isArray(value.games) ? value.games : [];
  assert.equal(
    games.every(game => taipeiDateTime(game.gameDate).date === boardDate),
    true,
    'production schedule route must return only the requested Taipei board-date slate',
  );
  return games.sort((left, right) => (
    Date.parse(left.gameDate) - Date.parse(right.gameDate) || Number(left.gamePk) - Number(right.gamePk)
  ));
}

function gameHasNotStarted(game) {
  const status = `${game.statusCode || ''} ${game.statusEnglish || ''} ${game.status || ''}`.toLowerCase();
  return !/final|in progress|game over|completed|live/.test(status)
    && !['I', 'F', 'O'].includes(String(game.statusCode || '').toUpperCase());
}

function readerGame(game, index, boardDate) {
  const local = taipeiDateTime(game.gameDate);
  const modifier = 10 + (index % 80);
  return {
    awayCode: TEAM_CODE_BY_ID[Number(game.awayTeamId)],
    homeCode: TEAM_CODE_BY_ID[Number(game.homeTeamId)],
    boardDate,
    boardTime: local.time,
    fullRunline: { lineSide: 'home', line: `1+${modifier}`, awayWater: 0.95, homeWater: 0.95, rawRows: ['0.950', `1+${modifier} 0.950`] },
    fullTotal: { line: `8+${modifier}`, overWater: 0.94, underWater: 0.94, rawRows: [`8+${modifier} 大 0.940`, '小 0.940'] },
    first5Runline: { lineSide: 'home', line: `0-${modifier}`, awayWater: 0.94, homeWater: 0.94, rawRows: ['0.940', `0-${modifier} 0.940`] },
    first5Total: { line: `4-${modifier}`, overWater: 0.93, underWater: 0.93, rawRows: [`4-${modifier} 大 0.930`, '小 0.930'] },
  };
}

const health = await waitUntilReady();
assert.equal(health.readerPairingConfigured, true);
assert.equal(health.authConfigured, true);

const login = await json('/api/auth', {
  method: 'POST',
  headers: { Origin: BASE, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' },
  body: JSON.stringify({ password: APP_PASSWORD }),
}, 30000);
const cookie = (login.response.headers.get('set-cookie') || '').split(';')[0];
assert.match(cookie, /^mlb_session=/);

let selectedDate = '';
let game = null;
let schedule = [];
for (let offset = 1; offset <= 10 && !game; offset += 1) {
  const date = taipeiDate(offset);
  const slate = await officialTaipeiSlate(date, cookie);
  if (!slate.length || slate.some(row => !TEAM_CODE_BY_ID[Number(row.awayTeamId)] || !TEAM_CODE_BY_ID[Number(row.homeTeamId)])) continue;
  const candidate = slate.find(gameHasNotStarted);
  if (!candidate) continue;
  selectedDate = date;
  schedule = slate;
  game = candidate;
}
assert.ok(game, 'No future complete/modelable MLB Taipei slate found for local Reader E2E');

const pair = await json('/api/reader/pair', {
  method: 'POST',
  headers: { Origin: EXTENSION_ORIGIN, 'Content-Type': 'application/json', 'X-Reader-Version': READER_VERSION },
  body: JSON.stringify({ deviceId: 'local-e2e-device-1234', deviceName: 'CI Reader', password: PAIR_PASSWORD }),
}, 30000);
assert.match(pair.value.token, /^reader-v2\./);

const observedAt = new Date().toISOString();
const pageActivityAt = new Date(Date.parse(observedAt) - 1000).toISOString();
const rawGames = schedule.map((row, index) => readerGame(row, index, selectedDate)).reverse();
const readerPayload = {
  version: 'TAI888-READER-DOM-v2.0.3',
  readerVersion: READER_VERSION,
  sourceHost: 'www1.tai888.in',
  pageUrl: 'https://www1.tai888.in/newapp/#/BS',
  boardDate: selectedDate,
  observedAt,
  pageActivityAt,
  expectedGameCount: rawGames.length,
  detectedGameCount: rawGames.length,
  payloadHash: 'b'.repeat(64),
  games: rawGames,
};
const readerHeaders = {
  Origin: EXTENSION_ORIGIN,
  Authorization: `Bearer ${pair.value.token}`,
  'Content-Type': 'application/json',
  'X-Reader-Version': READER_VERSION,
  'X-Device-Id': 'local-e2e-device-1234',
};

const ingest = await json('/api/reader/ingest', {
  method: 'POST', headers: readerHeaders, body: JSON.stringify(readerPayload),
}, 60000);
assert.equal(ingest.value.heartbeat, false);
assert.equal(ingest.value.rawGameCount, schedule.length);
assert.equal(ingest.value.matchedGameCount, schedule.length);
assert.equal(ingest.value.scheduleGameCount, schedule.length);
assert.equal(ingest.value.allRequiredWritesSucceeded, true);
assert.match(ingest.value.payloadHash, /^[a-f0-9]{64}$/);
assert.match(ingest.value.rawBoardHash, /^[a-f0-9]{64}$/);
assert.notEqual(ingest.value.rawBoardHash, readerPayload.payloadHash);

const heartbeatObservedAt = new Date(Math.max(Date.now(), Date.parse(observedAt) + 1000)).toISOString();
const heartbeatPageActivityAt = new Date(Date.parse(heartbeatObservedAt) - 250).toISOString();
const heartbeat = await json('/api/reader/ingest', {
  method: 'POST',
  headers: readerHeaders,
  body: JSON.stringify({ ...readerPayload, observedAt: heartbeatObservedAt, pageActivityAt: heartbeatPageActivityAt, payloadHash: 'c'.repeat(64) }),
}, 30000);
assert.equal(heartbeat.value.heartbeat, true, 'client hash spoof must not defeat server raw-board heartbeat');
assert.equal(heartbeat.value.rawBoardHash, ingest.value.rawBoardHash);
assert.equal(heartbeat.value.payloadHash, ingest.value.payloadHash);
assert.equal(heartbeat.value.matchedGameCount, schedule.length);

const status = await json(`/api/reader/status?date=${selectedDate}&t=${Date.now()}`, {
  headers: { Origin: EXTENSION_ORIGIN },
}, 20000);
assert.equal(status.value.fresh, true);
assert.equal(status.value.executable, true);
assert.equal(status.value.matchedGameCount, schedule.length);
assert.equal(status.value.readerVersion, READER_VERSION);
assert.equal(status.value.rawBoardHash, ingest.value.rawBoardHash);
assert.equal(status.value.pageActivityAt, heartbeatPageActivityAt);

const credit = await json('/api/credit-lines', {
  method: 'POST',
  headers: { Origin: BASE, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', Cookie: cookie },
  body: JSON.stringify({ date: selectedDate, schedule }),
}, 60000);
assert.equal(credit.value.provider, 'TAI888_READER_AUTO');
assert.equal(credit.value.readerFresh, true);
assert.equal(credit.value.games.length, schedule.length);
assert.equal(credit.value.games.every(row => row.markets.length === 8), true);
assert.equal(credit.value.games.flatMap(row => row.markets).every(row => row.sourceType === 'ACTUAL_TW_CREDIT'), true);
assert.equal(credit.value.pageActivityAt, heartbeatPageActivityAt);
assert.equal(credit.value.games.flatMap(row => row.markets).every(row => row.lineAsOf === heartbeatPageActivityAt), true);

const creditGame = credit.value.games.find(row => Number(row.gamePk) === Number(game.gamePk));
assert.ok(creditGame, 'selected modelable game must be present in the complete Reader slate');
const markets = creditGame.markets;
const analysis = await json('/api/analyze', {
  method: 'POST',
  headers: { Origin: BASE, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', Cookie: cookie },
  body: JSON.stringify({
    game,
    markets,
    previousMarkets: [],
    verificationMarkets: [],
    settings: { rebateRate: 0.015, simulationsPerScenario: 500, candidateThreshold: 7.2, strongestThreshold: 8.5 },
  }),
}, 120000);
assert.equal(analysis.value.analysis.analysisType, 'FULL');
assert.ok(analysis.value.repriceSnapshot?.distributionSnapshot?.distributionHash);
assert.equal(analysis.value.analysis.results.length, 8);

const targetAwayCode = TEAM_CODE_BY_ID[Number(game.awayTeamId)];
const targetHomeCode = TEAM_CODE_BY_ID[Number(game.homeTeamId)];
const changedRawGames = rawGames.map(row => (
  row.awayCode === targetAwayCode && row.homeCode === targetHomeCode && row.boardTime === taipeiDateTime(game.gameDate).time
    ? {
      ...row,
      fullTotal: {
        line: '8+50',
        overWater: 0.96,
        underWater: 0.96,
        rawRows: ['8+50 大 0.960', '小 0.960'],
      },
    }
    : row
));
const changedObservedAt = new Date(Math.max(Date.now(), Date.parse(heartbeatObservedAt) + 1000)).toISOString();
const changedPageActivityAt = new Date(Date.parse(changedObservedAt) - 250).toISOString();
const changedIngest = await json('/api/reader/ingest', {
  method: 'POST',
  headers: readerHeaders,
  body: JSON.stringify({
    ...readerPayload,
    observedAt: changedObservedAt,
    pageActivityAt: changedPageActivityAt,
    payloadHash: 'd'.repeat(64),
    games: changedRawGames,
  }),
}, 60000);
assert.equal(changedIngest.value.heartbeat, false);
assert.notEqual(changedIngest.value.rawBoardHash, ingest.value.rawBoardHash);
assert.notEqual(changedIngest.value.payloadHash, ingest.value.payloadHash);

const changedCredit = await json('/api/credit-lines', {
  method: 'POST',
  headers: { Origin: BASE, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', Cookie: cookie },
  body: JSON.stringify({ date: selectedDate, schedule }),
}, 60000);
assert.equal(changedCredit.value.payloadHash, changedIngest.value.payloadHash);
const changedCreditGame = changedCredit.value.games.find(row => Number(row.gamePk) === Number(game.gamePk));
assert.ok(changedCreditGame);
const changedMarkets = changedCreditGame.markets;
assert.equal(changedMarkets.filter(row => row.market === '全場大小').every(row => row.pick.endsWith('8+50')), true);
const repriced = await json('/api/reprice', {
  method: 'POST',
  headers: { Origin: BASE, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', Cookie: cookie },
  body: JSON.stringify({
    snapshot: analysis.value.repriceSnapshot,
    markets: changedMarkets,
    previousMarkets: markets,
    verificationMarkets: [],
    settings: { rebateRate: 0.015, candidateThreshold: 7.2, strongestThreshold: 8.5 },
  }),
}, 120000);
assert.equal(repriced.value.reprice.distributionReused, true);
assert.equal(repriced.value.analysis.distributionId, analysis.value.analysis.distributionId);
assert.equal(repriced.value.analysis.distributionHash, analysis.value.analysis.distributionHash);
assert.equal(repriced.value.analysis.analysisType, 'PRICE_ONLY_REPRICE');

console.log(JSON.stringify({
  ok: true,
  selectedDate,
  fullSlateGames: schedule.length,
  gamePk: game.gamePk,
  readerMarkets: markets.length,
  serverRawBoardHash: ingest.value.rawBoardHash,
  heartbeat: heartbeat.value.heartbeat,
  changedRawBoardHash: changedIngest.value.rawBoardHash,
  fullAnalysis: analysis.value.analysis.analysisType,
  repricing: repriced.value.analysis.analysisType,
  distributionReused: repriced.value.reprice.distributionReused,
}, null, 2));
