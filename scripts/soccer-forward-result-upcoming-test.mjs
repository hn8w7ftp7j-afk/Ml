import assert from 'node:assert/strict';
import { soccerSqlFixture } from './helpers/soccer-sql-fixture.mjs';
import { fixtureCapture, resultFor } from './helpers/soccer-forward-fixture.mjs';
import { soccerDate } from '../lib/soccer/contracts.js';
import { soccerForwardAnalysisRevision, validateSoccerForwardCapture } from '../lib/soccer/forward-validation.js';

// Engineering regression only: a simulated collector decision clock, synthetic
// source transport and actual PostgreSQL store/queue. This is not a real final
// result, Production/OOS evidence, source acceptance or a wager.
const fixture = await soccerSqlFixture(), { db } = fixture;
const previous = [process.env.DATABASE_URL, process.env.DATABASE_V2_URL], originalFetch = globalThis.fetch;
process.env.DATABASE_URL = 'postgres://fixture.invalid/forward-upcoming-offset';
delete process.env.DATABASE_V2_URL;
globalThis.fetch = async () => { throw Error('Offset queue fixture must not fetch external providers'); };
try {
  const service = await import('../lib/soccer/forward-validation-service.js');
  const { collectSoccerForwardResults } = await import('../lib/soccer/forward-result-collector.js');
  const protocol = await service.ensureSoccerForwardProtocol(), prepared = Date.now();
  const iso = value => new Date(value).toISOString();
  const completedKickoff = prepared + 60000, decision = prepared + 90000, upcomingKickoff = prepared + 180000;
  const originals = new Map();
  const query = async (sql, values = []) => (await db.query(sql, values)).rows;
  async function save(id, startTime) {
    const snapshot = fixtureCapture({ id }).snapshot;
    delete snapshot.readerIdentityEvidence; // No synthetic identity approval.
    snapshot.runStartedAt = snapshot.observedAt = snapshot.analysisCutoff = iso(prepared);
    snapshot.date = snapshot.evidence.game.date = soccerDate(Date.parse(startTime));
    snapshot.evidence.game.startTime = startTime;
    for (const source of [snapshot.evidence.source, snapshot.evidence.game.source, snapshot.evidence.scheduleSource])
      source.fetchedAt = iso(prepared);
    snapshot.inputVersions.evidenceFetchedAt = iso(prepared);
    snapshot.inputVersions.scheduleSourceVersion = { ...snapshot.evidence.scheduleSource };
    const revision = soccerForwardAnalysisRevision(snapshot);
    await query(`INSERT INTO sports_soccer_analysis_v1 (league,game_id,analysis_hash,observed_at,payload)
      VALUES ($1,$2,$3,$4::timestamptz,$5::jsonb)`,
    [snapshot.league, snapshot.gameId, revision, snapshot.observedAt, JSON.stringify(snapshot)]);
    await service.captureSoccerForwardSnapshot(snapshot, revision);
    originals.set(snapshot.gameId, snapshot);
    return snapshot;
  }
  // Six earlier games yield twelve valid BASELINE receipts (FT + HT), more
  // than one collector batch before the later finished game. +00:00 is a valid
  // admitted ISO instant but deliberately not the queue's canonical .SSSZ form.
  for (let index = 0; index < 6; index++) await save(String(900 + index), iso(upcomingKickoff).replace('Z', '+00:00'));
  const finished = await save('100', iso(completedKickoff));
  const scope = { league: 'epl', from: soccerDate(completedKickoff), through: soccerDate(upcomingKickoff) };
  const evidence = await service.loadSoccerForwardEvidence(scope);
  const upcoming = evidence.captures.filter(capture => capture.gameId !== finished.gameId && capture.variant === 'BASELINE');
  assert.equal(upcoming.length, 12);
  assert.ok(upcoming.every(capture => validateSoccerForwardCapture(capture, protocol, decision).ok),
    'the starvation counterexample uses genuinely admitted original captures');
  assert.ok(upcoming.every(capture => Date.parse(capture.snapshot.evidence.game.startTime) > decision));
  const before = await query('SELECT * FROM sports_soccer_forward_captures_v1 ORDER BY capture_sequence');
  const sourceCalls = [];
  const fetchResult = async context => {
    sourceCalls.push(context);
    assert.equal(context.gameId, finished.gameId, 'upcoming games must never trigger a result-source request');
    const snapshot = originals.get(context.gameId);
    const result = resultFor({ league: snapshot.league, gameId: snapshot.gameId, date: snapshot.date, snapshot });
    result.observedAt = iso(decision);
    result.sources = result.sources.map(source => ({ ...source, fetchedAt: iso(decision) }));
    return result;
  };
  const options = { query, fetchResult, receiptLimit: 12, timeBudgetMs: 8000, now: () => decision };
  const first = await collectSoccerForwardResults(scope, options);
  assert.equal(first.checkedCaptureReceipts, 12);
  assert.equal(first.pendingCaptureReceipts, 12);
  assert.equal(first.reasons.FORWARD_MATCH_NOT_STARTED, 8);
  assert.equal(first.sourceRequests, 0);
  const second = await collectSoccerForwardResults(scope, options);
  assert.equal(second.checkedCaptureReceipts, 9);
  assert.equal(second.evaluatedCaptureReceipts, 2);
  assert.equal(second.reasons.FORWARD_MATCH_NOT_STARTED, 4);
  assert.equal(second.sourceRequests, 1);
  assert.equal(sourceCalls.length, 1);
  const checks = await query(`SELECT c.game_id,c.variant,k.payload FROM sports_soccer_forward_result_checks_v1 k
    JOIN sports_soccer_forward_captures_v1 c USING(capture_id) ORDER BY c.capture_sequence`);
  assert.equal(checks.length, 21);
  assert.equal(checks.filter(row => row.game_id !== finished.gameId && row.variant === 'BASELINE'
    && row.payload.status === 'PENDING' && row.payload.reason === 'FORWARD_MATCH_NOT_STARTED').length, 12);
  assert.equal(checks.filter(row => row.game_id === finished.gameId && row.payload.status === 'EVALUATED').length, 2);
  assert.deepEqual(await query('SELECT * FROM sports_soccer_forward_captures_v1 ORDER BY capture_sequence'), before);
  assert.ok([first, second].every(summary => summary.complete === false && summary.formalEligible === false));
  console.log('PASS PostgreSQL upcoming-offset queue: twelve valid future baseline receipts rotate through durable PENDING checks, later finished FT/HT captures progress, no future provider fetch or original mutation; engineering clock only, no formal acceptance.');
} finally {
  if (previous[0] === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous[0];
  if (previous[1] === undefined) delete process.env.DATABASE_V2_URL; else process.env.DATABASE_V2_URL = previous[1];
  globalThis.fetch = originalFetch; await fixture.close();
}
