import { NextResponse } from 'next/server';
import { requireApiAuth, checkRateLimit } from '../../../../lib/security.js';
import { loadNbaData } from '../../../../lib/nba/data.js';
import { buildNbaPregame, saveNbaPregame, loadNbaPregame } from '../../../../lib/nba/pregame-store.js';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
async function handle(request, capture) {
  const denied = await requireApiAuth(request); if (denied) return denied;
  if (capture && request.headers.get('origin') !== new URL(request.url).origin) return NextResponse.json({ error: '來源不符' }, { status: 403 });
  const rate = checkRateLimit(request, { id: 'nba-pregame-snapshot', limit: 12, windowMs: 60000 });
  if (!rate.allowed) return NextResponse.json({ error: '快照操作過於頻繁' }, { status: 429, headers: { 'Retry-After': String(rate.retryAfter) } });
  const params = new URL(request.url).searchParams; const id = params.get('id'); if (!/^[1-9]\d{0,11}$/.test(id || '') || (params.has('league') && params.get('league') !== 'NBA')) return NextResponse.json({ error: 'NBA ID 無效' }, { status: 400 });
  try {
    if (!capture) return NextResponse.json({ league: 'NBA', snapshots: await loadNbaPregame(`nba:espn:game:${id}`) }, { headers: { 'Cache-Control': 'no-store' } });
    const [game, injuries] = await Promise.all([loadNbaData({ view: 'game', id }), loadNbaData({ view: 'injuries' })]);
    const snapshot = buildNbaPregame(game, injuries);
    const receipt = await saveNbaPregame(snapshot);
    return NextResponse.json({ league: 'NBA', snapshot, receipt }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return NextResponse.json({ league: 'NBA', error: error.code === 'PREGAME_INVALID' ? error.message : 'NBA 永久快照暫時無法讀寫；未標記保存成功。' }, { status: error.code === 'PREGAME_INVALID' ? 422 : 503, headers: { 'Cache-Control': 'no-store' } }); }
}
export const GET = request => handle(request, false);
export const POST = request => handle(request, true);
