import { createHash } from 'node:crypto';
import { canonicalReaderSeenCapture, buildReaderSeenCapture, readReaderSeenCaptureBatch } from '../reader-seen-capture.js';
import { resolveNbaReaderTeam } from './reader-teams.js';
import { parseReaderMarketRows } from '../../reader/parser.js';
import '../../reader/league-registry.js';

export const NBA_RAW_HISTORY_SCHEMA = 'nba-raw-seen-history-v1';
export const NBA_RAW_DERIVATION_VERSION = 'NBA-RAW-CREDIT-TABLE-HISTORY-v1';
export const NBA_RAW_HISTORY_FLAGS = Object.freeze({ archiveOnly:true, currentBoardUpdated:false,
  historicalAvailabilityVerified:false, executable:false, coverageComplete:false, closingCoverage:'NOT_VERIFIED' });
const HEADERS=['時間','主客隊伍','讓球','大小盤','單雙','獨贏','上半讓球','上半大小','上半單雙'];
const HASH=/^[a-f0-9]{64}$/, WATER=/^\d\.\d{3}$/, LINE=/^\d+(?:\.\d+)?(?:平|[+-]\d{1,3})?$/;
const HOME=/[\[［【(（]\s*主\s*[\]］】)）]/u;
const sha=v=>createHash('sha256').update(typeof v==='string'?v:canonicalReaderSeenCapture(v)).digest('hex');
const fail=(code,status=422)=>Object.assign(new Error(code),{code,status});
const check=(ok,code,status)=>{if(!ok)throw fail(code,status);};
const same=(a,b)=>canonicalReaderSeenCapture(a)===canonicalReaderSeenCapture(b);
const detach=v=>structuredClone(v);
const instant=v=>typeof v==='string'&&/Z$/.test(v)&&Number.isFinite(Date.parse(v));
const latest=v=>[...v].sort((a,b)=>Date.parse(a)-Date.parse(b)||a.localeCompare(b)).at(-1);
export function parseNbaRawHistoryQuery(params){
  check([...params.keys()].every(k=>k==='captureId')&&params.getAll('captureId').length===1&&HASH.test(params.get('captureId')||''),'RAW_SEEN_RECOVERY_QUERY_INVALID',400);
  return {captureId:params.get('captureId')};
}
export function reassembleNbaRawSeenBatch(parts) {
  check(Array.isArray(parts) && parts.length > 0, 'RAW_SEEN_RECOVERY_INCOMPLETE');
  check(parts.length <= 8 && parts.reduce((n,p) => n + Buffer.byteLength(JSON.stringify(p.evidence || {})), 0) <= 4_800_000,
    'RAW_SEEN_RECOVERY_BUDGET_EXCEEDED', 413);
  const sorted = [...parts].sort((a,b) => (a.partIndex ?? 0)-(b.partIndex ?? 0));
  const first = sorted[0], batch = first.captureBatchId;
  check(first.league === 'NBA', 'RAW_SEEN_RECOVERY_LEAGUE_INVALID');
  const strip = evidence => { const result = { ...evidence }; for (const field of ['tables','captureBatchId','partIndex','partCount']) delete result[field]; return result; };
  const base = strip(first.evidence), count = first.partCount ?? 1;
  check(count === sorted.length && sorted.every((p,i) => (p.partIndex ?? 0) === i), 'RAW_SEEN_RECOVERY_INCOMPLETE');
  const ids = new Set();
  for (const part of sorted) {
    check(!ids.has(part.captureId), 'RAW_SEEN_RECOVERY_CONFLICT'); ids.add(part.captureId);
    check(part.captureBatchId === batch && (part.partCount ?? 1) === count && same(strip(part.evidence),base)
      && part.league === first.league && instant(part.receivedAt) && instant(part.persistedAt), 'RAW_SEEN_RECOVERY_CONFLICT');
    const built = buildReaderSeenCapture({ schema:'READER-SEEN-CAPTURE-v1', evidence:part.evidence,
      captureId:part.captureId, evidenceHash:part.evidenceHash }, { deviceId:'readonly-history-replay', headerVersion:part.readerVersion });
    check(built.evidence.league === part.league && built.evidence.observedAt === part.observedAt && built.evidence.readerVersion === part.readerVersion
      && (built.evidence.partIndex ?? 0) === (part.partIndex ?? 0)
      && (built.evidence.partCount ?? 1) === (part.partCount ?? 1)
      && (built.evidence.captureBatchId ?? null) === (part.captureBatchId ?? null), 'RAW_SEEN_RECOVERY_CONFLICT');
  }
  if (!batch) return { evidence:detach(first.evidence), parts:sorted, batchHash:first.captureId };
  check(HASH.test(batch), 'RAW_SEEN_RECOVERY_CONFLICT');
  // The old fragment format has no table/row offsets. Only a hash-proven
  // boundary merge is permitted; never guess the original table grouping.
  const matches = new Map();
  for (let mask=0; mask<2 ** (count-1); mask++) {
    let tables=[], possible=true;
    for (let index=0; index<count; index++) {
      const next=detach(sorted[index].evidence.tables);
      if (index && mask & 2 ** (index-1)) {
        const prior=tables.at(-1), head=next[0];
        const meta=table => { const {rows,...rest}=table; return rest; };
        if (!prior || !head || !same(meta(prior),meta(head))) { possible=false; break; }
        prior.rows.push(...head.rows); next.shift();
      }
      tables.push(...next);
    }
    if (!possible) continue;
    const evidence={...base,tables};
    if (sha({schema:'READER-SEEN-CAPTURE-v1',evidence}) === batch) matches.set(canonicalReaderSeenCapture(evidence),evidence);
  }
  check(matches.size === 1, matches.size ? 'RAW_SEEN_RECOVERY_CONFLICT' : 'RAW_SEEN_RECOVERY_HASH_MISMATCH');
  return { evidence:[...matches.values()][0], parts:sorted, batchHash:batch };
}

