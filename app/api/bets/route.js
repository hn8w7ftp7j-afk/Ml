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
import { checkRateLimit, originErrorResponse, rateLimitResponse, readJsonBody, requireApiAuth, validateSameOrigin } from '../../../lib/security.js';

const response = bets => NextResponse.json({
  ok: true,
  bets,
  stats: cloudBetStats(bets),
  calibration: buildCalibrationStatusFromBetsV109(bets),
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
    if (body.action === 'settleOpen') return response(await settleOpenCloudBets({ league: body.league, limit: 500 }));
    return NextResponse.json({ ok: false, error: '不支援的下注紀錄操作' }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ ok: false, code: error?.code || 'BET_LEDGER_WRITE_FAILED', error: error?.message || '雲端下注紀錄更新失敗' }, { status: Number(error?.status) || 400 });
  }
}
