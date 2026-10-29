import { NextResponse } from 'next/server';
import { requireApiAuth, checkRateLimit, rateLimitResponse } from '../../../../lib/security.js';
import { readSoccerReaderInventory } from '../../../../lib/soccer/reader-inventory.js';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;
const response = (body, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
export async function GET(request) {
  const denied = await requireApiAuth(request); if (denied) return denied;
  const rate = checkRateLimit(request, { id: 'soccer-reader-inventory', limit: 60, windowMs: 60000 });
  if (!rate.allowed) return rateLimitResponse(rate);
  try {
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some(key => !['league', 'from', 'through'].includes(key) || params.getAll(key).length !== 1))
      return response({ ok: false, error: '足球原盤庫存查詢欄位無效。', formalEligible: false, executable: false }, 400);
    return response(await readSoccerReaderInventory(Object.fromEntries(params)));
  } catch (error) {
    return response({ ok: false, error: error.status === 400 ? error.message : '原盤保存紀錄暫時無法讀取，目前筆數未知。',
      formalEligible: false, executable: false }, error.status === 400 ? 400 : 503);
  }
}
