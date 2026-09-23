import { NextResponse } from 'next/server';
import { requireApiAuth } from './security.js';

export async function researchRelocated(request, url) {
  const denied = await requireApiAuth(request);
  if (denied) { denied.headers.set('Cache-Control', 'no-store'); return denied; }
  return NextResponse.json({ ok: false, code: 'RESEARCH_MOVED', error: '研究回測已移至獨立研究站，請在新站查看或匯入。', url }, {
    status: 410, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}
