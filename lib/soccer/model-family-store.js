import { ensureSoccerJournal, soccerJournalQuery, soccerJournalTransaction } from './journal.js';
import { soccerModelFamilyHash as hash, SOCCER_MODEL_FAMILY_UNCERTAINTY_VERSION } from './model-family-uncertainty.js';

export const SOCCER_MODEL_FAMILY_STORE_VERSION = 'SOCCER-MODEL-FAMILY-IMMUTABLE-RECEIPTS-v1';
const restrictions = { accepted:false, formalEligible:false, promotionEligible:false, executable:false,
  coverageAssumptionsVerified:false, calibrationProspectiveVerified:false, W:null, R:null, S:null };
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const instant = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
const iso = value => new Date(value).toISOString();
const fail = code => { throw Error(code); };
const clone = value => JSON.parse(JSON.stringify(value));
const finite = value => typeof value==='number'&&Number.isFinite(value);
const bounded = value => value&&finite(value.lower)&&finite(value.upper)&&value.lower>=0&&value.lower<=value.upper;
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const parametersFrom = artifact => Object.fromEntries(['version','type','baseline','protocolHash','independentRealGames',
  'observationHashes','quarantinedGames','excludedReasons','marginals','family','simultaneousErrorProbability']
  .map(key => [key,artifact[key]]));
const schema = [
  `CREATE TABLE IF NOT EXISTS sports_soccer_model_family_freezes_v1 (
    freeze_id TEXT PRIMARY KEY CHECK(freeze_id ~ '^[a-f0-9]{64}$'), scope_key TEXT UNIQUE NOT NULL,
    league TEXT NOT NULL CHECK(league IN ('epl','ucl')), period TEXT NOT NULL CHECK(period IN ('FT','HT')),
    model_hash TEXT NOT NULL, training_hash TEXT NOT NULL, protocol_hash TEXT NOT NULL, parameter_hash TEXT NOT NULL,
    source_artifact_hash TEXT NOT NULL, artifact JSONB NOT NULL, parameters JSONB NOT NULL,
    test_from TIMESTAMPTZ NOT NULL, test_before TIMESTAMPTZ NOT NULL,
    frozen_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())`,
  `CREATE INDEX IF NOT EXISTS sports_soccer_model_family_scope_v1 ON sports_soccer_model_family_freezes_v1
    (league,period,model_hash,training_hash,frozen_at)`,
  `CREATE OR REPLACE TRIGGER sports_soccer_model_family_immutable_v1 BEFORE UPDATE OR DELETE
    ON sports_soccer_model_family_freezes_v1 FOR EACH ROW EXECUTE FUNCTION sports_soccer_immutable_v2()`,
  `CREATE TABLE IF NOT EXISTS sports_soccer_model_family_reports_v1 (
    cache_key TEXT PRIMARY KEY, scope JSONB NOT NULL, source_revision TEXT NOT NULL,
    artifact JSONB NOT NULL, artifact_hash TEXT NOT NULL, written_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())`,
];
let ready;
export async function ensureSoccerModelFamilyStore() {
  return ready ||= (async () => { await ensureSoccerJournal(); await soccerJournalTransaction([
    ['SELECT pg_advisory_xact_lock(221019,2321)'], ...schema.map(sql => [sql]),
  ]); })().catch(error => { ready=null; throw error; });
}
export async function soccerModelFamilyDatabaseNow() {
  await ensureSoccerModelFamilyStore();
  const rows=await soccerJournalQuery('SELECT clock_timestamp() AS database_now');
  const now=new Date(rows[0]?.database_now).getTime();
  if(!Number.isFinite(now))fail('MODEL_FAMILY_DATABASE_TIME_UNAVAILABLE');
  return now;
}

