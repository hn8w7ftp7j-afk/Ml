import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import '../../reader/league-registry.js';

export const SOCCER_READER_PERIOD_BINDING_VERSION = 'TAI888-ACCOUNT-PERIOD-BINDING-v1';
const PROFILE = 'TAI888-DESKTOP-PRIMARY-WITH-EXPLICIT-HT-v1';
const PRIMARY = ['時間','主客隊伍','讓球','大小盤','獨贏','單雙','備註'];
const HALF = ['時間','主客隊伍','上半讓球','上半大小','','單雙','備註'];
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key,item[key]])) : item);
const equal = (left,right) => canonical(left) === canonical(right);
const sha = value => createHash('sha256').update(canonical(value)).digest('hex');
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const instant = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
const detach = value => JSON.parse(JSON.stringify(value));
export const soccerReaderPeriodResolutionProvenance = value => JSON.parse(canonical(value));
const evidence = market => globalThis.Tai888LeagueRegistry.soccerPeriodEvidence({sectionTitle:market?.periodEvidence?.sectionTitle,
  headers:market?.periodEvidence?.tableHeaders,marketHeader:market?.periodEvidence?.marketHeader,truncated:market?.periodEvidence?.truncated});

// Configuration is private server state. No caller-supplied approval or profile
// can register a binding; absent/malformed configuration preserves UNKNOWN.
export function readSoccerReaderPeriodBinding() {
  try {
    const value = JSON.parse(process.env.SOCCER_READER_PERIOD_BINDING_JSON || 'null');
    if (value?.version !== SOCCER_READER_PERIOD_BINDING_VERSION || value.profile !== PROFILE
      || value.sourceHost !== 'www.tai888.in' || !hex(value.deviceHash) || !hex(value.proofKey)
      || !Number.isFinite(instant(value.confirmedAt)) || !Array.isArray(value.leagues) || !value.leagues.length
      || value.leagues.some(league=>!['epl','ucl'].includes(league)) || new Set(value.leagues).size !== value.leagues.length) return null;
    return {version:value.version,profile:value.profile,confirmedAt:value.confirmedAt,sourceHost:value.sourceHost,
      deviceHash:value.deviceHash,leagues:[...value.leagues].sort(),proofKey:value.proofKey};
  } catch { return null; }
}
const publicConfig = config => Object.fromEntries(Object.entries(config).filter(([key])=>key!=='proofKey'));
function observationFor(market,capture) {
  const source = market?.serverObservation || (!capture?.isPeriodAggregate ? capture : null);
  if (!source) return null;
  return Object.fromEntries(['observationId','revision','observedAt','firstFetchedAt','receivedAt','persistedAt','sourceHost','pageUrl','deviceHash']
    .map(key=>[key,source[key]??null]));
}
function knownObservation(source,config,now) {
  if (!source || !hex(source.observationId) || !hex(source.revision) || source.deviceHash !== config.deviceHash
    || source.sourceHost !== config.sourceHost || !Number.isFinite(now) || now < instant(config.confirmedAt)) return false;
  const [observed,first,received,persisted] = ['observedAt','firstFetchedAt','receivedAt','persistedAt'].map(key=>instant(source[key]));
  return [observed,first,received,persisted].every(time=>Number.isFinite(time)&&time<=now)
    && observed>=instant(config.confirmedAt) && received>=instant(config.confirmedAt) && persisted>=instant(config.confirmedAt)
    && first<=received && received<=persisted;
}
function sameCapture(left,right) {
  // First discovery belongs to each period's content fingerprint. Two periods
  // in one immutable observation can legitimately have different first receipts.
  return ['observationId','revision','observedAt','receivedAt','persistedAt','sourceHost','pageUrl','deviceHash']
    .every(key=>left?.[key]===right?.[key]);
}
function marketBody(market) {
  if (!['HANDICAP','TOTAL'].includes(market?.kind) || market.unit !== 'GOALS'
    || typeof market.line!=='string' || !/^\d+(?:\.\d+)?(?:平|[+-]\d{1,3})?$/.test(market.line)
    || market.kind==='HANDICAP'&&!['home','away'].includes(market.lineSide)
    || !Array.isArray(market.rawRows) || market.rawRows.length!==2 || market.rawRows.some(row=>typeof row!=='string'||row.length>200)) return null;
  const sides = market.kind==='HANDICAP'?['homeWater','awayWater']:['overWater','underWater'];
  if (sides.some(key=>typeof market[key]!=='number'||!Number.isFinite(market[key])||market[key]<=0||market[key]>1000)) return null;
  return {kind:market.kind,unit:market.unit,line:market.line,lineSide:market.kind==='HANDICAP'?market.lineSide:null,
    ...Object.fromEntries(sides.map(key=>[key,market[key]])),rawRows:[...market.rawRows]};
}
function profileMatches(market,half=false) {
  const parsed=evidence(market), proof=market?.periodEvidence;
  const kind=market?.kind;
  if (!['HANDICAP','TOTAL'].includes(kind) || proof?.truncated || !equal(proof?.tableHeaders,half?HALF:PRIMARY)) return false;
  if (globalThis.Tai888LeagueRegistry.identify(proof.sectionTitle)!=='EPL'
    && globalThis.Tai888LeagueRegistry.identify(proof.sectionTitle)!=='UCL') return false;
  return half
    ? market.period==='HT'&&parsed.period==='HT'&&parsed.status==='EXPLICIT'
      && proof.marketHeader===(kind==='HANDICAP'?'上半讓球':'上半大小')
    : market.period==='UNKNOWN'&&parsed.period==='UNKNOWN'&&parsed.status==='UNKNOWN'
      && proof.marketHeader===(kind==='HANDICAP'?'讓球':'大小盤');
}
const signature = (body,config) => createHmac('sha256',config.proofKey).update(canonical(body)).digest('hex');

