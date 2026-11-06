import { NextResponse } from 'next/server';
import { requireApiAuth, validateSameOrigin, originErrorResponse, checkRateLimit, rateLimitResponse } from '../../../../lib/security.js';
import { validSoccerDate } from '../../../../lib/soccer/contracts.js';
import { startReaderInventoryScan, continueReaderInventoryScan } from '../../../../lib/soccer/reader-inventory-scan.js';
import { listReaderInventoryScans, resumeReaderInventoryScan, readerInventoryPublicId } from '../../../../lib/soccer/reader-inventory-recovery.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

const response = (body, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const inputError = (status = 400) => response({ ok: false, error: status === 413 ? '請求資料過大。' : '盤口清點請求格式不正確。' }, status);
const MAX_BODY_BYTES = 2048;

// The only valid input is a flat object of strings. Parsing keys explicitly
// rejects duplicate JSON keys, including alternate escaped spellings.
function parseInput(text) {
  let index = 0;
  const whitespace = () => { while (/[\u0020\t\r\n]/.test(text[index] || '\0')) index++; };
  const string = () => {
    const start = index;
    if (text[index++] !== '"') throw Error('INVALID_JSON');
    while (index < text.length) {
      const char = text[index++];
      if (char === '"') return JSON.parse(text.slice(start, index));
      if (char === '\\') index++;
    }
    throw Error('INVALID_JSON');
  };
  const result = Object.create(null), seen = new Set();
  whitespace(); if (text[index++] !== '{') throw Error('INVALID_JSON'); whitespace();
  if (text[index] !== '}') for (;;) {
    const key = string(); whitespace(); if (text[index++] !== ':') throw Error('INVALID_JSON'); whitespace();
    const value = string(); if (seen.has(key)) throw Error('INVALID_JSON'); seen.add(key); result[key] = value;
    whitespace(); if (text[index] === '}') break;
    if (text[index++] !== ',') throw Error('INVALID_JSON'); whitespace();
  }
  index++; whitespace(); if (index !== text.length) throw Error('INVALID_JSON');
  return result;
}

const REASONS = new Set(['READER_MANIFEST_ROW_BUDGET', 'READER_MANIFEST_ITEM_MISMATCH',
  'READER_MANIFEST_ITEM_MISSING', 'READER_ORIGINAL_RECEIPT_MISSING', 'READER_RECEIPT_BYTE_BUDGET',
  'READER_RECEIPT_INVALID_OR_CLOCK_CONFLICT', 'READER_PAGE_UNAVAILABLE', 'READER_SOURCE_READ_UNAVAILABLE',
  'READER_MANIFEST_SCOPE_BUDGET']);
function publicReport(report, scope, cursor, isStart) {
  const count = value => Number.isSafeInteger(value) && value >= 0;
  const overScopeBudget = isStart && report?.cursor === null && report.status === 'PARTIAL'
    && report.totalCount === null && report.observedCount === null && report.verifiedCount === 0
    && Array.isArray(report.reasonCodes) && report.reasonCodes.length === 1
    && report.reasonCodes[0] === 'READER_MANIFEST_SCOPE_BUDGET';
  if (!report || report.version !== 'SOCCER-READER-INVENTORY-SCAN-v1'
    || (!overScopeBudget && (!/^[a-f0-9]{48}$/.test(report.cursor) || report.cursor !== cursor))
    || report.league !== scope.league || report.date !== scope.date || !['RUNNING', 'COMPLETE', 'PARTIAL'].includes(report.status)
    || !(report.totalCount === null || count(report.totalCount)) || !count(report.verifiedCount) || (!overScopeBudget && !count(report.observedCount))
    || !Array.isArray(report.reasonCodes) || !report.reasonCodes.every(code => REASONS.has(code))) throw Error('INVALID_REPORT');
  return { version: report.version, cursor: report.cursor, league: scope.league, date: scope.date,
    status: report.status, totalCount: report.totalCount, verifiedCount: report.verifiedCount, observedCount: report.observedCount,
    reasonCodes: report.reasonCodes, scopeDescription: overScopeBudget ? 'NOT_STARTED_SCOPE_LIMIT' : 'READER_RECEIPTS_VISIBLE_AT_MANIFEST_STATEMENT_ONLY',
    identityScope: 'FULL_DATE_OFFICIAL_SCHEDULE_NOT_VERIFIED', identityVerified: false, formalEligible: false,
    calibrationEligible: false, promotionEligible: false, executable: false, OOS: false, selectedPairCount: null, W: null, R: null, S: null };
}

function publicRecoveryReport(entry, scope) {
  if (!entry || !/^[a-f0-9]{48}$/.test(entry.cursor || '')
    || readerInventoryPublicId(entry.cursor) !== entry.scanId
    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(entry.startedAt || '')
    || !Number.isFinite(Date.parse(entry.startedAt))) throw Error('INVALID_REPORT');
  const { cursor, ...report } = publicReport(entry.report, scope, entry.cursor, false);
  return { scanId: entry.scanId, startedAt: entry.startedAt, ...report };
}

// Read in bounded chunks: request.text() buffers the entire body before a size
// check and therefore does not protect this endpoint from oversized streams.
async function boundedJson(request) {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES))
    throw Object.assign(Error('BODY_INVALID'), { status: /^\d+$/.test(declared) ? 413 : 400 });
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '') || !request.body)
    throw Object.assign(Error('BODY_INVALID'), { status: 400 });
  const reader = request.body.getReader(), chunks = []; let size = 0, timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(Error('BODY_TIMEOUT'), { status: 408 })), 5000); });
  try {
    for (;;) {
      const part = await Promise.race([reader.read(), deadline]);
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) throw Object.assign(Error('BODY_INVALID'), { status: 400 });
      size += part.value.byteLength;
      if (size > MAX_BODY_BYTES) throw Object.assign(Error('BODY_TOO_LARGE'), { status: 413 });
      chunks.push(part.value);
    }
    const buffer = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return parseInput(text);
  } catch (error) {
    // Do not await cancellation: an uncooperative source must not hold the
    // function open after the deadline. No body bytes are returned or logged.
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
    try { reader.releaseLock(); } catch { /* outstanding read is being cancelled */ }
  }
}

