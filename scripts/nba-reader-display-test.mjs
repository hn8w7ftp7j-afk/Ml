import assert from 'node:assert/strict';
import { matchNbaReaderGame, nbaReaderDisplayStatus } from '../lib/nba/reader-display.js';

const row = { boardDate: '2026-10-05', boardTime: '07:00', away: { id: 'nba:espn:team:2' }, home: { id: 'nba:espn:team:5' } };
const game = { league: 'NBA', id: 'nba:espn:game:123', startTime: '2026-10-04T23:00:00Z', away: row.away, home: row.home };
const schedule = games => ({ league: 'NBA', status: 'ready', qa: { status: 'PASS' }, data: { games } });
assert.equal(matchNbaReaderGame(row, schedule([game])).status, 'matched');
assert.equal(matchNbaReaderGame(row, schedule([{ ...game, startTime: '2026-10-04T23:06:00Z' }])).status, 'conflict');
assert.equal(matchNbaReaderGame(row, schedule([{ ...game, startTime: '2026-10-03T23:00:00Z' }])).status, 'conflict');
assert.equal(matchNbaReaderGame(row, schedule([{ ...game, home: row.away, away: row.home }])).status, 'conflict');
assert.equal(matchNbaReaderGame(row, schedule([{ ...game, league: 'MLB' }])).status, 'conflict');
assert.equal(matchNbaReaderGame(row, schedule([game, { ...game, id: 'nba:espn:game:456' }])).status, 'conflict');
assert.equal(matchNbaReaderGame(row, { ...schedule([game]), qa: { status: 'BLOCK' } }).status, 'unverified');
assert.equal(matchNbaReaderGame(row, { ...schedule([game]), status: 'partial' }).status, 'unverified');
assert.equal(matchNbaReaderGame(row, schedule([])).status, 'conflict');
assert.equal(matchNbaReaderGame(row, null).status, 'unverified');

const now = Date.parse('2026-10-04T22:00:00Z');
assert.equal(nbaReaderDisplayStatus(null, now), 'waiting');
assert.equal(nbaReaderDisplayStatus({ status: 'fresh', observedAt: new Date(now).toISOString() }, now), 'fresh');
assert.equal(nbaReaderDisplayStatus({ status: 'fresh', observedAt: new Date(now - 301_000).toISOString() }, now), 'stale');
assert.equal(nbaReaderDisplayStatus({ status: 'fresh', observedAt: new Date(now - 181_000).toISOString() }, now), 'stale');
assert.equal(nbaReaderDisplayStatus({ status: 'fresh', observedAt: new Date(now).toISOString(), pageActivityAt: new Date(now - 181_000).toISOString() }, now), 'stale');
assert.equal(nbaReaderDisplayStatus({ status: 'stale', observedAt: new Date(now).toISOString() }, now), 'stale');
assert.equal(nbaReaderDisplayStatus({ status: 'fresh', observedAt: new Date(now + 10_000).toISOString() }, now), 'stale');
console.log('NBA Reader display: Taipei date/time, home/away, league, ambiguous event and freshness checks passed');
