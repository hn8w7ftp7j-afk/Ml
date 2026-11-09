import { createHash, randomUUID } from 'node:crypto';
import { soccerDate } from './contracts.js';

export const SOCCER_OBSERVATION_ARCHIVE_VERSION = 'SOCCER-EXTERNAL-OBSERVATION-ARCHIVE-v1';
export const SOCCER_OBSERVATION_DOCUMENT_MAX_BYTES = 4 * 1024 * 1024;
const MAX_DOCUMENTS = 32, MAX_TOTAL_BYTES = 24 * 1024 * 1024, MAX_CONTEXT_BYTES = 2 * 1024 * 1024;
const representation = 'PARSED_PROVIDER_JSON';
const restrictions = { historicalAvailabilityVerified:false, independentlyConfirmed:false, formalEligible:false,
  modelEffectApplied:false,modelEffectAccepted:false,executable:false };
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const digest = text => createHash('sha256').update(text, 'utf8').digest('hex');
export const soccerObservationArchiveHash = value => digest(canonical(value));
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const clone = value => JSON.parse(JSON.stringify(value));
const instant = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
const iso = value => new Date(value).toISOString();
const journal = () => import('./journal.js');
const queryJournal = async (...args) => (await journal()).soccerJournalQuery(...args);
const transactionJournal = async (...args) => (await journal()).soccerJournalTransaction(...args);
const identities = new WeakMap(), availability = new WeakMap();
const fail = code => { throw Error(code); };
const unavailable = reason => ({version:SOCCER_OBSERVATION_ARCHIVE_VERSION,status:'UNAVAILABLE',persisted:false,
  reason,normalizedDocumentHashRecomputed:false,rawSourceHashRecomputed:false,prematchReceipt:false,...restrictions});
export const unavailableSoccerObservationArchive = () => unavailable('OBSERVATION_SOURCE_STORAGE_UNAVAILABLE');
function observationView(observation) {
  if (!observation || typeof observation !== 'object' || Array.isArray(observation)) return null;
  return Object.fromEntries(Object.entries(observation).filter(([key]) => !['sourceDocumentArchive','observationArchive','archiveReceipt'].includes(key)));
}
function gameBinding(game) {
  if (!['epl','ucl'].includes(game?.league) || !/^\d{1,16}$/.test(game?.sourceId || '')
    || game.id !== `soccer:${game.league}:${game.sourceId}` || !Number.isFinite(instant(game.startTime))
    || soccerDate(game.startTime) !== game.date || !['scheduled','live','final','postponed','cancelled','suspended'].includes(game.status)
    || !['home','away'].every(side => /^\d{1,16}$/.test(game[side]?.sourceId || '')
      && game[side]?.id === `soccer:${game.league}:team:${game[side].sourceId}`)
    || game.home.sourceId === game.away.sourceId) return null;
  return {league:game.league,gameId:game.id,eventId:game.sourceId,date:game.date,kickoffAt:iso(game.startTime),
    gameStatus:game.status,neutralSite:game.neutralSite === true,
    teamIds:{home:game.home.sourceId,away:game.away.sourceId}};
}
const kindFor = field => field === 'weather' ? 'WEATHER_FORECAST' : ['travel','uclContext'].includes(field)
  ? 'MATCH_CONDITIONS' : /^teams\.(home|away)\.minutes$/.test(field || '') ? 'PERSONNEL_RESEARCH' : null;