export async function POST(request) {
  const denied = await requireApiAuth(request); if (denied) return denied;
  if (!validateSameOrigin(request)) return originErrorResponse();
  // A continuation credential belongs only in a POST body, never in a URL.
  if (new URL(request.url).search) return inputError();
  const rate = checkRateLimit(request, { id: 'soccer-reader-inventory-scan', limit: 40, windowMs: 60000 });
  if (!rate.allowed) return rateLimitResponse(rate);
  let body;
  try { body = await boundedJson(request); }
  catch (error) { return inputError(error?.status === 413 ? 413 : error?.status === 408 ? 408 : 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || !['epl', 'ucl'].includes(body.league)
    || !validSoccerDate(body.date) || !['start', 'continue', 'list', 'resume'].includes(body.action)) return inputError();
  const allowed = body.action === 'list' ? ['action', 'league', 'date']
    : body.action === 'resume' ? ['action', 'league', 'date', 'scanId'] : ['action', 'league', 'date', 'cursor'];
  if (Object.keys(body).some(key => !allowed.includes(key))
    || (['start', 'continue'].includes(body.action) && (typeof body.cursor !== 'string' || !/^[a-f0-9]{48}$/.test(body.cursor)))
    || (body.action === 'resume' && (typeof body.scanId !== 'string' || !/^[a-f0-9]{64}$/.test(body.scanId)))) return inputError();
  try {
    const scope = { league: body.league, date: body.date };
    if (body.action === 'list') {
      const result = await listReaderInventoryScans(scope);
      if (!Array.isArray(result.entries) || result.entries.length > 1000 || typeof result.complete !== 'boolean') throw Error('INVALID_REPORT');
      return response({ ok: true, reports: result.entries.map(entry => publicRecoveryReport(entry, scope)),
        complete: result.complete, reasonCodes: result.complete ? [] : ['READER_MANIFEST_LIST_TRUNCATED'] });
    }
    if (body.action === 'resume') {
      const entry = await resumeReaderInventoryScan({ ...scope, scanId: body.scanId });
      if (!entry) return response({ ok: false, error: '找不到此範圍的清點紀錄。' }, 404);
      if (entry.scanId !== body.scanId) throw Error('INVALID_REPORT');
      return response({ ok: true, report: publicRecoveryReport(entry, scope) });
    }
    const report = body.action === 'start' ? await startReaderInventoryScan({ ...scope, cursor: body.cursor })
      : await continueReaderInventoryScan({ ...scope, cursor: body.cursor });
    return response({ ok: true, report: publicReport(report, scope, body.cursor, body.action === 'start') });
  } catch {
    // Provider, database, tokens, payloads and body content are never reflected.
    return response({ ok: false, error: '盤口清點暫時無法完成，已保存資料不受影響。' }, 503);
  }
}
