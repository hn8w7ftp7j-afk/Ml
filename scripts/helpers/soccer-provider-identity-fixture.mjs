import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { fetchSoccerSchedule } from '../../lib/soccer/data.js';
import { normalizeSoccerPrematch } from '../../lib/soccer/prematch.js';
import { buildSoccerAnalysis } from '../../lib/soccer/analysis.js';
import { soccerCompleteScheduleAuthorityVerified } from '../../lib/soccer/reader-identity-proof.js';
import { parseSoccerCapture } from '../../reader/soccer-parser.js';
import { validateSoccerCapture } from '../../lib/soccer/reader.js';
import { soccerDate } from '../../lib/soccer/contracts.js';
// Synthetic network fixture enters the actual adapter/parser. No authority
// module is mocked, and no real source/account is contacted by this helper.
export async function soccerProviderIdentityFixture({now=Date.now()}={}) {
const at=new Date(now).toISOString(),start=new Date(Math.ceil((now+86400000)/60000)*60000).toISOString(),date=soccerDate(start);
const payload=JSON.parse(fs.readFileSync('scripts/fixtures/soccer/epl-summary.json'));
payload.header.date=start;const competition=payload.header.competitions[0];competition.date=start;competition.status={type:{state:'pre',completed:false,name:'STATUS_SCHEDULED'}};
const raw={...payload.header,date:start,status:competition.status},league=payload.header.league;
async function boardFor(events=[raw]){return fetchSoccerSchedule('epl',date,{now:()=>now,fetchImpl:async()=>Response.json({leagues:[league],events})});}
const board=await boardFor();assert.equal(board.ok,true);const game=board.games[0];
assert.equal(soccerCompleteScheduleAuthorityVerified(board,game),true,'real adapter registers normalized source scope');
const summarySource={provider:'ESPN',url:`https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/summary?event=${game.sourceId}`,fetchedAt:at,contentHash:createHash('sha256').update(JSON.stringify(payload)).digest('hex')};
const evidence=normalizeSoccerPrematch(payload,game,summarySource,now);evidence.scheduleSource=game.source;
const local=new Date(Date.parse(start)+8*3600000).toISOString(),time=local.slice(11,16),day=`${Number(date.slice(5,7))}/${Number(date.slice(8,10))}`;
const capture={league:'EPL',pageLeagueLabel:'英格蘭超級聯賽',sourceHost:'www.tai888.in',pageUrl:'https://www.tai888.in/newapp/',observedAt:at,
  tables:[{sectionTitle:'英格蘭超級聯賽 全場',headers:['時間','隊伍','全場讓球','全場大小','全場獨贏'],rows:[{cells:[{pair:[day,time]},{pair:[game.away.name,`${game.home.name}[主]`]},{pair:['0.900','0.5 0.900']},{pair:['大2.5 0.900','小 0.900']},{pair:['主勝 -','和 -','客勝 -']}]}]}]};
const parsed=parseSoccerCapture(capture,new Date(now));assert.deepEqual(parsed.parseIssues,[]);
const checked=validateSoccerCapture({...parsed,readerVersion:'2.1.54',pageActivityAt:at},{now,headerVersion:'2.1.54'});assert.equal(checked.ok,true,JSON.stringify(checked));
const reader={...checked.payload,revision:'a'.repeat(64),observationId:'b'.repeat(64),firstFetchedAt:at,receivedAt:at,persistedAt:at};
const build=(schedule=board,e=evidence,r=reader)=>buildSoccerAnalysis({evidence:e,reader:r,schedule,now});
const snapshot=build();return {now,at,start,date,payload,raw,boardFor,board,game,evidence,reader,build,snapshot};
}
