import { randomUUID } from 'node:crypto';
import { soccerDate } from './contracts.js';
import { soccerJournalQuery, soccerJournalTransaction, soccerJournalConfigured } from './journal.js';
import { soccerForwardHash, SOCCER_FORWARD_POLICY } from './forward-validation.js';
import { SOCCER_MARKET_RETURN_SOURCE_BOUND_SELECTION, SOCCER_MARKET_RETURN_DIAGNOSTIC_VERSION } from './market-return-validation.js';
import { SOCCER_ACCOUNT_RULE_CONFIRMATION } from './account-rule-policy.js';
import { continueSoccerForwardScan } from './forward-validation-scan.js';
import { ensureSoccerForwardProtocol } from './forward-validation-service.js';
import { buildSoccerReturnErrorDatasetHydrated, fitSoccerReturnErrorResearch, SOCCER_RETURN_ERROR_REPLAY_REVISION } from './return-error-model.js';
import { ensureSoccerReturnErrorValidationStore, listActiveSoccerReturnErrorProtocols,
  loadSoccerReturnErrorFreezeVerifier, freezeSoccerReturnErrorParameters, soccerReturnErrorDatabaseNow } from './return-error-validation-store.js';

export const SOCCER_RETURN_ERROR_LIFECYCLE_VERSION = 'SOCCER-RETURN-ERROR-DURABLE-LIFECYCLE-v1';
export { SOCCER_RETURN_ERROR_REPLAY_REVISION };
const restrictions = { accepted: false, formalEligible: false, executable: false, W: null, R: null, S: null };
const maxDatasetBytes = 64*1024*1024;
const iso = value => new Date(value).toISOString();
const fail = code => { throw Error(code); };
const registrationInputs = ['league','from','trainingBefore','calibrationBefore','testBefore','miscoverage'];
const registrationCommand = league => `node scripts/soccer-return-error-validation.mjs register --league ${league} --from YYYY-MM-DD --training-before ISO --calibration-before ISO --test-before ISO --miscoverage 0.1`;

// Immutable capture IDs bind original model/price bytes. Distinct result and
// return-evidence identities retain corrections, while recurring check-window
// receipts of identical evidence do not create another full dataset copy.
export async function readSoccerReturnErrorSourceWatermark(receipt, cutoff, operation='evaluate') {
  await ensureSoccerForwardProtocol();
  const through = soccerDate(Math.min(cutoff,Date.parse(operation==='freeze' ? receipt.protocol.calibrationBefore : receipt.protocol.testBefore))-1);
  const rows = await soccerJournalQuery(`WITH captures AS MATERIALIZED
    (SELECT capture_id,analysis_revision,model_hash,period,variant FROM sports_soccer_forward_captures_v1
      WHERE league=$1 AND board_date BETWEEN $2::date AND $3::date AND captured_at<=$4::timestamptz),
    identities AS (SELECT jsonb_build_array('capture',capture_id,analysis_revision,model_hash,period,variant)::text AS identity FROM captures
      UNION SELECT jsonb_build_array('check',r.capture_id,r.payload->>'status',r.payload->>'reason',
        r.payload#>>'{evaluation,status}',r.payload#>>'{evaluation,reason}',r.payload#>'{evaluation,actualScore}',
        r.payload#>>'{resultEvidence,resultHash}',r.payload#>>'{evaluation,marketReturnValidation,evidenceHash}')::text
      FROM sports_soccer_forward_result_checks_v1 r JOIN captures c USING(capture_id) WHERE r.checked_at<=$4::timestamptz
        AND coalesce((r.payload#>>'{evaluation,marketReturnValidation,checkedAt}')::timestamptz,r.checked_at)<=$4::timestamptz)
    SELECT encode(sha256(convert_to(coalesce(string_agg(identity,E'\\n' ORDER BY identity),''),'UTF8')),'hex') AS watermark FROM identities`,
  [receipt.league,receipt.protocol.from,through,iso(cutoff)]);
  return soccerForwardHash([receipt.protocolHash,rows[0].watermark,SOCCER_RETURN_ERROR_REPLAY_REVISION,
    SOCCER_FORWARD_POLICY,SOCCER_MARKET_RETURN_SOURCE_BOUND_SELECTION,SOCCER_MARKET_RETURN_DIAGNOSTIC_VERSION,SOCCER_ACCOUNT_RULE_CONFIRMATION]);
}

