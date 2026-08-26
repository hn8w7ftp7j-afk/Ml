import { NextResponse } from 'next/server';
import {
  cloudBetStats,
  listCloudBets,
  mergeCloudBets,
  settleOpenCloudBets,
  upsertCloudBet,
} from '../../../lib/cloud-bet-store.js';
import { buildCalibrationStatusFromBetsV109 } from '../../../lib/calibration-ledger-v109.js';
import { verifyCloudBetEvidenceV110 } from '../../../lib/bet-evidence-verification-v110.js';
import { settlePendingAnalysisDirections } from '../../../lib/analysis-direction-history-v1.js';
import { checkRateLimit, originErrorResponse, rateLimitResponse, readJsonBody, requireApiAuth, validateSameOrigin } from '../../../lib/security.js';

const response = (bets, extra = {}) => NextResponse.json({
  ok: true,
  bets,
  stats: cloudBetStats(bets),
  calibration: buildCalibrationStatusFromBetsV109(bets),
  ...extra,
}, { headers: { 'Cache-Control': 'no-store' } });

export async function GET(request) {
  const auth = await requireApiAuth(request); if (auth) return auth;
  try { return response(await listCloudBets()); }
  catch { return NextResponse.json({ ok: false, error: '雲端下注紀錄讀取失敗' }, { status: 503 }); }
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
      const verification = await verifyCloudBetEvidenceV110(body.bet);
      if (verification.pitVerified !== true) {
        return NextResponse.json({
          ok: false,
          code: 'PIT_EVIDENCE_REQUIRED',
          error: `目前下注找不到同場最新不可變PIT證據：${verification.pitError || 'PIT_UNVERIFIED'}`,
        }, { status: 409, headers: { 'Cache-Control': 'no-store' } });
      }
      return response(await upsertCloudBet(body.bet, { verification }));
    }
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
    return NextResponse.json({ ok: false, code: error?.code || 'BET_LEDGER_WRITE_FAILED', error: error?.message || '雲端下注紀錄更新失敗' }, { status: Number(error?.status) || 400 });
  }
}
