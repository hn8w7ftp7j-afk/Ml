// --sql emits the actual store's statements plus PostgreSQL assertions, to be
// piped into psql in the existing CI PostgreSQL service. Without --sql it tests
// SQL transport/scoping only, and does not claim a live database check.
import assert from 'node:assert/strict';
import {saveNbaLiveHistory,loadNbaLiveHistory,NBA_LIVE_HISTORY_SCHEMA} from '../lib/nba/live-history-store.js';
import {createLiveHistoryFixture,resealLiveHistoryFixture} from './fixtures/nba-live-history-fixture.mjs';
const emit = process.argv.includes('--sql');
const literal = value => value == null ? 'NULL' : typeof value === 'number' ? String(value) : `'${String(value).replaceAll("'","''")}'`;
const statements = [], rows = new Map(); let createAttempts = 0, failOnce = false;
const jsonbOrder = value => Array.isArray(value) ? value.map(jsonbOrder) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().reverse().map(key => [key,jsonbOrder(value[key])])) : value;
const db = async (parts,...values) => {
  const text = parts.reduce((output,part,index) => output+part+(index<values.length?literal(values[index]):''),'');
  statements.push(text); if (emit) console.log(`${text};`);
  if (text.startsWith('CREATE')) {createAttempts += 1; if (failOnce) {failOnce=false;throw Error('retry fixture');} return [];}
  if (text.startsWith('INSERT')) {
    const [gameId,revision,,date,year,,capturedAt,payload] = values;
    if (rows.has(gameId)) return [];
    const row = {revision,payload:jsonbOrder(JSON.parse(payload)),date,year,capturedAt}; rows.set(gameId,row); return [structuredClone(row)];
  }
  if (text.startsWith('SELECT') && text.includes('WHERE game_id=')) return rows.has(values[0]) ? [structuredClone(rows.get(values[0]))] : [];
  if (text.startsWith('SELECT')) return [...rows.values()].filter(row => row.date < values[0] && (values[1] === null || row.year === values[1])).map(row => structuredClone(row));
  throw Error('Unexpected store SQL');
};
const fixture = createLiveHistoryFixture(), {row,now} = fixture;
const first = await saveNbaLiveHistory(row,{sql:db,now});
const newerAcquisition = structuredClone(row); newerAcquisition.capturedAt = new Date(now+100).toISOString(); resealLiveHistoryFixture(newerAcquisition);
const repeated = await saveNbaLiveHistory(newerAcquisition,{sql:db,now:now+100});
assert.equal(first.inserted,true); assert.equal(repeated.inserted,false); assert.equal(repeated.capturedAt,row.capturedAt); assert.equal(repeated.revision,row.recordHash);
const beforeSameDate = await loadNbaLiveHistory({beforeDate:row.date},{sql:db,now}); assert.equal(beforeSameDate.length,0);
const after = await loadNbaLiveHistory({beforeDate:'2025-10-24',seasonYear:2026},{sql:db,now}); assert.equal(after.length,1); assert.equal(after[0].recordHash,row.recordHash);
assert.equal(createAttempts,1,'schema is coalesced for one SQL client');
if (emit) {
  console.log(`DO $$ BEGIN
   IF (SELECT count(*) FROM sports_nba_live_history_v1) <> 1 THEN RAISE EXCEPTION 'NBA live history duplicated'; END IF;
   IF (SELECT revision FROM sports_nba_live_history_v1) <> ${literal(row.recordHash)} THEN RAISE EXCEPTION 'original NBA evidence overwritten'; END IF;
   IF (SELECT captured_at FROM sports_nba_live_history_v1) <> ${literal(row.capturedAt)}::timestamptz THEN RAISE EXCEPTION 'original NBA acquisition time overwritten'; END IF;
   IF EXISTS (SELECT 1 FROM sports_nba_live_history_v1 WHERE game_date < ${literal(row.date)}::date) THEN RAISE EXCEPTION 'same-date training leak'; END IF;
  END $$;`);
  const conflict = structuredClone(row); conflict.game.home.score++; conflict.homeScore++;
  conflict.game.home.periodScores[3].score++;
  conflict.game.home.statistics.find(stat => stat.name==='freeThrowsMade-freeThrowsAttempted').displayValue='32-36';
  resealLiveHistoryFixture(conflict);
  await assert.rejects(() => saveNbaLiveHistory(conflict,{sql:db,now}),error => error.code==='NBA_LIVE_HISTORY_CONFLICT');
  console.log(`DO $$ BEGIN
   IF (SELECT payload->>'homeScore' FROM sports_nba_live_history_v1) <> '119' THEN RAISE EXCEPTION 'conflicting final overwritten'; END IF;
   IF (SELECT count(*) FROM sports_nba_live_history_v1) <> 1 THEN RAISE EXCEPTION 'conflicting final duplicated'; END IF;
  END $$;`);
} else {
  const db2 = async (parts,...values) => db(parts,...values);
  await loadNbaLiveHistory({beforeDate:'2025-10-24'},{sql:db2,now}); assert.equal(createAttempts,2,'different SQL clients initialize independently');
  const dbRetry = async (parts,...values) => db(parts,...values); failOnce=true;
  await assert.rejects(() => loadNbaLiveHistory({beforeDate:'2025-10-24'},{sql:dbRetry,now}));
  await loadNbaLiveHistory({beforeDate:'2025-10-24'},{sql:dbRetry,now}); assert.equal(createAttempts,4,'failed schema promise is cleared and retried');
  const conflict = structuredClone(row); conflict.game.home.score++; conflict.homeScore++; conflict.game.home.periodScores[3].score++; conflict.game.home.statistics.find(stat => stat.name==='freeThrowsMade-freeThrowsAttempted').displayValue='32-36'; resealLiveHistoryFixture(conflict);
  await assert.rejects(() => saveNbaLiveHistory(conflict,{sql:db,now}),error => error.code==='NBA_LIVE_HISTORY_CONFLICT');
  rows.get(row.gameId).payload.pace++;
  await assert.rejects(() => loadNbaLiveHistory({beforeDate:'2025-10-24'},{sql:db,now}));
  assert.ok(statements.every(query => !/\b(?:UPDATE|DELETE|TRUNCATE|DROP)\b/.test(query)));
  assert.ok(NBA_LIVE_HISTORY_SCHEMA.includes('game_id TEXT PRIMARY KEY'));
  console.log('NBA live history SQL transport: immutable original, conflict/tamper rejection, independent client schema and retry PASS (not live PostgreSQL)');
}
