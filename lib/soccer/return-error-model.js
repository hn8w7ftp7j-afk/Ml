import { soccerForwardHash, validateSoccerForwardCapture, evaluateSoccerForwardCapture } from './forward-validation.js';
import { SOCCER_MARKET_RETURN_VERSION, canonicalSoccerMarketReturnCaptures, evaluateSoccerMarketReturnCapture } from './market-return-validation.js';
import { soccerVerifiedSettlementContract } from './settlement-contract.js';

export const SOCCER_RETURN_ERROR_VERSION = 'SOCCER-GAME-BLOCK-RETURN-ERROR-RESEARCH-v1';
export const SOCCER_RETURN_ERROR_CANDIDATE_PROTOCOL = Object.freeze({
  version: SOCCER_RETURN_ERROR_VERSION, status: 'CANDIDATE_NOT_REGISTERED', registeredAt: null,
  trainingBefore: null, calibrationBefore: null, testBefore: null, miscoverage: 0.1,
  method: 'GAME_BALANCED_SIGNED_BIAS_THEN_GAME_MAX_ABSOLUTE_RESIDUAL_ORDER_STATISTIC',
  grouping: 'LEAGUE_PERIOD_VARIANT_MODEL_CONTRACT_MARKET_SIDE',
  selection: 'FIRST_VALID_SAVED_PREDICTION_PER_ECONOMIC_PRICE_MODEL',
  splitUnit: 'WHOLE_REAL_GAME_BY_KICKOFF',
  reference: 'https://proceedings.mlr.press/v313/barber26a.html',
  interpretation: 'REALIZED_RETURN_PREDICTION_ERROR_INCLUDES_OUTCOME_NOISE_NOT_CONDITIONAL_EV_UNCERTAINTY',
  exchangeabilityVerified: false, formalEligibility: false,
});
const restrictions = { accepted: false, formalEligible: false, calibrationEligible: false, promotionEligible: false,
  executable: false, empiricalErrorMargin: null, W: null, R: null, S: null };
const finite = value => typeof value === 'number' && Number.isFinite(value);
const interval = value => value && finite(value.lower) && finite(value.upper) && value.lower <= value.upper;
const returnObserved = row => ['OBSERVED','OBSERVED_BOUNDED'].includes(row?.status);
function validObservedReturn(row) {
  if (!finite(row.realizedNetReturn)) return false;
  if (row.status === 'OBSERVED') return [row.predictedNetReturn,row.predictionError].every(finite)
    && row.predictionError === row.realizedNetReturn-row.predictedNetReturn;
  return row.status === 'OBSERVED_BOUNDED' && row.predictedNetReturn === null && row.predictionError === null
    && interval(row.predictedReturnBounds) && interval(row.predictionErrorBounds)
    && finite(row.unresolvedTailMass) && row.unresolvedTailMass > 0 && row.unresolvedTailMass <= 1
    && row.predictionErrorBounds.lower <= row.realizedNetReturn-row.predictedReturnBounds.upper
    && row.predictionErrorBounds.upper >= row.realizedNetReturn-row.predictedReturnBounds.lower;
}
const returnSignature = row => soccerForwardHash([row.status,row.actualScore,row.contractHash,row.predictedNetReturn,
  row.realizedNetReturn,row.predictedReturnBounds ?? null,row.predictionErrorBounds ?? null,
  row.tailMass ?? null,row.resolvedTailMass ?? null,row.unresolvedTailMass ?? null]);
