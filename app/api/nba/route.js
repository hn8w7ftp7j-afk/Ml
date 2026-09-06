import { NextResponse } from 'next/server';
import { checkRateLimit, requireApiAuth } from '../../../lib/security.js';
import { loadNbaData } from '../../../lib/nba/data.js';
import { analyzeNbaHistory } from '../../../lib/nba/research.js';
import { NBA_MODULE_VERSION } from '../../../lib/nba/config.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const VIEWS = new Set(['schedule', 'teams', 'game', 'team', 'player', 'injuries', 'history']);

export async function GET(request) {
  const denied = await requireApiAuth(request);
  if (denied) return denied;
  const rate = checkRateLimit(request, { id: 'nba-sports-data', limit: 90, windowMs: 60_000 });
  if (!rate.allowed) return NextResponse.json({ error: '讀取太頻繁，請稍後再試。' }, { status: 429, headers: { 'Retry-After': String(rate.retryAfter), 'Cache-Control': 'no-store' } });
  const params = new URL(request.url).searchParams;
  const view = params.get('view') || 'schedule';
  const date = params.get('date') || undefined;
  const id = params.get('id') || undefined;
  const seasonText = params.get('season');
  const season = seasonText == null ? undefined : Number(seasonText);
  const seasonType = params.get('seasonType') || 'regular';
  const validDate = !date || (/^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date);
  const idKind = view === 'game' ? 'game' : view === 'player' ? 'player' : 'team';
  const validId = !id || new RegExp(`^(?:nba:espn:${idKind}:)?[1-9]\\d{0,11}$`).test(id);
  const validSeason = season === undefined || (/^\d{4}$/.test(seasonText) && season >= 1947 && season <= new Date().getUTCFullYear() + 1);
  if (!VIEWS.has(view) || !validDate || !validId || !validSeason || !['regular', 'preseason', 'postseason'].includes(seasonType)
    || (['game', 'team', 'player', 'history'].includes(view) && !id)
    || (view === 'history' && season === undefined)
    || (params.has('league') && params.get('league') !== 'NBA')) {
    return NextResponse.json({ league: 'NBA', error: 'NBA 查詢參數無效，請確認日期、球季與識別碼。' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  }
  try {
    const result = await loadNbaData({ view, date, id, season, seasonType });
    return NextResponse.json({ ...result, ...(view === 'history' ? { research: analyzeNbaHistory(result.data.games, { seasonType }) } : {}) }, { headers: { 'Cache-Control': 'no-store', 'X-NBA-Module': NBA_MODULE_VERSION } });
  } catch (error) {
    const status = Number(error?.status);
    return NextResponse.json({ league: 'NBA', status: 'unavailable', error: status === 400 ? 'NBA 查詢參數無效。' : 'NBA 資料暫時無法取得，請稍後重試。', code: error?.code || 'NBA_DATA_UNAVAILABLE' }, { status: status === 400 ? 400 : 502, headers: { 'Cache-Control': 'no-store' } });
  }
}