// Only reason codes and counts leave this module. Device identities, private
// configuration values and the signing key are never diagnostic output.
function periodBindingAssessment(raw,capture,market,config,now) {
  const league=String(raw?.league||'').toLowerCase();
  if (!config) return {issue:process.env.SOCCER_READER_PERIOD_BINDING_JSON?'CONFIG_INVALID':'CONFIG_MISSING'};
  if (!config.leagues.includes(league)) return {issue:'LEAGUE_NOT_BOUND'};
  if (raw?.matchStatus!=='MATCHED'||typeof raw.officialGameId!=='string'||!raw.officialGameId.startsWith(`soccer:${league}:`)) return {issue:'GAME_NOT_MATCHED'};
  const original=marketBody(market),source=observationFor(market,capture);
  if (!original) return {issue:'MARKET_INVALID'};
  if (!profileMatches(market)||globalThis.Tai888LeagueRegistry.identify(market.periodEvidence.sectionTitle)!==league.toUpperCase()) return {issue:'HEADER_PROFILE_MISMATCH'};
  if (!source) return {issue:'OBSERVATION_MISSING'};
  if (source.deviceHash!==config.deviceHash) return {issue:'SOURCE_DEVICE_MISMATCH'};
  if (source.sourceHost!==config.sourceHost) return {issue:'SOURCE_HOST_MISMATCH'};
  if (!Number.isFinite(now)||now<instant(config.confirmedAt)) return {issue:'CONFIRMATION_NOT_EFFECTIVE'};
  if (['observedAt','receivedAt','persistedAt'].some(key=>instant(source[key])<instant(config.confirmedAt))) return {issue:'OBSERVATION_BEFORE_CONFIRMATION'};
  if (!knownObservation(source,config,now)) return {issue:'OBSERVATION_TIME_INVALID'};
  const half=(raw.markets||[]).find(candidate=>candidate.kind===market.kind&&profileMatches(candidate,true)
    && knownObservation(observationFor(candidate,capture),config,now)
    && sameCapture(observationFor(candidate,capture),source)
    && candidate.periodEvidence.sectionTitle===market.periodEvidence.sectionTitle);
  return half?{original,source,half}:{issue:'SAME_CAPTURE_HALF_MISSING'};
}

