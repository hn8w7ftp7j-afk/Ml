import { randomUUID } from 'node:crypto';
import { soccerLeague,validSoccerDate } from './contracts.js';
import { soccerJournalQuery,soccerJournalTransaction,soccerJournalHash } from './journal.js';
import { loadSoccerReaderSnapshot } from './reader-store.js';
import { matchSoccerReaderGames, soccerReaderScheduleCandidates, soccerReaderGameHasFreshGoalMarket } from './reader.js';
import { buildSoccerMarketDirections } from './market-directions.js';
import { adaptSoccerReaderQuote } from './soccer-scoring.js';
import { fetchSoccerSchedule } from './data.js';
import { analyzeSoccerGame } from './analysis-service.js';
import { soccerResearchArtifacts } from './research-frozen.js';
import { soccerHalfTimeArtifacts } from './half-time-frozen.js';
import { soccerMarketEconomicPriceIdentity } from './market-return-validation.js';
import { soccerCalibrationShadowArtifacts } from './calibration-frozen.js';
import { SOCCER_ANALYSIS_VERSION } from './analysis.js';
import { SOCCER_ACCOUNT_RULE_CONFIRMATION as accountPolicy, soccerAccountRulesKnown } from './account-rule-policy.js';
import { soccerReaderIdentityVerified } from './reader-identity-proof.js';

export const SOCCER_READER_AUTO_VERSION='SOCCER-READER-PREGAME-CAPTURE-v1';
export const SOCCER_READER_AUTO_SCHEMA=[
  `CREATE TABLE IF NOT EXISTS sports_soccer_reader_analysis_queue_v1 (
    league text NOT NULL,board_date date NOT NULL,generation bigint NOT NULL DEFAULT 1,
    requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),lease_token text,lease_until timestamptz,
    retry_at timestamptz NOT NULL DEFAULT clock_timestamp(),last_reason text,
    PRIMARY KEY(league,board_date),CHECK(league IN ('epl','ucl')))`,
  `CREATE TABLE IF NOT EXISTS sports_soccer_reader_analysis_claims_v1 (
    identity text PRIMARY KEY,league text NOT NULL,board_date date NOT NULL,game_id text NOT NULL,
    model_hash text NOT NULL,price_hash text NOT NULL,state text NOT NULL,attempt_token text NOT NULL,
    lease_until timestamptz NOT NULL,attempts integer NOT NULL DEFAULT 1,analysis_revision text,
    receipt jsonb,last_reason text,updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK(state IN ('RUNNING','RETRYABLE','CAPTURED')))`
];
let schemaReady;
async function schema(query){
  if(query!==soccerJournalQuery){for(const sql of SOCCER_READER_AUTO_SCHEMA)await query(sql,[]);return;}
  return schemaReady||=(soccerJournalTransaction([
    ['SELECT pg_advisory_xact_lock(221019,2259)'],...SOCCER_READER_AUTO_SCHEMA.map(sql=>[sql,[]])
  ]).catch(error=>{schemaReady=null;throw error;}));
}
const scope=(league,date)=>{const id=soccerLeague(league)?.id;if(!id||!validSoccerDate(date))throw Error('SOCCER_AUTO_SCOPE_INVALID');return id;};
export const soccerReaderEconomicPriceSet=(quotes,capture)=>[...new Set(quotes.map(quote=>JSON.stringify(soccerMarketEconomicPriceIdentity(capture,quote))))].sort();
// Receipt timestamps are not new prices, but a source observation first made
// after confirmed terms becomes a distinct prospective settlement scope.
export const soccerReaderCapturePolicyScope=(quotes,capture)=>({policy:accountPolicy,
  applicability:[...new Set(quotes.map(quote=>JSON.stringify({price:soccerMarketEconomicPriceIdentity(capture,quote),
    termsKnownAtObservation:soccerAccountRulesKnown(quote.provenance?.observedAt)})))].sort()});
