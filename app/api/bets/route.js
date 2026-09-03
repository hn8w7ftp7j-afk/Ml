import { NextResponse } from 'next/server';
import {
  cancelOpenCloudBet,
  cloudBetStats,
  listCloudBets,
  mergeCloudBets,
  settleOpenCloudBets,
  upsertCloudBet,
} from '../../../lib/cloud-bet-store.js';
import { buildCalibrationStatusFromBetsV109 } from '../../../lib/calibration-ledger-v109.js';
import { verifyCloudBetEvidenceV110 } from '../../../lib/bet-evidence-verification-v110.js';
import { settlePendingAnalysisDirections } from '../../../lib/analysis-direction-history-v1.js';
import { classifyDatabaseError, databaseFailureLog, isDatabaseError } from '../../../lib/database-error.js';
import { checkRateLimit, originErrorResponse, rateLimitResponse, readJsonBody, requireApiAuth, validateSameOrigin } from '../../../lib/security.js';

const response = (bets, extra = {}) => NextResponse.json({
  ok: true,
  bets,
  stats: cloudBetStats(bets),
  calibration: buildCalibrationStatusFromBetsV109(bets),
  ...extra,
}, { headers: { 'Cache-Control': 'no-store' } });

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

function databaseFailureResponse(error, operation) {
  const failure = classifyDatabaseError(error);
  console.error(`[${operation}]`, databaseFailureLog(error, operation));
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
    },
  });
}

export async function GET(request) {
  const auth = await requireApiAuth(request); if (auth) return auth;
  try { return response(await listCloudBets()); }
  catch (error) { return databaseFailureResponse(error, 'BET_LEDGER_READ_FAILED'); }
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
      const verification = await verifyCloudBetEvidenceV110(candidate);
      if (verification.pitVerified !== true) {
        console.warn('[BET_LEDGER_REJECTED]', {
          code: 'PIT_EVIDENCE_REQUIRED',
          status: 409,
          message: String(verification.pitError || 'PIT_UNVERIFIED').slice(0, 300),
        });
        return NextResponse.json({
          ok: false,
          code: 'PIT_EVIDENCE_REQUIRED',
          error: `目前下注找不到同場最新不可變PIT證據：${verification.pitError || 'PIT_UNVERIFIED'}`,
        }, { status: 409, headers: { 'Cache-Control': 'no-store' } });
      }
      const mutation = await upsertCloudBet(candidate, { verification });
      return response(mutation.bets, {
        created: mutation.created === true,
        betId: mutation.betId || null,
      });
    }
    if (body.action === 'cancel') return response(await cancelOpenCloudBet(body.id));
    if (body.action === 'settleOpen') {
      const bets = await settleOpenCloudBets({ league: body.league, limit: 500 });
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