// This verifies a well-formed sealed research artifact, NOT the provenance of
// its observations or the applicability of its statistical family. Only the
// server's independently replayed source adapter may call this private store.
function checkedArtifact(artifact,{allowEmpty=false}={}) {
  if(!artifact || typeof artifact!=='object' || Array.isArray(artifact))fail('MODEL_FAMILY_ARTIFACT_INVALID');
  const {contentHash,...body}=artifact, b=artifact.baseline,p=artifact.protocol;
  if(!sha(contentHash)||hash(body)!==contentHash||artifact.version!==SOCCER_MODEL_FAMILY_UNCERTAINTY_VERSION
    ||artifact.type!=='MODEL_FAMILY_RATE_CONFIDENCE_SET'
    ||!['epl','ucl'].includes(b?.league)||!['FT','HT'].includes(b?.period)||!sha(b.modelHash)||!sha(b.trainingHash)
    ||!Array.isArray(b.sourceHashes)||!b.sourceHashes.length||!b.sourceHashes.every(sha)
    ||![b.createdAt,b.trainedThrough,artifact.generatedAt,p?.registeredAt,p?.calibrationFrom,p?.calibrationBefore].every(value=>Number.isFinite(instant(value)))
    ||!(instant(b.trainedThrough)<instant(b.createdAt))||instant(b.createdAt)>instant(p.calibrationFrom)
    ||instant(p.registeredAt)>instant(p.calibrationFrom)||!(instant(p.calibrationFrom)<instant(p.calibrationBefore))
    ||instant(p.calibrationBefore)>instant(artifact.generatedAt)||hash(p)!==artifact.protocolHash
    ||!Number.isFinite(p.alpha)||!(p.alpha>0&&p.alpha<1)
    ||!Number.isSafeInteger(artifact.independentRealGames)||artifact.independentRealGames<0
    ||!allowEmpty&&artifact.independentRealGames===0
    ||artifact.status!==(artifact.independentRealGames?'MODEL_FAMILY_ONLY_CONFIDENCE_SET':'MISSING_VALID_CALIBRATION_GAMES')
    ||!Array.isArray(artifact.observationHashes)||artifact.observationHashes.length!==artifact.independentRealGames
    ||!artifact.observationHashes.every(sha)||new Set(artifact.observationHashes).size!==artifact.observationHashes.length
    ||!Number.isSafeInteger(artifact.quarantinedGames)||artifact.quarantinedGames<0
    ||artifact.durableFreezeVerified!==false||artifact.individualGameApplicabilityVerified!==false
    ||artifact.coverageAssumptionsVerified!==false||artifact.modelMisspecificationBound!==null
    ||['accepted','formalEligible','calibrationEligible','promotionEligible','executable'].some(key=>artifact[key]!==false)
    ||['W','R','S','empiricalErrorMargin'].some(key=>artifact[key]!==null)
    ||!artifact.excludedReasons||typeof artifact.excludedReasons!=='object'||Array.isArray(artifact.excludedReasons)
    ||Object.values(artifact.excludedReasons).some(value=>!Number.isSafeInteger(value)||value<0)
    ||artifact.independentRealGames>0&&(artifact.simultaneousErrorProbability!==p.alpha
      ||['home','away'].some(side=>{const m=artifact.marginals?.[side];return !m
        ||!Number.isSafeInteger(m.goals)||m.goals<0||!bounded(m.exposure)||m.exposure.lower<=0
        ||!bounded(m.countMean)||!bounded(m.multiplier)||!finite(m.countMean.errorProbability)
        ||!(m.countMean.errorProbability>0&&m.countMean.errorProbability<p.alpha)
        ||m.countMean.method!=='TWO_SIDED_POISSON_CHERNOFF_KL_OUTSIDE_ROOT_ENCLOSURE';}))
    ||artifact.independentRealGames===0&&(artifact.simultaneousErrorProbability!==null||Object.keys(artifact.marginals||{}).length!==0))
    fail('MODEL_FAMILY_ARTIFACT_INVALID');
  return {artifact,b,parameters:parametersFrom(artifact)};
}
function freezeScope(artifact,testFrom,testBefore) {
  const b=artifact.baseline;
  if(![testFrom,testBefore].every(value=>Number.isFinite(instant(value)))
    ||!(instant(artifact.protocol.calibrationBefore)<=instant(testFrom)&&instant(testFrom)<instant(testBefore)))
    fail('MODEL_FAMILY_TEST_WINDOW_INVALID');
  return {league:b.league,period:b.period,modelHash:b.modelHash,trainingHash:b.trainingHash,
    protocolHash:artifact.protocolHash,testFrom:iso(testFrom),testBefore:iso(testBefore)};
}
const freezeSelection=`SELECT *,round(extract(epoch from frozen_at)*1000000)::text AS frozen_epoch_micros,
  frozen_at>=(artifact->>'generatedAt')::timestamptz
    AND frozen_at>=(artifact->'protocol'->>'calibrationBefore')::timestamptz
    AND frozen_at<test_from AND test_from<test_before AS valid_window
  FROM sports_soccer_model_family_freezes_v1`;