const modelHash=(league,shadow)=>soccerJournalHash({version:SOCCER_READER_AUTO_VERSION,analysisVersion:SOCCER_ANALYSIS_VERSION,
  FT:soccerResearchArtifacts().leagues[league].liveModel,HT:soccerHalfTimeArtifacts().leagues[league].liveModel,
  calibration:{candidateHash:shadow.candidate.contentHash,planHash:shadow.plan.contentHash,
    modelHash:shadow.candidate.modelHash,halfTimeModelHash:shadow.candidate.halfTimeModelHash}});

// Only scope is queued. Browser-supplied game identities, prices and times never
// become analysis inputs. Reader save remains successful if this separate queue fails.
export async function enqueueSoccerReaderAnalysis(league,date,{query=soccerJournalQuery}={}){
  const id=scope(league,date);await schema(query);
  const rows=await query(`INSERT INTO sports_soccer_reader_analysis_queue_v1(league,board_date) VALUES($1,$2::date)
    ON CONFLICT(league,board_date) DO UPDATE SET generation=sports_soccer_reader_analysis_queue_v1.generation+1,
    requested_at=clock_timestamp(),retry_at=clock_timestamp() RETURNING generation`,[id,date]);
  if(rows.length!==1)throw Error('SOCCER_AUTO_QUEUE_RECEIPT_MISSING');
  return{status:'QUEUED',durable:true,version:SOCCER_READER_AUTO_VERSION,executable:false};
}

export function soccerReaderAnalysisCandidates(reader,board,{league,date,now=Date.now()}={}){
  scope(league,date);
  if(!board?.ok||soccerLeague(reader?.league)?.id!==league||reader?.boardDate!==date)return[];
  // Consider *all* same-day provider candidates for ambiguity. A competing
  // finished/postponed event must not disappear merely because it cannot run.
  const candidates=(board.games||[]).filter(game=>game?.league===league&&game.date===date);
  const games=candidates.filter(game=>game.status==='scheduled'
    &&game.id===`soccer:${league}:${game.sourceId}`&&Date.parse(game.startTime)>now);
  const matched=matchSoccerReaderGames(reader,candidates,now),shadow=soccerCalibrationShadowArtifacts(league),model=modelHash(league,shadow);
  return games.flatMap(game=>{
    // Use the same board-scope admission as the analysis builder, otherwise a
    // partial response creates a claim that can never yield a research receipt.
    if(!soccerReaderScheduleCandidates(board,game,{requireVerified:false}))return [];
    const quotes=buildSoccerMarketDirections({reader,game,matchedGames:matched,now}).flatMap(direction=>direction.quotes)
      .filter(quote=>adaptSoccerReaderQuote({quote,game,now}).ok);
    if(!quotes.length)return[];
    const priceScope={league,gameId:game.id,snapshot:{inputVersions:{readerSourceObservations:reader.sourceObservations||[]}}};
    const economicPrices=soccerReaderEconomicPriceSet(quotes,priceScope),priceHash=soccerJournalHash(economicPrices);
    const policyScope=soccerReaderCapturePolicyScope(quotes,priceScope),policyHash=soccerJournalHash(policyScope);
    // A later independently verified board must not be suppressed by an old
    // provisional receipt for the same price. Each identity scope has its own
    // durable claim; a change mid-run cannot complete the old scope.
    const identityStatus=soccerReaderScheduleCandidates(board,game)?'VERIFIED_SCHEDULE_IDENTITY':'PROVISIONAL_SCHEDULE_IDENTITY_UNVERIFIED';
    const identity=soccerJournalHash({league,date,gameId:game.id,startTime:game.startTime,
      home:game.home.sourceId,away:game.away.sourceId,modelHash:model,priceHash,policyHash,identityStatus});
    const shadowRequired=now>=Date.parse(shadow.candidate.createdAt)&&Date.parse(game.startTime)>Date.parse(shadow.plan.beginsStrictlyAfter)
      &&!shadow.plan.usedGamesExcluded.includes(`${league}:${game.sourceId}`);
    return[{identity,identityStatus,league,date,game,modelHash:model,priceHash,policyHash,economicPrices,shadow:{required:shadowRequired,
      candidateHash:shadow.candidate.contentHash,planHash:shadow.plan.contentHash,beginsStrictlyAfter:shadow.plan.beginsStrictlyAfter}}];
  });
}

