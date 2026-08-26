import { NextResponse } from 'next/server';
import { loadAnalysisDirectionStats } from '../../../../lib/analysis-direction-history-v1.js';
import { requestedLeagueId } from '../../../../lib/leagues.js';
import { checkRateLimit, rateLimitResponse, requireApiAuth } from '../../../../lib/security.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MARKETS = new Set(['全場讓分', '全場大小', '上半讓分', '上半大小']);
const R_SIGNS = new Set(['POSITIVE', 'NON_POSITIVE', 'MISSING']);
const LINE_TYPES = new Set(['FLAT_ZERO', 'SPLIT_LINE', 'TAIL_LINE', 'STANDARD']);

function optionalNumber(params, name) {
  const raw = params.get(name);
  if (raw == null || raw.trim() === '') return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name}必須是有限數值`);
  return value;
}

export async function GET(request) {
  const auth = await requireApiAuth(request);
  if (auth) return auth;
  const rate = checkRateLimit(request, { id: 'analysis-direction-stats-v1', limit: 60, windowMs: 10 * 60 * 1000 });
  if (!rate.allowed) return rateLimitResponse(rate);
  try {
    const params = new URL(request.url).searchParams;
    const suppliedLeague = String(params.get('league') || '').trim();
    const league = suppliedLeague ? requestedLeagueId(suppliedLeague) : '';
    if (suppliedLeague && !league) throw new Error('不支援的聯盟');
    const market = String(params.get('market') || '').trim();
    if (market && !MARKETS.has(market)) throw new Error('不支援的市場');
    const rSign = String(params.get('rSign') || '').trim().toUpperCase();
    if (rSign && !R_SIGNS.has(rSign)) throw new Error('rSign必須是POSITIVE、NON_POSITIVE或MISSING');
    const lineType = String(params.get('lineType') || '').trim().toUpperCase();
    if (lineType && !LINE_TYPES.has(lineType)) throw new Error('不支援的盤口類型');
    const qaStatus = String(params.get('qaStatus') || '').trim().toUpperCase().slice(0, 80);
    const stats = await loadAnalysisDirectionStats({
      league,
      market,
      wMin: optionalNumber(params, 'wMin'),
      wMax: optionalNumber(params, 'wMax'),
      rSign,
      qaStatus,
      lineType,
      minLeadMinutes: optionalNumber(params, 'minLeadMinutes'),
      maxLeadMinutes: optionalNumber(params, 'maxLeadMinutes'),
    });
    return NextResponse.json({ ok: true, filters: {
      league: league || null, market: market || null, rSign: rSign || null,
      qaStatus: qaStatus || null, lineType: lineType || null,
    }, stats }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error?.message || error) }, {
      status: /DATABASE_URL/.test(String(error?.message || '')) ? 503 : 400,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}