function receipt(row) {
  if(!row)fail('MODEL_FAMILY_FREEZE_NOT_FOUND');
  const {artifact,b,parameters}=checkedArtifact(row.artifact);
  const scope=freezeScope(artifact,iso(row.test_from),iso(row.test_before)),scopeKey=hash(scope),parameterHash=hash(parameters);
  if(row.valid_window!==true||!/^\d+$/.test(row.frozen_epoch_micros||'')
    ||row.scope_key!==scopeKey||row.parameter_hash!==parameterHash||hash(row.parameters)!==parameterHash
    ||row.source_artifact_hash!==artifact.contentHash||row.protocol_hash!==artifact.protocolHash
    ||row.league!==b.league||row.period!==b.period||row.model_hash!==b.modelHash||row.training_hash!==b.trainingHash
    ||row.freeze_id!==hash([SOCCER_MODEL_FAMILY_STORE_VERSION,scopeKey,parameterHash]))
    fail('MODEL_FAMILY_FREEZE_READBACK_INVALID');
  return {version:SOCCER_MODEL_FAMILY_STORE_VERSION,status:'DATABASE_FROZEN_FAMILY_RESEARCH',freezeId:row.freeze_id,
    scopeKey,...scope,parameterHash,sourceArtifactHash:row.source_artifact_hash,
    frozenAt:iso(row.frozen_at),frozenEpochMicros:row.frozen_epoch_micros, ...restrictions};
}

/** A new receipt proves only existence before its future test window. It does
 * not retroactively prove the calibration choices were made before outcomes. */
export async function freezeSoccerModelFamilyArtifact(input) {
  if(!exactKeys(input,['artifact','testFrom','testBefore']))fail('MODEL_FAMILY_FREEZE_INPUT_INVALID');
  const {artifact,parameters}=checkedArtifact(input.artifact),scope=freezeScope(artifact,input.testFrom,input.testBefore);
  const scopeKey=hash(scope),parameterHash=hash(parameters),freezeId=hash([SOCCER_MODEL_FAMILY_STORE_VERSION,scopeKey,parameterHash]);
  await ensureSoccerModelFamilyStore();
  await soccerJournalQuery(`INSERT INTO sports_soccer_model_family_freezes_v1
    (freeze_id,scope_key,league,period,model_hash,training_hash,protocol_hash,parameter_hash,source_artifact_hash,artifact,parameters,test_from,test_before)
    SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::timestamptz,$13::timestamptz
    WHERE clock_timestamp()>=$14::timestamptz AND clock_timestamp()>=$15::timestamptz AND clock_timestamp()<$12::timestamptz
    ON CONFLICT DO NOTHING`,[freezeId,scopeKey,scope.league,scope.period,scope.modelHash,scope.trainingHash,scope.protocolHash,
    parameterHash,artifact.contentHash,JSON.stringify(artifact),JSON.stringify(parameters),scope.testFrom,scope.testBefore,
    artifact.generatedAt,artifact.protocol.calibrationBefore]);
  const rows=await soccerJournalQuery(`${freezeSelection} WHERE scope_key=$1`,[scopeKey]);
  if(rows.length!==1)fail('MODEL_FAMILY_FREEZE_WINDOW_CLOSED');
  const result=receipt(rows[0]);
  if(result.parameterHash!==parameterHash)fail('MODEL_FAMILY_PARAMETERS_ALREADY_FROZEN_DIFFERENTLY');
  return result;
}
export async function loadLatestSoccerModelFamilyFreeze(scope) {
  if(!exactKeys(scope,['league','period','modelHash','trainingHash'])||!['epl','ucl'].includes(scope.league)
    ||!['FT','HT'].includes(scope.period)||!sha(scope.modelHash)||!sha(scope.trainingHash))fail('MODEL_FAMILY_FREEZE_SCOPE_INVALID');
  await ensureSoccerModelFamilyStore();
  const rows=await soccerJournalQuery(`${freezeSelection} WHERE league=$1 AND period=$2 AND model_hash=$3 AND training_hash=$4
    ORDER BY frozen_at DESC,freeze_id DESC LIMIT 1`,[scope.league,scope.period,scope.modelHash,scope.trainingHash]);
  return rows.length?receipt(rows[0]):null;
}
export async function loadSoccerModelFamilyFreezeVerifier(freezeId) {
  if(!sha(freezeId))fail('MODEL_FAMILY_FREEZE_ID_INVALID');
  await ensureSoccerModelFamilyStore();
  const rows=await soccerJournalQuery(`${freezeSelection} WHERE freeze_id=$1`,[freezeId]);
  if(rows.length!==1)fail('MODEL_FAMILY_FREEZE_NOT_FOUND');
  const frozen=receipt(rows[0]),signature=clone(frozen),keys=['league','period','modelHash','trainingHash','protocolHash','parameterHash'];
  return {freeze:clone(frozen),verifyFrozenParameters(input) {
    return Boolean(exactKeys(input,[...keys,'before'])&&keys.every(key=>input[key]===signature[key])
      &&Number.isFinite(instant(input.before))&&instant(input.before)>=instant(signature.testFrom)
      &&instant(input.before)<instant(signature.testBefore)
      &&BigInt(instant(input.before))*1000n>BigInt(signature.frozenEpochMicros));
  }};
}

