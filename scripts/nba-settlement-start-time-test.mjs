import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { crosswalkOfficialGame, findOfficialGame, loadOfficialNbaEvidence } from '../lib/nba/official.js';
import { normalizeNbaManualBetRecord } from '../lib/nba/manual-bet-record.js';
import { nbaManualContractHash, settleNbaManualBet } from '../lib/nba/manual-bet-settlement.js';
import { settleOpenNbaManualRecords } from '../lib/nba/manual-bet-settlement-service.js';

const fixtures = ['401909090', '401898717'].map(id => JSON.parse(fs.readFileSync(
  new URL(`./fixtures/nba-settlement-start-time-${id}.json`, import.meta.url), 'utf8')));
const now = Date.parse('2026-11-07T23:00:00.000Z');
const clone = value => structuredClone(value);
const card = fixture => fixture.schedule.gameCardFeed.modules[0].cards[0].cardData;
const wrapper = pageProps => `<script id="__NEXT_DATA__">${JSON.stringify({ props: { pageProps } })}</script>`;
function fetchFixture(fixture) {
  return async url => {
    const parsed = new URL(url);
    if (parsed.pathname === '/games') return new Response(wrapper(fixture.schedule));
    assert.equal(url, `${card(fixture).shareUrl}/box-score`, 'box-score must use the official verified URL');
    return new Response(wrapper(fixture.box));
  };
}
async function evidence(fixture, expectedScheduledStartTime = fixture.contract.startTime) {
  return loadOfficialNbaEvidence(fixture.game, [], {
    now: () => now, fetchImpl: fetchFixture(fixture), expectedScheduledStartTime,
  });
}
function originalRecord(fixture) {
  return { ...normalizeNbaManualBetRecord(fixture.contract),
    id: '11111111-1111-4111-8111-111111111111', status: 'OPEN',
    recordedAt: fixture.contract.startTime };
}
function resultFor(fixture) {
  return { data: { game: clone(fixture.game) }, sources: [{
    provider: 'ESPN', url: fixture.provenance[0].url,
    hash: fixture.provenance[0].sha256, status: 'ready', fetchedAt: new Date(now).toISOString(),
  }] };
}
function assertBlocked(actual, label) {
  assert.ok(!['ready', 'partial'].includes(actual.status), `${label}: must reject the time bridge`);
}

