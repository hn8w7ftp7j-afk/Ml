import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { soccerDate } from '../lib/soccer/contracts.js';
import { soccerSqlFixture } from './helpers/soccer-sql-fixture.mjs';
import { fetchSoccerTeamXg, normalizeSoccerTeamXg, soccerTeamXgDocumentProof, getSoccerTeamXgProvider, SOCCER_TEAM_XG_SOURCE_URL } from '../lib/soccer/team-xg.js';
import { archiveSoccerTeamXg, loadSoccerTeamXgDocument, unavailableSoccerTeamXgArchive,
  SOCCER_TEAM_XG_DOCUMENT_MAX_BYTES } from '../lib/soccer/team-xg-store.js';

const fixture = await soccerSqlFixture(), { db } = fixture;
const keys = ['DATABASE_URL', 'DATABASE_V2_URL'], oldEnv = Object.fromEntries(keys.map(key => [key, process.env[key]]));
process.env.DATABASE_URL = 'postgres://fixture.invalid/soccer-team-xg'; delete process.env.DATABASE_V2_URL;
const html = fs.readFileSync(new URL('./fixtures/soccer/opta-epl-20261028.html', import.meta.url), 'utf8');
const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');
const iso = value => new Date(value).toISOString();
function gameFor(kickoff = Date.now() + 3600000) {
  return { id: 'soccer:epl:999999', sourceId: '999999', league: 'epl', date: soccerDate(iso(kickoff)),
    startTime: iso(kickoff), status: 'scheduled', neutralSite: false,
    home: { id: 'soccer:epl:team:363', sourceId: '363', name: 'Chelsea' },
    away: { id: 'soccer:epl:team:360', sourceId: '360', name: 'Manchester United' } };
}
let fetchCalls = 0;
function transport(body = html, expectedUrl = SOCCER_TEAM_XG_SOURCE_URL) {
  return async url => {
    fetchCalls++; assert.equal(String(url), expectedUrl);
    const response = new Response(body, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    Object.defineProperty(response, 'url', { value: expectedUrl });
    return response;
  };
}
async function fetched(game = gameFor(), fetchImpl = transport()) {
  const value = await fetchSoccerTeamXg(game, { fetchImpl });
  assert.equal(value.ok, true, JSON.stringify(value)); return value;
}
try {
  const game = gameFor(), fetchImpl = transport(), first = await fetched(game, fetchImpl), beforeArchive = JSON.stringify(first);
  assert.equal(beforeArchive.includes(html), false, 'private source body cannot serialize into the compact result');
  const receipt = await archiveSoccerTeamXg(first);
  assert.equal(receipt.status, 'ARCHIVED'); assert.equal(receipt.persisted, true); assert.equal(receipt.prematchReceipt, true);
  assert.equal(receipt.representation, 'DECODED_HTML_TEXT_DOCUMENT'); assert.equal(receipt.serialization, 'UTF8_DECODED_HTTP_RESPONSE_TEXT');
  assert.equal(receipt.contentHash, hash(html)); assert.equal(receipt.documentBytes, Buffer.byteLength(html, 'utf8'));
  assert.equal(receipt.decodedDocumentHashRecomputed, true); assert.equal(receipt.rawSourceHashRecomputed, false);
  assert.equal(receipt.sourcePublishedAt, null); assert.equal(receipt.sourceUpdatedAt, first.source.sourceUpdatedAt);
  assert.equal(receipt.historicalAvailabilityVerified, false); assert.equal(receipt.independentlyConfirmed, false); assert.equal(receipt.formalEligible, false);
  assert.equal(receipt.gameId, game.id); assert.equal(receipt.league, 'epl'); assert.equal(receipt.season, first.season);
  assert.deepEqual(receipt.competition, first.competition); assert.deepEqual(receipt.teamIds, { home: '363', away: '360' });
  assert.ok(Date.parse(receipt.recordedAt) >= Date.parse(first.source.availableAt));
  assert.ok(JSON.stringify(receipt).length < 2500); assert.equal(Object.hasOwn(receipt, 'document'), false);
  assert.equal(JSON.stringify(first), beforeArchive, 'the archive does not rewrite normalized xG, flags or source times');
  const loaded = await loadSoccerTeamXgDocument(receipt.receiptId);
  assert.equal(loaded.document, html); assert.deepEqual(loaded.receipt, receipt);
  const detachedProof = soccerTeamXgDocumentProof(first); detachedProof.text = 'changed'; detachedProof.binding.teamIds.home = '999';
  assert.deepEqual(await archiveSoccerTeamXg(first), receipt, 'retry keeps the immutable first observation clock');
  const callsBeforeCache = fetchCalls, cached = await fetched(game, fetchImpl), cachedReceipt = await archiveSoccerTeamXg(cached);
  assert.equal(fetchCalls, callsBeforeCache, 'actual adapter cache is reused');
  assert.equal(cachedReceipt.receiptId, receipt.receiptId, 'cache reuse is not a new actual fetch receipt');
  const second = await fetched(game, transport()), secondReceipt = await archiveSoccerTeamXg(second);
  assert.notEqual(secondReceipt.receiptId, receipt.receiptId, 'a new transport fetch has its own immutable observation');
  assert.equal(secondReceipt.contentHash, receipt.contentHash); assert.equal(secondReceipt.documentRecordedAt, receipt.documentRecordedAt);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM sports_soccer_team_xg_documents_v1')).rows[0].n, 1);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM sports_soccer_team_xg_observations_v1')).rows[0].n, 2);
  for (const name of ['documents', 'observations']) {
    await assert.rejects(() => db.query(`UPDATE sports_soccer_team_xg_${name}_v1 SET content_hash=content_hash`), /SOCCER_IMMUTABLE_HISTORY/);
    await assert.rejects(() => db.query(`DELETE FROM sports_soccer_team_xg_${name}_v1`), /SOCCER_IMMUTABLE_HISTORY/);
  }
  for (const copy of [structuredClone(first), JSON.parse(JSON.stringify(first)), { ...first },
    { ...first, formalEligible: true, sourceDocumentArchive: receipt }]) {
    const rejected = await archiveSoccerTeamXg(copy); assert.equal(rejected.persisted, false); assert.equal(rejected.status, 'UNAVAILABLE');
  }
  const normalized = normalizeSoccerTeamXg(html, game, first.source, Date.now());
  assert.equal(normalized.ok, true); assert.equal((await archiveSoccerTeamXg(normalized)).persisted, false,
    'pure normalization with genuine-looking source metadata cannot register actual-fetch authority');
  for (const mutate of [
    value => { value.source.contentHash = 'f'.repeat(64); }, value => { value.source.url += '?different=scope'; },
    value => { value.gameId = 'soccer:epl:999998'; }, value => { value.league = 'ucl'; },
    value => { value.date = '2026-01-01'; }, value => { value.startTime = iso(Date.parse(value.startTime) + 60000); },
    value => { value.season = '2025/2026'; }, value => { value.competition.id = 'other'; },
    value => { value.teams.home.sourceId = '360'; }, value => { value.teams.home.optaId = 'other'; },
    value => { value.teams.home.xg += 1; }, value => { value.teams.away.xga += 1; }, value => { value.teams.home.played += 1; },
    value => { value.teams.home.xgPerMatch += 1; }, value => { value.coverage.matchLevel = true; },
    value => { value.sourceEvidence.sourceScopeVerified = false; }, value => { value.sourceEvidence.historicalAvailabilityVerified = true; },
    value => { value.source.sourcePublishedAt = value.source.fetchedAt; }, value => { value.source.scope.field = 'lineup'; },
    value => { value.source.fetchedAt = iso(Date.parse(value.source.fetchedAt) - 1000); },
    value => { value.modelEffectApplied = true; }, value => { value.pointInTimeAvailabilityVerified = true; },
  ]) {
    const altered = await fetched(game); mutate(altered);
    assert.equal((await archiveSoccerTeamXg(altered)).persisted, false, mutate.toString());
  }
  const sourceTime = Date.parse(first.source.fetchedAt);
  const pastGame = gameFor(sourceTime - 1000), past = await fetchSoccerTeamXg(pastGame, { fetchImpl: transport() });
  assert.equal((await archiveSoccerTeamXg(past)).persisted, false, 'new source fetch cannot backfill an old game with a pregame receipt');
  const nearGame = gameFor(Date.now() + 2000), near = await fetched(nearGame);
  const receiptAfterKickoff = await archiveSoccerTeamXg(near, { ensure: async () => {
    // Work crosses the real kickoff clock; do not inject a fake database time.
    while (Date.now() <= Date.parse(nearGame.startTime)) await new Promise(resolve => setTimeout(resolve, 20));
  } });
  assert.equal(receiptAfterKickoff.status, 'ARCHIVED'); assert.equal(receiptAfterKickoff.prematchReceipt, false);
  assert.equal(receiptAfterKickoff.timingStatus, 'AFTER_KICKOFF_DATABASE_RECEIPT');
  assert.equal(receiptAfterKickoff.documentRecordedAt, receipt.documentRecordedAt, 'dedup must never borrow the old document clock as this fetch receipt');
  const futureClock = Date.now() + 60000, futureSource = await fetchSoccerTeamXg(gameFor(futureClock + 3600000), { fetchImpl: transport(), now: () => futureClock });
  assert.equal(futureSource.ok, true, 'the transport fixture deliberately supplies a future adapter clock');
  assert.equal((await archiveSoccerTeamXg(futureSource)).persisted, false, 'the archive compares source times to its real clock and never trusts an injected future adapter clock');
  const oversize = await fetchSoccerTeamXg(game, { fetchImpl: transport(html + 'x'.repeat(SOCCER_TEAM_XG_DOCUMENT_MAX_BYTES)) });
  assert.equal((await archiveSoccerTeamXg(oversize)).persisted, false);
  const tamperedQuery = async (sql, params) => (await db.query(sql, params)).rows.map(row => ({ ...row, document_text: '<html>changed</html>', document_bytes: 20 }));
  await assert.rejects(() => loadSoccerTeamXgDocument(receipt.receiptId, { query: tamperedQuery }), /READBACK_FAILED/);
  const changedBody = html + '<!-- distinct exact decoded source document -->', atomic = await fetched(game, transport(changedBody));
  await assert.rejects(() => archiveSoccerTeamXg(atomic, { transaction: queries => db.transaction(async tx => {
    await tx.query(queries[0][0], queries[0][1]); throw Error('controlled observation transaction failure');
  }) }), /controlled observation transaction failure/);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM sports_soccer_team_xg_documents_v1 WHERE content_hash=$1', [hash(changedBody)])).rows[0].n, 0,
    'a failed observation transaction cannot leave a committed half-archive document');
  const unarchived = await fetched(game);
  await assert.rejects(() => archiveSoccerTeamXg(unarchived, { ensure: async () => { throw Error('controlled storage unavailable'); } }), /controlled storage unavailable/);
  assert.equal(unavailableSoccerTeamXgArchive().reason, 'TEAM_XG_SOURCE_STORAGE_UNAVAILABLE');
  assert.equal(unavailableSoccerTeamXgArchive().persisted, false); assert.equal(unavailableSoccerTeamXgArchive().prematchReceipt, false);
  // The exact same ESPN event number and clubs remain separate observations in
  // different competitions. Exercise the actual shared-transport cache too.
  const uclHtml = fs.readFileSync(new URL('./fixtures/soccer/opta-ucl-20261028.html', import.meta.url), 'utf8');
  const uclProvider = getSoccerTeamXgProvider('ucl');
  const uclGame = { ...game, league: 'ucl', id: 'soccer:ucl:999999',
    home: { id: 'soccer:ucl:team:362', sourceId: '362', name: 'Aston Villa' },
    away: { id: 'soccer:ucl:team:360', sourceId: '360', name: 'Manchester United' } };
  const uclTransport = transport(uclHtml, uclProvider.sourceUrl), ucl = await fetched(uclGame, uclTransport);
  const uclReceipt = await archiveSoccerTeamXg(ucl);
  assert.equal(uclReceipt.status, 'ARCHIVED'); assert.equal(uclReceipt.league, 'ucl'); assert.equal(uclReceipt.gameId, uclGame.id);
  assert.equal(uclReceipt.sourceUrl, uclProvider.sourceUrl); assert.equal(uclReceipt.season, uclProvider.season);
  assert.deepEqual(uclReceipt.competition, uclProvider.competition); assert.deepEqual(uclReceipt.teamIds, { home: '362', away: '360' });
  assert.equal(uclReceipt.contentHash, hash(uclHtml)); assert.equal(uclReceipt.documentBytes, Buffer.byteLength(uclHtml));
  assert.equal(uclReceipt.sourceUpdatedAt, ucl.source.sourceUpdatedAt); assert.equal(uclReceipt.sourcePublishedAt, null);
  assert.equal(uclReceipt.prematchReceipt, true); assert.equal(uclReceipt.historicalAvailabilityVerified, false); assert.equal(uclReceipt.formalEligible, false);
  assert.notEqual(uclReceipt.receiptId, receipt.receiptId); assert.notEqual(uclReceipt.contentHash, receipt.contentHash);
  assert.equal((await loadSoccerTeamXgDocument(uclReceipt.receiptId)).document, uclHtml);
  assert.deepEqual(await archiveSoccerTeamXg(ucl), uclReceipt);
  const uclCached = await fetched(uclGame, uclTransport);
  assert.equal((await archiveSoccerTeamXg(uclCached)).receiptId, uclReceipt.receiptId);
  assert.equal((await archiveSoccerTeamXg(structuredClone(ucl))).persisted, false);
  const wrongLeagueHtml = await fetchSoccerTeamXg(uclGame, { fetchImpl: transport(html, uclProvider.sourceUrl) });
  assert.equal(wrongLeagueHtml.ok, false); assert.equal((await archiveSoccerTeamXg(wrongLeagueHtml)).persisted, false,
    'EPL document bytes cannot create a UCL archival observation');
  const eplCollisionGame = { ...uclGame, league: 'epl', id: game.id,
    home: { ...uclGame.home, id: 'soccer:epl:team:362' }, away: { ...uclGame.away, id: 'soccer:epl:team:360' } };
  const sharedCalls = [];
  const sharedTransport = async url => {
    sharedCalls.push(String(url)); const isUcl = String(url) === uclProvider.sourceUrl;
    assert.ok(isUcl || String(url) === SOCCER_TEAM_XG_SOURCE_URL);
    const response = new Response(isUcl ? uclHtml : html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    Object.defineProperty(response, 'url', { value: String(url) }); return response;
  };
  const collisionEpl = await fetched(eplCollisionGame, sharedTransport), collisionUcl = await fetched(uclGame, sharedTransport);
  assert.equal(sharedCalls.length, 2, 'one transport function must retain distinct provider URL caches');
  const collisionEplReceipt = await archiveSoccerTeamXg(collisionEpl), collisionUclReceipt = await archiveSoccerTeamXg(collisionUcl);
  assert.equal(collisionEplReceipt.status, 'ARCHIVED'); assert.equal(collisionUclReceipt.status, 'ARCHIVED');
  assert.deepEqual(collisionEplReceipt.teamIds, collisionUclReceipt.teamIds);
  assert.notEqual(collisionEplReceipt.receiptId, collisionUclReceipt.receiptId);
  assert.notEqual(collisionEplReceipt.competition.id, collisionUclReceipt.competition.id);
  assert.notEqual(collisionEplReceipt.sourceUrl, collisionUclReceipt.sourceUrl);
  await fetched(eplCollisionGame, sharedTransport); await fetched(uclGame, sharedTransport);
  assert.equal(sharedCalls.length, 2, 'neither league overwrites the other league cache');
  for (const mutate of [value => { value.league = 'epl'; }, value => { value.source.url = SOCCER_TEAM_XG_SOURCE_URL; },
    value => { value.competition = { ...receipt.competition }; }, value => { value.coverage.teamCount = 20; },
    value => { value.teams.home.xg = 999; }, value => { value.sourceEvidence.teamIdentityVerified = false; }]) {
    const altered = await fetched(uclGame, transport(uclHtml, uclProvider.sourceUrl)); mutate(altered);
    assert.equal((await archiveSoccerTeamXg(altered)).persisted, false, mutate.toString());
  }
  const crossLeagueReadback = async (sql, params) => (await db.query(sql, params)).rows.map(row => ({ ...row, league: 'epl' }));
  await assert.rejects(() => loadSoccerTeamXgDocument(uclReceipt.receiptId, { query: crossLeagueReadback }), /READBACK_FAILED/);
  const byLeague = (await db.query('SELECT league,count(*)::int AS n FROM sports_soccer_team_xg_observations_v1 GROUP BY league ORDER BY league')).rows;
  assert.deepEqual(byLeague.map(row => row.league), ['epl', 'ucl']); assert.ok(byLeague.every(row => row.n > 0));
  console.log('PASS actual Opta fetch → immutable PostgreSQL decoded HTML archive: exact UTF8 body/hash readback, content dedup and separate actual fetch receipts, cache/retry idempotence, immutable tables, private proof and normalized value/scope tamper rejection, bounded compact receipts, real DB clock after kickoff, no historical/formal promotion');
  console.log('PASS EPL/UCL source archive isolation: actual 20/36-team adapters, distinct competition/calendar/URL bindings and shared-transport caches, same event/team IDs stay separate, wrong-league document/projection/readback rejection, no score approval');
} finally {
  for (const key of keys) { if (oldEnv[key] === undefined) delete process.env[key]; else process.env[key] = oldEnv[key]; }
  await fixture.close();
}
