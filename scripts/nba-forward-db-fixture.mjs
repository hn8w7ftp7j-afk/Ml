// Emit the actual production SQL with a synthetic pregame capture and verified
// fixture result. Run only in a dedicated empty PostgreSQL test database.
import fs from 'node:fs';
import { loadOfficialNbaEvidence } from '../lib/nba/official.js';
import { freezeNbaForwardSelection, nbaCaptureRevision, evaluateNbaForwardCapture } from '../lib/nba/forward-validation.js';
import { prepareNbaForwardSchema, archiveNbaForwardEvaluation, listPendingNbaForwardCaptures, readNbaForwardValidation, recordNbaForwardAttempt } from '../lib/nba/forward-store.js';
const literal = value => value == null ? 'NULL' : typeof value === 'number' ? String(value)
  : `'${String(Array.isArray(value) ? `{${value.map(item => `"${item}"`).join(',')}}` : value).replaceAll("'", "''")}'`;
let evaluation, pendingSql;
const db = async (strings, ...values) => {
  const sql = strings.reduce((text, part, i) => text + part + (i < values.length ? literal(values[i]) : ''), '');
  console.log(`${sql};`);
  if (sql.includes('WITH candidate_games')) pendingSql = sql;
  if (sql.includes('INSERT INTO nba_forward_attempts')) return [{ attempt_id: values[0] }];
  return sql.includes('INSERT INTO nba_forward_evaluations') ? [{ contract_hash: evaluation.contractHash, payload: evaluation }] : [];
};
await prepareNbaForwardSchema(db);
const raw = JSON.parse(fs.readFileSync(new URL('./fixtures/nba-official-0022500003.json', import.meta.url)));
const game = JSON.parse(fs.readFileSync(new URL('./fixtures/nba-onoff-401809234.json', import.meta.url))).game;
const now = Date.parse('2026-10-06T20:00:00Z'), start = Date.parse(game.startTime), total = game.away.score + game.home.score;
const official = await loadOfficialNbaEvidence(game, [], { now: () => now, fetchImpl: async url => new Response(`<script id="__NEXT_DATA__">${JSON.stringify({ props: { pageProps: url.includes('/games?') ? raw.schedule : { game: raw.game } } })}</script>`) });
const result = { data: { game }, sources: [{ provider: 'ESPN', url: `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${game.sourceId}`,
  status: 'ready', hash: 'a'.repeat(64), fetchedAt: new Date(now).toISOString() }] };
const estimate = positive => ({ expectedNet: positive ? 10 : -10, robustExpectedNet: null,
  winProbability: positive ? .6 : .3, lossProbability: positive ? .3 : .6, pushProbability: .1 });
function capture(line, offset, microseconds = '123456') {
  const quote = { line, overWater: .94, underWater: .92 }, at = new Date(start - offset).toISOString().replace('.000Z', `.${microseconds}Z`);
  const payload = { status: 'ready', league: 'NBA', gameId: game.id, date: game.taipeiDate, executable: false,
    game: { ...game, status: 'scheduled', completed: false, timeConfirmed: true },
    forwardCaptureVersion: 'nba-analysis-forward-v1', forwardCaptureHashVersion: 'canonical-json-sha256-v1', captureScope: 'SERVER_PREDICTION_AND_ORIGINAL_QUOTES',
    modelVersion: 'synthetic-forward-v1', engineVersion: 'synthetic-forward-engine-v1', observedAt: at, quoteHash: 'b'.repeat(64),
    quotes: { fullTotal: quote }, marketAnalyses: { fullTotal: { status: 'ready', quote, sides: { over: estimate(true), under: estimate(false) } } } };
  payload.forwardSelection = freezeNbaForwardSelection(payload);
  return { revision: nbaCaptureRevision(payload), capturedAt: new Date(at).toISOString(), capturedAtExact: at, payload, marketKey: 'fullTotal' };
}
// Both captures deliberately fall in the SAME millisecond, with different PG
// microseconds. The archive equality guard must use the exact .123900 value.
const old = capture(`${total}+25`, 30000, '123100'), latest = capture(`${total + 10}平`, 30000, '123900');
for (const row of [old, latest]) console.log(`INSERT INTO nba_analysis_forward_v1(revision,game_id,board_date,captured_at,payload)
  VALUES (${literal(row.revision)},${literal(game.id)},${literal(game.taipeiDate)},${literal(row.capturedAtExact)}::timestamptz,${literal(JSON.stringify(row.payload))}::jsonb);`);
