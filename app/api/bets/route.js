import { NextResponse } from 'next/server';
import {
  cancelOpenCloudBet,
  cloudBetStats,
  listCloudBetsReadPage,
  listCloudBetsByIds,
  mergeCloudBets,
  recoverPersistedCloudBet,
  settleOpenCloudBets,
  upsertCloudBet,
} from '../../../lib/cloud-bet-store.js';
import { buildCalibrationStatusFromBetsV109 } from '../../../lib/calibration-ledger-v109.js';
import { verifyCloudBetEvidenceV110 } from '../../../lib/bet-evidence-verification-v110.js';
import { settlePendingAnalysisDirections } from '../../../lib/analysis-direction-history-v1.js';
import { classifyDatabaseError, databaseFailureLog, isDatabaseError } from '../../../lib/database-error.js';
import { checkRateLimit, originErrorResponse, rateLimitResponse, readJsonBody, requireApiAuth, validateSameOrigin } from '../../../lib/security.js';

const response = (bets, extra = {}, headers = {}) => NextResponse.json({
  ok: true,
  bets,
  stats: cloudBetStats(bets),
  calibration: buildCalibrationStatusFromBetsV109(bets),
  ...extra,
}, { headers: { 'Cache-Control': 'no-store', ...headers } });

const BET_LEDGER_READ_TIMEOUT_MS = 12_000;

async function withBetLedgerReadDeadline(operation, timeoutMs = BET_LEDGER_READ_TIMEOUT_MS) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error('Permanent ledger read exceeded its response deadline');
      error.code = 'BET_LEDGER_READ_TIMEOUT';
      error.databaseOperation = true;
      reject(error);
    }, timeoutMs);
  });
  try { return await Promise.race([Promise.resolve().then(operation), deadline]); }
  finally { clearTimeout(timer); }
}

const readTimingHeaders = startedAt => ({
  'Server-Timing': `ledger;dur=${Math.max(0, performance.now() - startedAt).toFixed(1)}`,
});

const mutationResponse = mutation => response(mutation.bets, {
  created: mutation.created === true,
  idempotent: mutation.idempotent === true,
  betId: mutation.betId || null,
  persistence: mutation.persistence,
});

// The browser may identify the exact Reader/PIT contract and choose a stake.
// All durable ledger fields are rebuilt after server verification.
function betUpsertCandidate(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    league: source.league,
    date: source.date,
    gamePk: source.gamePk,
    market: source.market,
    pick: source.pick,
    water: source.water,
    stake: source.stake,
    readerPayloadHash: source.readerPayloadHash,
    rawBoardHash: source.rawBoardHash,
    readerRevision: source.readerRevision,
    pitSnapshotId: source.pitSnapshotId,
  };
}

function databaseFailureResponse(error, operation, headers = {}) {
  const failure = error?.code === 'BET_LEDGER_READ_TIMEOUT' ? {
    code: 'BET_LEDGER_READ_TIMEOUT', status: 503, retryAfterSeconds: 5,
    publicMessage: '帳本讀取暫時逾時，尚未完成同步；請稍後重試，既有紀錄未被變更。',
  } : classifyDatabaseError(error);
  console.error(`[${operation}]`, { ...databaseFailureLog(error, operation), code: failure.code });
  return NextResponse.json({
    ok: false,
    code: failure.code,
    error: failure.publicMessage,
    retryAfterSeconds: failure.retryAfterSeconds,
  }, {
    status: failure.status,
    headers: {
      'Cache-Control': 'no-store',
      'Retry-After': String(failure.retryAfterSeconds),
      ...headers,
    },
  });
}

export async function GET(request) {
  const auth = await requireApiAuth(request); if (auth) return auth;
  const startedAt = performance.now();
  try {
    const params = new URL(request.url).searchParams;
    const view = params.get('view');
    if (view != null && !['compact', 'full'].includes(view)) {
      return NextResponse.json({ ok: false, code: 'BET_READ_OPTIONS_INVALID', error: '不支援的帳本讀取格式' }, {
        status: 400, headers: { 'Cache-Control': 'no-store', ...readTimingHeaders(startedAt) },
      });
    }
    const confirmBetId = params.get('confirmBetId');
    if (confirmBetId != null && (!confirmBetId.trim() || confirmBetId.length > 120)) {
      return NextResponse.json({ ok: false, code: 'BET_ID_INVALID', error: '下注紀錄識別格式不正確' }, {
        status: 400, headers: { 'Cache-Control': 'no-store' },
      });
    }
    const page = await withBetLedgerReadDeadline(async () => {
      const result = await listCloudBetsReadPage({
        compact: view === 'compact', date: params.get('date'), league: params.get('league'),
        limit: params.get('limit'), cursor: params.get('cursor'),
      });
      if (confirmBetId != null) {
        // Independent client readback must also find old retry/cancellation IDs
        // beyond the bounded ledger page, and must use their latest DB state.
        const confirmed = await listCloudBetsByIds([confirmBetId]);
        result.bets = [...confirmed, ...result.bets.filter(bet => bet.id !== confirmBetId)];
        result.confirmedBetId = confirmed[0]?.id || null;
      }
      return result;
    });
    const extra = {
      pagination: page.pagination, view: page.view,
      ...(confirmBetId != null ? { confirmedBetId: page.confirmedBetId } : {}),
      statsScope: page.view === 'compact' ? 'NOT_COMPUTED_COMPACT_READ'
        : page.pagination.hasMore || params.get('cursor') || confirmBetId != null
          ? 'RETURNED_RECORDS_ONLY' : 'FILTERED_LEDGER',
    };
    if (page.view === 'compact') {
      // Fast visibility reads never publish partial-page performance/calibration
      // as complete statistics. The client must load every page for history.
      return NextResponse.json({ ok: true, bets: page.bets, stats: null, calibration: null, ...extra }, {
        headers: { 'Cache-Control': 'no-store', ...readTimingHeaders(startedAt) },
      });
    }
    return response(page.bets, extra, readTimingHeaders(startedAt));
  }
  catch (error) {
    if (error?.status === 400) return NextResponse.json({ ok: false, code: error.code, error: error.message }, {
      status: 400, headers: { 'Cache-Control': 'no-store', ...readTimingHeaders(startedAt) },
    });
    return databaseFailureResponse(error, 'BET_LEDGER_READ_FAILED', readTimingHeaders(startedAt));
  }
}

