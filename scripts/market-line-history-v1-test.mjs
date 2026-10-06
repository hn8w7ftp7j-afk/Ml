import assert from 'node:assert/strict';
import {
  MARKET_LINE_HISTORY_VERSION,
  buildMarketLineHistoryRows,
  marketLineHistoryStorageBytes,
} from '../lib/market-line-history-v1.js';

const hash = value => String(value).repeat(64).slice(0, 64);
const baseball = {
  league: 'MLB',
  boardDate: '2026-10-06',
  pageActivityAt: '2026-10-06T12:00:00.000Z',
  readerVersion: '2.1.28',
  rawBoardHash: hash('a'),
  games: [{
    gamePk: 777,
    marketStatus: 'open',
    markets: [
      { market: '全場讓分', pick: 'NYY讓1+60', water: 1.06 },
      { market: '全場讓分', pick: 'BOS受讓1+60', water: 0.94 },
      { market: '全場大小', pick: '大8+20', water: 0.98 },
      { market: '全場大小', pick: '小8+20', water: 1.02 },
      { market: '上半讓分', pick: 'NYY讓0.5', water: 0.92 },
      { market: '上半讓分', pick: 'BOS受讓0.5', water: 1.08 },
      { market: '上半大小', pick: '大4平', water: 0.96 },
      { market: '上半大小', pick: '小4平', water: 1.04 },
    ],
  }],
};

const first = buildMarketLineHistoryRows(baseball);
assert.equal(MARKET_LINE_HISTORY_VERSION, 'TAI888-LINE-HISTORY-v1.0.0');
assert.equal(first.length, 1);
assert.equal(first[0].game_key, '777');
assert.equal(first[0].game_pk, 777);
assert.equal(first[0].source_hash.length, 32);
assert.ok(first[0].markets.length < 300, 'full eight-direction state must remain compact');
assert.ok(marketLineHistoryStorageBytes(baseball) < 400, 'one changed game should remain well below 0.4 KB payload estimate');
assert.equal(first[0].markets.includes('rawText'), false);

const heartbeat = buildMarketLineHistoryRows({
  ...baseball,
  pageActivityAt: '2026-10-06T12:01:00.000Z',
});
assert.equal(heartbeat[0].state_hash, first[0].state_hash, 'timestamp-only heartbeat must not change state hash');

const changed = structuredClone(baseball);
changed.pageActivityAt = '2026-10-06T12:02:00.000Z';
changed.games[0].markets[0].water = 1.08;
const changedRows = buildMarketLineHistoryRows(changed);
assert.notEqual(changedRows[0].state_hash, first[0].state_hash, 'price change must create a new state hash');

const reordered = structuredClone(baseball);
reordered.games[0].markets.reverse();
assert.equal(buildMarketLineHistoryRows(reordered)[0].state_hash, first[0].state_hash, 'row order must not create false history');

const locked = structuredClone(baseball);
locked.games[0].marketStatus = 'locked';
locked.games[0].markets = [];
assert.equal(buildMarketLineHistoryRows(locked).length, 0, 'locked rows without prices must not replace the prestart closing state');

const nba = {
  league: 'NBA',
  boardDate: '2026-10-06',
  pageActivityAt: '2026-10-06T13:00:00.000Z',
  readerVersion: '2.1.28',
  clientPayloadHash: hash('b'),
  games: [{
    boardTime: '19:30',
    awayCode: 'LAL',
    homeCode: 'GSW',
    marketStatus: 'open',
    fullRunline: { lineSide: 'home', line: '2+50', awayWater: 0.94, homeWater: 1.06 },
    fullTotal: { line: '224.5', overWater: 0.98, underWater: 1.02 },
    firstHalfRunline: { lineSide: 'away', line: '1+20', awayWater: 1.03, homeWater: 0.97 },
    firstHalfTotal: { line: '112.5', overWater: 0.96, underWater: 1.04 },
  }],
};
const nbaRows = buildMarketLineHistoryRows(nba);
assert.equal(nbaRows.length, 1);
assert.equal(nbaRows[0].game_key, '19:30|LAL|GSW');
assert.equal(nbaRows[0].game_pk, null);
const nextDayNba = structuredClone(nba);
nextDayNba.boardDate = '2026-10-07';
nextDayNba.games[0].boardDate = '2026-10-07';
nextDayNba.pageActivityAt = '2026-10-07T13:00:00.000Z';
const nextDayRows = buildMarketLineHistoryRows(nextDayNba);
assert.equal(nextDayRows[0].game_key, nbaRows[0].game_key, 'compact NBA key may repeat across dates because board_date is a separate identity dimension');
assert.notEqual(nextDayRows[0].board_date, nbaRows[0].board_date, 'board_date must isolate repeated NBA matchup/time keys');
assert.ok(nbaRows[0].markets.length < 150, 'NBA direct market representation should be very compact');
assert.ok(marketLineHistoryStorageBytes(nba) < 250);

console.log('compact Tai888 market line history: change-only state hashing and low-capacity encoding PASS');
