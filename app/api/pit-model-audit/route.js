import { hydrateAsianSourceEvidence } from '../../../lib/asian-source-store-v1.js';
import { NextResponse } from 'next/server';
import { requireApiAuth, checkRateLimit, rateLimitResponse } from '../../../lib/security.js';
import { loadAnalysisPitReplay } from '../../../lib/analysis-pit-snapshot-store-v1.js';
import { auditSavedAsianPit } from '../../../lib/saved-asian-pit-audit.js';
import { auditSavedPitModel } from '../../../lib/saved-pit-model-audit.js';

export const runtime = 'nodejs';
export const maxDuration = 60;
const json = (body, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export async function GET(request) {
  const auth = await requireApiAuth(request); if (auth) return auth;
  const snapshotId = new URL(request.url).searchParams.get('snapshotId') || '';
  const match = /^(MLB|NPB|KBO|CPBL):([1-9]\d{0,15}):(FULL|PRICE_ONLY_REPRICE):[a-f0-9]{64}$/.exec(snapshotId);
  if (!match || !Number.isSafeInteger(Number(match[2]))) return json({ ok: false, code: 'INVALID_BASEBALL_SNAPSHOT_ID' }, 400);
  const rate = checkRateLimit(request, { id: 'pit-model-audit', limit: 6, windowMs: 60_000 });
  if (!rate.allowed) return rateLimitResponse(rate);
  try {
    const bundle = await loadAnalysisPitReplay({ league: match[1], snapshotId, expected: { gamePk: Number(match[2]) } });
    return json({ ok: true, audit: match[1] === 'MLB' ? auditSavedPitModel(bundle) : auditSavedAsianPit({ ...bundle, frozenContext: await hydrateAsianSourceEvidence(bundle.frozenContext) }) });
  } catch (error) {
    // Do not expose database connection details or private provider payloads.
    console.error('[PIT_MODEL_AUDIT_FAILED]', { name: error?.name, code: error?.code || null });
    return json({ ok: false, code: 'SAVED_PIT_AUDIT_UNAVAILABLE',
      message: '原始快照讀取、完整性檢查或重播未完成；不能宣稱模型驗證通過。' }, 409);
  }
}
