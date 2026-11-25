import { neon } from '@neondatabase/serverless';
import { durableDatabaseConfigured,durableDatabaseUrl } from '../database-url.js';
import { soccerAnalysisHash,SOCCER_ANALYSIS_VERSION } from './analysis.js';
import { soccerLeague,validSoccerDate } from './contracts.js';
import { ensureSoccerJournal } from './journal.js';
import { soccerPredictionScorePresentation } from './score-presentation.js';
import { publishSoccerAnalysisCandidates } from './candidate-publication.js';
import { restoreSoccerCurrentSourceAvailability } from './source-document-store.js';
import { restoreSoccerPrematchInputAvailability } from './prematch-inputs.js';
let client;
function sql(){if(!durableDatabaseConfigured())throw Object.assign(Error('SOCCER_ANALYSIS_STORAGE_UNAVAILABLE'),{status:503});return client||=neon(durableDatabaseUrl());}
async function schema(){return ensureSoccerJournal();}
// JSONB object key order is not stable; hash a canonical serialization on both sides.
function canonical(value){return JSON.stringify(value,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);}
const storageHash=value=>soccerAnalysisHash(canonical(value));
export async function listSoccerAnalysis(leagueValue,gameId,date,{limit=5}={}){
  const league=soccerLeague(leagueValue)?.id;
  if(!league||!new RegExp(`^soccer:${league}:\\d{1,16}$`).test(gameId)||!validSoccerDate(date)||!Number.isInteger(limit)||limit<1||limit>5)throw Error('SOCCER_ANALYSIS_SCOPE_INVALID');
  await schema();const rows=await sql()`SELECT analysis_hash,payload FROM sports_soccer_analysis_v1 WHERE league=${league} AND game_id=${gameId} AND payload->>'date'=${date} ORDER BY observed_at DESC,analysis_hash DESC LIMIT ${limit}`;
  return rows.map(r=>{if(storageHash(r.payload)!==r.analysis_hash||r.payload.league!==league||r.payload.gameId!==gameId||r.payload.date!==date)throw Error('SOCCER_ANALYSIS_HISTORY_CORRUPTED');return{...r.payload,persisted:true,revision:r.analysis_hash};});
}
// Find an actual scored prematch revision even when several newer attempts
// have no usable prices. Return only its original quote/score pairs, without
// changing the head, its prices, or publication/ranking authority.
export async function loadSoccerHistoricalPrediction(latest){
  const game=latest?.evidence?.game,league=latest?.league,date=latest?.date,gameId=latest?.gameId;
  const quotes=latest?.directions?.flatMap(direction=>direction.quotes||[])||[];
  if(!game||!['epl','ucl'].includes(league)||gameId!==game.id||game.league!==league||game.date!==date
    ||!validSoccerDate(date)||!Number.isFinite(Date.parse(latest.observedAt))
    ||!/^[a-f0-9]{64}$/.test(latest.revision||'')
    ||(quotes.length&&quotes.every(quote=>quote.predictionScore?.status==='PREDICTION_SCORE_AVAILABLE')))return null;
  await schema();
  const rows=await sql()`SELECT analysis_hash,payload FROM sports_soccer_analysis_v1
    WHERE league=${league} AND game_id=${gameId} AND payload->>'date'=${date}
      AND analysis_hash<>${latest.revision} AND observed_at<=${latest.observedAt}::timestamptz
      AND payload->>'status'='RESEARCH_ONLY' AND payload->>'qaFlag'<>'BLOCKED'
      AND payload #>> '{evidence,game,home,sourceId}'=${game.home.sourceId}
      AND payload #>> '{evidence,game,away,sourceId}'=${game.away.sourceId}
      AND payload #>> '{evidence,game,startTime}'=${game.startTime}
      AND COALESCE(payload #>> '{evidence,game,neutralSite}','false')=${String(Boolean(game.neutralSite))}
      AND (payload->'directions') @> '[{"quotes":[{"predictionScore":{"status":"PREDICTION_SCORE_AVAILABLE"}}]}]'::jsonb
    ORDER BY observed_at DESC,analysis_hash DESC LIMIT 1`;
  if(!rows.length)return null;
  const {analysis_hash:revision,payload}=rows[0];
  if(storageHash(payload)!==revision||payload.league!==league||payload.date!==date||payload.gameId!==gameId)
    throw Error('SOCCER_ANALYSIS_HISTORY_CORRUPTED');
  const result={...payload,revision,persisted:true,publishedCurrent:false},prices=[];
  for(const direction of result.directions){
    for(const quote of direction.quotes||[]){
      if(quote.predictionScore?.status!=='PREDICTION_SCORE_AVAILABLE')continue;
      const display=soccerPredictionScorePresentation({result,direction,quote,displayGame:game});
      if(display.status!=='HISTORICAL'||!Number.isFinite(display.score))continue;
      prices.push({key:quote.key,period:quote.period,kind:quote.kind,side:quote.side,
        line:quote.line,lineSide:quote.lineSide,water:quote.water,label:quote.label,
        observedAt:quote.provenance.observedAt,calculatedAt:quote.predictionScore.provenance.calculatedAt,
        S:display.score,W:display.W,R:display.R});
    }
  }
  return prices.length?{status:'HISTORICAL_PREDICTION',league,date,gameId,revision,startTime:game.startTime,
    homeId:game.home.sourceId,awayId:game.away.sourceId,neutralSite:Boolean(game.neutralSite),
    observedAt:payload.observedAt,quotes:prices,eligible:false,executable:false}:null;
}
export async function saveSoccerAnalysis(value){
  const {analysisHash,...body}=value;
  if(value.formalScoringEnabled!==false||value.qualification?.eligible===true
    ||value.directions?.some(d=>d.eligible===true||d.executable!==false||d.quotes?.some(q=>q.qualification?.eligible===true)))throw Error('SOCCER_ANALYSIS_PREMATURE_PUBLICATION');
  if(value.version!==SOCCER_ANALYSIS_VERSION||!['epl','ucl'].includes(value.league)||!value.gameId.startsWith(`soccer:${value.league}:`)||value.executable!==false||analysisHash!==soccerAnalysisHash(body))throw Error('SOCCER_ANALYSIS_SNAPSHOT_INVALID');
  const hash=storageHash(value);await schema();
  await sql()`INSERT INTO sports_soccer_analysis_v1 (league,game_id,analysis_hash,observed_at,payload) VALUES (${value.league},${value.gameId},${hash},${value.observedAt}::timestamptz,${JSON.stringify(value)}::jsonb) ON CONFLICT DO NOTHING`;
  const rows=await sql()`SELECT payload FROM sports_soccer_analysis_v1 WHERE league=${value.league} AND game_id=${value.gameId} AND analysis_hash=${hash}`;
  if(!rows[0]||storageHash(rows[0].payload)!==hash)throw Error('SOCCER_ANALYSIS_READBACK_FAILED');
  return{persisted:true,revision:hash};
}

