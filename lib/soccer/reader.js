import { createHash } from 'node:crypto';
import { canonicalSoccerPayload, parseSoccerCapture, scopeSoccerPayload } from '../../reader/soccer-parser.js';
import { sanitizeTai888PageUrl } from '../../reader/parser.js';
import { soccerLeague, validSoccerDate } from './contracts.js';
import { soccerTeamLabel } from './team-labels.js';
import { soccerReaderMatchTeamKey } from './reader-team-identity.js';
import { resolveSoccerReaderPeriods, soccerMarketHasVerifiedPeriodResolution } from './reader-period-binding.js';

export const SOCCER_READER_VERSION='SOCCER-READER-v1';
export const soccerReaderHash=value=>createHash('sha256').update(value).digest('hex');
// Wire compatibility only: stored legacy payloads retain their original canonical
// hash. No client period assertion is used as evidence for the server parse.
function legacyWire(input){
  return !Object.hasOwn(input,'periodsCovered')&&(input.games||[]).every(game=>!Object.hasOwn(game,'periodsCovered')&&!Object.hasOwn(game,'periodStates')&&(game.markets||[]).every(market=>!Object.hasOwn(market,'period')&&!Object.hasOwn(market,'periodEvidence')));
}
function legacyComparison(payload){
  const {periodsCovered,...rest}=payload;
  return {...rest,games:(payload.games||[]).filter(game=>game.markets.length).map(game=>{
    const {periodsCovered,periodStates,...identity}=game;
    return {...identity,markets:game.markets.map(market=>{const {period,periodEvidence,...quote}=market;return quote;})};
  })};
}
export function validateSoccerCapture(input,{now=Date.now(),headerVersion=null}={}) {
  const errors=[]; const league=soccerLeague(input?.league);
  const observed=Date.parse(input?.observedAt||''),activity=Date.parse(input?.pageActivityAt||'');
  if(!league||input.league!==league.id.toUpperCase()||input.provider!=='TAI888_READER'||input.interfaceVersion!==SOCCER_READER_VERSION||input.executable!==false)errors.push('SOCCER_READER_IDENTITY_INVALID');
  if(!Array.isArray(input?.games)||input.games.length>40||input.games.some(game=>!game||typeof game!=='object'||!Array.isArray(game.markets)||game.markets.some(market=>!market||typeof market!=='object'||Array.isArray(market))))errors.push('SOCCER_READER_GAMES_INVALID');
  if(!validSoccerDate(input?.boardDate))errors.push('SOCCER_READER_DATE_INVALID');
  if(!Number.isFinite(now)||!/(Z|[+-]\d{2}:\d{2})$/.test(input?.observedAt||'')||!/(Z|[+-]\d{2}:\d{2})$/.test(input?.pageActivityAt||'')||!Number.isFinite(observed)||observed>now+5000||now-observed>180000||!Number.isFinite(activity)||activity>now+5000||now-activity>180000)errors.push('SOCCER_READER_STALE');
  if(!/^\d+\.\d+\.\d+$/.test(input?.readerVersion||'')||input.readerVersion!==headerVersion)errors.push('SOCCER_READER_VERSION_MISMATCH');
  let page='';
  try{const u=new URL(input.pageUrl);if(u.username||u.password||u.port||u.protocol!=='https:')throw Error();page=sanitizeTai888PageUrl(input.pageUrl);if(!page||new URL(page).hostname!==input.sourceHost)throw Error();}catch{errors.push('SOCCER_READER_SOURCE_INVALID');}
  const source=input?.sourceCapture;
  if(!source||source.league!==input?.league||source.pageLeagueLabel!==input.pageLeagueLabel||!Array.isArray(source.tables)||source.tables.length>12)errors.push('SOCCER_READER_RAW_CAPTURE_MISSING');
  if(errors.length)return {ok:false,errors};
  // Only bounded sport cells enter storage; never retain arbitrary client objects.
  const tables=[];
  for(const table of source.tables){
    if(!Array.isArray(table?.rows)||table.rows.length>100){errors.push('SOCCER_READER_ROWS_INVALID');continue;}
    if(table.sectionTitle!==undefined&&(typeof table.sectionTitle!=='string'||table.sectionTitle.length>240||/[<>\u0000-\u001f]/.test(table.sectionTitle))){errors.push('SOCCER_READER_PERIOD_TITLE_INVALID');continue;}
    if(table.headers!==undefined&&(!Array.isArray(table.headers)||table.headers.length>12||table.headers.some(v=>typeof v!=='string'||v.length>160||/[<>\u0000-\u001f]/.test(v)))){errors.push('SOCCER_READER_PERIOD_HEADERS_INVALID');continue;}
    if(table.periodEvidenceTruncated!==undefined&&typeof table.periodEvidenceTruncated!=='boolean'){errors.push('SOCCER_READER_PERIOD_TRUNCATION_INVALID');continue;}
    const rows=[];
    for(const row of table.rows){
      if(!Array.isArray(row?.cells)||row.cells.length!==5){errors.push('SOCCER_READER_CELLS_INVALID');continue;}
      const cells=[];
      for(const cell of row.cells){
        if(!Array.isArray(cell?.pair)||cell.pair.length<2||cell.pair.length>3||cell.pair.some(v=>typeof v!=='string'||v.length>200||/[<>\u0000-\u001f]/.test(v))){errors.push('SOCCER_READER_CELL_TEXT_INVALID');break;}
        cells.push({pair:[...cell.pair]});
      }
      if(cells.length===5)rows.push({cells});
    }
    tables.push({...(table.sectionTitle!==undefined?{sectionTitle:table.sectionTitle}:{}),...(table.headers!==undefined?{headers:[...table.headers]}:{}),...(table.periodEvidenceTruncated!==undefined?{periodEvidenceTruncated:table.periodEvidenceTruncated}:{}),rows});
  }
  const rawCapture={league:input.league,pageLeagueLabel:input.pageLeagueLabel,tables,sourceHost:input.sourceHost,pageUrl:page,observedAt:input.observedAt};
  let parsed=parseSoccerCapture(rawCapture,new Date(observed));
  parsed.boardDate=input.boardDate;parsed.games=parsed.games.filter(g=>g.boardDate===input.boardDate);
  parsed.periodsCovered=[...new Set(parsed.games.flatMap(game=>game.periodsCovered))].sort();
  if(parsed.parseIssues.length)errors.push(...parsed.parseIssues);
  if(Object.hasOwn(input,'sourceScope')){
    const scoped=input.sourceScope?.boardDate===input.boardDate?scopeSoccerPayload(parsed,input.sourceScope):null;
    if(!scoped)errors.push('SOCCER_READER_SOURCE_SCOPE_INVALID');
    else parsed=scoped;
  }
  if(!parsed.games.length||parsed.games.length>40)errors.push('SOCCER_READER_GAMES_MISSING');
  const comparison=legacyWire(input)?legacyComparison(parsed):parsed;
  if(canonicalSoccerPayload(comparison)!==canonicalSoccerPayload(input))errors.push('SOCCER_READER_REPARSE_MISMATCH');
  if(errors.length)return {ok:false,errors:[...new Set(errors)]};
  const contentHash=soccerReaderHash(canonicalSoccerPayload(parsed));
  return {ok:true,payload:{...parsed,sourceCapture:{league:input.league,pageLeagueLabel:input.pageLeagueLabel,tables},readerVersion:input.readerVersion,pageActivityAt:input.pageActivityAt,observedAt:new Date(observed).toISOString(),contentHash,marketVerification:'CAPTURED_RULES_UNVERIFIED',settlementScope:null,executable:false}};
}
export function soccerReaderGameHasFreshGoalMarket(raw,capture,now=Date.now()) {
  if(!Number.isFinite(now)||!capture||!Array.isArray(raw?.markets))return false;
  return raw.markets.some(market=>{
    if(market?.unit!=='GOALS'||!['HANDICAP','TOTAL'].includes(market.kind)||typeof market.line!=='string'||!market.line
      ||market.kind==='HANDICAP'&&!['home','away'].includes(market.lineSide))return false;
    const sides=market.kind==='HANDICAP'?['home','away']:['over','under'];
    if(!sides.some(side=>Number.isFinite(market[`${side}Water`])&&market[`${side}Water`]>0&&market[`${side}Water`]<=1000))return false;
    const proof=market.periodEvidence,period=globalThis.Tai888LeagueRegistry.soccerPeriodEvidence({sectionTitle:proof?.sectionTitle,
      headers:proof?.tableHeaders,marketHeader:proof?.marketHeader,truncated:proof?.truncated});
    if((period.status!=='EXPLICIT'||period.period!==market.period)&&!soccerMarketHasVerifiedPeriodResolution(market,now))return false;
    // Aggregated periods have independent observations. Never freshen an old
    // or unreceipted market using the bundle or a sibling period's heartbeat.
    const observation=market.serverObservation||(capture.isPeriodAggregate?null:capture);
    const observed=Date.parse(observation?.observedAt||'');
    if(!Number.isFinite(observed)||observed>now||now-observed>180000)return false;
    return ![observation?.firstFetchedAt,observation?.receivedAt,observation?.persistedAt].some(value=>value!=null&&(!Number.isFinite(Date.parse(value))||Date.parse(value)>now));
  });
}
export function matchSoccerReaderGames(capture,officialGames,now=Date.now()) {
  const key=soccerReaderMatchTeamKey,league=soccerLeague(capture?.league)?.id;
  return (capture?.games||[]).map(raw=>{
    const homeKey=key(raw.homeKey),awayKey=key(raw.awayKey);
    const identityValid=league&&homeKey&&awayKey&&homeKey!==awayKey
      &&(raw.league===undefined||soccerLeague(raw.league)?.id===league)
      // Match-time aliases cannot excuse a changed original Reader wire key.
      &&['home','away'].every(side=>raw[`${side}Raw`]===undefined||globalThis.Tai888SoccerTeams.key(raw[`${side}Raw`])===raw[`${side}Key`]);
    const kickoff=validSoccerDate(raw.boardDate)&&/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(raw.boardTime||'')
      ?new Date(`${raw.boardDate}T${raw.boardTime}:00+08:00`).toISOString():null;
    const candidates=identityValid&&kickoff?(officialGames||[]).filter(game=>game.league===league&&game.date===raw.boardDate&&game.startTime===kickoff
      &&key(soccerTeamLabel(game.home))===homeKey&&key(soccerTeamLabel(game.away))===awayKey):[];
    const game=candidates.length===1?candidates[0]:null;
    const matched=resolveSoccerReaderPeriods({...raw,officialGameId:game?.id||null,matchStatus:game?'MATCHED':candidates.length?'AMBIGUOUS':'UNMATCHED'},capture,now);
    return {...matched,fresh:soccerReaderGameHasFreshGoalMarket(matched,capture,now),prestart:Boolean(game&&Date.parse(game.startTime)>now&&game.status==='scheduled'),executable:false};
  });
}