const epoch = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
const seal = value => ({ ...value, contentHash: soccerForwardHash(value) });
const validSeal = value => { if (!value) return false; const { contentHash, ...body } = value; return contentHash === soccerForwardHash(body); };
const count = (reasons,key,n=1) => { reasons[key]=(reasons[key]||0)+n; };
const gameKey = value => `${value.league}:${value.gameId}`;
const resultScope = value => `${gameKey(value)}:${value.period}`;
const stableReturnRow=value=>Object.fromEntries(Object.entries(value).filter(([key])=>!['checkedAt','returnCalculatedAt','resultPersistedAt','resultAvailableAt','sourceHashes'].includes(key)));
function trackResultScore(row,scores,quarantined) {
  const key=resultScope(row),signature=soccerForwardHash(row.actualScore);
  if(scores.has(key)&&scores.get(key)!==signature)quarantined.add(gameKey(row));
  scores.set(key,signature);
}
function checkSeal(check) {
  if (check?.version !== SOCCER_MARKET_RETURN_VERSION || !Array.isArray(check.observations)) return false;
  const { evidenceHash, checkedAt, ...body } = check;
  return evidenceHash === soccerForwardHash({ ...body, observations: check.observations.map(({ checkedAt, ...row })=>row) });
}
function sameReturn(left,right) {
  return ['observationId','captureId','captureSequence','analysisRevision','league','gameId','date','period','variant','modelHash',
    'economicPriceIdentity','predictionCapturedAt','analysisCutoff','originalQuote','quoteKey','contractHash','contractVerifiedAt',
    'distributionHash','resultHash','status','predictedNetReturn','realizedNetReturn','predictionError','actualScore',
    'predictedReturnBounds','predictionErrorBounds','tailMass','resolvedTailMass','unresolvedTailMass','boundInterpretation']
    .every(key=>soccerForwardHash(left[key]??null)===soccerForwardHash(right[key]??null));
}

/** Server-only research intake. Recompute against the immutable prediction,
 * original quote, complete result history and current trusted contract resolver.
 * No HTTP-supplied status or observed-return number is sufficient on its own. */
