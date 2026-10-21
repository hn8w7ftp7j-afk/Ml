import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {openingIndependentHistory as archive,openingIndependentHistoryArchiveSha256} from '../lib/nba/opening-independent-history.js';
import {auditOpeningIndependentArchive,OPENING_INDEPENDENT_REVIEWED_ARCHIVE_SHA256,OPENING_INDEPENDENT_SOURCE_YEARS} from '../lib/nba/opening-independent-evidence.js';

const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const audit=(history=archive.history,evidence=archive)=>auditOpeningIndependentArchive(history,evidence);
assert.equal(openingIndependentHistoryArchiveSha256,OPENING_INDEPENDENT_REVIEWED_ARCHIVE_SHA256);
assert.equal(hash(archive),OPENING_INDEPENDENT_REVIEWED_ARCHIVE_SHA256);
assert.ok(Object.isFrozen(archive)&&Object.isFrozen(archive.history)&&Object.isFrozen(archive.sources));
assert.deepEqual(OPENING_INDEPENDENT_SOURCE_YEARS,[2013,2014,2015,2016,2017]);
const good=audit();assert.ok(good.every(r=>r.verified));
assert.deepEqual(good.map(r=>r.observedGames),[1229,1230,1230,1230,1230]);
assert.equal(archive.sources.filter(r=>r.kind==='team_schedule').length,150);
assert.equal(archive.sources.filter(r=>r.kind==='daily_scoreboard').length,811);
assert.equal(archive.history.length,6149);assert.deepEqual(archive.quarantinedHoldoutYears,[2017]);
assert.equal(archive.strictPointInTime,false);assert.equal(archive.officialNbaVerified,false);
assert.match(archive.temporalBasis,/not_prospective_OOS/);
const bad=(mutate,code)=>{
  const changed=structuredClone(archive);mutate(changed);
  const result=audit(changed.history,changed);
  assert.ok(result.every(r=>!r.verified));
  assert.ok(result.some(r=>r.failureCodes.includes(code)),code);
};
bad(r=>{r.sources.splice(r.sources.findIndex(s=>s.kind==='daily_scoreboard'),1);},'SCOREBOARD_CALENDAR_INCOMPLETE');
bad(r=>{r.sources=r.sources.filter(s=>!(s.kind==='team_schedule'&&s.year===2017&&s.team===30));},'THIRTY_TEAM_SCHEDULES_REQUIRED');
bad(r=>{r.sources.push(r.sources[0]);},'SOURCE_URL_DUPLICATE_OR_INVALID');
bad(r=>{r.sources.find(s=>s.kind==='daily_scoreboard').sha256='f'.repeat(64);},'ROW_SOURCE_CHECKPOINT_MISMATCH');
bad(r=>{r.history[0].homeHalf++;},'REVIEWED_ARCHIVE_HASH_MISMATCH');
bad(r=>{r.quarantinedHoldoutYears=[2022];},'ARCHIVE_SCOPE_INVALID');
bad(r=>{r.strictPointInTime=true;},'ARCHIVE_SCOPE_INVALID');
bad(r=>{r.coverage.years[2017].expectedGames--;},'RECONSTRUCTED_COVERAGE_MISMATCH');
bad(r=>{r.history[0].date='2012-11-01';},'ROW_TAIPEI_DATE_MISMATCH');
bad(r=>{r.sources[0].cacheFile='../outside';},'SOURCE_CHECKPOINT_INVALID');
const changed=archive.history.map((r,i)=>i?r:{...r,homeScore:r.homeScore+1});
assert.ok(audit(changed).some(r=>r.failureCodes.includes('EVALUATED_HISTORY_SOURCE_MISMATCH')));
assert.ok(audit(archive.history.filter(r=>r.year!==2017)).some(r=>r.year===2017&&!r.verified));
for(const malformed of [null,{},[],{sources:[null]}, {history:[null],sources:[null]}])assert.ok(audit([],malformed).every(r=>!r.verified));
for(const file of ['scripts/download-nba-opening-independent-history.mjs','scripts/prepare-nba-opening-independent-history.mjs']){
  assert.doesNotMatch(fs.readFileSync(file,'utf8'),/from ['"].*(?:opening-research-v|opening-model|analysis-training)/,'source acquisition cannot calculate predictive metrics');
}
console.log('PASS earlier-era independent archive: raw-reviewed pin, all150schedules+811scoreboards,6149identities/quarters,2017quarantine, malformed/forged/incomplete sources fail closed; no predictive metrics');
