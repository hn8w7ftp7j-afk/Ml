import { NextResponse } from 'next/server';
import { checkRateLimit, requireApiAuth } from '../../../../lib/security.js';
import { loadNbaData } from '../../../../lib/nba/data.js';
import { loadOfficialNbaEvidence } from '../../../../lib/nba/official.js';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
export async function GET(request) {
  const denied = await requireApiAuth(request); if (denied) return denied;
  const rate = checkRateLimit(request, { id: 'nba-official-evidence', limit: 12, windowMs: 60000 });
  if (!rate.allowed) return NextResponse.json({ error: '官方核對過於頻繁，請稍後再試。' }, { status: 429, headers: { 'Retry-After': String(rate.retryAfter), 'Cache-Control': 'no-store' } });
  const params = new URL(request.url).searchParams; const id = params.get('id');
  if (!/^[1-9]\d{0,11}$/.test(id || '') || (params.has('league') && params.get('league') !== 'NBA')) return NextResponse.json({ error: 'NBA 場次 ID 無效' }, { status: 400 });
  const result = await loadNbaData({ view: 'game', id });
  if (!result.data.game || result.qa.status === 'BLOCK') return NextResponse.json({ league: 'NBA', error: '基礎場次未通過核對', status: 'unavailable' }, { status: 502 });
  const evidence = await loadOfficialNbaEvidence(result.data.game, result.data.players);
  return NextResponse.json({ league: 'NBA', evidence }, { headers: { 'Cache-Control': 'no-store' } });
}