function* datasetPipeline(evidence={}, { now=Date.now(), resolveContract=soccerVerifiedSettlementContract }={}) {
  const reasons={}, observations=[], boundedObservations=[], quarantined=new Set(), byGameResult=new Map(),kickoffs=new Map();
  const selection=canonicalSoccerMarketReturnCaptures(evidence.captures||[],evidence.protocol,now);
  const captures=new Map(selection.valid.map(capture=>[capture.captureId,capture]));
  for(const capture of selection.valid){const key=gameKey(capture),start=capture.snapshot.evidence.game.startTime;
    if(kickoffs.has(key)&&kickoffs.get(key)!==epoch(start))quarantined.add(key);kickoffs.set(key,epoch(start));}
  const selected=new Set(selection.observations.map(row=>`${row.captureId}:${row.observationId}`));
  for (const row of selection.excluded) count(reasons,row.reason);
  const receipts=new Map();
  for(const item of evidence.checks||[]){
    if(!item.resultEvidence||!Number.isFinite(epoch(item.checkedAt))||epoch(item.checkedAt)>now)continue;
    const key=`${item.captureId}:${item.marketReturnEvidenceHash}`;
    if(!receipts.has(key))receipts.set(key,[]);receipts.get(key).push(item);
  }
  for(const values of receipts.values())values.sort((left,right)=>epoch(left.checkedAt)-epoch(right.checkedAt));
  const availability=row=>{
    const check=row.marketReturnValidation,calc=epoch(check?.checkedAt),first=receipts.get(`${row.captureId}:${check?.evidenceHash}`)?.[0];
    return Number.isFinite(calc)&&first?Math.max(calc,epoch(first.checkedAt)):Infinity;
  };
  const evaluations=(evidence.evaluations||[]).map(row=>row.status==='EVALUATED'?row:{...row,...row.marketReturnValidation})
    .filter(row=>captures.has(row?.captureId)).sort((left,right)=>
      availability(left)-availability(right)
      ||String(left.captureId).localeCompare(String(right.captureId))
      ||String(left.marketReturnValidation?.evidenceHash||'').localeCompare(String(right.marketReturnValidation?.evidenceHash||'')));
  for (const id of evidence.incompleteResultCaptureIds||[]) if(captures.has(id)) quarantined.add(gameKey(captures.get(id)));
  for (const row of evaluations) {
    const capture=captures.get(row.captureId);
    if (!['revision','modelHash','period','variant','league','gameId'].every(key=>row[key]===capture[key])
      || row.captureSequence!==String(capture.captureSequence)) { quarantined.add(gameKey(capture)); count(reasons,'RETURN_ERROR_RESULT_SCOPE_MISMATCH'); continue; }
    if (row.status==='EVALUATED') {
      const scope=resultScope(row),actual=soccerForwardHash([row.actualScore,row.actualOutcome]);
      if(byGameResult.has(scope)&&byGameResult.get(scope)!==actual)quarantined.add(gameKey(row));
      byGameResult.set(scope,actual);
    }
  }
  const first=new Map(), returnSignatures=new Map(),checked=new Set(),reasonIds=new Set();
  const observationReason=(reason,id)=>{const key=`${reason}:${id}`;if(!reasonIds.has(key)){reasonIds.add(key);count(reasons,reason);}};
  for (const evaluation of evaluations) {
    const capture=captures.get(evaluation.captureId),check=evaluation.marketReturnValidation;
    if (!check) continue;
    if (!checkSeal(check)) { quarantined.add(gameKey(capture));count(reasons,'RETURN_ERROR_CHECK_HASH_INVALID');continue; }
    for (const row of check.observations) {
      const identity=`${capture.captureId}:${row.observationId}`;
      if(selected.has(identity))checked.add(row.observationId);
      if(!returnObserved(row)){if(selected.has(identity))observationReason(row.reason||'RETURN_ERROR_NOT_OBSERVED',row.observationId);continue;}
      const signature=returnSignature(row);
      if(returnSignatures.has(row.observationId)&&returnSignatures.get(row.observationId)!==signature)quarantined.add(gameKey(capture));
      returnSignatures.set(row.observationId,signature);
      if(!selected.has(identity))continue;
      if(first.has(row.observationId))continue;
      const cutoff=epoch(capture.snapshot.analysisCutoff),checkedAt=epoch(check.checkedAt);
      if(!Number.isFinite(checkedAt)||checkedAt>now){observationReason('RETURN_ERROR_CHECK_TIME_INVALID',row.observationId);continue;}
      if(epoch(row.contractVerifiedAt)>cutoff||!Number.isFinite(epoch(row.contractVerifiedAt))){
        observationReason('RETURN_ERROR_TERMS_NOT_KNOWN_AT_PREDICTION',row.observationId);continue;
      }
      const fullCapture=yield capture.captureId;
      if(!fullCapture||fullCapture.captureId!==capture.captureId||fullCapture.revision!==capture.revision
        ||!validateSoccerForwardCapture(fullCapture,evidence.protocol,now).ok){observationReason('RETURN_ERROR_ORIGINAL_CAPTURE_UNAVAILABLE',row.observationId);continue;}
      const results=receipts.get(`${capture.captureId}:${check.evidenceHash}`)||[];
      const resultCheck=results.find(item=>item.resultEvidence.resultHash===row.resultHash
        &&evaluateSoccerForwardCapture(fullCapture,evidence.protocol,item.resultEvidence,Math.max(checkedAt,epoch(item.checkedAt))).status==='EVALUATED');
      if(!resultCheck){observationReason('RETURN_ERROR_ORIGINAL_RESULT_EVIDENCE_MISSING',row.observationId);continue;}
      const result=resultCheck.resultEvidence,availableAt=Math.max(checkedAt,epoch(resultCheck.checkedAt));
      const rechecked=evaluateSoccerMarketReturnCapture({capture:fullCapture,protocol:evidence.protocol,result,now:availableAt,resolveContract});
      const original=rechecked.observations.find(value=>value.observationId===row.observationId&&value.status===row.status);
      if(!original||!sameReturn(row,original)||!validObservedReturn(row)){observationReason('RETURN_ERROR_EXACT_RETURN_RECOMPUTE_FAILED',row.observationId);continue;}
      const valid=validateSoccerForwardCapture(fullCapture,evidence.protocol,now);
      if(!valid.ok){count(reasons,valid.reason);continue;}
      const value={observationId:row.observationId,captureId:capture.captureId,quoteKey:row.quoteKey,
        economicPriceHash:soccerForwardHash(row.economicPriceIdentity),league:row.league,gameId:row.gameId,period:row.period,
        variant:row.variant,modelHash:row.modelHash,contractHash:row.contractHash,kind:row.originalQuote.kind,side:row.originalQuote.side,
        kickoff:capture.snapshot.evidence.game.startTime,predictionCapturedAt:capture.capturedAt,analysisCutoff:capture.snapshot.analysisCutoff,
        resultAvailableAt:result.sources.map(source=>source.fetchedAt).sort().at(-1),checkedAt:new Date(availableAt).toISOString(),
        returnCalculatedAt:check.checkedAt,resultPersistedAt:resultCheck.checkedAt,
        predictedNetReturn:row.predictedNetReturn,realizedNetReturn:row.realizedNetReturn,predictionError:row.predictionError,actualScore:row.actualScore,
        ...(row.status==='OBSERVED_BOUNDED'?{status:row.status,predictedReturnBounds:{...row.predictedReturnBounds},
          predictionErrorBounds:{...row.predictionErrorBounds},tailMass:row.tailMass,resolvedTailMass:row.resolvedTailMass,
          unresolvedTailMass:row.unresolvedTailMass,boundInterpretation:row.boundInterpretation}:{}),
        sourceHashes:[capture.revision,row.distributionHash,row.contractHash,row.resultHash,...result.sources.map(source=>source.contentHash)],
        validation:'ORIGINAL_DATABASE_PREDICTION_PRICE_AND_RESULT_RECOMPUTED'};
      first.set(row.observationId,value);
    }
  }
  for(const value of first.values())if(quarantined.has(gameKey(value)))count(reasons,'RETURN_ERROR_GAME_RESULT_OR_TERMS_QUARANTINED');
    else (value.status==='OBSERVED_BOUNDED'?boundedObservations:observations).push(value);
  const order=(a,b)=>epoch(a.kickoff)-epoch(b.kickoff)||a.observationId.localeCompare(b.observationId);
  observations.sort(order);boundedObservations.sort(order);
  // A scanner supplies one privately validated complete game at a time. Its
  // final requested-scope completion is a separate fitter/report condition.
  const complete=evidence.truncated!==true&&(!evidence.readCoverage
    ||['COMPLETE_WITHIN_REQUESTED_SCOPE','COMPLETE_WITHIN_REQUESTED_GAME'].includes(evidence.readCoverage.status));
  if(!complete)count(reasons,'RETURN_ERROR_INCOMPLETE_REQUESTED_SCOPE');
  const selectedIds=selection.observations.map(row=>row.observationId);
  if(selectedIds.length>checked.size)count(reasons,'RETURN_ERROR_NOT_CHECKED',selectedIds.length-checked.size);
  return seal({version:SOCCER_RETURN_ERROR_VERSION,type:'VALIDATED_RETURN_ERROR_DATASET',...restrictions,
    status:observations.length?'RESEARCH_OBSERVATIONS_AVAILABLE':boundedObservations.length?'BOUNDED_OBSERVATIONS_AVAILABLE':'MISSING_OBSERVATIONS',observations,boundedObservations,
    selectedQuoteObservations:selection.observations.length,selectedObservationIds:selectedIds,checkedObservationIds:[...checked].sort(),
    checkedQuoteObservations:checked.size,duplicateEconomicObservations:selection.duplicateQuoteObservations,
    invalidOriginalQuoteObservations:selection.invalidQuoteObservations,observedQuoteReturns:observations.length,
    boundedQuoteReturns:boundedObservations.length,boundedGames:new Set(boundedObservations.map(gameKey)).size,
    observedGames:new Set(observations.map(gameKey)).size,quarantinedGames:quarantined.size,quarantinedGameKeys:[...quarantined].sort(),excludedReasons:reasons,
    coverage:{completeWithinRequestedScope:complete,readCoverage:evidence.readCoverage||null,
      incompleteResultHistories:(evidence.incompleteResultCaptureIds||[]).length},
    rawSourceHashRecomputed:false,strictHistoricalPit:false});
}

