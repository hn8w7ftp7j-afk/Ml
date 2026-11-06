import assert from 'node:assert/strict';
import { soccerSqlFixture } from './helpers/soccer-sql-fixture.mjs';

// Isolated PostgreSQL fixture. No source calls, production database or real odds.
const fixture=await soccerSqlFixture(), {db}=fixture;
const before={DATABASE_URL:process.env.DATABASE_URL,DATABASE_V2_URL:process.env.DATABASE_V2_URL};
process.env.DATABASE_URL='postgres://fixture.invalid/reader-manifest'; delete process.env.DATABASE_V2_URL;

try {
  const {ensureSoccerJournal,soccerJournalHash}=await import('../lib/soccer/journal.js');
  const {saveSoccerReaderSnapshot:save}=await import('../lib/soccer/reader-store.js');
  const {soccerReaderHash}=await import('../lib/soccer/reader.js');
  const {canonicalSoccerPayload}=await import('../reader/soccer-parser.js');
  const {SOCCER_READER_INVENTORY_SCAN_SCHEMA:SCHEMA,startReaderInventoryScan:start,continueReaderInventoryScan:next}
    =await import('../lib/soccer/reader-inventory-scan.js');
  await ensureSoccerJournal();
  const query=async(sql,params=[]) => (await db.query(sql,params)).rows;
  for(const sql of SCHEMA) await query(sql);
  const ensure=async()=>{};
  const capture=(league,date,observed,legacy=false)=>{
    const payload={league,boardDate:date,observedAt:observed,executable:false,deviceId:'private-fixture-device',
      pageUrl:'https://sensitive.invalid/private',...(legacy?{}:{periodsCovered:['FT']}),games:[{
        league,boardDate:date,boardTime:'21:00',awayKey:'away',homeKey:'home',
        ...(legacy?{}:{periodsCovered:['FT'],periodStates:{FT:'open'}}),markets:[{
          kind:'TOTAL',unit:'GOALS',line:'2.5',overWater:0.9,underWater:0.95,
          ...(legacy?{}:{period:'FT',periodEvidence:{period:'FT',status:'EXPLICIT'}})}]}]};
    payload.contentHash=soccerReaderHash(canonicalSoccerPayload(payload));return payload;
  };
  const saveAt=async(league,date,sec)=>save(capture(league,date,`2026-10-20T08:00:${sec}.123456Z`),
    {receivedAt:`2026-10-20T08:00:${sec}.223456Z`});
  const neverLeak=value=>{
    const text=JSON.stringify(value);
    assert.equal(text.includes('private-fixture-device'),false,'device ID must never leave the service');
    assert.equal(text.includes('sensitive.invalid'),false,'source page URL must never leave the service');
    assert.equal(text.includes('overWater'),false,'raw market payload must never leave the service');
    assert.equal(value.formalEligible,false);assert.equal(value.selectedPairCount,null);
  };
  const date='2026-10-21';
  await saveAt('UCL',date,'01'); await saveAt('UCL',date,'02');
  const legacy=capture('UCL',date,'2026-10-20T08:00:03.123456Z',true), legacyId=soccerJournalHash(legacy);
  await query(`INSERT INTO sports_soccer_reader_observations_v2
    (observation_id,league,board_date,content_hash,source_observed_at,received_at,payload)
    VALUES($1,'UCL',$2,$3,$4,$5,$6::jsonb)`,
    [legacyId,date,legacy.contentHash,legacy.observedAt,'2026-10-20T08:00:03.223456Z',JSON.stringify(legacy)]);
  await saveAt('EPL',date,'04'); await saveAt('UCL','2026-10-22','05');
  const sql=[];const traced=async(statement,params=[])=>{sql.push(statement);return query(statement,params);};
  const started=await start({league:'ucl',date},{query:traced,ensure,maxReceipts:10});
  neverLeak(started);assert.equal(started.status,'RUNNING');assert.equal(started.totalCount,3);
  assert.match(started.cursor,/^[0-9a-f]{48}$/);
  assert.ok(sql.some(s=>/WITH/i.test(s)&&/INSERT\s+INTO\s+sports_soccer_reader_inventory_scans_v1/i.test(s)
    &&/INSERT\s+INTO\s+sports_soccer_reader_inventory_items_v1/i.test(s)),
    'job and receipt ID/period manifest must be frozen by one MVCC SQL statement');
  const cursor=started.cursor;

  // This later-committed row advertises earlier logical/DB timestamps. The frozen
  // snapshot MUST not gain it; timestamp watermarks alone cannot prove that.
  const late=capture('UCL',date,'2026-10-20T07:00:00.100001Z');
  const lateId=soccerJournalHash(late);
  await query(`INSERT INTO sports_soccer_reader_observations_v2
    (observation_id,league,board_date,content_hash,source_observed_at,received_at,persisted_at,payload)
    VALUES($1,'UCL',$2,$3,$4,$5,'2026-10-20T07:00:00.300001Z',$6::jsonb)`,
    [lateId,date,late.contentHash,late.observedAt,'2026-10-20T07:00:00.200001Z',JSON.stringify(late)]);
  // New period index after freeze cannot mutate the frozen legacy period set.
  await query(`INSERT INTO sports_soccer_reader_period_observations_v2(observation_id,period,content_hash)
    VALUES($1,'FT','later-period-must-not-be-read')`,[legacyId]);
  let page=await next({cursor,league:'ucl',date},{query,ensure,maxPageRows:1,maxPageBytes:1048576});
  neverLeak(page);assert.equal(page.verifiedCount,1);assert.equal(page.totalCount,3);
  for(let count=0;page.status==='RUNNING'&&count<10;count++) {
    const prior=page.verifiedCount;
    page=await next({cursor,league:'ucl',date},{query,ensure,maxPageRows:1,maxPageBytes:1048576});
    neverLeak(page);assert.ok(page.verifiedCount>=prior,'resuming must not roll counts backward');
  }
  assert.equal(page.status,'COMPLETE');assert.equal(page.verifiedCount,3);assert.equal(page.totalCount,3);
  const repeated=await next({cursor,league:'ucl',date},{query,ensure,maxPageRows:1,maxPageBytes:1048576});
  assert.equal(repeated.status,'COMPLETE');assert.equal(repeated.verifiedCount,3,'terminal replay is idempotent');
  for(const scope of [{cursor,league:'epl',date},{cursor,league:'ucl',date:'2026-10-22'},{cursor:'f'.repeat(48),league:'ucl',date}]) {
    let denied;try{denied=await next(scope,{query,ensure,maxPageRows:1,maxPageBytes:1048576});}
    catch {denied=null;}
    assert.notEqual(denied?.status,'COMPLETE','cursor cannot be reused for another scope or guessed');
  }
  // A new snapshot sees the late committed row; the earlier snapshot never does.
  const fresh=await start({league:'ucl',date},{query,ensure,maxReceipts:10});
  assert.equal(fresh.totalCount,4);
  const overflow=await start({league:'ucl',date},{query,ensure,maxReceipts:1});
  neverLeak(overflow);assert.equal(overflow.status,'PARTIAL');
  assert.ok(overflow.reasonCodes.length>0,'an oversize manifest must expose its actual bound');
  assert.notEqual(overflow.totalCount,1,'a truncated prefix must not be presented as the complete total');

  const byteDate='2026-10-23';await saveAt('UCL',byteDate,'06');
  const byteStart=await start({league:'ucl',date:byteDate},{query,ensure,maxReceipts:10});
  const bytes=await next({cursor:byteStart.cursor,league:'ucl',date:byteDate},{query,ensure,maxPageRows:1,maxPageBytes:1024});
  neverLeak(bytes);assert.equal(bytes.status,'PARTIAL');assert.ok(bytes.reasonCodes.includes('READER_RECEIPT_BYTE_BUDGET'));
  assert.equal(bytes.verifiedCount,0,'an oversize original must not be skipped');

  const badDate='2026-10-24',bad=capture('UCL',badDate,'2026-10-20T08:00:07.123456Z',true);
  await query(`INSERT INTO sports_soccer_reader_observations_v2
    (observation_id,league,board_date,content_hash,source_observed_at,received_at,payload)
    VALUES('wrong-original-hash','UCL',$1,$2,$3,$3,$4::jsonb)`,[badDate,bad.contentHash,bad.observedAt,JSON.stringify(bad)]);
  const badStart=await start({league:'ucl',date:badDate},{query,ensure,maxReceipts:10});
  const invalid=await next({cursor:badStart.cursor,league:'ucl',date:badDate},{query,ensure,maxPageRows:1,maxPageBytes:1048576});
  neverLeak(invalid);assert.equal(invalid.status,'PARTIAL');assert.equal(invalid.verifiedCount,0,'bad original cannot be silently skipped');

  const skewDate='2026-10-25',skew=capture('UCL',skewDate,'2026-10-20T08:00:08.000100Z',true);
  await query(`INSERT INTO sports_soccer_reader_observations_v2
    (observation_id,league,board_date,content_hash,source_observed_at,received_at,persisted_at,payload)
    VALUES($1,'UCL',$2,$3,$4,'2026-10-20T08:00:08.000900Z','2026-10-20T08:00:08.000200Z',$5::jsonb)`,
    [soccerJournalHash(skew),skewDate,skew.contentHash,skew.observedAt,JSON.stringify(skew)]);
  const skewStart=await start({league:'ucl',date:skewDate},{query,ensure,maxReceipts:10});
  const invalidTime=await next({cursor:skewStart.cursor,league:'ucl',date:skewDate},{query,ensure,maxPageRows:1,maxPageBytes:1048576});
  assert.equal(invalidTime.status,'PARTIAL');assert.equal(invalidTime.verifiedCount,0,'submillisecond backward receipt is invalid');

  const concurrentDate='2026-10-26';
  await saveAt('UCL',concurrentDate,'09'); await saveAt('UCL',concurrentDate,'10'); await saveAt('UCL',concurrentDate,'11');
  const concurrent=await start({league:'ucl',date:concurrentDate},{query,ensure,maxReceipts:10});
  const concurrentInput={cursor:concurrent.cursor,league:'ucl',date:concurrentDate};
  const attempts=await Promise.allSettled([next(concurrentInput,{query,ensure,maxPageRows:1,maxPageBytes:1048576}),
    next(concurrentInput,{query,ensure,maxPageRows:1,maxPageBytes:1048576})]);
  for(const attempt of attempts) if(attempt.status==='fulfilled'){
    neverLeak(attempt.value);assert.ok(attempt.value.verifiedCount<=3,'concurrent claims cannot double count');
  }
  let resumed;
  for(let n=0;n<10;n++) {
    resumed=await next(concurrentInput,{query,ensure,maxPageRows:1,maxPageBytes:1048576});
    assert.ok(resumed.verifiedCount<=3,'stale progress cannot increment a receipt twice');
    if(resumed.status==='COMPLETE')break;
  }
  assert.equal(resumed.status,'COMPLETE');assert.equal(resumed.verifiedCount,3,'concurrent resume is complete and idempotent');

  // A legitimate explicitly empty board is indexed as UNKNOWN by the writer.
  // If that period index is missing we must not invent it during snapshotting.
  const emptyDate='2026-10-28';
  const empty={league:'UCL',boardDate:emptyDate,observedAt:'2026-10-20T08:00:14.123456Z',
    executable:false,periodsCovered:[],games:[]};
  empty.contentHash=soccerReaderHash(canonicalSoccerPayload(empty));
  await save(empty,{receivedAt:'2026-10-20T08:00:14.223456Z'});
  const emptyStart=await start({league:'ucl',date:emptyDate},{query,ensure,maxReceipts:10});
  const emptyResult=await next({cursor:emptyStart.cursor,league:'ucl',date:emptyDate},
    {query,ensure,maxPageRows:1,maxPageBytes:1048576});
  assert.equal(emptyResult.status,'COMPLETE');assert.equal(emptyResult.verifiedCount,1);
  const noIndexDate='2026-10-29',noIndex={...empty,boardDate:noIndexDate};
  noIndex.contentHash=soccerReaderHash(canonicalSoccerPayload(noIndex));
  await query(`INSERT INTO sports_soccer_reader_observations_v2
    (observation_id,league,board_date,content_hash,source_observed_at,received_at,payload)
    VALUES($1,'UCL',$2,$3,$4,$4,$5::jsonb)`,[soccerJournalHash(noIndex),noIndexDate,noIndex.contentHash,noIndex.observedAt,JSON.stringify(noIndex)]);
  const noIndexStart=await start({league:'ucl',date:noIndexDate},{query,ensure,maxReceipts:10});
  const noIndexResult=await next({cursor:noIndexStart.cursor,league:'ucl',date:noIndexDate},
    {query,ensure,maxPageRows:1,maxPageBytes:1048576});
  assert.equal(noIndexResult.status,'PARTIAL');assert.equal(noIndexResult.verifiedCount,0,
    'missing typed period evidence must never be synthesized');

  const archiveDate='2026-10-30';await saveAt('UCL',archiveDate,'15');
  // Insert an old job via fixture-only schema default, never mutate a manifest.
  await query(`ALTER TABLE sports_soccer_reader_inventory_scans_v1 ALTER COLUMN started_at SET DEFAULT '2020-01-01T00:00:00Z'::timestamptz`);
  const archive=await start({league:'ucl',date:archiveDate},{query,ensure,maxReceipts:10});
  await query(`ALTER TABLE sports_soccer_reader_inventory_scans_v1 ALTER COLUMN started_at SET DEFAULT clock_timestamp()`);
  const archiveCursor=archive.cursor;
  await assert.rejects(query(`UPDATE sports_soccer_reader_inventory_items_v1 SET periods='[]'::jsonb WHERE cursor=$1`,[archiveCursor]),
    'manifest items must reject updates');
  await assert.rejects(query(`DELETE FROM sports_soccer_reader_inventory_items_v1 WHERE cursor=$1`,[archiveCursor]),
    'manifest items must reject deletes');
  await assert.rejects(query(`UPDATE sports_soccer_reader_inventory_scans_v1 SET league='EPL' WHERE cursor=$1`,[archiveCursor]),
    'manifest scope must reject updates');
  await assert.rejects(query(`UPDATE sports_soccer_reader_inventory_scans_v1 SET started_at=clock_timestamp() WHERE cursor=$1`,[archiveCursor]),
    'manifest snapshot time must reject updates');
  await assert.rejects(query(`DELETE FROM sports_soccer_reader_inventory_scans_v1 WHERE cursor=$1`,[archiveCursor]),
    'manifest jobs must reject deletes');
  const oldPage=await next({cursor:archiveCursor,league:'ucl',date:archiveDate},
    {query,ensure,maxPageRows:1,maxPageBytes:1048576});
  assert.equal(oldPage.status,'COMPLETE','an old frozen manifest must remain resumable');
  assert.equal(oldPage.verifiedCount,1);
  const scopeDate='2026-10-31';await saveAt('UCL',scopeDate,'16');
  for(let i=0;i<2;i++) {
    const allowed=await start({league:'ucl',date:scopeDate},{query,ensure,maxReceipts:10,maxScansPerScope:2});
    assert.equal(allowed.status,'RUNNING');
  }
  const scopeExceeded=await start({league:'ucl',date:scopeDate},{query,ensure,maxReceipts:10,maxScansPerScope:2});
  neverLeak(scopeExceeded);assert.equal(scopeExceeded.status,'PARTIAL');
  assert.equal(scopeExceeded.totalCount,null);assert.equal(scopeExceeded.observedCount,null);
  assert.ok(scopeExceeded.reasonCodes.includes('READER_MANIFEST_SCOPE_BUDGET'));

  // A caller-selected opaque token makes a start retry idempotent even when a
  // response was lost. Later observations must not enter the original snapshot.
  const retryDate='2026-11-01',fixedCursor='a'.repeat(48);
  const retryInput={league:'ucl',date:retryDate,cursor:fixedCursor};
  const retryOptions={query,ensure,maxReceipts:10,maxScansPerScope:2};
  await saveAt('UCL',retryDate,'17');
  const first=await start(retryInput,retryOptions);
  assert.equal(first.cursor,fixedCursor);assert.equal(first.totalCount,1);
  await saveAt('UCL',retryDate,'18');
  const retried=await start(retryInput,retryOptions);
  assert.equal(retried.cursor,fixedCursor);assert.equal(retried.totalCount,1,
    'start retry cannot include newly committed receipts');
  for(const scope of [{league:'epl',date:retryDate,cursor:fixedCursor},
    {league:'ucl',date:'2026-11-02',cursor:fixedCursor}]) {
    let reused;try{reused=await start(scope,retryOptions);}catch{reused=null;}
    assert.ok(!reused || reused.cursor!==fixedCursor,'a fixed cursor cannot be reused for another scope');
  }
  const second=await start({league:'ucl',date:retryDate,cursor:'b'.repeat(48)},retryOptions);
  assert.equal(second.totalCount,2,'a new manifest sees the later receipt');
  const refused=await start({league:'ucl',date:retryDate,cursor:'c'.repeat(48)},retryOptions);
  assert.equal(refused.status,'PARTIAL');assert.equal(refused.totalCount,null);
  assert.ok(refused.reasonCodes.includes('READER_MANIFEST_SCOPE_BUDGET'));
  const afterQuota=await start(retryInput,retryOptions);
  assert.equal(afterQuota.cursor,fixedCursor);assert.equal(afterQuota.totalCount,1,
    'reusing an existing cursor remains possible at the scope budget');
  const fixedComplete=await next(retryInput,{query,ensure,maxPageRows:1,maxPageBytes:1048576});
  assert.equal(fixedComplete.status,'COMPLETE');assert.equal(fixedComplete.verifiedCount,1);

  // Simulate impossible-under-normal-immutable-FK storage loss explicitly so
  // the reader still fails closed if an operator accidentally damages storage.
  const missingDate='2026-10-27',missing=capture('UCL',missingDate,'2026-10-20T08:00:12.123456Z',true);
  const missingId=soccerJournalHash(missing);
  await query(`INSERT INTO sports_soccer_reader_observations_v2
    (observation_id,league,board_date,content_hash,source_observed_at,received_at,payload)
    VALUES($1,'UCL',$2,$3,$4,$4,$5::jsonb)`,[missingId,missingDate,missing.contentHash,missing.observedAt,JSON.stringify(missing)]);
  const missingStart=await start({league:'ucl',date:missingDate},{query,ensure,maxReceipts:10});
  const foreignKeys=await query(`SELECT conname FROM pg_constraint
    WHERE conrelid='sports_soccer_reader_inventory_items_v1'::regclass
      AND confrelid='sports_soccer_reader_observations_v2'::regclass AND contype='f'`);
  for(const {conname} of foreignKeys){
    assert.match(conname,/^[a-zA-Z0-9_]+$/);
    await query(`ALTER TABLE sports_soccer_reader_inventory_items_v1 DROP CONSTRAINT "${conname}"`);
  }
  await query(`ALTER TABLE sports_soccer_reader_observations_v2 DISABLE TRIGGER USER`);
  await query(`DELETE FROM sports_soccer_reader_observations_v2 WHERE observation_id=$1`,[missingId]);
  const missingResult=await next({cursor:missingStart.cursor,league:'ucl',date:missingDate},{query,ensure,maxPageRows:1,maxPageBytes:1048576});
  neverLeak(missingResult);assert.equal(missingResult.status,'PARTIAL');assert.equal(missingResult.verifiedCount,0,
    'a missing original cannot be skipped or counted as verified');
  console.log('PASS Reader inventory: frozen period manifests, late commits, scope isolation, bounded pages, corruption, microsecond clocks, no payload disclosure or scoring');
} finally {
  for(const [key,value] of Object.entries(before)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  await fixture.close();
}