function boardDate(pair, observedAt) {
  if (!Array.isArray(pair) || !/^\d{2}-\d{2}$/.test(pair[0] || '') || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(pair[1] || '')
    || pair.length < 2 || pair.length > 3 || pair.length === 3 && pair[2] !== '滾球') return null;
  const year=Number(new Intl.DateTimeFormat('en',{year:'numeric',timeZone:'Asia/Taipei'}).format(new Date(observedAt)));
  const candidates=[year-1,year,year+1].map(y=>`${y}-${pair[0]}`).filter(date=>{
    const time=Date.parse(`${date}T00:00:00Z`); return Number.isFinite(time) && new Date(time).toISOString().slice(0,10) === date;
  }).sort((a,b)=>Math.abs(Date.parse(`${a}T${pair[1]}:00+08:00`)-Date.parse(observedAt))-Math.abs(Date.parse(`${b}T${pair[1]}:00+08:00`)-Date.parse(observedAt)));
  return candidates[0] ? {boardDate:candidates[0],boardTime:pair[1]} : null;
}

function quote(kind,pair){
  if(!Array.isArray(pair))return null;
  let rows;
  if(kind==='HANDICAP'&&pair.length===3){
    if(LINE.test(pair[0])&&WATER.test(pair[1])&&WATER.test(pair[2]))rows=[`${pair[0]} ${pair[1]}`,pair[2]];
    else if(WATER.test(pair[0])&&LINE.test(pair[1])&&WATER.test(pair[2]))rows=[pair[0],`${pair[1]} ${pair[2]}`];
  }
  if(kind==='TOTAL'&&pair.length===5&&LINE.test(pair[0])&&pair[1]==='大'&&pair[3]==='小'&&WATER.test(pair[2])&&WATER.test(pair[4]))rows=[`大${pair[0]} ${pair[2]}`,`小 ${pair[4]}`];
  const parsed=rows&&parseReaderMarketRows(kind==='TOTAL'?'fullTotal':'fullRunline',rows);
  return parsed?{...parsed,kind,unit:'POINTS'}:null;
}
const oddEven=p=>Array.isArray(p)&&p.length===4&&p[0]==='單'&&p[2]==='雙'&&WATER.test(p[1])&&WATER.test(p[3]);
function teams(pair){
  if(!Array.isArray(pair)||![[3,'grade'],[4,'grade']].some(([n,last])=>pair.length===n&&pair.at(-1)===last)||pair.length===4&&pair[1]!=='滾球')return null;
  const raw=[pair[0],pair[pair.length-2]],home=raw.map(s=>HOME.test(s));
  if(home[0]||!home[1])return null;
  const mapped=raw.map(s=>{const code=s.match(/^([A-Z][A-Z0-9]{1,3})\s+/)?.[1];return resolveNbaReaderTeam(code==='SAN'&&/馬刺/.test(s)?'SA':code);});
  if(mapped.some(v=>!v)||mapped[0].abbreviation===mapped[1].abbreviation)return null;
  return {awayRaw:raw[0],homeRaw:raw[1],awayKey:mapped[0].abbreviation,homeKey:mapped[1].abbreviation};
}

