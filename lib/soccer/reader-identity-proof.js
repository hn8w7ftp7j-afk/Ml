import { soccerIdentityHash as hash, soccerIdentityTextHash } from './identity-hash.js';
import { soccerDate, shiftSoccerDate, validSoccerDate } from './contracts.js';
import { soccerTeamLabel } from './team-labels.js';
import { soccerReaderMatchTeamKey } from './reader-team-identity.js';

// This proves a unique match inside the provider pages actually returned. It
// does not certify universal schedule completeness or independent corroboration.
export const SOCCER_READER_IDENTITY_PROOF_VERSION='SOCCER-PROVIDER-SCOPED-IDENTITY-v1';
const slug={epl:'eng.1',ucl:'uefa.champions'};
const id=value=>typeof value==='string'&&/^[1-9]\d{0,15}$/.test(value);
const instant=value=>typeof value==='string'&&/(?:Z|[+-]\d\d:\d\d)$/.test(value)?Date.parse(value):NaN;
const pages=new WeakMap();
const quoteFields=['key','sourceQuoteKey','marketKey','period','kind','unit','line','lineSide','side','water','rawRows','provenance','fresh','prestart'];
function quoteBindings(snapshot){return [...(snapshot.directions||[]).flatMap(direction=>(direction.quotes||[]).map(quote=>({period:direction.period,direction:direction.direction,quote:Object.fromEntries(quoteFields.map(key=>[key,quote?.[key]??null]))}))),...(snapshot.unassignedQuotes||[]).map(quote=>({period:'UNKNOWN',direction:'UNASSIGNED',quote:Object.fromEntries(quoteFields.map(key=>[key,quote?.[key]??null]))}))].map(row=>({period:row.period,direction:row.direction,key:row.quote.key,hash:hash(row.quote)})).sort((a,b)=>`${a.period}:${a.direction}:${a.key}`.localeCompare(`${b.period}:${b.direction}:${b.key}`));}
const source=value=>value&&({provider:value.provider,url:value.url,contentHash:value.contentHash,fetchedAt:value.fetchedAt});
function sourceValid(value,league,date,cutoff,{summaryId=null}={}){
  if(value?.provider!=='ESPN'||!/^[a-f0-9]{64}$/.test(value.contentHash||'')||!Number.isFinite(instant(value.fetchedAt))||instant(value.fetchedAt)>cutoff||cutoff-instant(value.fetchedAt)>180000)return false;
  try{const u=new URL(value.url);return u.protocol==='https:'&&u.hostname==='site.api.espn.com'&&!u.username&&!u.password&&!u.port&&!u.hash
    &&u.pathname===`/apis/site/v2/sports/soccer/${slug[league]}/${summaryId?'summary':'scoreboard'}`
    &&[...u.searchParams.keys()].length===1&&(summaryId?u.searchParams.get('event')===summaryId:u.searchParams.get('dates')===date.replaceAll('-',''));}catch{return false;}
}
function identity(game){
  if(!Object.hasOwn(slug,game?.league)||!id(game.sourceId)||game.id!==`soccer:${game.league}:${game.sourceId}`
    ||!Number.isFinite(instant(game.startTime))||soccerDate(game.startTime)!==game.date||typeof game.neutralSite!=='boolean'
    ||!['home','away'].every(side=>id(game[side]?.sourceId)&&game[side]?.id===`soccer:${game.league}:team:${game[side].sourceId}`&&typeof game[side]?.name==='string')||game.home.sourceId===game.away.sourceId)return null;
  const teams=Object.fromEntries(['home','away'].map(side=>[side,{id:game[side].id,sourceId:game[side].sourceId,name:game[side].name,key:soccerReaderMatchTeamKey(soccerTeamLabel(game[side]))}]));
  if(!teams.home.key||!teams.away.key||teams.home.key===teams.away.key)return null;
  return{id:game.id,sourceId:game.sourceId,league:game.league,date:game.date,startTime:game.startTime,neutralSite:game.neutralSite,...teams};
}
function sameGame(a,b){return a&&b&&['id','sourceId','league','date','startTime','neutralSite'].every(k=>a[k]===b[k])&&['home','away'].every(side=>a[side]?.sourceId===b[side]?.sourceId&&a[side]?.key===b[side]?.key);}
function manifest(board){
  if(board?.ok!==true||board.coverage?.complete!==true||!Object.hasOwn(slug,board.league?.id)||!validSoccerDate(board.date)||board.until!==board.date
    ||!Array.isArray(board.games)||!Array.isArray(board.sources)||board.sources.length!==2)return null;
  const identities=board.games.map(identity);if(identities.some(value=>!value||value.league!==board.league.id||value.date!==board.date)||new Set(identities.map(value=>value.id)).size!==identities.length)return null;
  const sources=board.sources.map(source),sourceDates=[shiftSoccerDate(board.date,-1),board.date];
  const at=Math.max(...sources.map(s=>instant(s?.fetchedAt)));if(!Number.isFinite(at)||sources.some((s,i)=>!sourceValid(s,board.league.id,sourceDates[i],at)))return null;
  const aggregate=soccerIdentityTextHash(JSON.stringify(board.sources.map(item=>({url:item.url,contentHash:item.contentHash}))));
  if(board.source?.contentHash!==aggregate||board.source?.scope!=='COMBINED_SINGLE_DAY_SNAPSHOTS')return null;
  return{league:board.league.id,date:board.date,sourceDates,sources,aggregateSourceHash:aggregate,identities:identities.sort((a,b)=>a.id.localeCompare(b.id))};
}
// Called only by the server schedule adapter after its existing reads and
// normalizers succeed. Plain HTTP/fixture coverage flags do not enter this map.
export function registerSoccerScheduleIdentityBoard(board){try{const m=manifest(board);if(m)pages.set(board,{manifest:m,hash:hash(m)});}catch{}return board;}
// Compatibility name: this is returned-provider-scope authority, not a claim
// that the source supplied every fixture that exists outside those pages.
export function soccerCompleteScheduleAuthorityVerified(board,game){try{return boardVerified(board,game);}catch{return false;}}
function boardVerified(board,game){
  const saved=pages.get(board),m=manifest(board),g=identity(game);return Boolean(saved&&m&&hash(m)===saved.hash&&m.identities.filter(row=>sameGame(row,g)).length===1);
}
function rawIdentity(raw,game){
  if(raw?.officialGameId!==game.id||raw.matchStatus!=='MATCHED'||raw.boardDate!==game.date||!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(raw.boardTime||''))return null;
  const startTime=new Date(`${raw.boardDate}T${raw.boardTime}:00+08:00`).toISOString();
  if(startTime!==game.startTime||['home','away'].some(side=>raw[`${side}Raw`]!==undefined&&globalThis.Tai888SoccerTeams.key(raw[`${side}Raw`])!==raw[`${side}Key`]))return null;
  const result={boardDate:raw.boardDate,boardTime:raw.boardTime,startTime,homeKey:soccerReaderMatchTeamKey(raw.homeKey),awayKey:soccerReaderMatchTeamKey(raw.awayKey)};
  return result.homeKey===game.home.key&&result.awayKey===game.away.key?result:null;
}
export function createVerifiedSoccerScheduleIdentityEvidence(board,game,scheduleSource,now,options={}){try{return createEvidence(board,game,scheduleSource,now,options);}catch{return null;}}
function createEvidence(board,game,scheduleSource,now,{summarySource,matchedGames=[],directions=[],unassignedQuotes=[]}={}){
  if(!Number.isFinite(now)||!soccerCompleteScheduleAuthorityVerified(board,game))return null;
  const m=pages.get(board).manifest,g=identity(game),selected=source(scheduleSource),summary=source(summarySource);
  if(m.sources.some((s,i)=>!sourceValid(s,g.league,m.sourceDates[i],now))||!m.sources.some(s=>hash(s)===hash(selected))
    ||!sourceValid(summary,g.league,g.date,now,{summaryId:g.sourceId})||!Array.isArray(matchedGames)||!matchedGames.length)return null;
  const matches=matchedGames.map(raw=>rawIdentity(raw,g));if(matches.some(value=>!value))return null;
  if(matches.some(raw=>m.identities.filter(row=>row.startTime===raw.startTime&&row.home.key===raw.homeKey&&row.away.key===raw.awayKey).length!==1))return null;
  const body={version:SOCCER_READER_IDENTITY_PROOF_VERSION,status:'PROVIDER_SCOPED_UNIQUE_MATCH',league:g.league,gameId:g.id,date:g.date,
    verifiedAt:new Date(now).toISOString(),manifest:m,scheduleSource:selected,summarySource:summary,readerIdentities:matches,quoteBindings:quoteBindings({directions,unassignedQuotes}),
    providerCompletenessVerified:false,independentlyConfirmed:false,formalEligible:false};return{...body,contentHash:hash(body)};
}
// Inputs here are server-created current snapshots or original snapshots whose
// immutable analysis revision/DB receipt is checked by the caller. A recomputed
// hash on an arbitrary HTTP object is not an authorization mechanism.
export function soccerReaderIdentityVerified(snapshot){try{return verify(snapshot);}catch{return false;}}
function verify(snapshot){
  const proof=snapshot?.readerIdentityEvidence,game=identity(snapshot?.evidence?.game),cutoff=instant(snapshot?.analysisCutoff);
  if(!proof||!game||proof.version!==SOCCER_READER_IDENTITY_PROOF_VERSION||proof.status!=='PROVIDER_SCOPED_UNIQUE_MATCH'
    ||!Number.isFinite(cutoff)||instant(proof.verifiedAt)!==cutoff||proof.league!==snapshot.league||proof.gameId!==snapshot.gameId||proof.date!==snapshot.date
    ||proof.gameId!==game.id||proof.providerCompletenessVerified!==false||proof.independentlyConfirmed!==false||proof.formalEligible!==false)return false;
  const {contentHash,...body}=proof;if(contentHash!==hash(body))return false;
  const m=proof.manifest;if(m?.league!==game.league||m.date!==game.date||!Array.isArray(m.sourceDates)||m.sourceDates.length!==2
    ||m.sourceDates[0]!==shiftSoccerDate(game.date,-1)||m.sourceDates[1]!==game.date||!Array.isArray(m.sources)||m.sources.length!==2
    ||m.sources.some((s,i)=>!sourceValid(s,game.league,m.sourceDates[i],cutoff))||!Array.isArray(m.identities)||m.identities.some(row=>!sameGame(identity(row),row)||row.league!==game.league||row.date!==game.date)
    ||new Set(m.identities.map(row=>row.id)).size!==m.identities.length||m.identities.filter(row=>sameGame(row,game)).length!==1)return false;
  const aggregate=soccerIdentityTextHash(JSON.stringify(m.sources.map(item=>({url:item.url,contentHash:item.contentHash}))));
  if(aggregate!==m.aggregateSourceHash||!m.sources.some(s=>hash(s)===hash(proof.scheduleSource))
    ||hash(source(snapshot.evidence.scheduleSource))!==hash(proof.scheduleSource)||hash(source(snapshot.inputVersions?.scheduleSourceVersion))!==hash(proof.scheduleSource)
    ||!sourceValid(proof.summarySource,game.league,game.date,cutoff,{summaryId:game.sourceId})||hash(source(snapshot.evidence.source))!==hash(proof.summarySource))return false;
  if(!Array.isArray(proof.quoteBindings)||hash(proof.quoteBindings)!==hash(quoteBindings(snapshot)))return false;
  return Array.isArray(proof.readerIdentities)&&proof.readerIdentities.length>0&&proof.readerIdentities.every(raw=>raw.boardDate===game.date&&raw.startTime===game.startTime
    &&raw.homeKey===game.home.key&&raw.awayKey===game.away.key&&new Date(`${raw.boardDate}T${raw.boardTime}:00+08:00`).toISOString()===game.startTime
    &&m.identities.filter(row=>row.startTime===raw.startTime&&row.home.key===raw.homeKey&&row.away.key===raw.awayKey).length===1);
}