export async function loadSoccerAnalysisRevision(league,gameId,date,revision){
  if(!['epl','ucl'].includes(league)||!new RegExp(`^soccer:${league}:\\d{1,16}$`).test(gameId)||!validSoccerDate(date)||!/^[a-f0-9]{64}$/.test(revision||''))throw Object.assign(Error('原分析版本不正確。'),{status:400});
  await schema();
  const rows=await sql()`SELECT analysis_hash,payload FROM sports_soccer_analysis_v1 WHERE league=${league} AND game_id=${gameId} AND analysis_hash=${revision} AND payload->>'date'=${date}`;
  if(!rows[0]||storageHash(rows[0].payload)!==rows[0].analysis_hash)throw Object.assign(Error('找不到可核對的原分析版本。'),{status:400});
  return{...rows[0].payload,persisted:true,revision};
}

export async function listSoccerAnalysisBoard(league,date,through){
  if(!['epl','ucl'].includes(league)||![date,through].every(validSoccerDate)||through<date||Date.parse(through)-Date.parse(date)>14*86400000)throw Object.assign(Error('分析日期範圍不正確。'),{status:400});
  await schema();
  // A superseded request can finish with newer evidence than the active run.
  // Restore the fenced active version first; otherwise retain latest history.
  const rows=await sql()`SELECT DISTINCT ON (a.game_id,a.payload->>'date') a.analysis_hash,a.payload,
    h.requested_run_id,h.requested_seq,h.quote_generation,h.valid_until,clock_timestamp() AS checked_at,
    COALESCE(h.published_revision=a.analysis_hash AND h.valid_until>clock_timestamp()
      AND h.quote_generation=COALESCE(s.quote_generation,0)
      AND r.run_id IS NOT NULL AND e.run_id IS NOT NULL
      AND a.payload->>'analysisRunId'=r.run_id
      AND a.payload->>'league'=a.league AND a.payload->>'gameId'=a.game_id,false) AS is_current
    FROM sports_soccer_analysis_v1 a
    LEFT JOIN sports_soccer_analysis_heads_v2 h ON h.league=a.league AND h.game_id=a.game_id AND h.board_date=(a.payload->>'date')::date
    LEFT JOIN sports_soccer_analysis_runs_v2 r ON r.run_id=h.requested_run_id
      AND r.league=h.league AND r.game_id=h.game_id AND r.board_date=h.board_date
      AND r.request_seq=h.requested_seq AND r.quote_generation=h.quote_generation
    LEFT JOIN sports_soccer_analysis_events_v2 e ON e.run_id=r.run_id AND e.analysis_revision=h.published_revision
      AND e.analysis_status='COMPLETED' AND e.qa_flag<>'BLOCKED' AND e.selection_result='RESEARCH_SHADOW'
    LEFT JOIN sports_soccer_source_heads_v2 s ON s.league=h.league AND s.board_date=h.board_date
    WHERE a.league=${league} AND a.payload->>'date'>=${date} AND a.payload->>'date'<=${through}
    ORDER BY a.game_id,a.payload->>'date',is_current DESC,a.observed_at DESC,a.analysis_hash DESC LIMIT 250`;
  const results=[];
  for(const r of rows){
    if(storageHash(r.payload)!==r.analysis_hash||r.payload.league!==league)throw Error('SOCCER_ANALYSIS_HISTORY_CORRUPTED');
    const currentStatus=r.is_current===true?{analysisRunId:r.requested_run_id,qualificationVersion:String(r.requested_seq),
      quoteGeneration:String(r.quote_generation),revision:r.analysis_hash,checkedAt:new Date(r.checked_at).toISOString(),
      validUntil:new Date(r.valid_until).toISOString(),publishedCurrent:true,reason:'ACTIVE',analysisStatus:'COMPLETED',
      selectionResult:'RESEARCH_SHADOW',formalScoringEnabled:false,executable:false}:null;
    if(r.is_current===true){await restoreSoccerCurrentSourceAvailability(r.payload?.evidence);await restoreSoccerPrematchInputAvailability(r.payload?.evidence);}
    results.push(publishSoccerAnalysisCandidates({...r.payload,persisted:true,revision:r.analysis_hash,publishedCurrent:r.is_current===true}, {currentStatus}));
  }
  return results;
}