export async function POST(request) {
  const auth = await requireApiAuth(request); if (auth) return auth;
  if (!validateSameOrigin(request)) return originErrorResponse();
  const rate = checkRateLimit(request, { id: 'cloud-bets-v2', limit: 90, windowMs: 60_000 });
  if (!rate.allowed) return rateLimitResponse(rate);
  try {
    const body = await readJsonBody(request, 500_000);
    if (body.action === 'merge') return response(await mergeCloudBets(body.bets));
    if (body.action === 'upsert') {
      const candidate = betUpsertCandidate(body.bet);
      // Preserve the exact attempted contract for incident recovery. A click
      // is not a durable ticket; only a verified persistence receipt is success.
      console.info('[BET_LEDGER_ATTEMPT]', {
        league: String(candidate.league || '').slice(0, 8),
        date: String(candidate.date || '').slice(0, 10),
        gamePk: Number(candidate.gamePk) || null,
        market: String(candidate.market || '').slice(0, 40),
        pick: String(candidate.pick || '').slice(0, 160),
        water: Number.isFinite(Number(candidate.water)) ? Number(candidate.water) : null,
        stake: Number.isFinite(Number(candidate.stake)) ? Number(candidate.stake) : null,
        pitSnapshotId: String(candidate.pitSnapshotId || '').slice(0, 500),
      });
      // Only return an existing trusted record for an exact repeated intent.
      // This never creates a bet or relaxes the evidence gate below.
      const recovered = await recoverPersistedCloudBet(candidate);
      if (recovered) {
        console.info('[BET_LEDGER_PERSISTED]', { betId: recovered.betId, created: false, idempotent: true });
        return mutationResponse(recovered);
      }
      const verification = await verifyCloudBetEvidenceV110(candidate);
      if (verification.pitVerified !== true) {
        console.warn('[BET_LEDGER_REJECTED]', {
          code: 'PIT_EVIDENCE_REQUIRED',
          reasonCode: verification.pitErrorCode || null,
          status: 409,
          league: String(candidate.league || '').slice(0, 8),
          date: String(candidate.date || '').slice(0, 10),
          gamePk: Number(candidate.gamePk) || null,
          pitSnapshotId: String(candidate.pitSnapshotId || '').slice(0, 500),
          message: String(verification.pitError || 'PIT_UNVERIFIED').slice(0, 300),
        });
        return NextResponse.json({
          ok: false,
          code: 'PIT_EVIDENCE_REQUIRED',
          reasonCode: verification.pitErrorCode || null,
          error: `目前下注找不到同場最新不可變PIT證據：${verification.pitError || 'PIT_UNVERIFIED'}`,
        }, { status: 409, headers: { 'Cache-Control': 'no-store' } });
      }
      const mutation = await upsertCloudBet(candidate, { verification });
      console.info('[BET_LEDGER_PERSISTED]', {
        betId: mutation.betId, created: mutation.created === true, idempotent: mutation.idempotent === true,
      });
      return mutationResponse(mutation);
    }
    if (body.action === 'cancel') return response(await cancelOpenCloudBet(body.id));
    if (body.action === 'settleOpen') {
      const bets = await settleOpenCloudBets({ league: body.league, limit: 500, timeBudgetMs: 15_000 });
      // The UI already invokes settleOpen automatically.  Use the same
      // authenticated trigger to settle every persisted CALCULATED analysis
      // direction, including negative-EV/non-ranked rows that were never bets.
      let analysisDirectionSettlement;
      try {
        analysisDirectionSettlement = await settlePendingAnalysisDirections({
          league: body.league,
          limitGames: 20,
          concurrency: 4,
          timeBudgetMs: 15_000,
        });
      } catch (error) {
        // Cloud-bet settlement may already be durable. A separate direction
        // history outage must not make that completed operation look rolled back.
        analysisDirectionSettlement = {
          stored: false,
          reason: 'DIRECTION_SETTLEMENT_UNAVAILABLE',
          error: String(error?.message || error),
        };
        console.error('[ANALYSIS_DIRECTION_SETTLEMENT_FAILED]', analysisDirectionSettlement);
      }
      return response(bets, { analysisDirectionSettlement });
    }
    return NextResponse.json({ ok: false, error: '不支援的下注紀錄操作' }, { status: 400 });
  } catch (error) {
    const message = String(error?.message || '');
    if (isDatabaseError(error)) return databaseFailureResponse(error, 'BET_LEDGER_WRITE_FAILED');
    console.warn('[BET_LEDGER_REJECTED]', {
      code: error?.code || 'BET_LEDGER_WRITE_FAILED',
      status: Number(error?.status) || 400,
      message: message.slice(0, 300),
    });
    return NextResponse.json({ ok: false, code: error?.code || 'BET_LEDGER_WRITE_FAILED', error: message || '雲端下注紀錄更新失敗' }, { status: Number(error?.status) || 400 });
  }
}