let checks = 0;
for (const fixture of fixtures) {
  const frozen = clone(fixture);
  const record = originalRecord(fixture), original = clone(record), hash = nbaManualContractHash(record);
  const game = fixture.game, expected = fixture.contract.startTime;
  assert.equal(fixture.fixtureFormat, 'public-source-projection-v1');
  assert.ok(fixture.provenance.every(source => /^[a-f0-9]{64}$/.test(source.sha256)));
  assert.notEqual(Date.parse(game.startTime), Date.parse(expected));
  assert.equal(Date.parse(card(fixture).gameTimeUtc), Date.parse(expected));
  assert.equal(Date.parse(fixture.box.game.gameTimeUTC), Date.parse(expected));

  // Public historical evidence has three different meanings. Neither the
  // provider-reported time nor the contract is rewritten as an actual tipoff.
  assert.ok(Date.parse(expected) < Date.parse(game.startTime));
  assert.ok(Date.parse(game.startTime) < Date.parse(card(fixture).actualStartTimeUTC));
  assert.equal(game.season.year, 2027);

  const strict = await loadOfficialNbaEvidence(game, [], { now: () => now, fetchImpl: fetchFixture(fixture) });
  assert.equal(strict.status, 'blocked', 'ordinary API/analysis crosswalk remains strict without contract context');
  assert.equal(strict.code, 'OFFICIAL_GAME_CONFLICT');
  const missingTimes = clone(fixture);
  missingTimes.game.startTime = null;
  card(missingTimes).gameTimeUtc = null;
  missingTimes.box.game.gameTimeUTC = null;
  assert.throws(() => findOfficialGame(missingTimes.schedule, missingTimes.game, missingTimes.schedule.selectedDate),
    error => error.code === 'OFFICIAL_GAME_CONFLICT', 'two invalid times must never become an equal-time identity match');
  assert.throws(() => crosswalkOfficialGame(missingTimes.box.game, card(missingTimes), missingTimes.game, []),
    error => error.code === 'OFFICIAL_GAME_CONFLICT', 'invalid provider/box times must remain blocked without context');
  checks += 2;

  const verified = await evidence(fixture);
  assert.ok(['ready', 'partial'].includes(verified.status), `${game.id}: exact scheduled contract must be recoverable`);
  assert.equal(verified.officialGameId, fixture.box.game.gameId);
  assert.equal(verified.sources.length, 2);
  const proof = verified.startTimeVerification;
  assert.equal(proof.status, 'verified');
  assert.equal(proof.timeBasis, 'official_schedule_and_box_score_contract');
  assert.equal(proof.matchingBasis, 'unique_same_day_matchup_official_schedule_and_complete_final_period_scores');
  assert.equal(proof.gameId, game.id);
  assert.equal(proof.officialGameId, fixture.box.game.gameId);
  assert.equal(Date.parse(proof.contractScheduledStartTime), Date.parse(expected));
  assert.equal(Date.parse(proof.officialScheduledStartTime), Date.parse(expected));
  assert.equal(Date.parse(proof.boxScheduledStartTime), Date.parse(expected));
  assert.equal(Date.parse(proof.providerReportedStartTime), Date.parse(game.startTime));
  assert.equal(Date.parse(proof.officialActualStartTime), Date.parse(card(fixture).actualStartTimeUTC));
  assert.equal(Date.parse(proof.officialActualEndTime), Date.parse(card(fixture).actualEndTimeUTC));
  assert.equal(proof.sourceRefs.length, 2);
  for (const source of verified.sources) assert.ok(proof.sourceRefs.some(ref => ref.url === source.url && ref.hash === source.hash));

  const result = resultFor(fixture), settlement = settleNbaManualBet(record, result, verified, now);
  assert.equal(settlement.status, 'SETTLED');
  assert.equal(settlement.result, 'WIN');
  assert.equal(settlement.profit, 9650);
  assert.equal(settlement.contractHash, hash);
  assert.deepEqual(settlement.startTimeVerification, proof, 'settlement preserves all time evidence and source references');
  assert.notEqual(settlement.startTimeVerification, proof, 'saved evidence is copied rather than aliased');
  if (game.sourceId === '401898717') assert.equal(proof.espnGameIdCrossReference?.gameId, game.id);
  else assert.equal(proof.espnGameIdCrossReference, null, 'no direct cross-provider ID is invented for NBC game');
  assert.deepEqual(record, original, 'original contract and original scheduled time stay immutable');
  assert.deepEqual(fixture, frozen, 'source projections stay immutable');
  assert.equal(settleNbaManualBet(record, result, strict, now).status, 'PENDING');
  assert.equal(settleNbaManualBet({ ...record, startTime: '2026-10-01T00:00:00Z' }, result, verified, now).status, 'PENDING');

  const badEvidence = [
    ['missing proof', e => delete e.startTimeVerification],
    ['unverified proof', e => { e.startTimeVerification.status = 'unverified'; }],
    ['foreign provider game ID', e => { e.startTimeVerification.gameId = 'nba:espn:game:999999999'; }],
    ['foreign official game ID', e => { e.startTimeVerification.officialGameId = '0022600999'; }],
    ['different contract time', e => { e.startTimeVerification.contractScheduledStartTime = '2026-10-01T00:00:00Z'; }],
    ['different official scheduled time', e => { e.startTimeVerification.officialScheduledStartTime = '2026-10-01T00:00:00Z'; }],
    ['different box scheduled time', e => { e.startTimeVerification.boxScheduledStartTime = '2026-10-01T00:00:00Z'; }],
    ['different provider time', e => { e.startTimeVerification.providerReportedStartTime = '2026-10-01T00:00:00Z'; }],
    ['different direct provider ID', e => { e.startTimeVerification.espnGameIdCrossReference = { provider: 'ESPN', gameId: 'nba:espn:game:999999999', basis: 'official_broadcaster_espn_game_id' }; }],
    ['future actual end', e => { e.startTimeVerification.officialActualEndTime = new Date(now + 1000).toISOString(); }],
    ['unknown matching basis', e => { e.startTimeVerification.matchingBasis = 'same_team_guess'; }],
    ['missing source refs', e => { e.startTimeVerification.sourceRefs = []; }],
    ['changed source hash', e => { e.startTimeVerification.sourceRefs[0].hash = 'f'.repeat(64); }],
    ['changed evidence source hash', e => { e.sources[0].hash = 'f'.repeat(64); }],
    ['stale official source', e => { e.sources[0].status = 'stale'; }],
    ['expired official source', e => { e.sources[0].fetchedAt = new Date(now - 16 * 60000).toISOString(); }],
  ];
  for (const [label, mutate] of badEvidence) {
    const changed = clone(verified); mutate(changed);
    assert.equal(settleNbaManualBet(record, result, changed, now).status, 'PENDING', label); checks++;
  }

  const badSources = [
    ['live game', f => { f.game.status = 'live'; f.game.completed = false; }],
    ['scheduled game', f => { f.game.status = 'scheduled'; f.game.completed = false; }],
    ['final flag missing', f => { f.game.completed = false; }],
    ['wrong selected date', f => { f.schedule.selectedDate = '2026-01-01'; }],
    ['provider Taipei date differs from its source time', f => { f.game.taipeiDate = '2026-01-01'; }],
    ['different official league', f => { card(f).leagueId = '10'; }],
    ['different official season year', f => { card(f).seasonYear = '2025-26'; }],
    ['unknown official season type', f => { card(f).seasonType = 'Unknown'; }],
    ['two same-day candidate games', f => { f.schedule.gameCardFeed.modules[0].cards.push(clone(f.schedule.gameCardFeed.modules[0].cards[0])); }],
    ['schedule not final', f => { card(f).gameStatus = 2; }],
    ['box not final', f => { f.box.game.gameStatus = 2; }],
    ['box ID conflict', f => { f.box.game.gameId = '0022600999'; }],
    ['schedule and box time conflict', f => { f.box.game.gameTimeUTC = new Date(Date.parse(f.contract.startTime) + 1000).toISOString(); }],
    ['schedule and contract time conflict', f => { card(f).gameTimeUtc = new Date(Date.parse(f.contract.startTime) + 1000).toISOString(); }],
    ['missing actual start', f => { delete card(f).actualStartTimeUTC; }],
    ['invalid actual start', f => { card(f).actualStartTimeUTC = 'invalid'; }],
    ['actual start missing explicit timezone', f => { card(f).actualStartTimeUTC = card(f).actualStartTimeUTC.replace(/Z$/, ''); }],
    ['actual start before schedule', f => { card(f).actualStartTimeUTC = new Date(Date.parse(f.contract.startTime) - 1000).toISOString(); }],
    ['missing actual end', f => { delete card(f).actualEndTimeUTC; }],
    ['actual end before actual start', f => { card(f).actualEndTimeUTC = new Date(Date.parse(card(f).actualStartTimeUTC) - 1000).toISOString(); }],
    ['provider time before scheduled boundary', f => { f.game.startTime = new Date(Date.parse(f.contract.startTime) - 1000).toISOString(); }],
    ['provider time beyond actual boundary', f => { f.game.startTime = new Date(Date.parse(card(f).actualStartTimeUTC) + 1000).toISOString(); }],
    ['official team conflict', f => { f.box.game.homeTeam.teamTricode = 'BOS'; }],
    ['official total score conflict', f => { f.box.game.homeTeam.score++; }],
    ['official box period conflict', f => { f.box.game.homeTeam.periods[0].score++; f.box.game.homeTeam.periods[1].score--; }],
    ['official box period numbering conflict', f => { f.box.game.homeTeam.periods[0].period = 2; }],
    ['official schedule period conflict', f => { card(f).homeTeam.periods[0].score++; card(f).homeTeam.periods[1].score--; }],
    ['official schedule period numbering conflict', f => { card(f).homeTeam.periods[0].period = 2; }],
    ['official schedule total score conflict', f => { card(f).homeTeam.score++; }],
    ['all three sources incomplete but otherwise agreeing', f => {
      for (const side of ['home', 'away']) {
        for (const team of [f.game[side], card(f)[`${side}Team`], f.box.game[`${side}Team`]]) {
          const periods = team.periodScores || team.periods;
          periods.pop(); team.score = periods.reduce((sum, p) => sum + p.score, 0);
        }
      }
    }],
    ['official period count differs between teams', f => { f.box.game.homeTeam.periods.push({ period: 5, score: 0 }); }],
    ['negative period score with unchanged total', f => {
      const periods = card(f).homeTeam.periods;
      periods[1].score += periods[0].score + 1; periods[0].score = -1;
    }],
    ['contradictory direct ESPN reference', f => { card(f).broadcasters.nationalBroadcasters = [{ broadcasterVideoLink: 'https://espn.smart.link/b4uxwf8ow?gameId=999999999' }]; }],
    ['ambiguous direct ESPN reference', f => { card(f).broadcasters.nationalBroadcasters = [{ broadcasterVideoLink: `https://espn.smart.link/b4uxwf8ow?gameId=${f.game.sourceId}&gameId=999999999` }]; }],
  ];
  for (const [label, mutate] of badSources) {
    const changed = clone(fixture); mutate(changed);
    assertBlocked(await evidence(changed), `${game.id}: ${label}`); checks++;
  }

  // The accepted interval comes from this game's two official clock markers,
  // rather than a new fixed allowance of 15, 20, 30 or 60 minutes.
  const delayed = clone(fixture);
  delayed.game.startTime = new Date(Date.parse(expected) + 80 * 60000).toISOString();
  card(delayed).actualStartTimeUTC = new Date(Date.parse(expected) + 4 * 3600000).toISOString();
  card(delayed).actualEndTimeUTC = new Date(Date.parse(expected) + 6 * 3600000).toISOString();
  const delayedEvidence = await evidence(delayed);
  assert.ok(['ready', 'partial'].includes(delayedEvidence.status));
  assert.equal(settleNbaManualBet(record, resultFor(delayed), delayedEvidence, now).status, 'SETTLED');
  const missingTimezone = await evidence(fixture, expected.replace(/Z$/, ''));
  assertBlocked(missingTimezone, 'contract context requires explicit timezone');

  // A unique contract context is part of the real service call. Mock archive
  // callbacks exercise the read/verify boundary without any database writes.
  let archives = 0, loads = 0;
  const requestedContexts = [];
  const wrongContract = { ...record, id: '22222222-2222-4222-8222-222222222222', startTime: new Date(Date.parse(expected) + 60000).toISOString() };
  const records = [record, wrongContract], recordsBefore = clone(records);
  const summary = await settleOpenNbaManualRecords({
    now: () => now,
    list: async () => records,
    load: async () => { loads++; return result; },
    official: async (sourceGame, players, options) => {
      requestedContexts.push(options?.expectedScheduledStartTime);
      return loadOfficialNbaEvidence(sourceGame, players, { ...options, now: () => now, fetchImpl: fetchFixture(fixture) });
    },
    archive: async (sourceRecord, saved) => { archives++; assert.equal(sourceRecord.id, record.id); return { settlement: saved }; },
  });
  assert.equal(loads, 1);
  assert.equal(archives, 1);
  assert.equal(summary.settled, 1);
  assert.equal(summary.pending, 1);
  assert.deepEqual(new Set(requestedContexts), new Set(records.map(row => row.startTime)));
  assert.deepEqual(records, recordsBefore);
  checks += 16;
}

