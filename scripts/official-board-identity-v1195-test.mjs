import assert from 'node:assert/strict';
import { parseKboOfficialSchedulePayload } from '../lib/asian-baseball.js';
import { reconcileOfficialBoardIdentity, isHistoricalIdentityConflict,
  OFFICIAL_BOARD_IDENTITY_MAX_AGE_MS } from '../lib/official-board-identity-v1195.js';

// Actual KBO response shape: availability of the preview link changes the
// current parser's derived PK despite identical teams, start and game number.
const date = '2026-09-06';
const now = Date.parse('2026-09-06T04:00:00.000Z');
const link = "<a href='/Schedule/GameCenter/Main.aspx?gameDate=20260906&gameId=20260906NCWO0&section=PREVIEW'>preview</a>";
const payload = relay => ({ rows: [{ row: [
  { Text: '09.06(日)', Class: 'day' }, { Text: '<b>14:00</b>', Class: 'time' },
  { Text: '<span>NC</span><em>vs</em><span>키움</span>', Class: 'play' },
  { Text: relay, Class: 'relay' }, { Text: '' }, { Text: '' }, { Text: '고척' }, { Text: '-' },
] }] });
const [withLink] = parseKboOfficialSchedulePayload(payload(link), date);
const [withoutLink] = parseKboOfficialSchedulePayload(payload(''), date);
const options = { league: 'KBO', date, identitySlate: [withLink], identityAsOf: new Date(now).toISOString(), now };
const historical = {
  game: withoutLink, status: 'done', readerPayloadHash: 'old-reader-hash',
  latestMarketCoverage: { openMarkets: 4 }, latestReaderSource: { provider: 'TAI888' },
  pendingReaderEvidenceHash: 'old-pending-hash', pendingReaderAnalysis: true,
  resumedCurrentReaderGame: true, preservedCurrentReaderGame: true, readerWaitingHandled: true,
  customMarkets: [{ market: '全場大小', pick: '大8+50', water: 0.95 }],
  customData: { game: structuredClone(withoutLink), pitPersistence: { snapshotId: 'historical-pit-id', confirmed: true },
    analysis: { inputHash: 'historical-input', distributionHash: 'historical-distribution',
      results: [{ weightedEV: 0.12, robustEV: -0.004, formulaDiagnosticScore: 7.1 }], qa: { status: 'PASS' } } },
  referenceData: { analysis: { results: [{ weightedEV: -0.04, robustEV: -0.09, formulaDiagnosticScore: 5.3 }] } },
};
const board = [historical];
let checks = 0;
const test = (name, fn) => { fn(); checks++; console.log(`PASS ${name}`); };
let isolated;

test('real KBO parser link-present and link-absent produce the observed divergent PKs', () => {
  assert.equal(withLink.gamePk, 1099424697962592);
  assert.equal(withoutLink.gamePk, 188899822811850);
  for (const game of [withLink, withoutLink]) {
    assert.equal(game.awayTeamId, 609); assert.equal(game.homeTeamId, 610);
    assert.equal(game.gameDate, '2026-09-06T05:00:00.000Z'); assert.equal(game.gameNumber, 1);
  }
});

test('one uniquely identical official game quarantines the old PK without aliasing immutable data', () => {
  const serialized = JSON.stringify(board);
  isolated = reconcileOfficialBoardIdentity(board, options);
  assert.notEqual(isolated, board); assert.equal(isHistoricalIdentityConflict(isolated[0]), true);
  assert.equal(isolated[0].identityConflict.officialGamePk, withLink.gamePk);
  assert.equal(isolated[0].identityConflict.historicalGamePk, withoutLink.gamePk);
  assert.equal(isolated[0].identityConflict.verifiedAt, options.identityAsOf);
  assert.equal(isolated[0].game, historical.game);
  assert.equal(isolated[0].customData, historical.customData);
  assert.equal(isolated[0].referenceData, historical.referenceData);
  assert.equal(isolated[0].customMarkets, historical.customMarkets);
  assert.deepEqual(isolated[0].customData, historical.customData);
  assert.equal(JSON.stringify(board), serialized, 'No original object is mutated.');
  for (const field of ['readerPayloadHash', 'latestMarketCoverage', 'latestReaderSource', 'pendingReaderEvidenceHash']) assert.equal(isolated[0][field], null);
  for (const field of ['pendingReaderAnalysis', 'resumedCurrentReaderGame', 'preservedCurrentReaderGame', 'readerWaitingHandled']) assert.equal(isolated[0][field], false);
});

test('identical fresh evidence and later heartbeats are reference-idempotent', () => {
  assert.equal(reconcileOfficialBoardIdentity(isolated, options), isolated);
  assert.equal(reconcileOfficialBoardIdentity(isolated, { ...options, now: now + 1000, identityAsOf: new Date(now + 1000).toISOString() }), isolated);
  assert.equal(reconcileOfficialBoardIdentity(board, { ...options, identitySlate: [withoutLink] }), board);
  const authorityReturned = [{ ...isolated[0], readerPayloadHash: 'incorrectly-reactivated' }];
  const cleared = reconcileOfficialBoardIdentity(authorityReturned, options);
  assert.equal(cleared[0].readerPayloadHash, null);
  assert.equal(cleared[0].identityConflict, isolated[0].identityConflict);
});