const cacheScopeKeys=['league','period','modelHash','trainingHash','calibrationFrom','calibrationBefore'];
function cacheScope(scope) {
  if(!exactKeys(scope,cacheScopeKeys)||!['epl','ucl'].includes(scope.league)||!['FT','HT'].includes(scope.period)
    ||!sha(scope.modelHash)||!sha(scope.trainingHash)
    ||![scope.calibrationFrom,scope.calibrationBefore].every(value=>Number.isFinite(instant(value)))
    ||!(instant(scope.calibrationFrom)<instant(scope.calibrationBefore)))fail('MODEL_FAMILY_CACHE_SCOPE_INVALID');
  return clone(scope);
}
function cacheReceipt(row,scope,revision) {
  const {artifact,b}=checkedArtifact(row.artifact,{allowEmpty:true});
  if(row.cache_key!==hash([SOCCER_MODEL_FAMILY_STORE_VERSION,scope,revision])||hash(row.scope)!==hash(scope)
    ||row.source_revision!==revision||row.artifact_hash!==artifact.contentHash
    ||b.league!==scope.league||b.period!==scope.period||b.modelHash!==scope.modelHash||b.trainingHash!==scope.trainingHash
    ||artifact.protocol.calibrationFrom!==scope.calibrationFrom||artifact.protocol.calibrationBefore!==scope.calibrationBefore
    ||!Number.isFinite(new Date(row.written_at).getTime())||new Date(row.written_at).getTime()<instant(artifact.generatedAt))
    fail('MODEL_FAMILY_CACHE_READBACK_INVALID');
  return {version:SOCCER_MODEL_FAMILY_STORE_VERSION,status:'DATABASE_DERIVED_FAMILY_REPORT',persisted:true,
    scope:clone(scope),revision,writtenAt:iso(row.written_at),artifact:clone(artifact),...restrictions};
}
export async function saveSoccerModelFamilyReport(input) {
  if(!exactKeys(input,['scope','revision','artifact'])||!sha(input.revision))fail('MODEL_FAMILY_CACHE_INPUT_INVALID');
  const scope=cacheScope(input.scope),{artifact,b}=checkedArtifact(input.artifact,{allowEmpty:true}),revision=input.revision;
  if(b.league!==scope.league||b.period!==scope.period||b.modelHash!==scope.modelHash||b.trainingHash!==scope.trainingHash
    ||artifact.protocol.calibrationFrom!==scope.calibrationFrom||artifact.protocol.calibrationBefore!==scope.calibrationBefore)
    fail('MODEL_FAMILY_CACHE_SCOPE_INVALID');
  const cacheKey=hash([SOCCER_MODEL_FAMILY_STORE_VERSION,scope,revision]);
  await ensureSoccerModelFamilyStore();
  await soccerJournalQuery(`INSERT INTO sports_soccer_model_family_reports_v1(cache_key,scope,source_revision,artifact,artifact_hash)
    SELECT $1,$2::jsonb,$3,$4::jsonb,$5 WHERE clock_timestamp()>=$6::timestamptz
    ON CONFLICT(cache_key) DO UPDATE SET artifact=EXCLUDED.artifact,artifact_hash=EXCLUDED.artifact_hash,written_at=clock_timestamp()`,
  [cacheKey,JSON.stringify(scope),revision,JSON.stringify(artifact),artifact.contentHash,artifact.generatedAt]);
  const rows=await soccerJournalQuery('SELECT * FROM sports_soccer_model_family_reports_v1 WHERE cache_key=$1',[cacheKey]);
  if(rows.length!==1)fail('MODEL_FAMILY_CACHE_WRITE_FAILED');
  if(rows[0].artifact_hash!==artifact.contentHash)fail('MODEL_FAMILY_CACHE_WRITE_CONFLICT');
  return cacheReceipt(rows[0],scope,revision);
}
export async function readSoccerModelFamilyReport({scope:inputScope,revision,maxAgeMs=300000}={}) {
  const scope=cacheScope(inputScope);
  if(!sha(revision)||!Number.isSafeInteger(maxAgeMs)||maxAgeMs<1||maxAgeMs>604800000)fail('MODEL_FAMILY_CACHE_INPUT_INVALID');
  await ensureSoccerModelFamilyStore();
  const rows=await soccerJournalQuery(`SELECT * FROM sports_soccer_model_family_reports_v1 WHERE cache_key=$1
    AND written_at<=clock_timestamp() AND written_at>clock_timestamp()-($2::bigint*interval '1 millisecond')`,
  [hash([SOCCER_MODEL_FAMILY_STORE_VERSION,scope,revision]),maxAgeMs]);
  return rows.length?cacheReceipt(rows[0],scope,revision):null;
}