async function claimCandidate(candidate,query){
  const token=randomUUID();
  const rows=await query(`INSERT INTO sports_soccer_reader_analysis_claims_v1
    (identity,league,board_date,game_id,model_hash,price_hash,state,attempt_token,lease_until)
    VALUES($1,$2,$3::date,$4,$5,$6,'RUNNING',$7,clock_timestamp()+interval '120 seconds')
    ON CONFLICT(identity) DO UPDATE SET state='RUNNING',attempt_token=EXCLUDED.attempt_token,
    lease_until=EXCLUDED.lease_until,attempts=sports_soccer_reader_analysis_claims_v1.attempts+1,updated_at=clock_timestamp()
    WHERE sports_soccer_reader_analysis_claims_v1.state<>'CAPTURED'
      AND sports_soccer_reader_analysis_claims_v1.lease_until<=clock_timestamp() RETURNING identity`,
  [candidate.identity,candidate.league,candidate.date,candidate.game.id,candidate.modelHash,candidate.priceHash,token]);
  if(rows.length)return{token};
  const existing=await query('SELECT state FROM sports_soccer_reader_analysis_claims_v1 WHERE identity=$1',[candidate.identity]);
  return{token:null,captured:existing[0]?.state==='CAPTURED'};
}

function captureReceipt(response,candidate,now){
  const p=response?.payload,g=p?.evidence?.game,receipt=p?.forwardCapture;
  if(response?.status!==200||p?.ok!==true||p.persisted!==true||p.journalPersisted!==true||receipt?.persisted!==true
    ||p.analysisStatus!=='COMPLETED'||p.executable!==false
    ||g?.id!==candidate.game.id||g.league!==candidate.league||g.date!==candidate.date||g.startTime!==candidate.game.startTime
    ||g.status!=='scheduled'||Date.parse(g.startTime)<=now||p.status!=='RESEARCH_ONLY'
    ||!['home','away'].every(side=>g[side]?.sourceId===candidate.game[side].sourceId)
    ||!/^[a-f0-9]{64}$/.test(p.revision||''))return null;
  const original=(p.directions||[]).flatMap(direction=>direction.quotes||[]);
  const research=p.provisionalReaderResearch;
  const provisional=research?.status==='UNVERIFIED_SCHEDULE_SCOPE'&&research.league===g.league&&research.gameId===g.id
    &&research.date===g.date&&research.identityScope==='UNIQUE_AMONG_FETCHED_SCHEDULE_ONLY'
    &&p.readerEvidence?.status==='NO_MATCHED_QUOTE'&&Array.isArray(p.readerEvidence.games)&&p.readerEvidence.games.length===0
    &&research.scheduleCompletenessVerified===false&&research.formalEligible===false&&research.calibrationEligible===false
    &&research.promotionEligible===false&&research.executable===false&&research.W===null&&research.R===null&&research.S===null
    &&Array.isArray(research.quotes)&&research.quotes.length>0
    &&research.quotes.every(quote=>quote?.formalEligible===false&&quote.eligible===false&&quote.executable===false
      &&quote.W===null&&quote.R===null&&quote.S===null);
  // Acknowledging a saved research capture is not promotion of the quote.
  // Verified directions require their own complete-board authority; in its
  // absence only the explicitly isolated provisional field may acknowledge.
  const identityStatus=original.length&&soccerReaderIdentityVerified(p)?'VERIFIED_SCHEDULE_IDENTITY'
    :original.length===0&&provisional?'PROVISIONAL_SCHEDULE_IDENTITY_UNVERIFIED':null;
  if(!identityStatus||identityStatus!==candidate.identityStatus)return null;
  const quotes=(identityStatus==='VERIFIED_SCHEDULE_IDENTITY'?original:research.quotes)
    .filter(quote=>adaptSoccerReaderQuote({quote,game:g,now}).ok);
  const priceScope={league:candidate.league,gameId:g.id,snapshot:p};
  if(soccerJournalHash(soccerReaderEconomicPriceSet(quotes,priceScope))!==candidate.priceHash
    ||soccerJournalHash(soccerReaderCapturePolicyScope(quotes,priceScope))!==candidate.policyHash)return null;
  const expectedPeriods=new Set(quotes.map(quote=>quote.period==='FT'?'REGULATION_FT':'REGULATION_HT'));
  if(expectedPeriods.has('REGULATION_FT')&&p.prediction?.trainingHash!==soccerResearchArtifacts().leagues[candidate.league].liveModel.trainingHash
    ||expectedPeriods.has('REGULATION_HT')&&p.halfTimePrediction?.trainingHash!==soccerHalfTimeArtifacts().leagues[candidate.league].liveModel.trainingHash)return null;
  const captures=(receipt.captures||[]).filter(item=>item.variant==='BASELINE'&&expectedPeriods.has(item.period));
  if(captures.length!==expectedPeriods.size||new Set(captures.map(item=>item.period)).size!==expectedPeriods.size
    ||captures.some(item=>!/^[a-f0-9]{64}$/.test(item.captureId||'')||!/^[1-9]\d*$/.test(item.captureSequence||'')
      ||!Number.isFinite(Date.parse(item.capturedAt))||Date.parse(item.capturedAt)>=Date.parse(g.startTime)
      ||Date.parse(item.capturedAt)>now))return null;
  let calibrationShadow={status:'NOT_IN_CURRENT_VALIDATION_SCOPE'};
  if(candidate.shadow.required){
    const shadow=p.calibrationShadowCapture,freeze=shadow?.freeze,capture=shadow?.capture;
    if(shadow?.persisted!==true||shadow.status!=='SHADOW_PREDICTION_SAVED'||shadow.fullTimeCaptured!==true||shadow.halfTimeCaptured!==true
      ||freeze?.status!=='DATABASE_FROZEN'||freeze.league!==candidate.league||freeze.candidateHash!==candidate.shadow.candidateHash
      ||freeze.planHash!==candidate.shadow.planHash||!/^[a-f0-9]{64}$/.test(freeze.freezeId||'')
      ||capture?.status!=='DATABASE_PREGAME_CAPTURED'||capture.freezeId!==freeze.freezeId||capture.gameId!==g.id||capture.league!==g.league
      ||!['captureId','analysisRevision','sourceReceiptId','predictionHash'].every(key=>/^[a-f0-9]{64}$/.test(capture[key]||''))
      ||!/^[1-9]\d*$/.test(capture.captureSequence||'')||!(Date.parse(capture.capturedAt)>Date.parse(freeze.frozenAt))
      ||!(Date.parse(capture.capturedAt)>Date.parse(candidate.shadow.beginsStrictlyAfter))
      ||!(Date.parse(capture.capturedAt)<Date.parse(g.startTime))||!(Date.parse(capture.capturedAt)<=now))return null;
    // The existing shadow store preserves the first prediction for this game;
    // its original revision may correctly precede this price's baseline save.
    calibrationShadow={status:shadow.status,freezeId:freeze.freezeId,candidateHash:freeze.candidateHash,planHash:freeze.planHash,capture};
  }
  return{revision:p.revision,captures,calibrationShadow,identityStatus,policyVersion:accountPolicy.version,policyHash:candidate.policyHash,
    executable:false,formalScoringEnabled:false};
}