export function buildSoccerReturnErrorDataset(evidence={},options={}) {
  const full=new Map((evidence.captures||[]).map(capture=>[capture.captureId,capture]));
  const iterator=datasetPipeline(evidence,options);let step=iterator.next();
  while(!step.done)step=iterator.next(full.get(step.value));
  return step.value;
}
/** Scanner adapter: hydrate and retain at most one selected original capture,
 * rather than rebuilding every historical full distribution in memory. */
export async function buildSoccerReturnErrorDatasetHydrated(evidence={}, {hydrateCapture,...options}={}) {
  if(typeof hydrateCapture!=='function')throw Error('RETURN_ERROR_HYDRATOR_REQUIRED');
  const iterator=datasetPipeline(evidence,options);let step=iterator.next(),lastId=null,lastCapture=null;
  while(!step.done){
    if(step.value!==lastId){lastId=step.value;lastCapture=await hydrateCapture(lastId);}
    step=iterator.next(lastCapture);
  }
  return step.value;
}

/** Public report projection: counts only, never original quotes/account data. */
export function summarizeSoccerReturnErrorDatasets(datasets=[],{complete=true}={}) {
  const unique=[...new Map(datasets.map(value=>[value?.contentHash,value])).values()],selected=new Set(),checked=new Set(),games=new Set(),quarantined=new Set(),observed=new Map(),reasons={},scores=new Map();
  let invalidDatasets=0;
  for(const dataset of unique){
    if(!validSeal(dataset)||dataset.version!==SOCCER_RETURN_ERROR_VERSION||dataset.type!=='VALIDATED_RETURN_ERROR_DATASET'){invalidDatasets++;continue;}
    complete=complete&&dataset.coverage.completeWithinRequestedScope===true;
    for(const id of dataset.selectedObservationIds||[])selected.add(id);
    for(const id of dataset.checkedObservationIds||[])checked.add(id);
    for(const key of dataset.quarantinedGameKeys||[])quarantined.add(key);
    for(const [reason,n]of Object.entries(dataset.excludedReasons||{}))count(reasons,reason,n);
    for(const row of [...dataset.observations,...(dataset.boundedObservations||[])]){
      trackResultScore(row,scores,quarantined);
      const old=observed.get(row.observationId);
      if(old&&soccerForwardHash(stableReturnRow(old))!==soccerForwardHash(stableReturnRow(row)))quarantined.add(gameKey(row));
      if(!old||epoch(row.checkedAt)<epoch(old.checkedAt))observed.set(row.observationId,row);
    }
  }
  for(const [id,row]of observed)if(quarantined.has(gameKey(row)))observed.delete(id);
  const exact=[...observed.values()].filter(row=>row.status!=='OBSERVED_BOUNDED');
  const bounded=[...observed.values()].filter(row=>row.status==='OBSERVED_BOUNDED');
  for(const row of exact)games.add(gameKey(row));
  if(invalidDatasets){complete=false;count(reasons,'RETURN_ERROR_DATASET_HASH_INVALID',invalidDatasets);}
  return {version:SOCCER_RETURN_ERROR_VERSION,status:exact.length?'RESEARCH_OBSERVATIONS_AVAILABLE':bounded.length?'BOUNDED_OBSERVATIONS_AVAILABLE':'MISSING_OBSERVATIONS',
    selectedQuoteObservations:selected.size,checkedQuoteObservations:checked.size,uncheckedQuoteObservations:selected.size-checked.size,
    observedQuoteReturns:exact.length,observedGames:games.size,boundedQuoteReturns:bounded.length,
    boundedGames:new Set(bounded.map(gameKey)).size,quarantinedGames:quarantined.size,
    excludedReasons:reasons,completeWithinRequestedScope:complete,...restrictions,
    interpretation:SOCCER_RETURN_ERROR_CANDIDATE_PROTOCOL.interpretation};
}