evaluation = evaluateNbaForwardCapture(old, result, official, now);
await archiveNbaForwardEvaluation(old, evaluation, { db, prepareSchema: false });
console.log(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM nba_forward_evaluations_v1) THEN RAISE EXCEPTION 'earlier quote was accepted'; END IF; END $$;`);
evaluation = evaluateNbaForwardCapture(latest, result, official, now);
await archiveNbaForwardEvaluation(latest, evaluation, { db, prepareSchema: false });
await archiveNbaForwardEvaluation(latest, { ...evaluation, outcomes: evaluation.outcomes.map(o => ({ ...o, unitProfit: 999999 })) }, { db, prepareSchema: false });
console.log(`DO $$ BEGIN
  IF (SELECT COUNT(*) FROM nba_forward_evaluations_v1) <> 1 THEN RAISE EXCEPTION 'duplicate evaluation'; END IF;
  IF (SELECT payload->'originalQuote'->>'line' FROM nba_forward_evaluations_v1) <> ${literal(latest.payload.quotes.fullTotal.line)} THEN RAISE EXCEPTION 'original canonical quote changed'; END IF;
  IF (SELECT payload->'outcomes'->0->>'unitProfit' FROM nba_forward_evaluations_v1) <> '-0.985' THEN RAISE EXCEPTION 'unit return overwritten'; END IF;
  IF (SELECT payload->>'capturedAtExact' FROM nba_forward_evaluations_v1) NOT LIKE '%.123900Z' THEN RAISE EXCEPTION 'capture microseconds lost'; END IF;
  BEGIN UPDATE nba_forward_evaluations_v1 SET contract_hash = 'wrong'; RAISE EXCEPTION 'update allowed';
    EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'NBA forward evaluations are append-only%' THEN RAISE; END IF; END;
  BEGIN DELETE FROM nba_forward_evaluations_v1; RAISE EXCEPTION 'delete allowed';
    EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'NBA forward evaluations are append-only%' THEN RAISE; END IF; END;
END $$;`);
// Also exercise all production read-query syntax, including per-game LIMIT and
// JSONB market expansion. Results are printed by psql, not treated as outcomes.
await listPendingNbaForwardCaptures({ date: game.taipeiDate, now }, { db, prepareSchema: false });
await readNbaForwardValidation({ date: game.taipeiDate, now }, { db, prepareSchema: false });
// Failed old games cannot monopolize a bounded cron budget. Add two synthetic
// pending games and record one attempted old game; an untouched newer game
// must become the first real production pending-query result.
const pendingGame = (id, offset) => {
  const row = capture(`${total}+25`, offset);
  row.payload.gameId = `nba:espn:game:${id}`;
  row.payload.game.id = row.payload.gameId; row.payload.game.sourceId = id;
  row.revision = nbaCaptureRevision(row.payload);
  return row;
};
const retry = pendingGame('401999991', 120000), untouched = pendingGame('401999992', 90000);
for (const row of [retry, untouched]) console.log(`INSERT INTO nba_analysis_forward_v1(revision,game_id,board_date,captured_at,payload)
  VALUES (${literal(row.revision)},${literal(row.payload.gameId)},${literal(game.taipeiDate)},${literal(row.capturedAtExact)}::timestamptz,${literal(JSON.stringify(row.payload))}::jsonb);`);
const pendingAttempt = { checked: 1, evaluated: 0, pending: 1, deferred: 0, reasons: { OFFICIAL_SCORE_CROSSCHECK_PENDING: 1 } };
await recordNbaForwardAttempt(retry, pendingAttempt, { db, prepareSchema: false, id: 'fixture-forward-attempt' });
await recordNbaForwardAttempt(retry, pendingAttempt, { db, prepareSchema: false, id: 'fixture-forward-attempt' });
await listPendingNbaForwardCaptures({ date: game.taipeiDate, limit: 1, now }, { db, prepareSchema: false });
console.log(`DO $$ BEGIN
  IF (SELECT COUNT(*) FROM nba_forward_attempts_v1) <> 1 THEN RAISE EXCEPTION 'retry duplicate'; END IF;
  IF (SELECT game_id FROM (${pendingSql}) queued LIMIT 1) <> ${literal(untouched.payload.gameId)} THEN RAISE EXCEPTION 'old failure starved untouched pending game'; END IF;
  BEGIN UPDATE nba_forward_attempts_v1 SET game_id = 'wrong'; RAISE EXCEPTION 'attempt update allowed';
    EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE 'NBA forward evaluations are append-only%' THEN RAISE; END IF; END;
END $$;`);
