import { createHash } from 'node:crypto';
import { canonicalSoccerPayload, parseSoccerCapture } from '../../reader/soccer-parser.js';
import { sanitizeTai888PageUrl } from '../../reader/parser.js';
import { soccerLeague, validSoccerDate } from './contracts.js';
import { soccerTeamLabel } from './team-labels.js';

export const SOCCER_READER_VERSION='SOCCER-READER-v1';
export const soccerReaderHash=value=>createHash('sha256').update(value).digest('hex');
export function validateSoccerCapture(input,{now=Date.now(),headerVersion=null}={}) {
  const errors=[]; const league=soccerLeague(input?.league);
  const observed=Date.parse(input?.observedAt||''),activity=Date.parse(input?.pageActivityAt||'');
  if(!league||input.league!==league.id.toUpperCase()||input.provider!=='TAI888_READER'||input.interfaceVersion!==SOCCER_READER_VERSION||input.executable!==false)errors.push('SOCCER_READER_IDENTITY_INVALID');
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
    if(!Array.isArray(table.rows)||table.rows.length>100){errors.push('SOCCER_READER_ROWS_INVALID');continue;}
    const rows=[];
    for(const row of table.rows){
      if(!Array.isArray(row.cells)||row.cells.length!==5){errors.push('SOCCER_READER_CELLS_INVALID');continue;}
      const cells=[];
      for(const cell of row.cells){
        if(!Array.isArray(cell?.pair)||cell.pair.length<2||cell.pair.length>3||cell.pair.some(v=>typeof v!=='string'||v.length>200||/[<>\u0000-\u001f]/.test(v))){errors.push('SOCCER_READER_CELL_TEXT_INVALID');break;}
        cells.push({pair:[...cell.pair]});
      }
      if(cells.length===5)rows.push({cells});
    }
    tables.push({rows});
  }
  const rawCapture={league:input.league,pageLeagueLabel:input.pageLeagueLabel,tables,sourceHost:input.sourceHost,pageUrl:page,observedAt:input.observedAt};
  const parsed=parseSoccerCapture(rawCapture,new Date(observed));
  parsed.boardDate=input.boardDate;parsed.games=parsed.games.filter(g=>g.boardDate===input.boardDate);
  if(parsed.parseIssues.length)errors.push(...parsed.parseIssues);
  if(!parsed.games.length||parsed.games.length>40)errors.push('SOCCER_READER_GAMES_MISSING');
  if(canonicalSoccerPayload(parsed)!==canonicalSoccerPayload(input))errors.push('SOCCER_READER_REPARSE_MISMATCH');
  if(errors.length)return {ok:false,errors:[...new Set(errors)]};
  const contentHash=soccerReaderHash(canonicalSoccerPayload(parsed));
  return {ok:true,payload:{...parsed,sourceCapture:{league:input.league,pageLeagueLabel:input.pageLeagueLabel,tables},readerVersion:input.readerVersion,pageActivityAt:input.pageActivityAt,observedAt:new Date(observed).toISOString(),contentHash,marketVerification:'CAPTURED_RULES_UNVERIFIED',settlementScope:null,executable:false}};
}
export function matchSoccerReaderGames(capture,officialGames,now=Date.now()) {
  const fresh=Boolean(capture&&now-Date.parse(capture.observedAt)<=180000&&Date.parse(capture.observedAt)<=now+5000);
  const key=v=>globalThis.Tai888SoccerTeams.key(v);
  return (capture?.games||[]).map(raw=>{
    const candidates=(officialGames||[]).filter(game=>game.league===capture.league.toLowerCase()&&game.date===raw.boardDate&&game.startTime===new Date(`${raw.boardDate}T${raw.boardTime}:00+08:00`).toISOString()
      &&key(soccerTeamLabel(game.home))===raw.homeKey&&key(soccerTeamLabel(game.away))===raw.awayKey);
    const game=candidates.length===1?candidates[0]:null;
    return {...raw,officialGameId:game?.id||null,matchStatus:game?'MATCHED':candidates.length?'AMBIGUOUS':'UNMATCHED',fresh,prestart:Boolean(game&&Date.parse(game.startTime)>now&&game.status==='scheduled'),executable:false};
  });
}