function validSource(source) {
  if (!source || !sha(source.contentHash) || !Number.isFinite(instant(source.fetchedAt))) return false;
  let url; try { url = new URL(source.url); } catch { return false; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash
    || [...url.searchParams.keys()].some(key => /(?:api.?key|token|password|authorization|secret|credential)/i.test(key))) return false;
  const host = url.hostname, path = url.pathname;
  const allowed = source.provider === 'ESPN' && ((host === 'site.api.espn.com' && /^\/apis\/site\/v2\/sports\/soccer\//.test(path))
    || host === 'sports.core.api.espn.com' && /^\/v2\/sports\/soccer\//.test(path))
    || source.provider === 'OPEN_METEO' && host === 'api.open-meteo.com' && path === '/v1/forecast'
    || source.provider === 'WIKIDATA' && host === 'www.wikidata.org' && path === '/w/api.php';
  if (!allowed) return false;
  const fetched = instant(source.fetchedAt), available = source.availableAt == null ? fetched : instant(source.availableAt);
  const requested = source.requestedAt == null ? fetched : instant(source.requestedAt);
  const published = source.sourcePublishedAt == null ? null : instant(source.sourcePublishedAt);
  return Number.isFinite(available) && Number.isFinite(requested) && requested <= fetched && fetched <= available
    && (published === null || Number.isFinite(published) && published <= fetched);
}
function checkedDocuments(documents) {
  if (!Array.isArray(documents) || !documents.length || documents.length > MAX_DOCUMENTS) fail('OBSERVATION_SOURCE_DOCUMENTS_INVALID');
  let total = 0;
  return documents.map(document => {
    const source = document?.source;
    const text = typeof document?.text === 'string' ? document.text : typeof document?.retainedJson === 'string'
      ? document.retainedJson : document?.data && typeof document.data === 'object' ? JSON.stringify(document.data) : null;
    if (!validSource(source) || typeof text !== 'string' || !text.length || text.includes('\u0000')) fail('OBSERVATION_SOURCE_DOCUMENT_INVALID');
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > SOCCER_OBSERVATION_DOCUMENT_MAX_BYTES || (total += bytes) > MAX_TOTAL_BYTES) fail('OBSERVATION_SOURCE_BYTE_BUDGET');
    let data; try { data = JSON.parse(text); } catch { fail('OBSERVATION_SOURCE_DOCUMENT_JSON_INVALID'); }
    if (!data || typeof data !== 'object' || Array.isArray(data) || JSON.stringify(data) !== text
      || digest(text) !== source.contentHash) fail('OBSERVATION_SOURCE_HASH_MISMATCH');
    return {ok:true,source:clone(source),text,retainedJson:text,data,bytes,representation};
  });
}
async function adapterFor(field) {
  if (field === 'weather') {
    const module = await import('./weather.js');
    return { proof:(observation) => module.soccerWeatherDocumentProof(observation),
      rebuild:({game,documents,binding}) => module.normalizeSoccerWeather({game,documents,now:instant(binding.normalizedAt)}) };
  }
  if (['travel','uclContext'].includes(field)) {
    const module = await import('./match-conditions-evidence.js');
    return { proof:(observation) => module.soccerMatchConditionsDocumentProof(observation),
      rebuild:({documents,binding,reconstructionInputs,game}) => module.restoreSoccerMatchConditionsObservation({
        documents,binding:{...binding,startTime:binding.kickoffAt},reconstructionInputs:{...reconstructionInputs,game,now:instant(binding.normalizedAt),field}}) };
  }
  if (/^teams\.(home|away)\.minutes$/.test(field || '')) {
    const module = await import('./personnel-inputs.js');
    return { proof:(_observation,evidence) => module.getSoccerPersonnelInputArchiveProof?.(evidence,{field}),
      rebuild:async ({game,binding,reconstructionInputs,adapterMetadata}) => {
        const receiptId=reconstructionInputs?.sourceDocumentReceiptId;
        const {loadSoccerSourceDocument,soccerSourceDocumentProof}=await import('./source-document-store.js');
        const {normalizeSoccerPrematch}=await import('./prematch.js');
        const stored=await loadSoccerSourceDocument(receiptId);
        const evidence=normalizeSoccerPrematch(stored.document,game,reconstructionInputs.rawSource,reconstructionInputs.cutoff);
        if (!evidence.ok || soccerSourceDocumentProof(evidence)?.receiptId!==receiptId) fail('OBSERVATION_PERSONNEL_SUMMARY_SCOPE_INVALID');
        const projection={minutes:Object.fromEntries(['home','away'].map(side=>[side,evidence.teams?.[side]?.minutes??null])),
          present:Object.fromEntries(['home','away'].map(side=>[side,Boolean(evidence.teams?.[side]&&Object.hasOwn(evidence.teams[side],'minutes'))]))};
        if(soccerObservationArchiveHash(projection)!==soccerObservationArchiveHash(reconstructionInputs.sourceProjection))
          fail('OBSERVATION_PERSONNEL_SOURCE_PROJECTION_INVALID');
        evidence.sourceDocumentArchive=stored.receipt;
        return module.restoreSoccerPersonnelInputObservation(evidence,{...adapterMetadata,
          binding:{...binding,startTime:binding.kickoffAt},reconstructionInputs});
      } };
  }
  fail('OBSERVATION_FIELD_INVALID');
}
function scopeMatches(proof, game, field) {
  const scope = proof?.binding;
  return scope && scope.league === game.league && scope.gameId === game.id && scope.date === game.date
    && (scope.startTime || scope.kickoffAt) === game.startTime && scope.field === field
    && ['PREMATCH_OBSERVATION','POSTSTART_AUDIT'].includes(scope.phase);
}
function normalizedTime(proof, observation) {
  const value = proof?.binding?.normalizedAt ?? proof?.reconstructionInputs?.now ?? proof?.reconstructionInputs?.cutoff ?? proof?.normalizedAt ?? observation?.observedAt;
  const time = typeof value === 'number' ? value : instant(value);
  return Number.isFinite(time) ? iso(time) : null;
}
function timeValid(binding) {
  return [binding.normalizedAt,binding.availableAt,binding.fetchedAt,binding.kickoffAt].every(value => Number.isFinite(instant(value)))
    && instant(binding.fetchedAt) <= instant(binding.availableAt)
    && instant(binding.normalizedAt) <= instant(binding.availableAt);
}
// A personnel reconstruction can refer to the same original documents in its
// nested workload proofs. Store references, never a second full JSON copy.
function packContext(value,documents,depth=0) {
  if(depth>60)fail('OBSERVATION_RECONSTRUCTION_DEPTH');
  if(!value||typeof value!=='object')return value;
  if(Array.isArray(value))return value.map(item=>packContext(item,documents,depth+1));
  const text=typeof value.retainedJson==='string'?value.retainedJson:typeof value.text==='string'?value.text:null;
  const index=text&&value.source?documents.findIndex(document=>document.text===text
    &&soccerObservationArchiveHash(document.source)===soccerObservationArchiveHash(value.source)):-1;
  if(index>=0) return {__soccerArchiveDocument:index,keys:Object.keys(value),extras:Object.fromEntries(Object.entries(value)
    .filter(([key])=>!['source','text','retainedJson','data','bytes','representation','ok'].includes(key))
    .map(([key,item])=>[key,packContext(item,documents,depth+1)]))};
  return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,packContext(item,documents,depth+1)]));
}
function unpackContext(value,documents,depth=0) {
  if(depth>60)fail('OBSERVATION_RECONSTRUCTION_DEPTH');
  if(!value||typeof value!=='object')return value;
  if(Array.isArray(value))return value.map(item=>unpackContext(item,documents,depth+1));
  if(Object.hasOwn(value,'__soccerArchiveDocument')) {
    const document=documents[value.__soccerArchiveDocument];
    if(!Number.isSafeInteger(value.__soccerArchiveDocument)||!document||!Array.isArray(value.keys))fail('OBSERVATION_DOCUMENT_REFERENCE_INVALID');
    const extras=unpackContext(value.extras||{},documents,depth+1);
    return Object.fromEntries(value.keys.map(key=>[key,Object.hasOwn(extras,key)?extras[key]:document[key]]));
  }
  return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,unpackContext(item,documents,depth+1)]));
}
let ready;
export async function ensureSoccerObservationStore() {
  return ready ||= (async () => {
    await (await journal()).ensureSoccerJournal();
    await transactionJournal([
      ['SELECT pg_advisory_xact_lock(221019,2323)'],
      [`CREATE TABLE IF NOT EXISTS sports_soccer_observation_documents_v1 (
        content_hash TEXT PRIMARY KEY CHECK(content_hash ~ '^[a-f0-9]{64}$'),
        document_text TEXT NOT NULL,document_bytes INTEGER NOT NULL CHECK(document_bytes>0 AND document_bytes<=4194304
          AND octet_length(document_text)=document_bytes),representation TEXT NOT NULL CHECK(representation='PARSED_PROVIDER_JSON'),
        recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())`],
      [`CREATE TABLE IF NOT EXISTS sports_soccer_observations_v1 (
        receipt_id TEXT PRIMARY KEY CHECK(receipt_id ~ '^[a-f0-9]{64}$'),league TEXT NOT NULL CHECK(league IN ('epl','ucl')),
        game_id TEXT NOT NULL,field TEXT NOT NULL,kind TEXT NOT NULL,binding JSONB NOT NULL,observation JSONB NOT NULL,
        reconstruction_inputs JSONB NOT NULL,recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())`],
      [`CREATE INDEX IF NOT EXISTS sports_soccer_observation_scope_v1 ON sports_soccer_observations_v1(league,game_id,field,recorded_at)`],
      ...['observation_documents','observations'].map(name => [`CREATE OR REPLACE TRIGGER sports_soccer_immutable_v2
        BEFORE UPDATE OR DELETE ON sports_soccer_${name}_v1 FOR EACH ROW EXECUTE FUNCTION sports_soccer_immutable_v2()`]),
    ]);
  })().catch(error => { ready = null; throw error; });
}
async function readStored(receiptId, query) {
  const rows = await query(`SELECT *,date_trunc('milliseconds',recorded_at)+CASE WHEN recorded_at>date_trunc('milliseconds',recorded_at)
    THEN interval '1 millisecond' ELSE interval '0 milliseconds' END AS recorded_at_upper_bound,
    ((binding->>'availableAt')::timestamptz<=recorded_at) AS source_available_by_receipt,
    (recorded_at<(binding->>'kickoffAt')::timestamptz) AS receipt_before_kickoff
    FROM sports_soccer_observations_v1 WHERE receipt_id=$1`,[receiptId]);
  const row = rows[0], binding = row?.binding;
  if (rows.length !== 1 || !binding || soccerObservationArchiveHash(binding) !== receiptId
    || binding.version !== SOCCER_OBSERVATION_ARCHIVE_VERSION || !timeValid(binding)
    || binding.league !== row.league || binding.gameId !== row.game_id || binding.field !== row.field
    || binding.kind !== row.kind || kindFor(binding.field) !== binding.kind
    || binding.observationHash !== soccerObservationArchiveHash(row.observation)
    || binding.reconstructionHash !== soccerObservationArchiveHash(row.reconstruction_inputs)
    || !Array.isArray(binding.documents) || !binding.documents.length || binding.documents.length > MAX_DOCUMENTS)
    fail('OBSERVATION_READBACK_INVALID');
  const hashes=[...new Set(binding.documents.map(document=>document.contentHash))];
  const documents = await query(`SELECT *,recorded_at<=$2::timestamptz AS document_available_by_observation
    FROM sports_soccer_observation_documents_v1 WHERE content_hash=ANY($1::text[])`,[hashes,row.recorded_at]);
  if (documents.length !== hashes.length) fail('OBSERVATION_DOCUMENT_READBACK_MISSING');
  const byHash = new Map(documents.map(document=>[document.content_hash,document]));
  let documentsBefore = true;
  const original = binding.documents.map(reference => {
    const document=byHash.get(reference.contentHash);
    if (!document || document.representation!==representation || reference.contentHash!==reference.source?.contentHash
      || !validSource(reference.source) || Number(document.document_bytes)!==Buffer.byteLength(document.document_text,'utf8')
      || digest(document.document_text)!==reference.contentHash || Number(document.document_bytes)!==reference.bytes
      || typeof document.document_available_by_observation!=='boolean') fail('OBSERVATION_DOCUMENT_READBACK_INVALID');
    documentsBefore &&= document.document_available_by_observation;
    return {ok:true,source:reference.source,text:document.document_text,retainedJson:document.document_text,
      data:JSON.parse(document.document_text),bytes:document.document_bytes,representation};
  });
  checkedDocuments(original);
  const recordedAt=iso(row.recorded_at),upper=iso(row.recorded_at_upper_bound);
  if (!Number.isFinite(instant(recordedAt)) || !Number.isFinite(instant(upper))
    || instant(upper)<instant(recordedAt)||instant(upper)>instant(recordedAt)+1
    || !['source_available_by_receipt','receipt_before_kickoff'].every(key=>typeof row[key]==='boolean'))
    fail('OBSERVATION_RECEIPT_TIME_INVALID');
  const timingStatus = !row.source_available_by_receipt ? 'QUARANTINED_SOURCE_TIME_AFTER_DATABASE_RECEIPT'
    : !documentsBefore ? 'QUARANTINED_DOCUMENT_TIME_AFTER_OBSERVATION'
      : !row.receipt_before_kickoff ? 'AFTER_KICKOFF_DATABASE_RECEIPT'
        : binding.phase!=='PREMATCH_OBSERVATION'||binding.gameStatus!=='scheduled' ? 'POSTSTART_SOURCE_OBSERVATION' : 'PREGAME_DATABASE_RECEIPT';
  const receipt={version:SOCCER_OBSERVATION_ARCHIVE_VERSION,status:'ARCHIVED',persisted:true,receiptId,kind:binding.kind,field:binding.field,
    league:binding.league,gameId:binding.gameId,date:binding.date,kickoffAt:binding.kickoffAt,observationHash:binding.observationHash,
    documentCount:binding.documents.length,documentHashes:hashes,documentBytes:binding.documents.reduce((sum,item)=>sum+item.bytes,0),
    normalizedAt:binding.normalizedAt,fetchedAt:binding.fetchedAt,availableAt:binding.availableAt,recordedAt,recordedAtUpperBound:upper,
    timingStatus,prematchReceipt:timingStatus==='PREGAME_DATABASE_RECEIPT',normalizedDocumentHashRecomputed:true,
    rawSourceHashRecomputed:false,sourcePublishedAt:row.observation.source?.sourcePublishedAt??null,...restrictions};
  const context=unpackContext(row.reconstruction_inputs,original);
  return {binding,observation:row.observation,reconstructionInputs:context.inputs,adapterMetadata:context.metadata,documents:original,receipt};
}
function remember(observation, game, binding, receipt) {
  if (receipt.prematchReceipt!==true) return;
  const source=observation?.source;
  const references=binding.documents.filter(item=>source && item.contentHash===source.contentHash
    && item.source.url===source.url && item.source.provider===source.provider);
  if (!references.length || source.scope?.league!==binding.league || source.scope?.gameId!==binding.gameId
    || source.scope?.field!==binding.field || !validSource(source)) return;
  availability.set(observation,{binding:clone(binding),receipt:clone(receipt),gameHash:soccerObservationArchiveHash(gameBinding(game)),
    observationHash:soccerObservationArchiveHash(observationView(observation)),source,sourceHash:soccerObservationArchiveHash(source)});
}
/** Only an actual adapter's process-local proof can enter this append-only store. */
export async function archiveSoccerObservation(observation,{game,field,kind,evidence,
  query=queryJournal,transaction=transactionJournal,ensure=ensureSoccerObservationStore}={}) {
  const scope=gameBinding(game),expectedKind=kindFor(field),view=observationView(observation);
  if (!scope || !expectedKind || kind && ![expectedKind,'weather','travel','uclContext','personnel','match_conditions'].includes(kind)
    || !view || view.formalEligible===true || view.modelEffectApplied===true || view.executable===true)
    return unavailable('OBSERVATION_SCOPE_INVALID');
  let adapter,proof,documents;
  try { adapter=await adapterFor(field);proof=await adapter.proof(observation,evidence); }
  catch { return unavailable('OBSERVATION_PRIVATE_PROOF_UNAVAILABLE'); }
  if (!proof || !scopeMatches(proof,game,field)) return unavailable('OBSERVATION_PRIVATE_PROOF_MISSING');
  try { documents=checkedDocuments(proof.documents); } catch(error) { return unavailable(error.message); }
  const normalizedAt=normalizedTime(proof,view),rawContext=clone(proof.reconstructionInputs||{});
  const adapterMetadata=clone(Object.fromEntries(Object.entries(proof).filter(([key])=>!['documents','binding','reconstructionInputs'].includes(key))));
  let context;
  try { context=packContext({inputs:rawContext,metadata:adapterMetadata},documents); }
  catch { return unavailable('OBSERVATION_RECONSTRUCTION_INPUTS_INVALID'); }
  if (!normalizedAt || Buffer.byteLength(canonical(context))>MAX_CONTEXT_BYTES) return unavailable('OBSERVATION_RECONSTRUCTION_INPUTS_INVALID');
  let rebuilt;
  try { rebuilt=await adapter.rebuild({game,documents,binding:{...scope,...proof.binding,normalizedAt,field,kind:expectedKind},
    reconstructionInputs:rawContext,adapterMetadata}); }
  catch { return unavailable('OBSERVATION_RECONSTRUCTION_FAILED'); }
  if (soccerObservationArchiveHash(observationView(rebuilt))!==soccerObservationArchiveHash(view))
    return unavailable('OBSERVATION_RECONSTRUCTION_MISMATCH');
  let identity=identities.get(observation);
  const signature=soccerObservationArchiveHash({scope,field,observation:view,documents:documents.map(item=>({source:item.source,bytes:item.bytes})),context,normalizedAt});
  if (identity && identity.signature!==signature) return unavailable('OBSERVATION_BINDING_CHANGED');
  if (!identity) { identity={signature,fetchId:randomUUID(),availableAt:iso(Date.now())};identities.set(observation,identity); }
  const fetchedAt=iso(Math.max(...documents.map(item=>instant(item.source.fetchedAt))));
  const availableAt=iso(Math.max(instant(identity.availableAt),instant(normalizedAt),...documents.map(item=>instant(item.source.availableAt||item.source.fetchedAt))));
  if (instant(availableAt)>Date.now()) return unavailable('OBSERVATION_SOURCE_AFTER_SERVER_CLOCK');
  const binding={version:SOCCER_OBSERVATION_ARCHIVE_VERSION,...scope,field,kind:expectedKind,phase:proof.binding.phase,
    fetchId:identity.fetchId,normalizedAt,fetchedAt,availableAt,observationHash:soccerObservationArchiveHash(view),
    reconstructionHash:soccerObservationArchiveHash(context),documents:documents.map(item=>({contentHash:item.source.contentHash,bytes:item.bytes,source:item.source}))};
  const receiptId=soccerObservationArchiveHash(binding);
  await ensure();
  await transaction([
    ...[...new Map(documents.map(item=>[item.source.contentHash,item])).values()].map(item=>[
      `INSERT INTO sports_soccer_observation_documents_v1(content_hash,document_text,document_bytes,representation)
      VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[item.source.contentHash,item.text,item.bytes,representation]]),
    [`INSERT INTO sports_soccer_observations_v1(receipt_id,league,game_id,field,kind,binding,observation,reconstruction_inputs)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb) ON CONFLICT DO NOTHING`,
      [receiptId,scope.league,scope.gameId,field,expectedKind,JSON.stringify(binding),JSON.stringify(view),JSON.stringify(context)]],
  ]);
  const stored=await readStored(receiptId,query);
  if (soccerObservationArchiveHash(stored.observation)!==soccerObservationArchiveHash(view)) fail('OBSERVATION_CONTENT_CONFLICT');
  if (query===queryJournal&&transaction===transactionJournal&&ensure===ensureSoccerObservationStore) remember(observation,game,binding,stored.receipt);
  return stored.receipt;
}
function observationFor(evidence,field) { return field.split('.').reduce((value,key)=>value?.[key],evidence); }
export function soccerCurrentObservationAvailability(source,{evidence,game=evidence?.game,field,now=Date.now()}={}) {
  try {
    if (!kindFor(field)) return null;
    const observation=observationFor(evidence,field),proof=availability.get(observation);
    if (!proof || proof.source!==source || proof.sourceHash!==soccerObservationArchiveHash(source)
      || proof.observationHash!==soccerObservationArchiveHash(observationView(observation))
      || proof.gameHash!==soccerObservationArchiveHash(gameBinding(game)) || proof.binding.field!==field
      || evidence.phase!=='PREMATCH_OBSERVATION' || game.status!=='scheduled' || !Number.isFinite(now)
      || !(instant(proof.receipt.recordedAtUpperBound)<=now) || !(now<instant(game.startTime))
      || now-instant(source.fetchedAt)>=180000 || now<instant(source.fetchedAt) || now<instant(proof.binding.availableAt)) return null;
    return {version:'SOCCER-CURRENT-EXTERNAL-OBSERVATION-AVAILABILITY-v1',status:'CURRENT_DATABASE_RECEIPT_VERIFIED',scope:'CURRENT_ANALYSIS_ONLY',
      receiptId:proof.receipt.receiptId,gameId:game.id,league:game.league,field,contentHash:source.contentHash,sourceUrl:source.url,
      fetchedAt:source.fetchedAt,availableAt:proof.binding.availableAt,recordedAt:proof.receipt.recordedAt,
      recordedAtUpperBound:proof.receipt.recordedAtUpperBound,...restrictions};
  } catch { return null; }
}
export async function loadSoccerObservation(receiptId,{query=queryJournal,ensure=ensureSoccerObservationStore}={}) {
  if (!sha(receiptId)) fail('OBSERVATION_RECEIPT_INVALID');
  await ensure();
  return readStored(receiptId,query);
}
function storedMatches(stored,observation,game,field) {
  const scope=gameBinding(game);
  return scope&&stored.binding.field===field
    &&!['league','gameId','eventId','date','kickoffAt','gameStatus','neutralSite'].some(key=>stored.binding[key]!==scope[key])
    &&soccerObservationArchiveHash(stored.binding.teamIds)===soccerObservationArchiveHash(scope.teamIds)
    &&stored.binding.observationHash===soccerObservationArchiveHash(observationView(observation));
}
/** Return the original summary minutes only after every changed derived field
 * is reproduced from its immutable DB documents. This is a projection proof,
 * never a raw-source publication or accepted model-effect capability. */
export async function restoreSoccerPersonnelObservationProjection(evidence,{game=evidence?.game,now=Date.now()}={}) {
  try {
    if(!gameBinding(game)||!Number.isFinite(now)||!sha(evidence?.sourceDocumentArchive?.receiptId))return null;
    let projection;const archived=new Set();
    for(const side of ['home','away']) {
      const field=`teams.${side}.minutes`,observation=observationFor(evidence,field);
      const receiptId=observation?.observationArchive?.receiptId||observation?.sourceDocumentArchive?.receiptId||observation?.archiveReceipt?.receiptId;
      if(receiptId==null)continue;
      if(!sha(receiptId))return null;
      const stored=await loadSoccerObservation(receiptId);
      if(!storedMatches(stored,observation,game,field)
        ||stored.reconstructionInputs?.sourceDocumentReceiptId!==evidence.sourceDocumentArchive.receiptId)return null;
      const adapter=await adapterFor(field),rebuilt=await adapter.rebuild({...stored,game});
      if(soccerObservationArchiveHash(observationView(rebuilt))!==stored.binding.observationHash)return null;
      const original=stored.reconstructionInputs.sourceProjection;
      if(projection&&soccerObservationArchiveHash(projection)!==soccerObservationArchiveHash(original))return null;
      projection=original;archived.add(side);
    }
    if(!projection||!archived.size)return null;
    for(const side of ['home','away'])if(!archived.has(side)) {
      const team=evidence.teams?.[side],present=Boolean(team&&Object.hasOwn(team,'minutes'));
      if(present!==projection.present[side]||soccerObservationArchiveHash(team?.minutes??null)!==soccerObservationArchiveHash(projection.minutes[side]))return null;
    }
    return clone(projection);
  }catch{return null;}
}
/** Restoring a serialized receipt always revalidates original immutable files
 * and reruns the field's normalizer; stored PASS flags never grant authority. */
export async function restoreSoccerObservationAvailability(evidence,{field,game=evidence?.game,now=Date.now(),
  query=queryJournal,ensure=ensureSoccerObservationStore}={}) {
  try {
    if (soccerCurrentObservationAvailability(observationFor(evidence,field)?.source,{evidence,game,field,now})) return true;
    const observation=observationFor(evidence,field),view=observationView(observation),scope=gameBinding(game);
    const receiptId=observation?.sourceDocumentArchive?.receiptId||observation?.observationArchive?.receiptId||observation?.archiveReceipt?.receiptId;
    if (!kindFor(field)||!scope||!sha(receiptId)||!Number.isFinite(now)) return false;
    const stored=await loadSoccerObservation(receiptId,{query,ensure});
    if (!stored.receipt.prematchReceipt || !storedMatches(stored,observation,game,field)) return false;
    const adapter=await adapterFor(field),rebuilt=await adapter.rebuild({...stored,game});
    if (soccerObservationArchiveHash(observationView(rebuilt))!==stored.binding.observationHash) return false;
    if (query===queryJournal&&ensure===ensureSoccerObservationStore) remember(observation,game,stored.binding,stored.receipt);
    return Boolean(soccerCurrentObservationAvailability(observation?.source,{evidence,game,field,now}));
  } catch { return false; }
}
