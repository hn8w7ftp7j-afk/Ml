import { createHash } from 'node:crypto';
import { canonicalReaderSeenCapture, buildReaderSeenCapture, readReaderSeenCaptureBatch } from '../reader-seen-capture.js';
import { soccerMarket } from '../../reader/soccer-parser.js';

export const RAW_SEEN_HISTORY_SCHEMA = 'soccer-raw-seen-history-v1';
export const RAW_SEEN_DERIVATION_VERSION = 'SOCCER-RAW-CREDIT-TABLE-HISTORY-v2';
export const RAW_SEEN_READABLE_DERIVATION_VERSIONS = Object.freeze([RAW_SEEN_DERIVATION_VERSION, 'SOCCER-RAW-CREDIT-TABLE-HISTORY-v1']);
export const RAW_SEEN_HISTORY_FLAGS = Object.freeze({ archiveOnly: true, currentBoardUpdated: false,
  historicalAvailabilityVerified: false, executable: false, coverageComplete: false, closingCoverage: 'NOT_VERIFIED' });
const HEADERS = ['時間','主客隊伍','獨贏','讓球','大小盤','單雙','上半讓球','上半大小','備註'];
const HASH = /^[a-f0-9]{64}$/;
const WATER = /^\d{1,4}\.\d{3}$/;
const LINE = /^(?:\d+(?:\.\d)?)(?:平|[+-]\d{1,3})?$/;
const PROPS = /角球|副牌|罰牌|罚牌|卡牌|黃牌|黄牌|紅牌|红牌|CORNERS?|BOOKINGS?|\bCARDS?\b/i;
const YOUTH = /\b(?:U|UNDER)[\s-]*(?:1\d|2[0-3])\b|\b(?:women(?:'s)?|ladies|girls|youth|reserves?|academy)\b|青年|後備|后备|预备|預備|女足|女子/i;
const HOME = /[\[［【(（]\s*主\s*[\]］】)）]/u;
const sha = value => createHash('sha256').update(typeof value === 'string' ? value : canonicalReaderSeenCapture(value)).digest('hex');
const fail = (code, status = 422) => Object.assign(new Error(code), { code, status });
const check = (condition, code, status) => { if (!condition) throw fail(code, status); };
const instant = value => typeof value === 'string' && /Z$/.test(value) && Number.isFinite(Date.parse(value));
const same = (a,b) => canonicalReaderSeenCapture(a) === canonicalReaderSeenCapture(b);
const detach = value => structuredClone(value);
const latest = values => [...values].sort((a,b) => Date.parse(a)-Date.parse(b) || a.localeCompare(b)).at(-1);

export function parseRawSeenHistoryQuery(params) {
  check([...params.keys()].every(key => key === 'captureId') && params.getAll('captureId').length === 1
    && HASH.test(params.get('captureId') || ''), 'RAW_SEEN_RECOVERY_QUERY_INVALID', 400);
  return { captureId: params.get('captureId') };
}

export function reassembleRawSeenBatch(parts) {
  check(Array.isArray(parts) && parts.length > 0, 'RAW_SEEN_RECOVERY_INCOMPLETE');
  check(parts.length <= 8 && parts.reduce((n,p) => n + Buffer.byteLength(JSON.stringify(p.evidence || {})), 0) <= 4_800_000,
    'RAW_SEEN_RECOVERY_BUDGET_EXCEEDED', 413);
  const sorted = [...parts].sort((a,b) => (a.partIndex ?? 0)-(b.partIndex ?? 0));
  const first = sorted[0], batch = first.captureBatchId;
  check(['EPL','UCL'].includes(first.league), 'RAW_SEEN_RECOVERY_LEAGUE_INVALID');
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
    check(built.evidence.observedAt === part.observedAt && built.evidence.readerVersion === part.readerVersion
      && (built.evidence.partIndex ?? 0) === (part.partIndex ?? 0)
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
function quote(key,pair) {
  if (!Array.isArray(pair)) return null;
  if (key === 'runline' && pair.length === 3) {
    if (LINE.test(pair[0]) && WATER.test(pair[1]) && WATER.test(pair[2])) return soccerMarket(key,[pair[2],`${pair[0]} ${pair[1]}`]);
    if (WATER.test(pair[0]) && LINE.test(pair[1]) && WATER.test(pair[2])) return soccerMarket(key,[`${pair[1]} ${pair[2]}`,pair[0]]);
  }
  if (key === 'total' && pair.length === 5 && LINE.test(pair[0]) && pair[1] === '大' && pair[3] === '小'
    && WATER.test(pair[2]) && WATER.test(pair[4])) return soccerMarket(key,[`大${pair[0]} ${pair[2]}`,`小 ${pair[4]}`]);
  if (key === 'moneyline' && pair.length === 3 && pair.every(value=>WATER.test(value))) return soccerMarket(key,[`主勝 ${pair[0]}`,`和 ${pair[2]}`,`客勝 ${pair[1]}`]);
  return null;
}

export function deriveRawSeenSoccerHistory(parts, { now=Date.now() } = {}) {
  const restored=reassembleRawSeenBatch(parts), {evidence}=restored, league=evidence.league;
  const registry=globalThis.Tai888LeagueRegistry, teams=globalThis.Tai888SoccerTeams, games=new Map(), primaryIdentities=new Set(), unavailableByGame=new Map();
  const diagnostics={tablesRead:evidence.tables.length,supportedTables:0,rowsRead:0,excludedProps:0,excludedYouth:0,excludedScopeRows:0,lockedGoalRows:0,unrecognizedGoalRows:0,acceptedRows:0,partialRows:0,unavailableMarketCount:0};
  evidence.tables.forEach((table,tableIndex)=>{
    if (table.periodEvidenceTruncated || !registry.standardMarker(table.sectionTitle,league) || !same(table.headers,HEADERS)) return;
    const primaryPeriod=registry.soccerPeriodEvidence({sectionTitle:table.sectionTitle,headers:table.headers,marketHeader:'讓球'});
    const halfPeriod=registry.soccerPeriodEvidence({sectionTitle:table.sectionTitle,headers:table.headers,marketHeader:'上半讓球'});
    if (primaryPeriod.period !== 'UNKNOWN' || halfPeriod.period !== 'HT' || halfPeriod.status !== 'EXPLICIT') return;
    diagnostics.supportedTables++;
    let accepted=true;
    for (const [rowIndex,row] of table.rows.entries()) {
      diagnostics.rowsRead++;
      const cells=row.cells || [], markers=cells.flatMap(cell=>(cell.pair || []).filter(value=>/^(?:聯盟|联盟)\s*[:：]/.test(value)));
      if (markers.length) accepted=markers.every(value=>registry.standardMarker(value,league));
      if (!accepted) { diagnostics.excludedScopeRows++; continue; }
      const time=boardDate(cells[0]?.pair,evidence.observedAt), pair=cells[1]?.pair;
      if (!time || !Array.isArray(pair) || pair.length !== 3 || pair[2] !== 'grade') continue;
      if (pair.some(value=>PROPS.test(value.normalize('NFKC')))) {diagnostics.excludedProps++;continue;}
      if (pair.some(value=>YOUTH.test(value.normalize('NFKC')))) {diagnostics.excludedYouth++;continue;}
      if (!HOME.test(pair[0]) || HOME.test(pair[1])) continue;
      const home=teams.resolve(pair[0]),away=teams.resolve(pair[1]);
      if (!home || !away || home.key === away.key) continue;
      if (row.marketLocked === true) {diagnostics.lockedGoalRows++;continue;}
      const key=[time.boardDate,time.boardTime,away.key,home.key].join('|'), primary=cells.length === 8, alternative=cells.length === 6;
      if (!primary && !alternative) {diagnostics.unrecognizedGoalRows++;continue;}
      // Original column positions and the complete primary row identify the
      // layout. A locked/unrecognized moneyline or odd/even cell cannot erase
      // valid goal markets in other independently validated columns.
      const primaryIdentity=`${tableIndex}|${key}`;
      if (primary) primaryIdentities.add(primaryIdentity);
      if (alternative && !primaryIdentities.has(primaryIdentity)) {diagnostics.unrecognizedGoalRows++;continue;}
      const existing=games.get(key);
      const columns=primary?[[3,'runline','FT'],[4,'total','FT'],[6,'runline','HT'],[7,'total','HT'],[2,'moneyline','FT']]
        :[[2,'runline','FT'],[3,'total','FT'],[4,'runline','HT'],[5,'total','HT']];
      const parsed=[],unavailable=[];
      for (const [columnIndex,kind,period] of columns) {
        const pair=cells[columnIndex]?.pair,market=quote(kind,pair);
        const source={tableIndex,rowIndex,columnIndex,originalHeader:HEADERS[primary?columnIndex:columnIndex===2?3:columnIndex===3?4:columnIndex===4?6:7],
          originalCell:detach(pair)};
        if (market) parsed.push({...market,period,isAlternative:alternative,
          periodEvidence:{originalPeriod:period==='FT'?'UNKNOWN':'HT',displayPeriod:period,basis:'SAME_ROW_PRIMARY_AND_EXPLICIT_HT_COLUMNS'},
          source,executable:false});
        else unavailable.push({kind:kind==='runline'?'HANDICAP':kind==='total'?'TOTAL':'MONEYLINE',period,isAlternative:alternative,
          status:Array.isArray(pair)&&pair.length>0&&pair.some(value=>typeof value==='string'&&/[-－—]/.test(value))&&pair.every(value=>typeof value==='string'&&/^(?:\s*[-－—]\s*)?$/.test(value))?'LOCKED':'UNRECOGNIZED',source});
      }
      if (unavailable.length) {
        diagnostics.unavailableMarketCount+=unavailable.length;
        if (parsed.length) diagnostics.partialRows++;
        else diagnostics.unrecognizedGoalRows++;
      }
      const unavailableForGame=unavailableByGame.get(key)||[];
      unavailableForGame.push(...unavailable);unavailableByGame.set(key,unavailableForGame);
      if (!parsed.length && !existing) continue;
      const game=existing || {league,...time,awayRaw:pair[1],homeRaw:pair[0],awayKey:away.key,homeKey:home.key,
        sourceTables:[],markets:[],unavailableMarkets:[],identityStatus:'ORIGINAL_BOARD_IDENTITY_ONLY',executable:false};
      if (!game.sourceTables.includes(tableIndex)) game.sourceTables.push(tableIndex);
      game.markets.push(...parsed);game.unavailableMarkets=unavailableForGame;games.set(key,game);
      if (parsed.length) diagnostics.acceptedRows++;
    }
  });
  check(games.size <= 40, 'RAW_SEEN_RECOVERY_BUDGET_EXCEEDED', 413);
  const values=[...games.values()].sort((a,b)=>`${a.boardDate}${a.boardTime}${a.awayKey}`.localeCompare(`${b.boardDate}${b.boardTime}${b.awayKey}`));
  check(diagnostics.supportedTables > 0, 'RAW_SEEN_RECOVERY_UNSUPPORTED_FORMAT');
  check(values.length > 0, 'RAW_SEEN_RECOVERY_NO_GOALS');
  const manifest=restored.parts.map(({captureId,evidenceHash,partIndex,partCount,receivedAt,persistedAt})=>({captureId,evidenceHash,partIndex:partIndex ?? 0,partCount:partCount ?? 1,receivedAt,persistedAt}));
  const body={captureBatchId:restored.batchHash,derivationVersion:RAW_SEEN_DERIVATION_VERSION,games:values};
  return {ok:true,schema:RAW_SEEN_HISTORY_SCHEMA,recordKind:'RAW_SEEN_REPLAY',...RAW_SEEN_HISTORY_FLAGS,
    league,captureBatchId:restored.batchHash,observedAt:evidence.observedAt,pageActivityAt:evidence.pageActivityAt || null,
    receivedAt:latest(manifest.map(p=>p.receivedAt)),persistedAt:latest(manifest.map(p=>p.persistedAt)),
    recoveredAt:new Date(now).toISOString(),derivationVersion:RAW_SEEN_DERIVATION_VERSION,derivedHash:sha(body),
    integrity:{status:'VERIFIED',batchHashVerified:true,scope:'ORIGINAL_FRAGMENTS_AND_DERIVED_CELLS',scheduleCompletenessVerified:false},
    parts:manifest,games:values,diagnostics};
}

export async function queryRawSeenSoccerHistory(query, options={}) {
  const parts=await readReaderSeenCaptureBatch(query.captureId,options);
  return deriveRawSeenSoccerHistory(parts,options);
}
