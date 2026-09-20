import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readerWaitingDisplay } from '../lib/reader-waiting-display.js';
import { readerSnapshotPublicView } from '../lib/reader-store-v2.js';

const now = Date.parse('2026-09-20T04:05:00Z');
const game = { league: 'NPB', gamePk: 1164256048044029, gameDate: '2026-09-20T09:00:00Z', awayTeamId: 1, homeTeamId: 2 };
const item = { game, status: 'unopened', statusLabel: 'Reader目前未呈現盤口', customMarkets: [],
  marketCoverage: { openMarkets: 0 }, actualSource: { observedAt: '2026-09-20T04:01:00Z' } };
const snapshot = { league: 'NPB', boardDate: '2026-09-20', payloadHash: 'new',
  observedAt: '2026-09-20T04:04:30Z', pageActivityAt: '2026-09-20T04:04:30Z',
  games: [{ gamePk: game.gamePk, game, markets: ['a', 'b', 'c', 'd'].map(market => ({ market, water: 0.9, integrity: 'secret' })) }], unopenedGames: [] };
const view = readerSnapshotPublicView(snapshot, { complete: true, now, league: 'NPB' });
const authority = { ...view, expectedBoardDate: '2026-09-20' };
const original = JSON.stringify(item);
assert.equal(readerWaitingDisplay(item, authority, now).coverage.openMarkets, 4);
assert.match(readerWaitingDisplay(item, authority, now).message, /分析此場/);
assert.equal(JSON.stringify(item), original, 'status polling never mutates saved results or contracts');
assert.equal(readerWaitingDisplay({ ...item, customData: { analysis: { calculatedDirectionCount: 1 } } }, authority, now), null,
  'calculated historical evidence is never replaced by live coverage');
assert.doesNotMatch(JSON.stringify(view.gameAvailability), /water|integrity|secret/);
for (const changes of [{ fresh: false }, { league: 'MLB' }, { boardDate: '2026-09-19' }, { payloadHash: '' },
  { pageActivityAt: '2026-09-20T04:00:00Z' }, { pageActivityAt: '2026-09-20T04:06:00Z' },
  { observedAt: '2026-09-20T04:00:00Z' }, { gameAvailability: [] },
  { gameAvailability: [{ ...view.gameAvailability[0], game: { ...game, awayTeamId: 99 } }] },
  { gameAvailability: [{ ...view.gameAvailability[0], game: { ...game, gameDate: '2026-09-21T09:00:00Z' } }] }]) {
  assert.equal(readerWaitingDisplay(item, { ...authority, ...changes }, now), null);
}
for (const status of ['running', 'queued', 'done', 'failed']) {
  assert.equal(readerWaitingDisplay({ ...item, status }, authority, now), null);
}
assert.equal(readerWaitingDisplay(item, authority, Date.parse(game.gameDate)), null);
for (const complete of [false, true]) {
  assert.deepEqual(readerSnapshotPublicView(snapshot, { complete, now: now + 600_000, league: 'NPB' }).gameAvailability, []);
}
assert.deepEqual(readerSnapshotPublicView(snapshot, { complete: false, now, league: 'NPB' }).gameAvailability, []);
assert.deepEqual(readerSnapshotPublicView(snapshot, { complete: true, now, league: 'MLB' }).gameAvailability, []);
const locked = { ...authority, gameAvailability: [{ game, marketCoverage: { openMarkets: 0 }, unavailableReason: 'locked' }] };
assert.equal(readerWaitingDisplay(item, locked, now).open, false);
assert.match(readerWaitingDisplay(item, locked, now).message, /鎖盤/);
const partial = { ...authority, gameAvailability: [{ game, marketCoverage: { openMarkets: 2 } }] };
assert.match(readerWaitingDisplay(item, partial, now).message, /2\/4/);
const page = fs.readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');
assert.match(page, /const liveWaiting = readerWaitingDisplay\(item, readerAuthority, now\)/);
assert.match(page, /gameAvailability: readerStatus\?\.gameAvailability \|\| \[\]/);
assert.match(page, /onClick=\{\(\) => onRecheck\?\.\(item\)\}>分析此場/);
console.log('Reader waiting display: missing-to-open, partial, locked, freshness, identity and manual-only recovery PASS');