export function soccerReaderPeriodBindingDiagnostics(games,capture,now=Date.now()) {
  const config=readSoccerReaderPeriodBinding(),blockerCounts={};
  let candidateMarketCount=0,resolvedMarketCount=0;
  for (const raw of Array.isArray(games)?games:[]) for (const market of raw.markets||[]) {
    if (!['HANDICAP','TOTAL'].includes(market?.kind)||market?.periodEvidence?.period!=='UNKNOWN') continue;
    candidateMarketCount++;
    if (soccerMarketHasVerifiedPeriodResolution(market,now)) {resolvedMarketCount++;continue;}
    const result=periodBindingAssessment(raw,capture,market,config,now);
    const reason=result.issue||'RESOLUTION_NOT_APPLIED';
    blockerCounts[reason]=(blockerCounts[reason]||0)+1;
  }
  return {version:'SOCCER-PERIOD-BINDING-DIAGNOSTICS-v1',configurationStatus:config?'READY':process.env.SOCCER_READER_PERIOD_BINDING_JSON?'INVALID':'MISSING',
    candidateMarketCount,resolvedMarketCount,blockedMarketCount:candidateMarketCount-resolvedMarketCount,blockerCounts};
}

export function resolveSoccerReaderPeriods(raw,capture,now=Date.now()) {
  const config=readSoccerReaderPeriodBinding(),league=String(raw?.league||'').toLowerCase();
  if (!config || !config.leagues.includes(league) || raw?.matchStatus!=='MATCHED'
    || typeof raw.officialGameId!=='string'||!raw.officialGameId.startsWith(`soccer:${league}:`)) return raw;
  const markets=(raw.markets||[]).map(market=>{
    const {original,source,half,issue}=periodBindingAssessment(raw,capture,market,config,now);
    if (issue) return market;
    const body={version:config.version,profile:config.profile,configHash:sha(publicConfig(config)),confirmedAt:config.confirmedAt,
      originalPeriod:'UNKNOWN',resolvedPeriod:'FT',league,gameId:raw.officialGameId,date:raw.boardDate,time:raw.boardTime,
      observation:source,market:original,originalPeriodEvidence:detach(market.periodEvidence),
      companionEvidence:detach(half.periodEvidence)};
    return {...market,period:'FT',serverObservation:market.serverObservation||{...source},periodResolution:{...body,signature:signature(body,config)}};
  });
  return {...raw,markets,periodsCovered:[...new Set(markets.map(market=>market.period))].sort()};
}

function verifiedResolution(resolution,now) {
  const config=readSoccerReaderPeriodBinding();
  if (!config || !resolution || resolution.version!==config.version || resolution.profile!==config.profile
    || resolution.configHash!==sha(publicConfig(config)) || resolution.confirmedAt!==config.confirmedAt
    || resolution.originalPeriod!=='UNKNOWN'||resolution.resolvedPeriod!=='FT'
    || !config.leagues.includes(resolution.league)||!knownObservation(resolution.observation,config,now)
    || !hex(resolution.signature)) return false;
  const {signature:actual,...body}=resolution,expected=signature(body,config);
  return timingSafeEqual(Buffer.from(actual,'hex'),Buffer.from(expected,'hex'));
}
export function soccerMarketHasVerifiedPeriodResolution(market,now=Date.now()) {
  const resolution=market?.periodResolution;
  return market?.period==='FT'&&verifiedResolution(resolution,now)
    && equal(resolution.market,marketBody(market))&&equal(resolution.originalPeriodEvidence,market.periodEvidence)
    && equal(resolution.observation,observationFor(market,null));
}
export function soccerQuoteHasVerifiedPeriodResolution(quote,game,now=Date.now()) {
  const resolution=quote?.provenance?.periodResolution;
  if (quote?.period!=='FT'||!verifiedResolution(resolution,now)||resolution.gameId!==game?.id
    || resolution.league!==game?.league||resolution.date!==game?.date
    || Date.parse(`${resolution.date}T${resolution.time}:00+08:00`)!==instant(game?.startTime)
    || !equal(resolution.originalPeriodEvidence,quote.provenance.periodEvidence)) return false;
  const market=resolution.market,source=resolution.observation;
  if (quote.kind!==market.kind||quote.line!==market.line||(quote.lineSide??null)!==market.lineSide
    || quote.water!==market[`${quote.side}Water`]||!equal(quote.rawRows,market.rawRows)) return false;
  return ['readerRevision','readerObservationId','observedAt','firstFetchedAt','receivedAt','persistedAt','sourceHost','sourceUrl']
    .every(key=>quote.provenance[key]===source[({readerRevision:'revision',readerObservationId:'observationId',sourceUrl:'pageUrl'})[key]||key]);
}