// This projection is diagnostic only. Neither configured dates nor a durable
// freeze approve a model or establish conditional expected-return uncertainty.
export async function readSoccerReturnErrorLifecycleReadiness(league, overrides = {}) {
  if (!['epl','ucl'].includes(league)) fail('RETURN_ERROR_LIFECYCLE_SCOPE_INVALID');
  const deps = { configured: soccerJournalConfigured, listProtocols: listActiveSoccerReturnErrorProtocols,
    databaseNow: soccerReturnErrorDatabaseNow, timeoutMs: 1500, ...overrides };
  const base = { version: SOCCER_RETURN_ERROR_LIFECYCLE_VERSION, league, ...restrictions,
    requiredInputs: registrationInputs, registrationCommand: registrationCommand(league),
    nextAction: '先登錄未來的訓練、校準與測試截止時間；排程依原協定續讀、凍結及核對，不會自動驗收。' };
  if (!deps.configured()) return { ...base, status: 'STORAGE_NOT_CONFIGURED', configuredProtocols: null, protocols: [], persisted: false };
  let timer;
  try {
    const [listed, now] = await Promise.race([
      Promise.all([deps.listProtocols({league,limit:20}),deps.databaseNow()]),
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('RETURN_ERROR_READINESS_TIMEOUT')),deps.timeoutMs);}),
    ]);
    return { ...base, status: listed.protocols.length ? 'CONFIGURED_RESEARCH_ONLY' : 'NOT_CONFIGURED',
      configuredProtocols: listed.completeWithinRequestedScope ? listed.protocols.length : null,
      configuredProtocolLowerBound: listed.protocols.length, completeWithinRequestedScope: listed.completeWithinRequestedScope,
      checkedAt: iso(now), persisted: true, protocols: listed.protocols.map(value => ({ protocolId: value.protocolId,
        registeredAt: value.registeredAt, from: value.protocol.from, trainingBefore: value.protocol.trainingBefore,
        calibrationBefore: value.protocol.calibrationBefore, testBefore: value.protocol.testBefore,
        progress: value.lifecycle || null,
        pretestFreezeStatus: value.lifecycle?.frozenGroups > 0 ? 'DATABASE_FROZEN_RESEARCH_ONLY'
          : now >= Date.parse(value.protocol.testBefore) ? 'MISSING_PRETEST_FREEZE_WINDOW_CLOSED' : 'NOT_YET_FROZEN',
        phase: now < Date.parse(value.protocol.trainingBefore) ? 'TRAINING_WINDOW_OPEN'
          : now < Date.parse(value.protocol.calibrationBefore) ? 'CALIBRATION_WINDOW_OPEN'
          : now < Date.parse(value.protocol.testBefore) ? 'FREEZE_OR_TEST_WINDOW' : 'TEST_WINDOW_CLOSED' })) };
  } catch { return { ...base, status: 'NOT_VERIFIED', configuredProtocols: null, protocols: [], persisted: false }; }
  finally { clearTimeout(timer); }
}

