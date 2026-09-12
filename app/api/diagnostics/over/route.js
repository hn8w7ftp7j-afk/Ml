import { NextResponse } from 'next/server';
import { requireApiAuth } from '../../../../lib/security.js';
import { createOverDiagnosticSummary, gameSourceEvidence, OVER_DIAGNOSTIC_MAX_RESPONSE_BYTES, readOverDiagnosticAsset } from '../../../../lib/over-diagnostic-data.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store', 'X-Diagnostic-Mode': 'READ_ONLY_REPLAY', 'X-Content-Type-Options': 'nosniff' };
const json = (body, status = 200) => {
  if (Buffer.byteLength(JSON.stringify(body)) >= OVER_DIAGNOSTIC_MAX_RESPONSE_BYTES) throw new Error('DIAGNOSTIC_RESPONSE_TOO_LARGE');
  return NextResponse.json(body, { status, headers });
};

export async function GET(request) {
  const auth = await requireApiAuth(request);
  if (auth) {
    auth.headers.set('Cache-Control', 'no-store');
    return auth;
  }
  const query = new URL(request.url).searchParams;
  const gameId = query.get('gameId');
  const download = query.get('download');
  if ([...query.keys()].some(key => !['gameId', 'download'].includes(key))
    || ['gameId', 'download'].some(key => query.getAll(key).length > 1)
    || (gameId !== null && !/^[1-9]\d{0,11}$/.test(gameId))
    || (download !== null && download !== '1') || (gameId !== null && download !== null)) {
    return json({ ok: false, code: 'DIAGNOSTIC_QUERY_INVALID', error: '請提供單一有效賽事 ID，或選擇下載診斷檔。' }, 400);
  }
  try {
    const asset = await readOverDiagnosticAsset();
    if (download === '1') {
      // Keep the gzip file intact. This is not HTTP content-encoding, which browsers decompress.
      return new Response(asset.gzip, { headers: {
        ...headers, 'Content-Type': 'application/gzip',
        'Content-Disposition': 'attachment; filename="MLB-over-diagnostic-v1.json.gz"',
        'Content-Length': String(asset.gzip.length), 'X-Artifact-SHA256': asset.integrity.sha256,
      } });
    }
    if (gameId !== null) {
      const game = asset.data.games.find(row => String(row.gameId) === gameId);
      if (!game) return json({ ok: false, code: 'DIAGNOSTIC_GAME_NOT_FOUND', error: '這場賽事不在本次凍結大分診斷資料內。' }, 404);
      return json({ ok: true, data: { manifest: asset.data.manifest, game, sourceEvidenceCatalog: gameSourceEvidence(asset.data, game) }, integrity: asset.integrity });
    }
    return json({ ok: true, data: createOverDiagnosticSummary(asset.data), integrity: asset.integrity });
  } catch (error) {
    const code = error?.code === 'ENOENT' ? 'DIAGNOSTIC_DATA_NOT_AVAILABLE' : 'DIAGNOSTIC_DATA_INVALID';
    return json({ ok: false, code, error: code === 'DIAGNOSTIC_DATA_NOT_AVAILABLE'
      ? '診斷資料尚未提供，沒有代填數據。' : '診斷檔校驗或格式不符，暫停顯示，請重新匯出。' }, 503);
  }
}
