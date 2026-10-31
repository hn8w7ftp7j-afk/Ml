import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { normalizeSoccerSchedule } from '../lib/soccer/data.js';
import { normalizeSoccerPrematch } from '../lib/soccer/prematch.js';
import { soccerSqlFixture } from './helpers/soccer-sql-fixture.mjs';

const fixture = await soccerSqlFixture(), { db } = fixture, savedEnv = process.env.DATABASE_URL, savedV2 = process.env.DATABASE_V2_URL;
process.env.DATABASE_URL = 'postgres://fixture.invalid/calibration-evaluation'; delete process.env.DATABASE_V2_URL;
const { analyzeSoccerGame } = await import('../lib/soccer/analysis-service.js');
const { archiveSoccerCalibrationShadowEvaluation: archive, loadSoccerCalibrationShadowEvaluationHistory: read,
  listSoccerCalibrationShadowPendingCaptureIds: pending, ensureSoccerCalibrationShadowEvaluationStore: ensure } =
  await import('../lib/soccer/calibration-shadow-evaluation-store.js');
const iso = value => new Date(value).toISOString(), hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function evidence(eventId, kickoff) {
  const raw = JSON.parse(fs.readFileSync(new URL('./fixtures/soccer/epl-summary.json', import.meta.url)));
  raw.header.id = eventId; raw.header.uid = raw.header.uid.replace(/~e:\d+/, `~e:${eventId}`);
  const competition = raw.header.competitions[0]; competition.id = eventId;
  competition.uid = competition.uid.replace(/~e:\d+/, `~e:${eventId}`).replace(/~c:\d+/, `~c:${eventId}`);
  raw.header.date = iso(kickoff); competition.date = raw.header.date;
  competition.status = { type: { state: 'pre', completed: false, name: 'STATUS_SCHEDULED' } };
  const now = Date.now(), source = { provider: 'ESPN', url: `https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/summary?event=${eventId}`,
    requestedAt: iso(now - 20), fetchedAt: iso(now - 10), contentHash: hash(raw) };
  return normalizeSoccerPrematch(raw, normalizeSoccerSchedule({ leagues: [raw.header.league], events: [raw.header] }, 'epl', source).games[0], source, now);
}
try {
  await ensure();
  const kickoff = Date.now() + 3000, captures = [];
  for (const eventId of ['992000001', '992000002']) {
    const e = evidence(eventId, kickoff), game = e.game;
    const result = await analyzeSoccerGame({ league: game.league, date: game.date, eventId: game.sourceId }, {
      ensureSoccerForwardProtocol: async () => { throw Error('unrelated fixture'); }, fetchSoccerSchedule: async () => ({ ok: true, games: [game] }),
      fetchSoccerPrematch: async () => e, fetchSoccerWorkload: async () => ({ ok: false, status: 'INCOMPLETE', teams: {}, sources: [] }),
      fetchSoccerTeamXg: async () => ({ ok: false }), loadSoccerReaderSnapshot: async () => null,
    });
    assert.equal(result.payload.calibrationShadowCapture.persisted, true, JSON.stringify(result.payload.calibrationShadowCapture));
    captures.push(result.payload.calibrationShadowCapture);
  }
  const remaining = kickoff - Date.now(); if (remaining >= 0) await new Promise(resolve => setTimeout(resolve, remaining + 5));
  const [a, b] = captures, options = { limit: 1, freezeId: a.freeze.freezeId };
  assert.deepEqual(await pending('epl', options), [a.capture.captureId]);
  const first = await archive({ league: 'epl', captureId: a.capture.captureId, status: 'PENDING', reason: 'SAME_TIMEOUT' });
  assert.deepEqual(await pending('epl', options), [b.capture.captureId]);
  await archive({ league: 'epl', captureId: b.capture.captureId, status: 'PENDING', reason: 'SAME_TIMEOUT' });
  assert.deepEqual(await pending('epl', options), [a.capture.captureId]);
  const retry = await archive({ league: 'epl', captureId: a.capture.captureId, status: 'PENDING', reason: 'SAME_TIMEOUT' });
  assert.equal(first.checkId, retry.checkId, 'identical failure proof may deduplicate without overwriting history');
  assert.ok(Date.parse(retry.attemptedAt) > Date.parse(first.attemptedAt));
  assert.deepEqual(await pending('epl', options), [b.capture.captureId], 'a repeated identical failure must advance the fair attempt queue');
  assert.equal((await read('epl', { captureIds: [a.capture.captureId] })).length, 1);
  assert.deepEqual(await pending('epl', { ...options, freezeId: '0'.repeat(64) }), []);
  const sourceNow = iso(Date.now()), docs = { scoreboard: { ok: false, code: 'FIXTURE_SOURCE_FAILURE', source: { fetchedAt: sourceNow } }, summaries: [] };
  await archive({ league: 'epl', captureId: a.capture.captureId, resultDocuments: docs, status: 'PENDING' });
  assert.equal((await read('epl', { captureIds: [a.capture.captureId] })).length, 2, 'real DB Date readback preserves fractional receipt timestamps');
  const actualTransport = globalThis.__SOCCER_TEST_SQL;
  globalThis.__SOCCER_TEST_SQL = async (queries, transaction) => {
    const result = await actualTransport(queries, transaction);
    if (queries.some(value => /SELECT \* FROM sports_soccer_calibration_checks_v1/.test(value.query)))
      for (const rows of result) for (const row of rows) if (row.payload?.resultDocuments) row.checked_at = new Date(Date.parse(sourceNow) - 1);
    return result;
  };
  try { await assert.rejects(() => read('epl', { captureIds: [a.capture.captureId] }), /STORAGE_UNAVAILABLE/); }
  finally { globalThis.__SOCCER_TEST_SQL = actualTransport; }
  for (const table of ['checks', 'check_attempts']) {
    await assert.rejects(() => db.query(`UPDATE sports_soccer_calibration_${table}_v1 SET capture_id=capture_id`), /SOCCER_IMMUTABLE_HISTORY/);
    await assert.rejects(() => db.query(`DELETE FROM sports_soccer_calibration_${table}_v1`), /SOCCER_IMMUTABLE_HISTORY/);
  }
  console.log('PASS actual PostgreSQL analysis/source/capture → immutable result checks and attempt receipts; repeated identical pending errors advance fair queue, current-freeze isolation and fractional source/DB receipt chronology hold; updates/deletes rejected');
} finally {
  if (savedEnv === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = savedEnv;
  if (savedV2 === undefined) delete process.env.DATABASE_V2_URL; else process.env.DATABASE_V2_URL = savedV2;
  await fixture.close();
}