async function claimRun(receipt, operation, now, token, watermark) {
  const through = soccerDate(Math.min(now, operation === 'freeze'
    ? Date.parse(receipt.protocol.calibrationBefore) : Date.parse(receipt.protocol.testBefore))-1);
  if (through < receipt.protocol.from) return null;
  const id = soccerForwardHash([receipt.protocolId,operation,randomUUID()]);
  await soccerJournalTransaction([
    ['SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`soccer-return-error:${receipt.protocolId}:${operation}`]],
    [`INSERT INTO sports_soccer_return_error_lifecycle_v1(run_id,protocol_id,operation,evidence_cutoff_at,source_through,source_watermark,replay_revision)
      SELECT $1,$2,$3,$4::timestamptz,$5::date,$6,$7 WHERE NOT EXISTS
      (SELECT 1 FROM sports_soccer_return_error_lifecycle_v1 WHERE protocol_id=$2 AND operation=$3 AND status='RUNNING')`,
    [id,receipt.protocolId,operation,iso(now),through,watermark,SOCCER_RETURN_ERROR_REPLAY_REVISION]],
  ]);
  const rows = await soccerJournalQuery(`UPDATE sports_soccer_return_error_lifecycle_v1 SET lease_token=$3,
    lease_until=clock_timestamp()+interval '60 seconds',last_attempt_at=clock_timestamp()
    WHERE protocol_id=$1 AND operation=$2 AND status='RUNNING'
      AND (lease_until IS NULL OR lease_until<=clock_timestamp()) RETURNING *`,[receipt.protocolId,operation,token]);
  return rows[0] || null;
}

async function saveDataset(job, token, evidence, context, dataset) {
  const capture = evidence.captures?.[0], key = `${capture?.league}|${capture?.gameId}`;
  if (!capture || capture.league !== job.league || !capture.gameId?.startsWith(`soccer:${job.league}:`)
    || !/^[a-f0-9]{48}$/.test(context.scanCursor || '')) fail('RETURN_ERROR_LIFECYCLE_GAME_SCOPE_INVALID');
  const { contentHash, ...body } = dataset || {};
  if (soccerForwardHash(body) !== contentHash || [...(dataset.observations||[]),...(dataset.boundedObservations||[])]
    .some(row => `${row.league}|${row.gameId}` !== key)) fail('RETURN_ERROR_LIFECYCLE_DATASET_INVALID');
  const serialized = JSON.stringify(dataset), bytes = Buffer.byteLength(serialized);
  const results = await soccerJournalTransaction([
    [`INSERT INTO sports_soccer_return_error_lifecycle_datasets_v1(run_id,game_key,content_hash,payload,byte_count)
      SELECT j.run_id,$3,$4,$5::jsonb,$6::int FROM sports_soccer_return_error_lifecycle_v1 j
      WHERE j.run_id=$1 AND j.lease_token=$2 AND j.lease_until>clock_timestamp() AND j.status='RUNNING'
        AND j.dataset_bytes+$6::bigint<=$7::bigint AND (j.scan_cursor IS NULL OR j.scan_cursor=$8)
      ON CONFLICT DO NOTHING RETURNING content_hash`,[job.run_id,token,key,contentHash,serialized,bytes,maxDatasetBytes,context.scanCursor]],
    [`UPDATE sports_soccer_return_error_lifecycle_v1 j SET scan_cursor=$3,
      dataset_bytes=(SELECT coalesce(sum(byte_count),0) FROM sports_soccer_return_error_lifecycle_datasets_v1 d WHERE d.run_id=j.run_id)
      WHERE j.run_id=$1 AND j.lease_token=$2 AND j.lease_until>clock_timestamp() AND (j.scan_cursor IS NULL OR j.scan_cursor=$3)
      RETURNING dataset_bytes`,[job.run_id,token,context.scanCursor]],
    ['SELECT content_hash FROM sports_soccer_return_error_lifecycle_datasets_v1 WHERE run_id=$1 AND game_key=$2',[job.run_id,key]],
  ]);
  if (!results[1].length) fail('RETURN_ERROR_LIFECYCLE_LEASE_EXPIRED');
  if (!results[2].length) fail('RETURN_ERROR_LIFECYCLE_DATASET_BUDGET');
  if (results[2][0].content_hash !== contentHash) fail('RETURN_ERROR_LIFECYCLE_DATASET_CHANGED');
}

async function updateProgress(job, token, scan) {
  const rows = await soccerJournalQuery(`UPDATE sports_soccer_return_error_lifecycle_v1
    SET scan_cursor=$3,processed_games=$4 WHERE run_id=$1 AND lease_token=$2 AND lease_until>clock_timestamp()
      AND (scan_cursor IS NULL OR scan_cursor=$3) RETURNING run_id`,[job.run_id,token,scan.cursor,scan.processedGames]);
  if (rows.length !== 1) fail('RETURN_ERROR_LIFECYCLE_LEASE_EXPIRED');
}

async function finishRun(job, token, artifact) {
  const rows = await soccerJournalQuery(`UPDATE sports_soccer_return_error_lifecycle_v1 SET status='COMPLETE',artifact=$3::jsonb
    WHERE run_id=$1 AND lease_token=$2 AND lease_until>clock_timestamp() RETURNING run_id`,[job.run_id,token,JSON.stringify(artifact)]);
  if (rows.length !== 1) fail('RETURN_ERROR_LIFECYCLE_LEASE_EXPIRED');
  // These are reproducible derived chunks, never original prices/predictions
  // or result receipts. Keep two completed cohorts per operation; all freeze
  // artifacts remain available and the immutable source records are untouched.
  await soccerJournalQuery(`DELETE FROM sports_soccer_return_error_lifecycle_datasets_v1 WHERE run_id IN
    (SELECT run_id FROM sports_soccer_return_error_lifecycle_v1 WHERE protocol_id=$1 AND operation=$2 AND status='COMPLETE'
      ORDER BY evidence_cutoff_at DESC,run_id DESC OFFSET 2)`,[job.protocol_id,job.operation]);
  if(job.operation==='evaluate')await soccerJournalQuery(`DELETE FROM sports_soccer_return_error_lifecycle_v1
    WHERE run_id IN (SELECT run_id FROM sports_soccer_return_error_lifecycle_v1 WHERE protocol_id=$1 AND operation='evaluate' AND status='COMPLETE'
      ORDER BY evidence_cutoff_at DESC,run_id DESC OFFSET 2)`,[job.protocol_id]);
}

/** Cooperative scan budgets bound each cron batch. Validated whole-game data
 * are persisted before scanner progress, so timeout/retry never fits only the
 * final page. A fixed DB cutoff and frozen scan manifest survive continuation. */
export async function runSoccerReturnErrorLifecycle({ league, limit = 1, timeBudgetMs = 18000 } = {}, overrides = {}) {
  if (!['epl','ucl'].includes(league) || !Number.isSafeInteger(limit) || limit < 1 || limit > 4
    || !Number.isFinite(timeBudgetMs) || timeBudgetMs < 1 || timeBudgetMs > 18000) fail('RETURN_ERROR_LIFECYCLE_SCOPE_INVALID');
  const deps = { now: Date.now, databaseNow: soccerReturnErrorDatabaseNow, listProtocols: listActiveSoccerReturnErrorProtocols,
    scan: continueSoccerForwardScan, buildDataset: buildSoccerReturnErrorDatasetHydrated,
    fit: fitSoccerReturnErrorResearch, freeze: freezeSoccerReturnErrorParameters,
    loadVerifier: loadSoccerReturnErrorFreezeVerifier, sourceWatermark:readSoccerReturnErrorSourceWatermark, ...overrides };
  const deadline = deps.now()+timeBudgetMs, base = { version: SOCCER_RETURN_ERROR_LIFECYCLE_VERSION, league,
    persisted: true, protocols: [], ...restrictions };
  await ensureSoccerReturnErrorValidationStore();
  const listed = await deps.listProtocols({league,limit:100,readyOnly:true});
  if (!listed.protocols.length) {
    const all = await deps.listProtocols({league,limit:1});
    return { ...base, status: all.protocols.length ? 'WAITING' : 'NOT_CONFIGURED' };
  }
  for (const receipt of listed.protocols) {
    if (base.protocols.length >= limit || deps.now() >= deadline) break;
    const now = await deps.databaseNow(), authority = await deps.loadVerifier(receipt.protocolId);
    const pendingFreeze = receipt.lifecycle?.operation==='freeze' && receipt.lifecycle.status==='RUNNING';
    const operation = now < Date.parse(receipt.protocol.testBefore) && (!authority.freezes.length || pendingFreeze) ? 'freeze' : 'evaluate';
    const watermark = await deps.sourceWatermark(receipt,now,operation);
    {
      const existing = await soccerJournalQuery(`SELECT run_id,status,source_watermark,artifact,replay_revision FROM sports_soccer_return_error_lifecycle_v1
        WHERE protocol_id=$1 AND operation=$2 ORDER BY last_attempt_at DESC,run_id DESC LIMIT 1`,[receipt.protocolId,operation]);
      // Recheck once when the declared test window closes even if no new
      // source arrived, so testWindowComplete is never frozen prematurely.
      if(existing[0]?.status==='COMPLETE'&&existing[0].source_watermark===watermark
        &&existing[0].replay_revision===SOCCER_RETURN_ERROR_REPLAY_REVISION
        && (operation==='freeze'||now<Date.parse(receipt.protocol.testBefore)||Date.parse(existing[0].artifact?.generatedAt)>=Date.parse(receipt.protocol.testBefore))){
        await soccerJournalQuery('UPDATE sports_soccer_return_error_lifecycle_v1 SET last_attempt_at=clock_timestamp() WHERE run_id=$1',[existing[0].run_id]);
        base.protocols.push({protocolId:receipt.protocolId,operation,status:'UNCHANGED_SOURCE'});continue;
      }
    }
    const token = randomUUID(), job = await claimRun(receipt,operation,now,token,watermark);
    if (!job) { base.protocols.push({protocolId:receipt.protocolId,operation,status:'IN_PROGRESS'}); continue; }
    job.league = league;
    const outcome = {protocolId:receipt.protocolId,operation,status:'IN_PROGRESS',evidenceCutoffAt:iso(job.evidence_cutoff_at),
      sourceScope:{league,from:receipt.protocol.from,through:iso(job.source_through).slice(0,10)}};
    base.protocols.push(outcome);
    try {
      const cutoff = new Date(job.evidence_cutoff_at).getTime();
      if(job.replay_revision!==SOCCER_RETURN_ERROR_REPLAY_REVISION)
        throw Object.assign(Error('Replay implementation changed'),{code:'SOCCER_FORWARD_SCAN_SELECTION_CHANGED'});
      let cursor = job.scan_cursor, result;
      do {
        const remaining = deadline-deps.now(); if (remaining <= 0) break;
        result = await deps.scan(outcome.sourceScope,{cursor,purpose:'read',gameLimit:1,timeBudgetMs:Math.min(18000,remaining),
          onGameEvidence:async(evidence,context) => {
            const dataset = await deps.buildDataset(evidence,{...context,now:Math.min(context.now,cutoff)});
            await saveDataset(job,token,evidence,context,dataset);
          }});
        await updateProgress(job,token,result.report.scan);
        const next = result.report.scan.nextCursor;
        if (next && result.report.scan.processedGames <= Number(job.processed_games)) fail('RETURN_ERROR_LIFECYCLE_SCAN_DID_NOT_ADVANCE');
        job.processed_games = result.report.scan.processedGames; cursor = next;
      } while (cursor && deps.now() < deadline);
      if (!result || cursor || deps.now() >= deadline) continue;
      const datasets = await soccerJournalQuery('SELECT payload FROM sports_soccer_return_error_lifecycle_datasets_v1 WHERE run_id=$1 ORDER BY game_key',[job.run_id]);
      const currentAuthority = await deps.loadVerifier(receipt.protocolId);
      const artifact = deps.fit({datasets:datasets.map(row=>row.payload),protocol:receipt.protocol,now:cutoff,
        requestedScopeComplete:result.report.complete===true,verifyFrozenModelReceipt:currentAuthority.verifyFrozenModelReceipt});
      // Unsupported fits are saved as research diagnostics and retried with a
      // fresh manifest next cron; no null radius becomes an approved margin.
      const supported = artifact.groups.some(group=>Number.isFinite(group.biasCorrection)&&Number.isFinite(group.realizedReturnBandRadius));
      if (operation === 'freeze' && supported && artifact.requestedScopeComplete) await deps.freeze(receipt.protocolId,artifact);
      await finishRun(job,token,artifact);
      outcome.status = !artifact.requestedScopeComplete ? 'PARTIAL_SOURCE' : operation === 'freeze'
        ? supported ? 'RESEARCH_FROZEN' : 'WAITING_FOR_SUPPORTED_DATA' : 'RESEARCH_EVALUATED';
      outcome.observedGames = artifact.observedGames; outcome.missingReasons = artifact.missingReasons;
      outcome.pretestFreezeMissing = operation==='evaluate' && !currentAuthority.freezes.length;
    } catch (error) {
      if((error?.code==='SOCCER_FORWARD_SCAN_CURSOR_EXPIRED'&&job.scan_cursor)||error?.code==='SOCCER_FORWARD_SCAN_SELECTION_CHANGED'){
        const restartedId=soccerForwardHash([job.run_id,'restart',randomUUID()]);
        const restartWatermark=await deps.sourceWatermark(receipt,new Date(job.evidence_cutoff_at).getTime(),operation);
        await soccerJournalTransaction([
          [`UPDATE sports_soccer_return_error_lifecycle_v1 SET status='ABANDONED',artifact=$3::jsonb
            WHERE run_id=$1 AND lease_token=$2 AND lease_until>clock_timestamp()`,[job.run_id,token,JSON.stringify({
              type:'INCOMPLETE_SCAN_RESTART',reason:error.code,requestedScopeComplete:false,...restrictions})]],
          [`DELETE FROM sports_soccer_return_error_lifecycle_datasets_v1 d USING sports_soccer_return_error_lifecycle_v1 j
            WHERE d.run_id=j.run_id AND j.run_id=$1 AND j.lease_token=$2 AND j.status='ABANDONED'`,[job.run_id,token]],
          [`INSERT INTO sports_soccer_return_error_lifecycle_v1(run_id,protocol_id,operation,evidence_cutoff_at,source_through,source_watermark,replay_revision)
            SELECT $3,protocol_id,operation,evidence_cutoff_at,source_through,$4,$5 FROM sports_soccer_return_error_lifecycle_v1
            WHERE run_id=$1 AND lease_token=$2 AND status='ABANDONED'`,[job.run_id,token,restartedId,restartWatermark,SOCCER_RETURN_ERROR_REPLAY_REVISION]],
        ]);
        outcome.status='IN_PROGRESS';outcome.reason='RETURN_ERROR_LIFECYCLE_SCAN_RESTARTED';
      }else{
        outcome.status = 'RETRYABLE';
        outcome.reason = /^RETURN_ERROR_[A-Z0-9_]+$/.test(error?.message||'') ? error.message : 'RETURN_ERROR_LIFECYCLE_SOURCE_OR_STORAGE_UNAVAILABLE';
      }
    } finally {
      await soccerJournalQuery(`UPDATE sports_soccer_return_error_lifecycle_v1 SET lease_token=NULL,lease_until=NULL
        WHERE run_id=$1 AND lease_token=$2`,[job.run_id,token]);
    }
  }
  return { ...base, status: base.protocols.some(row=>row.status==='RETRYABLE') ? 'RETRYABLE'
    : base.protocols.some(row=>row.status==='IN_PROGRESS') || !base.protocols.length ? 'IN_PROGRESS'
    : base.protocols.at(-1).status, completeProtocolDiscovery:listed.completeWithinRequestedScope };
}