// Read durable scheduling state, rather than guessing from a zero-work batch:
// another worker may still own the scope lease or a retry may not yet be due.
async function readContinuation(league,date,query){
  if(league===null)return{needed:false,reason:'UNSCOPED_MAINTENANCE',delayMs:0};
  const rows=await query(`WITH observation AS MATERIALIZED (SELECT clock_timestamp() AS at)
    SELECT q.generation::text,q.last_reason,q.retry_at='infinity'::timestamptz AS dormant,
      q.lease_until>observation.at AS leased,
      CASE WHEN q.retry_at='infinity'::timestamptz THEN 0 ELSE
        GREATEST(0,ceil(extract(epoch FROM (GREATEST(q.retry_at,q.lease_until)-observation.at))*1000))::bigint END AS delay_ms
    FROM sports_soccer_reader_analysis_queue_v1 q CROSS JOIN observation
    WHERE q.league=$1 AND q.board_date=$2::date`,[league,date]);
  if(!rows.length)return{needed:false,reason:'SCOPE_COMPLETE',delayMs:0};
  if(rows.length!==1||!/^[1-9]\d*$/.test(String(rows[0].generation))||typeof rows[0].dormant!=='boolean')throw Error('SOCCER_AUTO_CONTINUATION_READ_INVALID');
  const row=rows[0],delayMs=Number(row.delay_ms);
  if(!Number.isSafeInteger(delayMs)||delayMs<0)throw Error('SOCCER_AUTO_CONTINUATION_READ_INVALID');
  return{needed:!row.dormant,reason:row.dormant?'NO_FRESH_ELIGIBLE_QUOTES':row.leased?'SCOPE_LEASE_HELD':row.last_reason||'QUEUED',
    delayMs,generation:String(row.generation),league,date};
}

