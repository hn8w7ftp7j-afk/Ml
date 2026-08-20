import assert from 'node:assert/strict';
import { buildGameContextV11 } from '../lib/mlb-context-v11.js';

const calls = new Map();
const fetchImpl = async input => {
  const url = String(input);
  calls.set(url, (calls.get(url) || 0) + 1);
  await new Promise(resolve => setTimeout(resolve, 5));
  if (url.includes('baseballsavant.mlb.com')) {
    return new Response('<html>fixture without park payload</html>', { status: 200 });
  }
  if (url.includes('open-meteo.com')) {
    return new Response(JSON.stringify({ hourly: {
      time: ['2099-08-11T23:00'],
      temperature_2m: [23],
      relative_humidity_2m: [55],
      precipitation_probability: [0],
      surface_pressure: [1010],
      wind_speed_10m: [8],
      wind_direction_10m: [180],
    } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (/\/venues\//.test(url)) {
    return new Response(JSON.stringify({ venues: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (/\/roster|\/injuries/.test(url)) {
    return new Response(JSON.stringify({ roster: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (/\/schedule/.test(url)) {
    return new Response(JSON.stringify({ dates: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return new Response(JSON.stringify({ stats: [{ splits: [] }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

const game = {
  leagueId: 'MLB',
  gamePk: 990001,
  gameDate: '2099-08-12T00:00:00.000Z',
  away: '客隊',
  home: '主隊',
  awayTeamId: 111,
  homeTeamId: 141,
  awayProbableId: 700001,
  homeProbableId: 700002,
  venueId: 13,
};

const [left, right] = await Promise.all([
  buildGameContextV11(game, { fetchImpl, timeoutMs: 1000 }),
  buildGameContextV11(game, { fetchImpl, timeoutMs: 1000 }),
]);
assert.equal(left.game.gamePk, game.gamePk);
assert.equal(right.game.gamePk, game.gamePk);
assert.ok(calls.size > 10, 'fixture必須覆蓋完整context請求集合');
for (const [url, count] of calls) {
  assert.equal(count, 1, `同一批次重複請求未去重：${url}`);
}

const isolatedCalls = [new Map(), new Map()];
const isolatedTransports = isolatedCalls.map((counter, transportIndex) => async input => {
  const url = String(input);
  counter.set(url, (counter.get(url) || 0) + 1);
  await new Promise(resolve => setTimeout(resolve, 5));
  const payload = url.includes('baseballsavant.mlb.com')
    ? '<html>isolated transport</html>'
    : JSON.stringify(url.includes('open-meteo.com') ? { hourly: {} } : { stats: [{ splits: [] }], transportIndex });
  return new Response(payload, { status: 200, headers: { 'Content-Type': url.includes('baseballsavant.mlb.com') ? 'text/html' : 'application/json' } });
});
await Promise.all([
  buildGameContextV11({ ...game, gamePk: 990002 }, { fetchImpl: isolatedTransports[0], timeoutMs: 900 }),
  buildGameContextV11({ ...game, gamePk: 990003 }, { fetchImpl: isolatedTransports[1], timeoutMs: 1100 }),
]);
assert.ok(isolatedCalls[0].size > 10 && isolatedCalls[1].size > 10, '不同transport必須各自執行完整請求');
for (const counter of isolatedCalls) {
  for (const count of counter.values()) assert.equal(count, 1, '各transport內仍須維持請求去重');
}

console.log(JSON.stringify({ ok: true, distinctRequests: calls.size, duplicateRequests: 0, transportIsolation: true }, null, 2));
