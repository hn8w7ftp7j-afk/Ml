import assert from 'node:assert/strict';
import { register } from 'node:module';
import { soccerSqlFixture } from './helpers/soccer-sql-fixture.mjs';
import { fixtureCapture, changed, protocol, iso, captured, after } from './helpers/soccer-forward-fixture.mjs';
import '../reader/soccer-teams.js';
const fixture=await soccerSqlFixture(),{db}=fixture;
const originalFetch=globalThis.fetch;
globalThis.fetch=async()=>({ok:false,status:503});
const before={DATABASE_URL:process.env.DATABASE_URL,DATABASE_V2_URL:process.env.DATABASE_V2_URL,
  APP_PASSWORD:process.env.APP_PASSWORD,SESSION_SECRET:process.env.SESSION_SECRET};
process.env.DATABASE_URL='postgres://fixture.invalid/retro-pair';delete process.env.DATABASE_V2_URL;
process.env.APP_PASSWORD='test-only-password';process.env.SESSION_SECRET='test-only-secret';
try {
  const {ensureSoccerJournal,soccerJournalHash,recordSoccerCohort}=await import('../lib/soccer/journal.js');
  const {SOCCER_FORWARD_SCHEMA,loadSoccerForwardEvidence}=await import('../lib/soccer/forward-validation-service.js');
  const {soccerForwardHash}=await import('../lib/soccer/forward-validation.js');
  const {soccerReaderHash}=await import('../lib/soccer/reader.js');
  const {canonicalSoccerPayload}=await import('../reader/soccer-parser.js');
  const {runSoccerRetrospectivePairDiagnostic:run}=await import('./soccer-retrospective-pair-diagnostic.mjs');
  const {diagnoseSoccerRetrospectivePairs}=await import('../lib/soccer/retrospective-pair-diagnostic.js');
  const {matchSoccerReaderGames}=await import('../lib/soccer/reader.js');
  await ensureSoccerJournal();for(const sql of SOCCER_FORWARD_SCHEMA)await db.query(sql);
  await db.query(`INSERT INTO sports_soccer_forward_protocol_v1(protocol_version,policy_hash,policy,activated_at) VALUES($1,$2,$3,$4)`,
    [protocol.version,soccerForwardHash(protocol.policy),JSON.stringify(protocol.policy),protocol.activatedAt]);
  const c=changed(fixtureCapture(), x=>{x.snapshot.evidence.game.home.name='Arsenal';x.snapshot.evidence.game.away.name='Manchester City';x.snapshot.directions=[];});
  await db.query(`INSERT INTO sports_soccer_analysis_v1(league,game_id,analysis_hash,observed_at,payload) VALUES($1,$2,$3,$4,$5)`,
    [c.league,c.gameId,c.revision,c.snapshot.observedAt,JSON.stringify(c.snapshot)]);
  await db.query(`INSERT INTO sports_soccer_forward_captures_v1(capture_id,protocol_version,league,game_id,board_date,period,variant,model_hash,analysis_revision,captured_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[c.captureId,protocol.version,c.league,c.gameId,c.date,c.period,c.variant,c.modelHash,c.revision,c.capturedAt.replace('Z','100Z')]);
  const observedAt=iso(captured+30000), receivedAt=iso(captured+31000), persistedAt=iso(captured+32000);
  const market={period:'FT',kind:'TOTAL',unit:'GOALS',line:'2.5',overWater:.9,underWater:.95,rawRows:['大2.5 0.9','小 0.95'],
    periodEvidence:{period:'FT',status:'EXPLICIT',sectionTitle:'英格蘭超級聯賽',tableHeaders:['全場'],marketHeader:'全場大小'}};
  const raw={league:'EPL',boardDate:c.date,boardTime:'19:00',homeKey:globalThis.Tai888SoccerTeams.key('Arsenal'),
    awayKey:globalThis.Tai888SoccerTeams.key('Manchester City'),homeRaw:'Arsenal',awayRaw:'Manchester City',
    periodsCovered:['FT'],periodStates:{FT:'open'},marketStatus:'open',markets:[market]};
  const payload={league:'EPL',boardDate:c.date,observedAt,executable:false,deviceId:'private-test-device',sourceHost:'www.tai888.in',
    pageUrl:'https://www.tai888.in/newapp/',periodsCovered:['FT'],games:[raw]};
  payload.contentHash=soccerReaderHash(canonicalSoccerPayload(payload));
  const id=soccerJournalHash(payload),periodHash=soccerJournalHash({league:'EPL',boardDate:c.date,period:'FT',games:[raw]});
  await db.query(`INSERT INTO sports_soccer_reader_observations_v2(observation_id,league,board_date,content_hash,source_observed_at,received_at,persisted_at,payload)
    VALUES($1,'EPL',$2,$3,$4,$5,$6,$7)`,[id,c.date,payload.contentHash,observedAt,receivedAt,persistedAt,JSON.stringify(payload)]);
  await db.query(`INSERT INTO sports_soccer_reader_period_observations_v2(observation_id,period,content_hash) VALUES($1,'FT',$2)`,[id,periodHash]);
  let writes=0;const original=globalThis.__SOCCER_TEST_SQL;
  globalThis.__SOCCER_TEST_SQL=async(queries,tx)=>{writes+=queries.filter(q=>/^\s*(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)/i.test(q.query)).length;return original(queries,tx);};
  // Internal research engine remains testable, but public service must not
  // expose any pairs without a complete original official identity source.
  const replay=async()=>{const e=await loadSoccerForwardEvidence({league:'epl',date:c.date},{ensure:async()=>{},limit:500});
    return diagnoseSoccerRetrospectivePairs({league:'epl',date:c.date,protocol:e.protocol,captures:e.captures,now:after});};
  const result=await run(['--league','epl','--date',c.date],{now:after});
  assert.equal(result.selectedPairCount,null,JSON.stringify(result));assert.deepEqual(result.pairs,[]);
  assert.equal(result.forecastCoverage,'NOT_VERIFIED_MULTIPLE_STATEMENTS');assert.equal(result.formalEligible,false);assert.equal(result.R,null);
  const internal=await replay();assert.equal(internal.selectedPairCount,2);assert.equal(internal.pairs[0].sourceObservationId,id);
  assert.equal(writes,0,'operator entry performs only reads');
  assert.ok(!JSON.stringify(result).includes('private-test-device'));
  const gameResult=await run(['--league','epl','--date',c.date,'--game-id',c.gameId],{now:after});
  assert.equal(gameResult.status,'PARTIAL');assert.equal(gameResult.gameDiagnosticStatus,'IDENTITY_UNVERIFIED');
  assert.equal(gameResult.selectedPairCount,null);assert.deepEqual(gameResult.pairs,[]);assert.equal(gameResult.dateCoverage,'PARTIAL_SINGLE_GAME');
  assert.equal(gameResult.validForecastCount,1);assert.equal(gameResult.readerObservationCount,1);
  assert.ok(gameResult.reasonCodes.includes('FULL_DATE_OFFICIAL_IDENTITY_NOT_VERIFIED'));
  assert.equal(gameResult.crossRequestConsistency,'NOT_VERIFIED_SEPARATE_DATABASE_STATEMENTS');
  assert.equal(gameResult.scope.gameId,c.gameId);assert.ok(!JSON.stringify(gameResult).includes('private-test-device'));
  const inventory=await run(['--league','epl','--date',c.date,'--list-games']);
  assert.equal(inventory.overallDateCoverage,'PARTIAL');assert.equal(inventory.games[0].gameId,c.gameId);
  assert.equal(writes,0,'single-game and inventory entry points perform no writes');
  // DB evidence can disagree inside a single JS millisecond: preserve actual
  // microseconds and reject an observation persisted before it was received.
  const backwards={...payload,observedAt:iso(captured+20000)};
  backwards.contentHash=soccerReaderHash(canonicalSoccerPayload(backwards));
  const backwardsId=soccerJournalHash(backwards);
  const receiptLater=backwards.observedAt.replace('Z','900Z'),persistedEarlier=backwards.observedAt.replace('Z','100Z');
  await db.query(`INSERT INTO sports_soccer_reader_observations_v2(observation_id,league,board_date,content_hash,source_observed_at,received_at,persisted_at,payload)
    VALUES($1,'EPL',$2,$3,$4,$5,$6,$7)`,[backwardsId,c.date,backwards.contentHash,backwards.observedAt,receiptLater,persistedEarlier,JSON.stringify(backwards)]);
  await db.query(`INSERT INTO sports_soccer_reader_period_observations_v2(observation_id,period,content_hash) VALUES($1,'FT',$2)`,[backwardsId,periodHash]);
  const backwardsClock=(await db.query(`SELECT to_char(received_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS r,
    to_char(persisted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS p FROM sports_soccer_reader_observations_v2 WHERE observation_id=$1`,[backwardsId])).rows[0];
  assert.ok(backwardsClock.r.endsWith('000900Z')&&backwardsClock.p.endsWith('000100Z'));
  const inverted=await replay();
  assert.ok(inverted.excludedReasons.READER_RECEIPT_TIME_INVALID,'a sub-millisecond backwards server receipt must be rejected');
  assert.ok(inverted.pairs.every(pair=>pair.sourceObservationId!==backwardsId));
  assert.deepEqual(inverted.pairs.map(pair=>pair.quoteHash),internal.pairs.map(pair=>pair.quoteHash),
    'the invalid earlier receipt cannot contaminate first-fetched provenance of the valid quote');
  assert.equal((await run(['--league','ucl','--date',c.date],{now:after})).selectedPairCount,null);
  const bounded=await run(['--league','epl','--date',c.date],{now:after,load:async()=>({truncated:true,readCoverage:{reasons:['CAPTURE_ROW_BUDGET']}})});
  assert.equal(bounded.status,'PARTIAL');assert.equal(bounded.selectedPairCount,null);
  await assert.rejects(()=>run(['--league','epl','--date','bogus']),/Usage/);
  // Two saved official game IDs have the same opposing teams and kickoff.
  // The complete candidate set rejects the ambiguous match; a single-game
  // request must never hide the other candidate and emit a pair.
  const collision=changed(fixtureCapture({id:'101'}),x=>{x.snapshot.evidence.game.home.name='Arsenal';x.snapshot.evidence.game.away.name='Manchester City';x.snapshot.directions=[];});
  const firstGame=c.snapshot.evidence.game,secondGame=collision.snapshot.evidence.game;
  assert.equal(matchSoccerReaderGames(payload,[firstGame],captured+32000)[0].matchStatus,'MATCHED');
  assert.equal(matchSoccerReaderGames(payload,[firstGame,secondGame],captured+32000)[0].matchStatus,'AMBIGUOUS');
  await recordSoccerCohort([firstGame,secondGame]);
  const withoutSecondForecast=await run(['--league','epl','--date',c.date],{now:after});
  const singleWithoutSecondForecast=await run(['--league','epl','--date',c.date,'--game-id',c.gameId],{now:after});
  assert.equal(withoutSecondForecast.selectedPairCount,null);assert.deepEqual(withoutSecondForecast.pairs,[]);
  assert.equal(singleWithoutSecondForecast.selectedPairCount,null);assert.deepEqual(singleWithoutSecondForecast.pairs,[]);
  assert.ok(withoutSecondForecast.reasonCodes.includes('FULL_DATE_OFFICIAL_IDENTITY_NOT_VERIFIED'));
  await db.query(`INSERT INTO sports_soccer_analysis_v1(league,game_id,analysis_hash,observed_at,payload) VALUES($1,$2,$3,$4,$5)`,
    [collision.league,collision.gameId,collision.revision,collision.snapshot.observedAt,JSON.stringify(collision.snapshot)]);
  await db.query(`INSERT INTO sports_soccer_forward_captures_v1(capture_id,protocol_version,league,game_id,board_date,period,variant,model_hash,analysis_revision,captured_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[collision.captureId,protocol.version,collision.league,collision.gameId,collision.date,collision.period,collision.variant,collision.modelHash,collision.revision,collision.capturedAt]);
  const dayCollision=await replay();
  assert.equal(dayCollision.selectedPairCount,0);assert.ok(dayCollision.excludedReasons.READER_GAME_NOT_MATCHED);
  const gameCollision=await run(['--league','epl','--date',c.date,'--game-id',c.gameId],{now:after});
  assert.equal(gameCollision.status,'PARTIAL');assert.equal(gameCollision.selectedPairCount,null);assert.deepEqual(gameCollision.pairs,[]);
  assert.ok(gameCollision.reasonCodes.includes('FULL_DATE_OFFICIAL_IDENTITY_NOT_VERIFIED'));
  const tie=changed(c,x=>{x.captureId=soccerForwardHash('later-microsecond-revision');x.captureSequence='2';x.snapshot.note='second distinct original';});
  await db.query(`INSERT INTO sports_soccer_analysis_v1(league,game_id,analysis_hash,observed_at,payload) VALUES($1,$2,$3,$4,$5)`,
    [tie.league,tie.gameId,tie.revision,tie.snapshot.observedAt,JSON.stringify(tie.snapshot)]);
  await db.query(`INSERT INTO sports_soccer_forward_captures_v1(capture_id,protocol_version,league,game_id,board_date,period,variant,model_hash,analysis_revision,captured_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[tie.captureId,protocol.version,tie.league,tie.gameId,tie.date,tie.period,tie.variant,tie.modelHash,tie.revision,c.capturedAt.replace('Z','900Z')]);
  const clocks=(await db.query(`SELECT to_char(captured_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS t FROM sports_soccer_forward_captures_v1 WHERE game_id=$1 ORDER BY captured_at`,[c.gameId])).rows.map(row=>row.t);
  assert.ok(clocks[0].endsWith('000100Z')&&clocks[1].endsWith('000900Z'),'two actual DB receipts differ within the same millisecond');
  const ambiguity=await replay();
  assert.equal(ambiguity.status,'PARTIAL');assert.equal(ambiguity.selectedPairCount,0);assert.ok(ambiguity.excludedReasons.FORECAST_TIME_TIE_AMBIGUOUS);
  register('./next-route-test-loader.mjs',import.meta.url);
  const {GET}=await import('../app/api/soccer/retrospective-pairs/route.js');
  const {createSessionToken}=await import('../lib/security.js'),cookie=`mlb_session=${await createSessionToken()}`;
  const request=(query,auth=true,ip='203.0.113.90')=>new Request(`https://example.test/api/soccer/retrospective-pairs${query}`,
    {headers:{...(auth?{cookie}:{}),'x-forwarded-for':ip}});
  assert.equal((await GET(request(`?league=epl&date=${c.date}`,false))).status,401);
  for(const query of ['?league=epl','?league=epl&date=bad','?league=nba&date=2026-01-01',
    '?league=epl&league=ucl&date=2026-01-01','?league=epl&date=2026-01-01&raw=1'])
    assert.equal((await GET(request(query,true,`203.0.113.${100+query.length}`))).status,400);
  const api=await GET(request(`?league=epl&date=${c.date}`));assert.equal(api.status,200);
  assert.equal(api.headers.get('cache-control'),'no-store');const body=await api.json();
  assert.equal(body.report.selectedPairCount,null);assert.ok(body.report.reasonCodes.includes('FULL_DATE_OFFICIAL_IDENTITY_NOT_VERIFIED'));
  assert.equal(body.report.formalEligible,false);
  assert.ok(!JSON.stringify(body).includes('private-test-device'));assert.ok(!JSON.stringify(body).includes('rawRows'));
  const listResponse=await GET(request(`?league=epl&date=${c.date}&mode=games`,true,'203.0.113.210'));
  assert.equal(listResponse.status,200);assert.equal((await listResponse.json()).report.games[0].gameId,c.gameId);
  const gameResponse=await GET(request(`?league=epl&date=${c.date}&gameId=${encodeURIComponent(c.gameId)}`,true,'203.0.113.211'));
  const gameBody=await gameResponse.json();assert.equal(gameResponse.status,200);assert.equal(gameBody.report.status,'PARTIAL');
  assert.equal(gameBody.report.scope.gameId,c.gameId);assert.equal(gameBody.report.dateCoverage,'PARTIAL_SINGLE_GAME');
  assert.equal(gameBody.report.selectedPairCount,null);assert.deepEqual(gameBody.report.pairs,[]);
  assert.equal((await GET(request(`?league=epl&date=${c.date}&mode=games&gameId=${encodeURIComponent(c.gameId)}`,true,'203.0.113.212'))).status,400);
  assert.equal((await GET(request(`?league=epl&date=${c.date}&gameId=soccer%3Aucl%3A123`,true,'203.0.113.213'))).status,400);
  // The public diagnostic does not run a matcher without authoritative date
  // identity, so it needs only a receipt metadata count. Whole-day originals
  // larger than 16MiB must not be hydrated merely to count stored rows. These
  // deliberately nonvalidated fixture payloads also prove count is not content
  // validation or an automatic route into formal evidence.
  await db.query(`INSERT INTO sports_soccer_reader_observations_v2
    (observation_id,league,board_date,content_hash,source_observed_at,received_at,payload)
    SELECT md5('big-original:'||i::text)||md5('big-observation:'||i::text),'EPL',$1,repeat('a',64),$2,$2,
      jsonb_build_object('fixturePadding',repeat('x',1048576)) FROM generate_series(1,17) AS i`,[c.date,observedAt]);
  const {loadSoccerRetrospectiveReaderReceipts:loadRaw}=await import('../lib/soccer/retrospective-reader-receipts.js');
  const oversized=await loadRaw('epl',c.date,{maxRows:1000});
  assert.equal(oversized.status,'PARTIAL');assert.ok(oversized.reasonCodes.includes('READER_RECEIPT_BYTE_BUDGET'));
  const expectedMetadataCount=Number((await db.query(`SELECT count(*) n FROM sports_soccer_reader_observations_v2
    WHERE league='EPL' AND board_date=$1::date`,[c.date])).rows[0].n);
  let readerMetadataQueries=0;
  globalThis.__SOCCER_TEST_SQL=async(queries,tx)=>{
    for(const {query} of queries)if(/sports_soccer_reader_observations_v2/.test(query)){
      readerMetadataQueries++;assert.doesNotMatch(query,/\bpayload\b|\bcontent_hash\b|\bperiods\b/,
        'the public diagnostic must not hydrate raw Reader content just for a count');
    }
    return original(queries,tx);
  };
  const largeMetadata=await run(['--league','epl','--date',c.date,'--game-id',c.gameId],{now:after});
  assert.equal(readerMetadataQueries,1);assert.equal(largeMetadata.readerObservationCount,expectedMetadataCount);
  assert.equal(largeMetadata.readerCoverage,'COMPLETE_METADATA_COUNT_SINGLE_STATEMENT');
  assert.equal(largeMetadata.readerCountScope,'RAW_RECEIPT_METADATA_COUNT_NOT_CONTENT_VALIDATION');
  assert.equal(largeMetadata.readerContentValidated,false);assert.equal(largeMetadata.selectedPairCount,null);
  assert.equal(largeMetadata.formalEligible,false);assert.deepEqual(largeMetadata.pairs,[]);
  assert.ok(!largeMetadata.reasonCodes.includes('READER_RECEIPT_BYTE_BUDGET'));
  const largeApi=await GET(request(`?league=epl&date=${c.date}&gameId=${encodeURIComponent(c.gameId)}`,true,'203.0.113.214'));
  const largeApiBody=await largeApi.json();assert.equal(largeApi.status,200);
  assert.equal(largeApiBody.report.readerObservationCount,expectedMetadataCount);
  assert.equal(largeApiBody.report.readerContentValidated,false);assert.equal(largeApiBody.report.selectedPairCount,null);
  assert.doesNotMatch(JSON.stringify(largeApiBody),/fixturePadding|rawRows|private-test-device/);
  globalThis.__SOCCER_TEST_SQL=async(queries,tx)=>{
    if(queries.some(({query})=>/sports_soccer_reader_observations_v2/.test(query)))throw Error('private-reader-count-failure');
    return original(queries,tx);
  };
  const metadataUnavailable=await run(['--league','epl','--date',c.date,'--game-id',c.gameId],{now:after});
  assert.equal(metadataUnavailable.readerObservationCount,null);assert.equal(metadataUnavailable.readerCoverage,'UNAVAILABLE');
  assert.equal(metadataUnavailable.selectedPairCount,null);assert.equal(metadataUnavailable.validForecastCount,largeMetadata.validForecastCount);
  assert.doesNotMatch(JSON.stringify(metadataUnavailable),/private-reader-count-failure/);
  globalThis.__SOCCER_TEST_SQL=original;
  for(let i=0;i<4;i++)assert.equal((await GET(request('?league=nba&date=2026-01-01',true,'203.0.113.200'))).status,400);
  assert.equal((await GET(request('?league=nba&date=2026-01-01',true,'203.0.113.200'))).status,429);
  globalThis.__SOCCER_TEST_SQL=async()=>{throw Error('postgres://private-password@private-host');};
  const failure=await GET(request(`?league=epl&date=${c.date}`,true,'203.0.113.201'));
  assert.equal(failure.status,503);assert.doesNotMatch(JSON.stringify(await failure.json()),/private-password|private-host/);
  globalThis.__SOCCER_TEST_SQL=original;
  // Reproduce the production blocker: >500 date-scope forecasts, while the
  // one requested game remains within its unchanged budget.
  await db.query(`INSERT INTO sports_soccer_analysis_v1(league,game_id,analysis_hash,observed_at,payload)
    SELECT 'epl','soccer:epl:888',md5(i::text)||md5('analysis:'||i::text),$1,'{}'::jsonb FROM generate_series(1,501) AS i`,[c.capturedAt]);
  await db.query(`INSERT INTO sports_soccer_forward_captures_v1(capture_id,protocol_version,league,game_id,board_date,period,variant,model_hash,analysis_revision,captured_at)
    SELECT md5('capture:'||i::text)||md5('unique:'||i::text),$1,'epl','soccer:epl:888',$2,'REGULATION_FT','BASELINE',repeat('a',64),
      md5(i::text)||md5('analysis:'||i::text),$3 FROM generate_series(1,501) AS i`,[protocol.version,c.date,c.capturedAt]);
  const fullDayBlocked=await run(['--league','epl','--date',c.date],{now:after});
  assert.equal(fullDayBlocked.status,'PARTIAL');assert.ok(fullDayBlocked.reasonCodes.includes('CAPTURE_ROW_BUDGET'));
  assert.equal(fullDayBlocked.readerObservationCount,expectedMetadataCount);
  assert.equal(fullDayBlocked.readerCoverage,'COMPLETE_METADATA_COUNT_SINGLE_STATEMENT');
  assert.equal(fullDayBlocked.readerContentValidated,false);assert.equal(fullDayBlocked.selectedPairCount,null);
  const stillOneGame=await run(['--league','epl','--date',c.date,'--game-id',c.gameId],{now:after});
  assert.equal(stillOneGame.forecastCoverage,'COMPLETE_SINGLE_GAME_CURRENT_PROTOCOL_STATEMENT');assert.equal(stillOneGame.status,'PARTIAL');
  assert.ok(stillOneGame.reasonCodes.includes('FULL_DATE_OFFICIAL_IDENTITY_NOT_VERIFIED'),'only this game is inspected despite the whole-day row budget');
  console.log('PASS read-only CLI through PostgreSQL forecast and original Reader receipts; no writes, strict scope, partial and formal-R exclusions');
} finally {globalThis.fetch=originalFetch;for(const [key,value] of Object.entries(before)){if(value===undefined)delete process.env[key];else process.env[key]=value;}await fixture.close();}