// Durable workflows, after() fallback and maintenance share this recoverable drain.
// Lease tokens fence late workers. Completion only acknowledges real immutable
// analysis and forward-capture DB receipts, never a synthetic success flag.
export async function drainSoccerReaderAnalysis({query=soccerJournalQuery,now=Date.now,loadReader=loadSoccerReaderSnapshot,
  schedule=fetchSoccerSchedule,analyze=analyzeSoccerGame,timeBudgetMs=40000,maxGames=4,league=null,date=null}={}){
  if(!Number.isFinite(timeBudgetMs)||timeBudgetMs<=0||timeBudgetMs>45000||!Number.isInteger(maxGames)||maxGames<1||maxGames>6)throw Error('SOCCER_AUTO_BUDGET_INVALID');
  const requestedLeague=league===null&&date===null?null:scope(league,date);
  await schema(query);const deadline=now()+timeBudgetMs,summary={checked:0,captured:0,duplicate:0,retryable:0,deferred:0,executable:false};
  const token=randomUUID();
  const jobs=await query(`WITH candidate AS (
    SELECT league,board_date FROM sports_soccer_reader_analysis_queue_v1
    WHERE retry_at<=clock_timestamp() AND (lease_until IS NULL OR lease_until<=clock_timestamp())
      AND ($2::text IS NULL OR (league=$2 AND board_date=$3::date))
    ORDER BY requested_at LIMIT 1 FOR UPDATE SKIP LOCKED)
    UPDATE sports_soccer_reader_analysis_queue_v1 q SET lease_token=$1,lease_until=clock_timestamp()+interval '120 seconds'
    FROM candidate c WHERE q.league=c.league AND q.board_date=c.board_date
    RETURNING q.league,q.board_date::text,q.generation`,[token,requestedLeague,date]);
  if(!jobs.length)return{...summary,continuation:await readContinuation(requestedLeague,date,query)};
  const job=jobs[0];let retry=false,reason=null,retryDelayMs=20000;
  try{
    const [reader,board]=await Promise.all([loadReader(job.league,job.board_date),
      Promise.resolve().then(()=>schedule(job.league,job.board_date)).catch(()=>null)]);
    // Retrying cannot capture an expired/missing Reader price. Go dormant
    // until a fresh upload, even if the schedule also remains unavailable.
    if(!reader?.games?.some(game=>soccerReaderGameHasFreshGoalMarket(game,reader,now())))throw Error('NO_FRESH_ELIGIBLE_QUOTES');
    if(!board?.ok)throw Error('SCHEDULE_UNAVAILABLE');
    // A partial/malformed board is transient input failure, not evidence of no
    // prices. Retry while prices are fresh, without needing another upload.
    if(board.coverage?.complete!==true||board.league?.id!==job.league
      ||board.date!==job.board_date||board.until!==job.board_date||!Array.isArray(board.games)
      ||board.games.some(game=>!soccerReaderScheduleCandidates(board,game,{requireVerified:false})))throw Error('SCHEDULE_INCOMPLETE');
    const candidates=soccerReaderAnalysisCandidates(reader,board,{league:job.league,date:job.board_date,now:now()});
    if(!candidates.length){summary.deferred++;reason='NO_FRESH_ELIGIBLE_QUOTES';}
    for(const candidate of candidates){
      if(now()>=deadline||summary.checked>=maxGames){retry=true;reason=reason||'BATCH_LIMIT_REACHED';retryDelayMs=summary.retryable?20000:0;break;}
      const claim=await claimCandidate(candidate,query);
      if(!claim.token){if(claim.captured)summary.duplicate++;else{retry=true;reason=reason||'CAPTURE_LEASE_HELD';}continue;}
      summary.checked++;let receipt=null;
      try{
        // Re-read actual server inputs in the normal service. If prices or the
        // official game change during the run, the old claim cannot be completed.
        const result=await analyze({league:candidate.league,date:candidate.date,eventId:candidate.game.sourceId},
          {fetchSoccerSchedule:async(league,date)=>{
            const current=await schedule(league,date),g=current?.games?.find(g=>g.id===candidate.game.id);
            return g?.status==='scheduled'&&g.startTime===candidate.game.startTime&&Date.parse(g.startTime)>now()
              ?current:{ok:false,games:[],code:'SOCCER_AUTO_GAME_NO_LONGER_PREGAME'};
          }});
        receipt=captureReceipt(result,candidate,now());
      }catch{}
      const updated=await query(`UPDATE sports_soccer_reader_analysis_claims_v1 SET state=$3,analysis_revision=$4,receipt=$5::jsonb,
        last_reason=$6,lease_until=clock_timestamp()+interval '20 seconds',updated_at=clock_timestamp()
        WHERE identity=$1 AND attempt_token=$2 AND state='RUNNING' AND lease_until>clock_timestamp() RETURNING identity`,
      [candidate.identity,claim.token,receipt?'CAPTURED':'RETRYABLE',receipt?.revision??null,JSON.stringify(receipt),receipt?null:'PREGAME_CAPTURE_NOT_CONFIRMED']);
      if(receipt&&updated.length)summary.captured++;else{summary.retryable++;retry=true;reason='PREGAME_CAPTURE_NOT_CONFIRMED';}
    }
  }catch(error){
    if(error?.message==='NO_FRESH_ELIGIBLE_QUOTES'){reason='NO_FRESH_ELIGIBLE_QUOTES';summary.deferred++;}
    else{retry=true;reason=error?.message==='SCHEDULE_INCOMPLETE'?'SCHEDULE_INCOMPLETE':'SERVER_INPUT_OR_STORAGE_UNAVAILABLE';summary.retryable++;}
  }
  if(!retry&&!summary.deferred)await query(`DELETE FROM sports_soccer_reader_analysis_queue_v1
    WHERE league=$1 AND board_date=$2::date AND generation=$3 AND lease_token=$4`,[job.league,job.board_date,job.generation,token]);
  const remaining=await query(`UPDATE sports_soccer_reader_analysis_queue_v1 SET lease_token=NULL,lease_until=NULL,
    retry_at=CASE WHEN generation<>$5 THEN clock_timestamp() WHEN $4='NO_FRESH_ELIGIBLE_QUOTES' THEN 'infinity'::timestamptz
      ELSE clock_timestamp()+$6*interval '1 millisecond' END,last_reason=$4
    WHERE league=$1 AND board_date=$2::date AND lease_token=$3 RETURNING generation`,[job.league,job.board_date,token,reason,job.generation,retryDelayMs]);
  // A fresh upload that arrived under this lease is not lost. Re-read that
  // generation within the same original time/game budget when time remains.
  if(remaining.length&&String(remaining[0].generation)!==String(job.generation)&&now()<deadline&&summary.checked<maxGames){
    const next=await drainSoccerReaderAnalysis({query,now,loadReader,schedule,analyze,timeBudgetMs:deadline-now(),
      maxGames:maxGames-summary.checked,league:job.league,date:job.board_date});
    for(const key of ['checked','captured','duplicate','retryable','deferred'])summary[key]+=next[key];
  }
  return{...summary,continuation:await readContinuation(requestedLeague||job.league,job.board_date,query)};
}