// Only an exact source table layout supplies column authority. Unsupported
// cells remain diagnostics, never live prices or analysis selections.
export function deriveNbaRawSeenHistory(parts,{now=Date.now()}={}){
  const restored=reassembleNbaRawSeenBatch(parts),{evidence}=restored,registry=globalThis.Tai888LeagueRegistry;
  const games=new Map(),diagnostics={tablesRead:evidence.tables.length,supportedTables:0,rowsRead:0,acceptedRows:0,lockedRows:0,unrecognizedRows:0,unrecognizedMarkets:0,excludedScopeRows:0};
  evidence.tables.forEach((table,tableIndex)=>{
    if(table.periodEvidenceTruncated||!registry.standardMarker(table.sectionTitle,'NBA')||!same(table.headers,HEADERS))return;
    diagnostics.supportedTables++;let inScope=true,layoutInScope=true;
    for(const [rowIndex,row]of table.rows.entries()){
      diagnostics.rowsRead++;
      const cells=row.cells||[],markers=cells.flatMap(c=>(c.pair||[]).filter(s=>/^(?:聯盟|联盟)\s*[:：]/.test(s)));
      if(markers.length)inScope=markers.every(s=>registry.standardMarker(s,'NBA'));
      const text=cells.flatMap(c=>c.pair||[]);
      // A new header or period marker inside an ancestor table ends its old
      // column authority. Only a later exact header can restore that layout.
      if(text[0]==='時間'&&text.includes('主客隊伍')){layoutInScope=same(text,HEADERS);continue;}
      if(text.length===1&&/^(?:全場|上半(?:場)?|下半(?:場)?|第[一二三四1-4]節|加時|延長|FT|HT|[12]H|Q[1-4])$/i.test(text[0])){layoutInScope=false;continue;}
      if(!inScope||!layoutInScope){diagnostics.excludedScopeRows++;continue;}
      const identity=teams(cells[1]?.pair),timing=boardDate(cells[0]?.pair,evidence.observedAt);
      if(!identity||!timing)continue;
      if(row.marketLocked){diagnostics.lockedRows++;continue;}
      const missingMoneyline=cells.length===8,standard=cells.length===9;
      // Some source rows omit the moneyline cell entirely. Both odd/even
      // anchors must independently prove that shortened topology. A standard
      // nine-cell row has fixed columns: unavailable non-core odd/even or
      // moneyline cells must not discard its independently valid core quotes.
      if((!standard&&!missingMoneyline)||missingMoneyline&&(!oddEven(cells[4]?.pair)||!oddEven(cells.at(-1)?.pair))){
        diagnostics.unrecognizedRows++;continue;
      }
      const columns=[[2,'HANDICAP','FT','讓球'],[3,'TOTAL','FT','大小盤'],[missingMoneyline?5:6,'HANDICAP','HT','上半讓球'],[missingMoneyline?6:7,'TOTAL','HT','上半大小']];
      const markets=[];
      for(const [columnIndex,kind,period,originalHeader]of columns){
        const originalCell=cells[columnIndex]?.pair,market=quote(kind,originalCell);
        if(!market){diagnostics.unrecognizedMarkets++;continue;}
        markets.push({...market,period,source:{tableIndex,rowIndex,columnIndex,originalHeader,originalCell:detach(originalCell)},executable:false});
      }
      if(!markets.length)continue;
      const gameKey=[timing.boardDate,timing.boardTime,identity.awayKey,identity.homeKey].join('|');
      const game=games.get(gameKey)||{league:'NBA',...timing,...identity,identityStatus:'ORIGINAL_BOARD_IDENTITY_ONLY',markets:[],executable:false};
      // Nested copies do not inflate the quote count; distinct prices remain
      // distinct and retain their original source positions.
      for(const market of markets){const signature=canonicalReaderSeenCapture({...market,source:null});
        if(!game.markets.some(m=>canonicalReaderSeenCapture({...m,source:null})===signature))game.markets.push(market);
      }
      check(game.markets.length<=200,'RAW_SEEN_RECOVERY_BUDGET_EXCEEDED',413);
      games.set(gameKey,game);diagnostics.acceptedRows++;
    }
  });
  check(diagnostics.supportedTables>0,'RAW_SEEN_RECOVERY_UNSUPPORTED_FORMAT');
  const values=[...games.values()];check(values.length>0,'RAW_SEEN_RECOVERY_NO_MARKETS');check(values.length<=40,'RAW_SEEN_RECOVERY_BUDGET_EXCEEDED',413);
  values.sort((a,b)=>[a.boardDate,a.boardTime,a.awayKey].join('|').localeCompare([b.boardDate,b.boardTime,b.awayKey].join('|')));
  const manifest=restored.parts.map(({captureId,evidenceHash,partIndex,partCount,receivedAt,persistedAt})=>({captureId,evidenceHash,partIndex:partIndex??0,partCount:partCount??1,receivedAt,persistedAt}));
  return {ok:true,schema:NBA_RAW_HISTORY_SCHEMA,recordKind:'RAW_SEEN_REPLAY',...NBA_RAW_HISTORY_FLAGS,league:'NBA',captureBatchId:restored.batchHash,
    observedAt:evidence.observedAt,pageActivityAt:evidence.pageActivityAt||null,receivedAt:latest(manifest.map(p=>p.receivedAt)),persistedAt:latest(manifest.map(p=>p.persistedAt)),recoveredAt:new Date(now).toISOString(),
    derivationVersion:NBA_RAW_DERIVATION_VERSION,derivedHash:sha({captureBatchId:restored.batchHash,derivationVersion:NBA_RAW_DERIVATION_VERSION,games:values}),
    integrity:{status:'VERIFIED',batchHashVerified:true,scope:'ORIGINAL_FRAGMENTS_AND_DERIVED_CELLS',scheduleCompletenessVerified:false},parts:manifest,games:values,diagnostics};
}
export async function queryNbaRawSeenHistory(query,options={}){return deriveNbaRawSeenHistory(await readReaderSeenCaptureBatch(query.captureId,options),options);}
