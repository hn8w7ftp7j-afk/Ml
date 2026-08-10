import assert from 'node:assert/strict';
import { normalizeJbotReference, normalizeOddsApiReference, referenceProviderStatus } from '../lib/reference-lines.js';

const schedule = [{
  gamePk: 123,
  gameDate: '2026-08-11T23:07:00Z',
  away: '波士頓紅襪',
  home: '多倫多藍鳥',
  awayEnglish: 'Boston Red Sox',
  homeEnglish: 'Toronto Blue Jays',
}];

const jbot = normalizeJbotReference({
  status: 'OK',
  data: [{
    id: 'TW-1', time: '2026-08-12T07:07', away: '波士頓紅襪', home: '多倫多藍鳥',
    odds: [{
      update: '2026-08-12T04:55:00+08:00',
      handi: { '-1.5': { a: 1.82, h: 1.68, m: true } },
      total: { '8.5': { o: 1.72, u: 1.78, m: true } },
    }],
  }],
}, schedule);
assert.equal(jbot.games.length, 1);
assert.deepEqual(jbot.games[0].markets.map(row => row.pick), [
  '波士頓紅襪受讓1.5', '多倫多藍鳥讓1.5', '大8.5', '小8.5',
]);
assert.deepEqual(jbot.games[0].markets.map(row => row.water), [0.82, 0.68, 0.72, 0.78]);
assert.ok(jbot.games[0].markets.every(row => row.sourceType === 'REFERENCE' && row.executable === false));

const odds = normalizeOddsApiReference([{
  id: 'ODDS-1', commence_time: '2026-08-11T23:07:00Z', away_team: 'Boston Red Sox', home_team: 'Toronto Blue Jays',
  bookmakers: [
    { last_update: '2026-08-11T20:00:00Z', markets: [
      { key: 'spreads', outcomes: [{ name: 'Boston Red Sox', point: 1.5, price: 1.91 }, { name: 'Toronto Blue Jays', point: -1.5, price: 1.87 }] },
      { key: 'totals', outcomes: [{ name: 'Over', point: 8.5, price: 1.9 }, { name: 'Under', point: 8.5, price: 1.88 }] },
    ] },
    { last_update: '2026-08-11T20:01:00Z', markets: [
      { key: 'spreads', outcomes: [{ name: 'Boston Red Sox', point: 1.5, price: 1.89 }, { name: 'Toronto Blue Jays', point: -1.5, price: 1.89 }] },
      { key: 'totals', outcomes: [{ name: 'Over', point: 8.5, price: 1.88 }, { name: 'Under', point: 8.5, price: 1.9 }] },
    ] },
  ],
}], schedule);
assert.equal(odds.games.length, 1);
assert.deepEqual(odds.games[0].markets.map(row => row.pick), [
  '波士頓紅襪受讓1.5', '多倫多藍鳥讓1.5', '大8.5', '小8.5',
]);
assert.ok(odds.games[0].markets.every(row => row.sourceType === 'INTERNATIONAL'));

assert.equal(referenceProviderStatus({}).configured, false);
assert.equal(referenceProviderStatus({ JBOT_API_TOKEN: 'x' }).primary, 'JBOT_TAIWAN_SPORTS_LOTTERY');
assert.equal(referenceProviderStatus({ THE_ODDS_API_KEY: 'x' }).primary, 'THE_ODDS_API_CONSENSUS');

console.log(JSON.stringify({ ok: true, jbotMarkets: jbot.games[0].markets.length, oddsApiMarkets: odds.games[0].markets.length }, null, 2));