// Execute the shipped read-only GET route with its network boundaries injected.
// This also proves that a diagnostic query never invokes the settlement writer.
const routeSource = fs.readFileSync(new URL('../app/api/nba/official/route.js', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '').replace(/export const /g, 'const ')
  .replace(/export async function /g, 'async function ');
let authorized = true, allowed = true, dataCalls = 0, officialCalls = 0, passedOptions;
let routeData = { data: { game: fixtures[0].game, players: [] }, qa: { status: 'WARNING' } };
const context = vm.createContext({ URL, Date,
  NextResponse: { json: (body, options) => Response.json(body, options) },
  requireApiAuth: async () => authorized ? null : Response.json({}, { status: 401 }),
  checkRateLimit: () => ({ allowed, retryAfter: 5 }),
  loadNbaData: async query => { dataCalls++; assert.equal(query.view, 'game'); assert.equal(query.id, '401909090'); return routeData; },
  loadOfficialNbaEvidence: async (game, players, options) => {
    officialCalls++; passedOptions = options;
    assert.equal(game, routeData.data.game);
    if (options.expectedScheduledStartTime === undefined) assert.equal(players, routeData.data.players);
    else { assert.ok(Array.isArray(players)); assert.equal(players.length, 0); }
    return { status: 'partial', gameId: game.id };
  },
});
vm.runInContext(`${routeSource};globalThis.shippedGET=GET;`, context);
const get = query => context.shippedGET(new Request(`https://fixture.invalid/api/nba/official?${query}`));
const idQuery = 'id=401909090';
assert.equal((await get(idQuery)).status, 200);
assert.equal(passedOptions.expectedScheduledStartTime, undefined);
const scheduledQuery = `${idQuery}&scheduledStartTime=${encodeURIComponent(fixtures[0].contract.startTime)}`;
const diagnosticResponse = await get(scheduledQuery);
assert.equal(diagnosticResponse.status, 200);
assert.equal(diagnosticResponse.headers.get('Cache-Control'), 'no-store');
assert.equal(passedOptions.expectedScheduledStartTime, fixtures[0].contract.startTime);

const invalidQueries = [
  `${idQuery}&scheduledStartTime=invalid`,
  `${idQuery}&scheduledStartTime=2026-10-21T01%3A30%3A00`,
  `${idQuery}&scheduledStartTime=2026-10-21T01%3A30%3A00Z`,
  `${idQuery}&scheduledStartTime=2026-02-30T01%3A30%3A00.000Z`,
  `${idQuery}&scheduledStartTime=2026-10-21T24%3A30%3A00.000Z`,
  `${scheduledQuery}&scheduledStartTime=${encodeURIComponent(fixtures[0].contract.startTime)}`,
  'id=nba%3Aespn%3Agame%3A401909090',
  `${idQuery}&league=NHL`,
];
for (const query of invalidQueries) {
  const before = dataCalls;
  assert.equal((await get(query)).status, 400, query);
  assert.equal(dataCalls, before, 'bad query must not reach upstream data'); checks++;
}
for (const data of [
  { data: { game: fixtures[0].game, players: [] }, qa: { status: 'BLOCK' } },
  { data: { game: null, players: [] }, qa: { status: 'WARNING' } },
]) {
  const before = officialCalls; routeData = data;
  assert.equal((await get(scheduledQuery)).status, 502);
  assert.equal(officialCalls, before, 'unverified provider identity must not reach official crosswalk'); checks++;
}
authorized = false;
let before = dataCalls;
assert.equal((await get(scheduledQuery)).status, 401);
assert.equal(dataCalls, before);
authorized = true; allowed = false; before = dataCalls;
const limited = await get(scheduledQuery);
assert.equal(limited.status, 429);
assert.equal(limited.headers.get('Retry-After'), '5');
assert.equal(dataCalls, before);
checks += 7;

console.log(`NBA scheduled/provider/actual time evidence PASS: ${checks} checks, 2 real public source projections, strict ordinary crosswalk, exact contract context, complete final score identity, read-only GET route, no time tolerance and no financial writes`);