// Scanner callers supply disjoint complete-game summaries; no quote rows need
// to survive between pages. This is a report merge, not a dataset or a fit.
export function mergeSoccerReturnErrorDiagnostics(summaries=[],{complete=true}={}) {
  const fields=['selectedQuoteObservations','checkedQuoteObservations','uncheckedQuoteObservations','observedQuoteReturns','observedGames','quarantinedGames'];
  const optional=['boundedQuoteReturns','boundedGames'];
  const total=Object.fromEntries([...fields,...optional].map(field=>[field,0])),reasons={};
  for(const row of summaries){
    if(row?.version!==SOCCER_RETURN_ERROR_VERSION||fields.some(field=>!Number.isSafeInteger(row[field])||row[field]<0)
      ||optional.some(field=>row[field]!==undefined&&(!Number.isSafeInteger(row[field])||row[field]<0))
      ||row.checkedQuoteObservations>row.selectedQuoteObservations
      ||row.observedQuoteReturns+(row.boundedQuoteReturns||0)>row.checkedQuoteObservations
      ||(row.boundedGames||0)>(row.boundedQuoteReturns||0)){
      complete=false;count(reasons,'RETURN_ERROR_DIAGNOSTIC_SUMMARY_INVALID');continue;
    }
    for(const field of [...fields,...optional])total[field]+=row[field]||0;
    for(const [reason,n]of Object.entries(row.excludedReasons||{}))if(Number.isSafeInteger(n)&&n>=0)count(reasons,reason,n);
    complete=complete&&row.completeWithinRequestedScope===true;
  }
  return{version:SOCCER_RETURN_ERROR_VERSION,status:total.observedQuoteReturns?'RESEARCH_OBSERVATIONS_AVAILABLE':total.boundedQuoteReturns?'BOUNDED_OBSERVATIONS_AVAILABLE':'MISSING_OBSERVATIONS',
    ...total,excludedReasons:reasons,completeWithinRequestedScope:complete,...restrictions,
    interpretation:SOCCER_RETURN_ERROR_CANDIDATE_PROTOCOL.interpretation};
}

