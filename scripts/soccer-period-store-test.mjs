import assert from 'node:assert/strict';
import { soccerSqlFixture } from './helpers/soccer-sql-fixture.mjs';

const fixture = await soccerSqlFixture(), { db } = fixture;
const before = { DATABASE_URL: process.env.DATABASE_URL, DATABASE_V2_URL: process.env.DATABASE_V2_URL };
process.env.DATABASE_URL = 'postgres://fixture.invalid/soccer-periods'; delete process.env.DATABASE_V2_URL;
try {
  const { saveSoccerReaderSnapshot: save, loadSoccerReaderSnapshot: load } = await import('../lib/soccer/reader-store.js');
  const { beginSoccerAnalysisRun, finishSoccerAnalysisRun, soccerJournalHash } = await import('../lib/soccer/journal.js');
  const { soccerReaderHash } = await import('../lib/soccer/reader.js');
  const { canonicalSoccerPayload } = await import('../reader/soccer-parser.js');
  const date = '2026-10-22', base = Date.now() - 120000;
  const at = seconds => new Date(base + seconds * 1000).toISOString();
  const market = (period, line = '2.5') => ({ kind: 'TOTAL', unit: 'GOALS', line, overWater: 0.9, underWater: 0.95,
    rawRows: [`大${line} 0.9`, '小 0.95'], period,
    periodEvidence: { period, status: 'EXPLICIT', sectionTitle: period === 'FT' ? '全場' : '上半場' } });
  const capture = (periods, seconds, lines = {}, { empty = false, legacy = false } = {}) => {
    const payload = { league: 'EPL', boardDate: date, observedAt: at(seconds), executable: false,
      sourceHost: 'www.tai888.in', pageUrl: `https://www.tai888.in/newapp/?period=${periods.join(',')}`,
      ...(legacy ? {} : { periodsCovered: periods }),
      games: [{ league: 'EPL', boardDate: date, boardTime: '21:00', awayCode: 'CRY', homeCode: 'BHA',
        awayKey: 'crystalpalace', homeKey: 'brighton', awayRaw: '水晶宮', homeRaw: '白禮頓[主]',
        ...(legacy ? {} : { periodsCovered: periods, periodStates: Object.fromEntries(periods.map(period => [period, empty ? 'locked' : 'open'])) }),
        markets: empty ? [] : periods.map(period => market(period, lines[period] || '2.5')) }] };
    if (legacy) for (const item of payload.games[0].markets) { delete item.period; delete item.periodEvidence; }
    payload.contentHash = soccerReaderHash(canonicalSoccerPayload(payload)); return payload;
  };
  const find = (bundle, period) => bundle.games.flatMap(game => game.markets).find(item => item.period === period);
  const generation = async () => String((await db.query('SELECT quote_generation FROM sports_soccer_source_heads_v2 WHERE league=$1 AND board_date=$2', ['epl', date])).rows[0].quote_generation);
  const cutoff = async () => { await new Promise(resolve => setTimeout(resolve, 5)); return new Date().toISOString(); };

  const ftPayload = capture(['FT'], 0), ft = await save(ftPayload), afterFT = await cutoff();
  const ftOriginal = (await db.query('SELECT * FROM sports_soccer_reader_observations_v2 WHERE observation_id=$1', [ft.observationId])).rows[0];
  const ht = await save(capture(['HT'], 20, { HT: '1' })), afterHT = await cutoff();
  let bundle = await load('epl', date);
  assert.equal(bundle.games.length, 1); assert.equal(bundle.games[0].markets.length, 2, 'FT and HT tabs do not overwrite one another');
  assert.equal(find(bundle, 'FT').serverObservation.observationId, ft.observationId);
  assert.equal(find(bundle, 'HT').serverObservation.observationId, ht.observationId);
  assert.equal(bundle.observationId, null, 'an aggregate must not impersonate one raw observation');
  assert.equal(find(bundle, 'FT').serverObservation.receivedAt, ft.receivedAt);
  assert.equal(find(bundle, 'HT').serverObservation.receivedAt, ht.receivedAt);
  assert.equal(find(bundle, 'FT').serverObservation.sourceHost, 'www.tai888.in');
  assert.equal(find(bundle, 'FT').serverObservation.pageUrl, 'https://www.tai888.in/newapp/?period=FT');
  assert.equal(find(bundle, 'HT').serverObservation.pageUrl, 'https://www.tai888.in/newapp/?period=HT');
  assert.equal(bundle.sourceObservations.find(row => row.period === 'FT').pageUrl, 'https://www.tai888.in/newapp/?period=FT');
  assert.equal(bundle.sourceObservations.find(row => row.period === 'HT').pageUrl, 'https://www.tai888.in/newapp/?period=HT');
  assert.notEqual(find(bundle, 'FT').serverObservation.revision, find(bundle, 'HT').serverObservation.revision);
  assert.equal(bundle.historicalAvailabilityVerified, false);
  assert.equal((await load('epl', date, { asOf: afterFT })).sourceObservations.length, 1);
  assert.equal(find(await load('epl', date, { asOf: afterFT }), 'HT'), undefined);

  // FT's new observation may precede the HT tab's latest observation time.
  const ft2 = await save(capture(['FT'], 10, { FT: '3' }));
  assert.deepEqual(ft2.adoptedPeriods, ['FT']);
  bundle = await load('epl', date); assert.equal(find(bundle, 'FT').line, '3'); assert.equal(find(bundle, 'HT').line, '1');
  assert.equal(find(bundle, 'HT').serverObservation.observationId, ht.observationId);
  const genBeforeStale = await generation();
  const stale = await save(capture(['FT'], 5, { FT: '99' }));
  assert.deepEqual(stale.adoptedPeriods, []); assert.equal(await generation(), genBeforeStale);
  assert.equal(find(await load('epl', date), 'FT').line, '3', 'late older scope is retained as history but cannot publish');
  assert.equal(find(await load('epl', date, { asOf: afterHT }), 'FT').line, '2.5', 'historical read does not use current heads');

  const run = await beginSoccerAnalysisRun({ league: 'epl', date, gameId: 'soccer:epl:777' });
  await save(capture(['FT'], 30, {}, { empty: true }));
  bundle = await load('epl', date); assert.equal(find(bundle, 'FT'), undefined); assert.equal(find(bundle, 'HT').line, '1');
  assert.ok(bundle.sourceObservations.some(row => row.period === 'FT'), 'a closed scope remains represented, not resurrected from history');
  assert.equal((await finishSoccerAnalysisRun(run, { analysisStatus: 'COMPLETED', qaFlag: 'WARN', selectionResult: 'RESEARCH_SHADOW', revision: 'stale-after-close', validUntil: new Date(Date.now() + 60000).toISOString() })).publishedCurrent, false);
  const afterClose = await cutoff();
  assert.equal(find(await load('epl', date, { asOf: afterClose }), 'FT'), undefined);

  const mixed = await save(capture(['FT', 'HT'], 40, { FT: '4', HT: '1.5' }));
  const beforeHeartbeat = await generation();
  const heart = await save(capture(['FT'], 50, { FT: '4' }));
  assert.equal(await generation(), beforeHeartbeat, 'another scope or same-price heartbeat cannot perturb FT content hash');
  bundle = await load('epl', date);
  assert.equal(find(bundle, 'FT').serverObservation.observationId, heart.observationId);
  assert.equal(find(bundle, 'FT').serverObservation.firstFetchedAt, mixed.receivedAt, 'first receipt belongs to this period content, not latest overall capture');
  assert.equal(find(bundle, 'HT').serverObservation.observationId, mixed.observationId);
  const exactRetry = await save(capture(['FT'], 50, { FT: '4' }));
  assert.equal(exactRetry.receivedAt, heart.receivedAt); assert.equal(await generation(), beforeHeartbeat);
  const mixedLocked = capture(['FT', 'HT'], 52, { FT: '4' });
  mixedLocked.games[0].markets = mixedLocked.games[0].markets.filter(item => item.period === 'FT');
  mixedLocked.games[0].periodStates = { FT: 'open', HT: 'locked' };
  mixedLocked.games[0].marketStatus = 'open';
  mixedLocked.contentHash = soccerReaderHash(canonicalSoccerPayload(mixedLocked));
  await save(mixedLocked);
  const generationAfterHTClose = await generation();
  bundle = await load('epl', date);
  assert.equal(find(bundle, 'FT').line, '4'); assert.equal(find(bundle, 'HT'), undefined);
  assert.deepEqual(bundle.games[0].periodStates, { FT: 'open', HT: 'locked' });
  assert.equal(bundle.games[0].marketStatus, 'open', 'one locked period does not lock an open other period');
  await save(capture(['FT'], 53, { FT: '4' }));
  assert.equal(await generation(), generationAfterHTClose, 'other-period states and overall board status do not perturb unchanged FT hash');
  await save(capture(['HT'], 54, { HT: '1.5' }));
  bundle = await load('epl', date);
  assert.deepEqual(bundle.games[0].periodStates, { FT: 'open', HT: 'open' });
  const unknown = await save(capture(['UNKNOWN'], 1, { UNKNOWN: '7' }, { legacy: true }));
  bundle = await load('epl', date);
  assert.equal(find(bundle, 'UNKNOWN').serverObservation.observationId, unknown.observationId);
  assert.equal(find(bundle, 'FT').line, '4'); assert.equal(find(bundle, 'HT').line, '1.5');
  for (const [status, seconds] of [['CONFLICT', 55], ['TRUNCATED', 56]]) {
    const uncertain = capture(['UNKNOWN'], seconds, { UNKNOWN: '7' });
    uncertain.games[0].markets[0].periodEvidence = { period: 'UNKNOWN', status,
      sectionTitle: '全場／上半場來源待核對', tableHeaders: ['時間', '隊伍', '讓球', '大小'], marketHeader: '大小' };
    uncertain.contentHash = soccerReaderHash(canonicalSoccerPayload(uncertain));
    await save(uncertain);
    const retained = find(await load('epl', date), 'UNKNOWN');
    assert.equal(retained.period, 'UNKNOWN', 'retaining evidence cannot promote an uncertain period');
    assert.deepEqual(retained.periodEvidence, uncertain.games[0].markets[0].periodEvidence);
  }

  // A fully empty snapshot clears only the explicitly covered period.
  const noGames = capture(['FT'], 60); noGames.games = []; noGames.contentHash = soccerReaderHash(canonicalSoccerPayload(noGames));
  await save(noGames); bundle = await load('epl', date);
  assert.equal(find(bundle, 'FT'), undefined); assert.ok(find(bundle, 'HT')); assert.ok(find(bundle, 'UNKNOWN'));
  assert.equal(await load('ucl', date), null); assert.equal(await load('epl', '2026-10-23'), null);
  assert.equal(await load('epl', date, { asOf: '2020-01-01T00:00:00Z' }), null);
  await assert.rejects(() => load('epl', date, { asOf: 'not-a-date' }), /SCOPE_INVALID/);

  const preserved = (await db.query('SELECT * FROM sports_soccer_reader_observations_v2 WHERE observation_id=$1', [ft.observationId])).rows[0];
  assert.deepEqual(preserved, ftOriginal); assert.equal(soccerJournalHash(preserved.payload), ft.observationId);
  await assert.rejects(() => db.query('UPDATE sports_soccer_reader_period_observations_v2 SET content_hash=content_hash'), /SOCCER_IMMUTABLE_HISTORY/);
  await assert.rejects(() => db.query('DELETE FROM sports_soccer_reader_observations_v2'), /SOCCER_IMMUTABLE_HISTORY/);

  // Existing v2 observations lacking the new period index remain UNKNOWN and readable.
  const old = capture(['UNKNOWN'], 70, {}, { legacy: true }); old.boardDate = '2026-10-24'; old.games[0].boardDate = old.boardDate;
  old.contentHash = soccerReaderHash(canonicalSoccerPayload(old)); const oldId = soccerJournalHash(old);
  await db.query(`INSERT INTO sports_soccer_reader_observations_v2(observation_id,league,board_date,content_hash,source_observed_at,received_at,payload) VALUES ($1,'EPL',$2,$3,$4,clock_timestamp(),$5)`, [oldId, old.boardDate, old.contentHash, old.observedAt, JSON.stringify(old)]);
  const oldRead = await load('epl', old.boardDate); assert.equal(find(oldRead, 'UNKNOWN').serverObservation.observationId, oldId);
  assert.equal(find(oldRead, 'FT'), undefined);
  await db.query(`INSERT INTO sports_soccer_source_heads_v2(league,board_date,quote_generation,content_hash,source_observed_at,observation_id) VALUES ('epl',$1,1,$2,$3,$4)`, [old.boardDate, old.contentHash, old.observedAt, oldId]);
  const migrated = capture(['FT'], 80); migrated.boardDate = old.boardDate; migrated.games[0].boardDate = old.boardDate;
  migrated.contentHash = soccerReaderHash(canonicalSoccerPayload(migrated));
  await save(migrated);
  const migratedRead = await load('epl', old.boardDate);
  assert.ok(find(migratedRead, 'FT'));
  assert.equal(find(migratedRead, 'UNKNOWN').serverObservation.observationId, oldId, 'adoption of new typed scope preserves previous untyped source as UNKNOWN');
  console.log('PASS actual PostgreSQL period store: FT/HT independent replacement, closed/empty tombstones, stale scope rejection, as-of reconstruction, per-quote provenance/first receipt, heartbeat dedup, UNKNOWN legacy and global generation fencing');
} finally {
  for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await fixture.close();
}