test('a doubleheader number, changed start or reversed teams cannot be inferred to be the same game', () => {
  for (const patch of [{ gameNumber: 2 }, { gameDate: '2026-09-06T06:00:00Z' },
    { awayTeamId: 610, homeTeamId: 609 }, { awayTeamId: 608 }, { homeTeamId: 607 }]) {
    assert.equal(reconcileOfficialBoardIdentity(board, { ...options, identitySlate: [{ ...withLink, ...patch }] }), board);
  }
  const doubleheaderSlate = [withLink, { ...withLink, gamePk: withLink.gamePk + 1, gameNumber: 2 }];
  assert.equal(isHistoricalIdentityConflict(reconcileOfficialBoardIdentity(board, { ...options, identitySlate: doubleheaderSlate })[0]), true);
  const zoneEquivalent = { ...withLink, gameDate: '2026-09-06T13:00:00+08:00' };
  assert.equal(isHistoricalIdentityConflict(reconcileOfficialBoardIdentity(board, { ...options, identitySlate: [zoneEquivalent] })[0]), true);
});

test('wrong league/date, blank numeric values and malformed official records provide no authority', () => {
  for (const patch of [{ league: 'MLB' }, { leagueId: 'NPB' }, { taipeiDate: '2026-09-05' },
    { gamePk: null }, { gamePk: ' ' }, { gamePk: true }, { awayTeamId: null }, { awayTeamId: '' },
    { homeTeamId: 0 }, { homeTeamId: [] }, { gameNumber: null }, { gameNumber: 0 }, { gameNumber: 1.5 },
    { gameDate: '2026-09-06T05:00:00' }, { gameDate: '2026-02-30T05:00:00Z' },
    { startTimeUTC: '2026-09-06T06:00:00Z' }]) {
    const invalid = { ...options, identitySlate: [{ ...withLink, ...patch }] };
    assert.equal(reconcileOfficialBoardIdentity(board, invalid), board, JSON.stringify(patch));
    assert.equal(reconcileOfficialBoardIdentity(isolated, invalid), isolated, 'Insufficient evidence must not erase existing quarantine.');
  }
  assert.equal(reconcileOfficialBoardIdentity(board, { ...options, league: 'NPB' }), board);
  assert.equal(reconcileOfficialBoardIdentity(board, { ...options, date: '2026-09-05' }), board);
});

test('empty, ambiguous, partially malformed or failed full-slate evidence cannot change isolation', () => {
  for (const identitySlate of [[], null, { ok: false, games: [withLink] }, [withLink, withLink],
    [withLink, { ...withLink, gamePk: withLink.gamePk + 1 }], [withLink, null],
    [withLink, { ...withLink, gamePk: withLink.gamePk + 1, gameNumber: null }]]) {
    assert.equal(reconcileOfficialBoardIdentity(board, { ...options, identitySlate }), board);
    assert.equal(reconcileOfficialBoardIdentity(isolated, { ...options, identitySlate }), isolated);
  }
});

test('stale/future evidence and invalid clocks do not create or remove quarantine', () => {
  for (const patch of [{ identityAsOf: new Date(now + 1).toISOString() },
    { identityAsOf: new Date(now - OFFICIAL_BOARD_IDENTITY_MAX_AGE_MS - 1).toISOString() },
    { identityAsOf: null }, { identityAsOf: '2026-09-06T04:00:00' }, { now: NaN }]) {
    assert.equal(reconcileOfficialBoardIdentity(board, { ...options, ...patch }), board);
    assert.equal(reconcileOfficialBoardIdentity(isolated, { ...options, ...patch }), isolated);
  }
});

test('old PK reappearance with matching identity releases quarantine but never revives old Reader authority', () => {
  const restored = reconcileOfficialBoardIdentity(isolated, { ...options, identitySlate: [withoutLink] });
  assert.equal(isHistoricalIdentityConflict(restored[0]), false);
  assert.equal(restored[0].identityConflict, null);
  assert.equal(restored[0].readerPayloadHash, null);
  assert.equal(restored[0].latestMarketCoverage, null);
  assert.equal(restored[0].game, historical.game);
  assert.equal(restored[0].customData, historical.customData);
  assert.equal(reconcileOfficialBoardIdentity(restored, { ...options, identitySlate: [withoutLink] }), restored);
  assert.equal(reconcileOfficialBoardIdentity(isolated, { ...options, identitySlate: [{ ...withoutLink, gameNumber: 2 }] }), isolated);
});

test('unrelated current board rows remain untouched and the marker remains a narrow display state', () => {
  const current = { ...historical, game: withLink };
  const anotherLeague = { ...historical, game: { ...withoutLink, league: 'MLB', leagueId: 'MLB' } };
  const invalidOld = { ...historical, game: { ...withoutLink, awayTeamId: null } };
  const mixed = reconcileOfficialBoardIdentity([historical, current, anotherLeague, invalidOld], options);
  assert.equal(isHistoricalIdentityConflict(mixed[0]), true);
  assert.equal(mixed[1], current); assert.equal(mixed[2], anotherLeague); assert.equal(mixed[3], invalidOld);
  assert.equal(isHistoricalIdentityConflict({ identityConflict: { status: 'BLOCK' } }), false);
  assert.equal(isHistoricalIdentityConflict(null), false);
});

console.log(`Official board identity v11.9.5: ${checks} reconciliation/isolation groups PASS; original PK/PIT/W/R/S are preserved.`);