const average = values => values.reduce((sum,value)=>sum+value,0)/values.length;
function gamesFor(rows) {
  const games=new Map();for(const row of rows){const key=gameKey(row);if(!games.has(key))games.set(key,[]);games.get(key).push(row);}return[...games.values()];
}
function metrics(rows,bias,radius) {
  if(!rows.length)return{games:0,quotes:0,meanError:null,mae:null,rmse:null,allQuotesGameCoverage:null};
  if(!finite(bias))return{games:gamesFor(rows).length,quotes:rows.length,meanError:null,mae:null,rmse:null,allQuotesGameCoverage:null};
  const games=gamesFor(rows),errors=games.map(game=>game.map(row=>row.realizedNetReturn-(row.predictedNetReturn+bias)));
  return{games:games.length,quotes:rows.length,meanError:average(errors.map(values=>average(values))),
    mae:average(errors.map(values=>average(values.map(Math.abs)))),rmse:Math.sqrt(average(errors.map(values=>average(values.map(value=>value**2))))),
    allQuotesGameCoverage:finite(radius)?average(errors.map(values=>Number(values.every(value=>Math.abs(value)<=radius)))):null};
}

/** No automatic dates/split optimization. Candidate boundaries are deliberately
 * unset until reviewed. The fitting algorithm never uses test outcomes. An
 * external durable pre-test model receipt is required to prove an untouched test. */
