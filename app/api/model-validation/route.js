import { NextResponse } from 'next/server';
import { requireApiAuth } from '../../../lib/security.js';
import { isLeagueId } from '../../../lib/leagues.js';
import { modelValidationLink } from '../../../lib/model-validation-registry.js';
export const dynamic = 'force-dynamic';
export async function GET(request) {
  const auth = await requireApiAuth(request); if (auth) return auth;
  const params = new URL(request.url).searchParams;
  const league = params.get('league'); const modelVersion = params.get('modelVersion');
  if (!isLeagueId(league) || !modelVersion || modelVersion.length > 180) return NextResponse.json({ ok: false, code: 'INVALID_MODEL_SCOPE' }, { status: 400 });
  return NextResponse.json({ ok: true, acceptance: modelValidationLink(league, modelVersion) }, { headers: { 'Cache-Control': 'no-store' } });
}
