import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function removedResponse() {
  return NextResponse.json({
    ok: false,
    code: 'VISION_IMPORT_REMOVED',
    error: '盤口圖片、文字與貼上上傳功能已取消；請只使用 Tai888 Reader 自動信用盤。',
  }, {
    status: 410,
    headers: { 'Cache-Control': 'no-store' },
  });
}

export async function GET() {
  return removedResponse();
}

export async function POST() {
  return removedResponse();
}
