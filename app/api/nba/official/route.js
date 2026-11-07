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
  const expectedScheduledStartTime = params.has('scheduledStartTime') ? params.get('scheduledStartTime') : undefined;
  const validScheduledTime = expectedScheduledStartTime === undefined || (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(expectedScheduledStartTime || '')
    && Number.isFinite(Date.parse(expectedScheduledStartTime)) && new Date(expectedScheduledStartTime).toISOString() === expectedScheduledStartTime);
  if (!/^[1-9]\d{0,11}$/.test(id || '') || (params.has('league') && params.get('league') !== 'NBA')
    || !validScheduledTime || params.getAll('scheduledStartTime').length > 1) return NextResponse.json({ error: 'NBA 場次或預定時間無效' }, { status: 400 });
  const result = await loadNbaData({ view: 'game', id });
  if (!result.data.game || result.qa.status === 'BLOCK') return NextResponse.json({ league: 'NBA', error: '基礎場次未通過核對', status: 'unavailable' }, { status: 502 });
  // Optional final-result diagnosis is read-only. Settlement itself obtains the
  // original time from the saved contract, never from this query parameter.
  const evidence = await loadOfficialNbaEvidence(result.data.game,
    expectedScheduledStartTime === undefined ? result.data.players : [], { expectedScheduledStartTime });
  return NextResponse.json({ league: 'NBA', evidence }, { headers: { 'Cache-Control': 'no-store' } });
}