export function fitSoccerReturnErrorResearch({evidence,datasets,protocol=SOCCER_RETURN_ERROR_CANDIDATE_PROTOCOL,now=Date.now(),
  resolveContract=soccerVerifiedSettlementContract,verifyFrozenModelReceipt=null,requestedScopeComplete=true}={}) {
  const inputs=datasets||[buildSoccerReturnErrorDataset(evidence||{},{now,resolveContract})],reasons={},byId=new Map(),badGames=new Set(),scores=new Map();
  let complete=requestedScopeComplete===true;
  for(const dataset of inputs){
    if(!validSeal(dataset)||dataset.type!=='VALIDATED_RETURN_ERROR_DATASET'||dataset.version!==SOCCER_RETURN_ERROR_VERSION){count(reasons,'RETURN_ERROR_DATASET_HASH_INVALID');complete=false;continue;}
    if(dataset.coverage.completeWithinRequestedScope!==true)complete=false;
    for(const key of dataset.quarantinedGameKeys||[])badGames.add(key);
    for(const [reason,n]of Object.entries(dataset.excludedReasons))count(reasons,reason,n);
    for(const row of [...dataset.observations,...(dataset.boundedObservations||[])]){
      trackResultScore(row,scores,badGames);
      const old=byId.get(row.observationId);
      if(old&&soccerForwardHash(stableReturnRow(old))!==soccerForwardHash(stableReturnRow(row)))badGames.add(gameKey(row));
      else if(!old||epoch(row.checkedAt)<epoch(old.checkedAt))byId.set(row.observationId,row);
    }
  }
  const kickoffs=new Map();
  for(const row of byId.values()){const key=gameKey(row);if(kickoffs.has(key)&&kickoffs.get(key)!==epoch(row.kickoff))badGames.add(key);kickoffs.set(key,epoch(row.kickoff));}
  const eligibleRows=[...byId.values()].filter(row=>!badGames.has(gameKey(row))&&epoch(row.checkedAt)<=now);
  // Tail bounds are source observations, never point errors. Do not convert a
  // narrow interval (or its midpoint) into an empirical fit or formal R.
  const rows=eligibleRows.filter(row=>row.status!=='OBSERVED_BOUNDED');
  const boundedRows=eligibleRows.filter(row=>row.status==='OBSERVED_BOUNDED');
  if(boundedRows.length)count(reasons,'RETURN_ERROR_INTERVAL_OBSERVATIONS_NOT_POINT_FIT',boundedRows.length);
  const dates=['trainingBefore','calibrationBefore','testBefore'].map(key=>epoch(protocol?.[key]));
  const protocolValid=protocol?.version===SOCCER_RETURN_ERROR_VERSION&&protocol.method===SOCCER_RETURN_ERROR_CANDIDATE_PROTOCOL.method
    &&protocol.grouping===SOCCER_RETURN_ERROR_CANDIDATE_PROTOCOL.grouping&&protocol.splitUnit==='WHOLE_REAL_GAME_BY_KICKOFF'
    &&dates.every(Number.isFinite)&&dates[0]<dates[1]&&dates[1]<dates[2]
    &&finite(protocol.miscoverage)&&protocol.miscoverage>0&&protocol.miscoverage<1;
  if(!protocolValid)count(reasons,'RETURN_ERROR_SPLIT_PROTOCOL_NOT_SPECIFIED');
  if(!rows.length)count(reasons,'RETURN_ERROR_OBSERVED_NET_RETURNS_MISSING');
  if(!complete)count(reasons,'RETURN_ERROR_INCOMPLETE_REQUESTED_SCOPE');
  const grouped=new Map(),groups=[];
  if(protocolValid&&complete)for(const row of rows){
    const key=soccerForwardHash([row.league,row.period,row.variant,row.modelHash,row.contractHash,row.kind,row.side]);
    if(!grouped.has(key))grouped.set(key,[]);grouped.get(key).push(row);
  }
  for(const [groupHash,values]of grouped){
    const train=values.filter(row=>epoch(row.kickoff)<dates[0]&&epoch(row.checkedAt)<dates[0]);
    const calibration=values.filter(row=>epoch(row.kickoff)>=dates[0]&&epoch(row.kickoff)<dates[1]&&epoch(row.checkedAt)<dates[1]);
    const test=values.filter(row=>epoch(row.kickoff)>=dates[1]&&epoch(row.kickoff)<dates[2]);
    const excludedDelayed=values.length-train.length-calibration.length-test.length;
    const bias=train.length?average(gamesFor(train).map(game=>average(game.map(row=>row.predictionError)))):null;
    const residuals=finite(bias)?gamesFor(calibration).map(game=>Math.max(...game.map(row=>Math.abs(row.predictionError-bias)))).sort((a,b)=>a-b):[];
    const rank=Math.ceil((residuals.length+1)*(1-protocol.miscoverage));
    const radius=rank>=1&&rank<=residuals.length?residuals[rank-1]:null;
    const missing=[];if(!train.length)missing.push('TRAINING_GAMES_MISSING');if(!finite(radius))missing.push('CALIBRATION_ORDER_STATISTIC_UNSUPPORTED');
    const fitBody={groupHash,biasCorrection:bias,realizedReturnBandRadius:radius,calibrationRank:rank,calibrationGames:residuals.length,
      trainingObservationHashes:train.map(soccerForwardHash).sort(),calibrationObservationHashes:calibration.map(soccerForwardHash).sort(),
      protocolHash:soccerForwardHash(protocol)};
    const parameterHash=soccerForwardHash(fitBody),firstTestAt=test.length?Math.min(...test.map(row=>epoch(row.predictionCapturedAt))):dates[1];
    // A Boolean field in an HTTP/JSON input cannot establish a DB receipt.
    const declaredBeforeTest=Number.isFinite(epoch(protocol.registeredAt))&&epoch(protocol.registeredAt)<=dates[0];
    const untouched=declaredBeforeTest&&typeof verifyFrozenModelReceipt==='function'&&verifyFrozenModelReceipt({parameterHash,protocolHash:fitBody.protocolHash,
      calibrationBefore:protocol.calibrationBefore,before:new Date(firstTestAt).toISOString()})===true;
    if(!untouched)missing.push('DURABLE_PRETEST_MODEL_RECEIPT_MISSING');
    const example=values[0];
    groups.push({...fitBody,parameterHash,scope:Object.fromEntries(['league','period','variant','modelHash','contractHash','kind','side'].map(key=>[key,example[key]])),
      status:missing.length?'INCOMPLETE_RESEARCH_MODEL':'RESEARCH_MODEL_NOT_ACCEPTED',missing,
      train:metrics(train,bias,null),calibration:metrics(calibration,bias,radius),
      test:metrics(test,bias,radius),testUntouchedVerified:untouched,
      testWindowComplete:now>=dates[2],
      testInterpretation:untouched?'CHRONOLOGICAL_FROZEN_MODEL_RESEARCH_TEST':'DESCRIPTIVE_HOLDOUT_NOT_PROVEN_UNTOUCHED',
      delayedOrOutsideSplitObservations:excludedDelayed,...restrictions});
  }
  const available=groups.some(group=>finite(group.biasCorrection)&&finite(group.realizedReturnBandRadius));
  return seal({version:SOCCER_RETURN_ERROR_VERSION,type:'RETURN_ERROR_RESEARCH_ARTIFACT',status:available?'NOT_ACCEPTED_RESEARCH_FIT':'NOT_ACCEPTED_MISSING_DATA',
    ...restrictions,protocol,protocolHash:soccerForwardHash(protocol),generatedAt:Number.isFinite(now)?new Date(now).toISOString():null,
    datasetHashes:inputs.filter(validSeal).map(value=>value.contentHash).sort(),observedQuoteReturns:rows.length,observedGames:new Set(rows.map(gameKey)).size,
    boundedQuoteReturns:boundedRows.length,boundedGames:new Set(boundedRows.map(gameKey)).size,quarantinedGames:badGames.size,
    groups,missingReasons:reasons,requestedScopeComplete:complete,
    interpretation:SOCCER_RETURN_ERROR_CANDIDATE_PROTOCOL.interpretation,
    limitations:['Game blocks retain correlated prices/directions without counting them as independent games.',
      'Different games may remain dependent over time; no exchangeability or nominal coverage guarantee is asserted.',
      'Realized single-game return error includes outcome noise and cannot substitute for uncertainty of conditional expected return or formal R.',
      'Candidate protocol, stored hashes and retrospective holdout metrics are not model acceptance or proof of an untouched test.']});
}
