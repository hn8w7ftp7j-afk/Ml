import {createHash} from 'node:crypto';
import {validateOpeningHistory} from './opening-core.js';
import {validDate} from './identity.js';
import {OPENING_ARCHIVE_SOURCE_ROLE,nbaScoreboardDate} from './opening-history-acquisition.js';

// Pin is set only after all raw sources have been replayed by the preparer.
export const OPENING_INDEPENDENT_REVIEWED_ARCHIVE_SHA256='b387b11e4127df1d953821b37575b035d91b63cdd6d6125f8321fab52720578c';
export const OPENING_INDEPENDENT_SOURCE_YEARS=Object.freeze([2013,2014,2015,2016,2017]);
const sha=x=>createHash('sha256').update(x).digest('hex');
const digest=x=>{try{return sha(JSON.stringify(x));}catch{return null;}};
const iso=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x;
const keys=['gameId','date','startTime','year','seasonType','homeId','awayId','homeScore','awayScore','neutralSite','homeHalf','awayHalf','checkpointSha256'];
const identities=rows=>rows.map(r=>Object.fromEntries(keys.map(k=>[k,r[k]]))).sort((a,b)=>a.gameId.localeCompare(b.gameId));
const taipei=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'});

export function auditOpeningIndependentArchive(history,archive){
  const errors=[],fail=(ok,reason)=>{if(!ok&&!errors.includes(reason))errors.push(reason);};
  const suppliedHash=digest(archive),years=OPENING_INDEPENDENT_SOURCE_YEARS;
  fail(suppliedHash===OPENING_INDEPENDENT_REVIEWED_ARCHIVE_SHA256,'REVIEWED_ARCHIVE_HASH_MISMATCH');
  fail(archive?.kind==='NBA_OPENING_INDEPENDENT_REGULAR_ARCHIVE'&&archive?.version==='nba-opening-independent-history-v1'
    &&archive?.sourceRole===OPENING_ARCHIVE_SOURCE_ROLE&&archive?.synthetic!==true
    &&archive?.temporalBasis==='earlier_era_external_retrospective_results_not_prospective_OOS_or_historical_pregame_capture'
    &&archive?.strictPointInTime===false&&archive?.officialNbaVerified===false
    &&JSON.stringify(archive?.quarantinedHoldoutYears)==='[2017]'&&iso(archive?.retrievedAt),'ARCHIVE_SCOPE_INVALID');
  fail(archive?.coverage?.status==='complete'&&Array.isArray(archive?.missing)&&!archive.missing.length
    &&Array.isArray(archive?.coverage?.missing)&&!archive.coverage.missing.length,'ARCHIVE_INCOMPLETE');
  fail(JSON.stringify(Object.keys(archive?.coverage?.years||{}).map(Number).sort((a,b)=>a-b))===JSON.stringify(years),'ARCHIVE_YEAR_SCOPE_INVALID');
  const rows=Array.isArray(archive?.history)?archive.history:[],sources=Array.isArray(archive?.sources)?archive.sources:[];
  fail(validateOpeningHistory(history)&&!history.some(r=>r.league!=null&&r.league!=='NBA'),'EVALUATED_HISTORY_INVALID');
  fail(validateOpeningHistory(rows)&&rows.every(r=>years.includes(r.year)&&!(r.league!=null&&r.league!=='NBA')),'ARCHIVE_HISTORY_INVALID');
  fail(sources.length>0,'SOURCE_MANIFEST_MISSING');
  const urls=new Set(),schedules=new Map(),boards=new Map();
  for(const s of sources){
    if(!s||typeof s!=='object'){fail(false,'SOURCE_MANIFEST_INVALID');continue;}
    fail(typeof s.url==='string'&&!urls.has(s.url),'SOURCE_URL_DUPLICATE_OR_INVALID');urls.add(s.url);
    fail(/^[a-f0-9]{64}$/.test(s.sha256||'')&&Number.isSafeInteger(s.bytes)&&s.bytes>0&&iso(s.retrievedAt)
      &&s.retrievedAt<=archive?.retrievedAt&&typeof s.url==='string'&&s.cacheFile===`sources/${sha(String(s.url))}.json.gz`,'SOURCE_CHECKPOINT_INVALID');
    if(s.kind==='team_schedule'){
      fail(years.includes(s.year)&&/^(?:[1-9]|[12]\d|30)$/.test(String(s.team))
        &&s.url===`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${s.team}/schedule?season=${s.year}&seasontype=2`,'SCHEDULE_SOURCE_SCOPE_INVALID');
      const teams=schedules.get(s.year)||new Set();fail(!teams.has(String(s.team)),'SCHEDULE_TEAM_DUPLICATE');teams.add(String(s.team));schedules.set(s.year,teams);
    }else if(s.kind==='daily_scoreboard'){
      fail(validDate(s.day)&&s.url===`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${String(s.day).replaceAll('-','')}&limit=1000`,'SCOREBOARD_SOURCE_SCOPE_INVALID');
      fail(!boards.has(s.day),'SCOREBOARD_DAY_DUPLICATE');boards.set(s.day,s);
    }else fail(false,'SOURCE_KIND_INVALID');
  }
  const days=new Set();
  for(const r of rows){
    if(!iso(r?.startTime)){fail(false,'ROW_START_TIME_INVALID');continue;}
    const day=nbaScoreboardDate(r.startTime);days.add(day);
    fail(taipei.format(new Date(r.startTime))===r.date,'ROW_TAIPEI_DATE_MISMATCH');
    fail(boards.get(day)?.sha256===r.checkpointSha256,'ROW_SOURCE_CHECKPOINT_MISMATCH');
  }
  fail(boards.size===days.size&&[...boards.keys()].every(day=>days.has(day)),'SCOREBOARD_CALENDAR_INCOMPLETE');
  return years.map(year=>{
    const failures=[...errors],sourceRows=rows.filter(r=>r?.year===year),evaluated=Array.isArray(history)?history.filter(r=>r?.year===year):[];
    const check=(ok,reason)=>{if(!ok&&!failures.includes(reason))failures.push(reason);};
    const dates=sourceRows.map(r=>r.date).sort(),c=archive?.coverage?.years?.[year];
    check(schedules.get(year)?.size===30,'THIRTY_TEAM_SCHEDULES_REQUIRED');
    check(sourceRows.length>0&&c?.expectedGames===sourceRows.length&&c?.observedGames===sourceRows.length&&c?.quarterCrosscheckedGames===sourceRows.length
      &&c?.teamSchedulesChecked===30&&c?.missingGames===0&&c?.firstSourceGameDate===dates[0]&&c?.lastSourceGameDate===dates.at(-1),'RECONSTRUCTED_COVERAGE_MISMATCH');
    let matches=false;try{matches=JSON.stringify(identities(sourceRows))===JSON.stringify(identities(evaluated));}catch{}
    check(matches,'EVALUATED_HISTORY_SOURCE_MISMATCH');
    return {year,observedGames:evaluated.length,verified:!failures.length,reason:failures.length?'COMPLETE_YEAR_SOURCE_AUDIT_REQUIRED':null,failureCodes:failures,
      reviewedArchiveSha256:OPENING_INDEPENDENT_REVIEWED_ARCHIVE_SHA256,suppliedArchiveSha256:suppliedHash,schedulesChecked:schedules.get(year)?.size||0,
      sourceBasis:'reviewed_raw_source_hash_and_reconstructed_manifest_not_remote_attestation_or_prospective_OOS'};
  });
}
