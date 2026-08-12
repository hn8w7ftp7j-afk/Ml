import assert from 'node:assert/strict';

const BASE = String(process.env.LOCAL_E2E_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const APP_PASSWORD = process.env.APP_PASSWORD || 'local-app-password';
const PAIR_PASSWORD = process.env.READER_PAIR_SECRET || 'local-reader-password';
const EXTENSION_ORIGIN = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

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
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(value));
  const get = type => parts.find(part => part.type === type)?.value || '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
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
      if (value.ok && value.version === '9.4.1') return value;
      last = JSON.stringify(value);
    } catch (error) { last = String(error?.message || error); }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`local app not ready: ${last}`);
}

const health = await waitUntilReady();
assert.equal(health.readerPairingConfigured, true);
assert.equal(health.authConfigured, true);

const login = await json('/api/auth', {
  method: 'POST',
  headers: {
    Origin: BASE,
    'Sec-Fetch-Site': 'same-origin',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ password: APP_PASSWORD }),
}, 30000);
const setCookie = login.response.headers.get('set-cookie') || '';
const cookie = setCookie.split(';')[0];
assert.match(cookie, /^mlb_session=/);

let selectedDate = '';
let game = null;
let schedule = [];
for (let offset = 0; offset < 10 && !game; offset += 1) {
  const date = taipeiDate(offset);
  const result = await json(`/api/mlb?date=${date}&t=${Date.now()}`, {
    headers: { Cookie: cookie },
  }, 30000);
  schedule = result.value.games || [];
  game = schedule.find(row => {
    const status = `${row.statusCode || ''} ${row.statusEnglish || ''} ${row.status || ''}`.toLowerCase();
    return row.gamePk
      && TEAM_CODE_BY_ID[Number(row.awayTeamId)]
      && TEAM_CODE_BY_ID[Number(row.homeTeamId)]
      && !/final|in progress|game over|completed|live/.test(status)
      && !['I', 'F', 'O'].includes(String(row.statusCode || '').toUpperCase());
  }) || null;
  if (game) selectedDate = date;
}
assert.ok(game, 'No future modelable MLB game found for local Reader E2E');

const pair = await json('/api/reader/pair', {
  method: 'POST',
  headers: {
    Origin: EXTENSION_ORIGIN,
    'Content-Type': 'application/json',
    'X-Reader-Version': '2.0.2',
  },
  body: JSON.stringify({
    deviceId: 'local-e2e-device-1234',
    deviceName: 'CI Reader',
    password: PAIR_PASSWORD,
  }),
}, 30000);
assert.match(pair.value.token, /^reader-v2\./);

const local = taipeiDateTime(game.gameDate);
const observedAt = new Date().toISOString();
const readerPayload = {
  version: 'TAI888-READER-DOM-v2.0.2',
  readerVersion: '2.0.2',
  sourceHost: 'www1.tai888.in',
  pageUrl: 'https://www1.tai888.in/newapp/#/BS',
  pageTitle: '泰8',
  boardDate: local.date,
  observedAt,
  payloadHash: 'b'.repeat(64),
  games: [{
    awayCode: TEAM_CODE_BY_ID[Number(game.awayTeamId)],
    homeCode: TEAM_CODE_BY_ID[Number(game.homeTeamId)],
    boardDate: local.date,
    boardTime: local.time,
    fullRunline: { lineSide: 'home', line: '1+50', awayWater: 0.95, homeWater: 0.95, rawRows: ['0.950', '1+50 0.950'] },
    fullTotal: { line: '8平', overWater: 0.94, underWater: 0.94, rawRows: ['8平 大 0.940', '小 0.940'] },
    first5Runline: { lineSide: 'home', line: '0-50', awayWater: 0.94, homeWater: 0.94, rawRows: ['0.940', '0-50 0.940'] },
    first5Total: { line: '4平', overWater: 0.93, underWater: 0.93, rawRows: ['4平 大 0.930', '小 0.930'] },
  }],
};

const ingest = await json('/api/reader/ingest', {
  method: 'POST',
  headers: {
    Origin: EXTENSION_ORIGIN,
    Authorization: `Bearer ${pair.value.token}`,
    'Content-Type': 'application/json',
    'X-Reader-Version': '2.0.2',
    'X-Device-Id': 'local-e2e-device-1234',
  },
  body: JSON.stringify(readerPayload),
}, 60000);
assert.equal(ingest.value.matchedGameCount, 1);
assert.equal(ingest.value.heartbeat, false);

const heartbeat = await json('/api/reader/ingest', {
  method: 'POST',
  headers: {
    Origin: EXTENSION_ORIGIN,
    Authorization: `Bearer ${pair.value.token}`,
    'Content-Type': 'application/json',
    'X-Reader-Version': '2.0.2',
    'X-Device-Id': 'local-e2e-device-1234',
  },
  body: JSON.stringify({ ...readerPayload, observedAt: new Date().toISOString() }),
}, 30000);
assert.equal(heartbeat.value.heartbeat, true);
assert.equal(heartbeat.value.matchedGameCount, 1);

const status = await json(`/api/reader/status?date=${local.date}&t=${Date.now()}`, {
  headers: { Origin: EXTENSION_ORIGIN },
}, 20000);
assert.equal(status.value.fresh, true);
assert.equal(status.value.matchedGameCount, 1);
assert.equal(status.value.readerVersion, '2.0.2');

const credit = await json('/api/credit-lines', {
  method: 'POST',
  headers: {
    Origin: BASE,
    'Sec-Fetch-Site': 'same-origin',
    'Content-Type': 'application/json',
    Cookie: cookie,
  },
  body: JSON.stringify({ date: local.date, schedule }),
}, 60000);
assert.equal(credit.value.provider, 'TAI888_READER_AUTO');
assert.equal(credit.value.readerFresh, true);
assert.equal(credit.value.games.length, 1);
assert.equal(credit.value.games[0].markets.length, 8);
assert.equal(credit.value.games[0].markets.every(row => row.sourceType === 'ACTUAL_TW_CREDIT'), true);

const markets = credit.value.games[0].markets;
const analysis = await json('/api/analyze', {
  method: 'POST',
  headers: {
    Origin: BASE,
    'Sec-Fetch-Site': 'same-origin',
    'Content-Type': 'application/json',
    Cookie: cookie,
  },
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

const changedMarkets = markets.map(row => {
  if (row.market !== '全場大小') return row;
  return { ...row, pick: row.pick.startsWith('大') ? '大8+50' : '小8+50', water: 0.96, lineAsOf: new Date().toISOString() };
});
const repriced = await json('/api/reprice', {
  method: 'POST',
  headers: {
    Origin: BASE,
    'Sec-Fetch-Site': 'same-origin',
    'Content-Type': 'application/json',
    Cookie: cookie,
  },
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
  gamePk: game.gamePk,
  readerMarkets: markets.length,
  fullAnalysis: analysis.value.analysis.analysisType,
  repricing: repriced.value.analysis.analysisType,
  distributionReused: repriced.value.reprice.distributionReused,
}, null, 2));
