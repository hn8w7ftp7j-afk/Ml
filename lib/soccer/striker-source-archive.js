import { createHash, randomUUID } from 'node:crypto';
import { fetchStrikerEventPages, summarizeStrikerEventPages } from './striker-xg-research.js';
import { reserveStrikerCredits } from './striker-credit-budget.js';

// Research-only server primitive. There is deliberately no route, cron, or
// scoring import. The source key never enters the database or a result object.
const ENDPOINT = 'https://mcp.strikerapi.com/v1/get_events';
const VERSION = 'SOCCER-STRIKER-SOURCE-ARCHIVE-v1';
const flags = Object.freeze({ historicalAvailabilityVerified: false, strictOosEligible: false,
  independentlyConfirmed: false, completenessVerified: false, providerRightsVerified: false, providerBalanceVerified: false, formalEligible: false, executable: false });
const bytesHash = text => createHash('sha256').update(text, 'utf8').digest('hex');
const canonical = value => JSON.stringify(value, (_k, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const seal = value => bytesHash(canonical(value));
const fail = reason => ({ ok: false, version: VERSION, reason, ...flags });
const handles = new WeakMap();
function containsSecret(body, secret) {
  if (body.includes(secret)) return true;
  let root;
  try { root = JSON.parse(body.startsWith('\ufeff') ? body.slice(1) : body); } catch { return true; }
  const pending = [root]; let visited = 0;
  while (pending.length) {
    if (++visited > 100000) return true;
    const node = pending.pop();
    if (typeof node === 'string' && node.includes(secret)) return true;
    if (node && typeof node === 'object') for (const [key, value] of Object.entries(node)) {
      if (key.includes(secret)) return true;
      pending.push(value);
    }
  }
  return false;
}

const trustedFetch = globalThis.fetch?.bind(globalThis);
const scopeFields = value => ({ league: value.league, gameId: value.gameId, homeTeamId: value.homeTeamId, awayTeamId: value.awayTeamId });
const journal = () => import('./journal.js');
const query = async (...args) => (await journal()).soccerJournalQuery(...args);
const transaction = async (...args) => (await journal()).soccerJournalTransaction(...args);
let ready;
async function ensureStore() {
  return ready ||= (async () => {
    await (await journal()).ensureSoccerJournal();
    await transaction([
      ['SELECT pg_advisory_xact_lock(221019,2310)'],
      [`CREATE TABLE IF NOT EXISTS sports_soccer_striker_documents_v1 (
        content_hash TEXT PRIMARY KEY CHECK (content_hash ~ '^[a-f0-9]{64}$'),
        document_data BYTEA NOT NULL, document_bytes INTEGER NOT NULL CHECK (document_bytes>0 AND document_bytes<=1048576 AND octet_length(document_data)=document_bytes),
        representation TEXT NOT NULL CHECK (representation='FETCH_DECODED_UTF8_BODY_BYTES'), recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())`],
      [`CREATE TABLE IF NOT EXISTS sports_soccer_striker_observations_v1 (
        receipt_id TEXT PRIMARY KEY CHECK (receipt_id ~ '^[a-f0-9]{64}$'),
        request_id UUID NOT NULL UNIQUE REFERENCES sports_soccer_striker_credit_reservations_v1(request_id),
        content_hash TEXT NOT NULL REFERENCES sports_soccer_striker_documents_v1(content_hash),
        capture_id UUID NOT NULL, page_index INTEGER NOT NULL CHECK (page_index>=0 AND page_index<5),
        league TEXT NOT NULL CHECK (league IN ('epl','ucl')), game_id TEXT NOT NULL,
        fetched_at TIMESTAMPTZ NOT NULL, binding JSONB NOT NULL, recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        UNIQUE(capture_id,page_index), CHECK (fetched_at<=recorded_at))`],
      ...['documents', 'observations'].map(name => [`CREATE OR REPLACE TRIGGER sports_soccer_immutable_v2
        BEFORE UPDATE OR DELETE ON sports_soccer_striker_${name}_v1
        FOR EACH ROW EXECUTE FUNCTION sports_soccer_immutable_v2()`]),
    ]);
  })().catch(error => { ready = null; throw error; });
}

/** All switches and secrets are server configuration, never request input.
 * Quota reservation precedes every network request, and failures do not refund. */
export async function captureStrikerResearch(scope) {
  if (process.env.SOCCER_STRIKER_RESEARCH_ENABLED !== 'true') return fail('STRIKER_ARCHIVE_DISABLED');
  // Never retain a caller-owned mutable object across awaits or page requests.
  try { scope = Object.freeze(scopeFields(scope)); } catch { return fail('STRIKER_SCOPE_INVALID'); }
  const apiKey = process.env.SOCCER_STRIKER_API_KEY;
  const budgetId = process.env.SOCCER_STRIKER_BUDGET_ID;
  const windowStart = process.env.SOCCER_STRIKER_BUDGET_WINDOW_START;
  if (!apiKey || !budgetId || !windowStart || typeof trustedFetch !== 'function') return fail('STRIKER_CONFIG_MISSING');
  const captureId = randomUUID(), requests = [];
  // fetchStrikerEventPages supplies its own fixed endpoint/body and bounds. This
  // wrapper verifies them again before pessimistically charging a reservation.
  const sourceFetch = async (url, init) => {
    let body;
    try { body = JSON.parse(init.body); } catch { throw Error('REQUEST_INVALID'); }
    if (url !== ENDPOINT || init.method !== 'POST' || init.redirect !== 'error' || body.game_id !== scope?.gameId
      || body.league !== (scope?.league === 'epl' ? 'soccer' : 'ucl') || body.kind !== 'all'
      || !Number.isSafeInteger(body.offset) || body.offset < 0 || !Number.isSafeInteger(body.limit) || body.limit > 300
      || init.headers?.['x-api-key'] !== apiKey) throw Error('REQUEST_INVALID');
    const requestId = randomUUID();
    const signal = init.signal;
    let abortHandler;
    const deadline = new Promise((_, reject) => {
      abortHandler = () => reject(Error('REQUEST_DEADLINE_EXPIRED'));
      if (signal?.aborted) abortHandler();
      else signal?.addEventListener('abort', abortHandler, { once: true });
    });
    let reservation;
    try { reservation = await Promise.race([reserveStrikerCredits({ enabled: true, budgetId, windowStart, requestId, credits: 10 }), deadline]); }
    finally { signal?.removeEventListener('abort', abortHandler); }
    if (reservation?.allowed !== true || reservation.status !== 'RESERVED') throw Error('CREDIT_RESERVATION_REJECTED');
    requests.push({ requestId, budgetId, windowStart, requestedAt: new Date().toISOString(), offset: body.offset, limit: body.limit });
    if (init.signal?.aborted) throw Error('REQUEST_DEADLINE_EXPIRED');
    const response = await trustedFetch(url, { ...init, headers: { ...init.headers, 'x-request-id': requestId } });
    if (response.redirected || response.url !== ENDPOINT || !/^application\/json(?:\s*;|$)/i.test(response.headers?.get('content-type') || '')) throw Error('SOURCE_RESPONSE_INVALID');
    return response;
  };
  const capture = await fetchStrikerEventPages({ enabled: true, apiKey, scope, fetchImpl: sourceFetch, maxPages: 3, pageSize: 300, timeoutMs: 10000 });
  if (!capture.ok) return fail(capture.code || 'STRIKER_CAPTURE_FAILED');
  const summary = summarizeStrikerEventPages({ capture });
  if (!summary.ok || requests.length !== capture.pages.length || capture.pages.some((page, index) => page.offset !== requests[index].offset
    || containsSecret(page.rawBody, apiKey) || page.rawBody.includes('\u0000'))) return fail('STRIKER_CAPTURE_INTEGRITY_INVALID');
  const binding = { version: VERSION, captureId, provider: 'STRIKER_API', endpoint: ENDPOINT,
    scope: scopeFields(scope), pageCount: capture.pages.length, representation: 'FETCH_DECODED_UTF8_BODY_BYTES',
    sourceModelNotice: 'PROVIDER_XG_REFITTED_WITH_LATER_SEASONS_NOT_STRICT_OOS', ...flags };
  const result = { ok: true, version: VERSION, captureId, scope: scopeFields(scope), pageCount: capture.pages.length,
    status: 'PRIVATE_RESEARCH_CAPTURE_NOT_ARCHIVED', creditLimitScope: 'LOCAL_CONFIGURED_SUB_BUDGET_NOT_PROVIDER_ACCOUNT_LIMIT', ...flags };
  handles.set(result, { binding, capture, requests, handleHash: seal(result) });
  return result;
}

/** Persist only private same-process captures; cloned or modified handles fail.
 * A database receipt proves archival time, not match identity, completeness,
 * source availability before a historical match, or model acceptance. */
export async function archiveStrikerResearch(handle) {
  const proof = handles.get(handle);
  if (!proof || seal(handle) !== proof.handleHash) return fail('STRIKER_PRIVATE_FETCH_PROOF_MISSING');
  const { binding, capture, requests } = proof;
  const entries = capture.pages.map((page, index) => {
    const b = { ...binding, pageIndex: index, offset: page.offset, limit: requests[index].limit,
      requestId: requests[index].requestId, requestedAt: requests[index].requestedAt, budgetId: requests[index].budgetId, windowStart: requests[index].windowStart, reservedCredits: 10, contentHash: page.sha256, fetchedAt: page.fetchedAt };
    return { binding: b, receiptId: seal(b), text: page.rawBody, bytes: Buffer.byteLength(page.rawBody, 'utf8') };
  });
  if (entries.some(entry => !entry.bytes || entry.bytes > 1048576 || bytesHash(entry.text) !== entry.binding.contentHash
    || !Number.isFinite(Date.parse(entry.binding.requestedAt)) || Date.parse(entry.binding.requestedAt) > Date.parse(entry.binding.fetchedAt))) return fail('STRIKER_PAGE_HASH_INVALID');
  try {
    await ensureStore();
    const statements = [];
    for (const entry of entries) {
      const b = entry.binding;
      statements.push([`INSERT INTO sports_soccer_striker_documents_v1(content_hash,document_data,document_bytes,representation)
        VALUES($1,decode($2,'hex'),$3,$4) ON CONFLICT DO NOTHING`, [b.contentHash, Buffer.from(entry.text,'utf8').toString('hex'), entry.bytes, b.representation]]);
      statements.push([`INSERT INTO sports_soccer_striker_observations_v1(receipt_id,request_id,content_hash,capture_id,page_index,league,game_id,fetched_at,binding)
        VALUES($1,$2::uuid,$3,$4::uuid,$5,$6,$7,$8::timestamptz,$9::jsonb) ON CONFLICT DO NOTHING`,
      [entry.receiptId, b.requestId, b.contentHash, b.captureId, b.pageIndex, b.scope.league, b.scope.gameId, b.fetchedAt, JSON.stringify(b)]]);
    }
    await transaction(statements);
    const rows = await query(`SELECT o.receipt_id,o.binding,o.recorded_at,o.fetched_at,d.content_hash,encode(d.document_data,'hex') AS document_hex,d.document_bytes,d.representation,
      r.request_id,r.budget_id,r.window_start,r.credits,
      date_trunc('milliseconds',o.recorded_at)+CASE WHEN o.recorded_at>date_trunc('milliseconds',o.recorded_at) THEN interval '1 millisecond' ELSE interval '0 milliseconds' END AS recorded_at_upper_bound,
      (d.recorded_at<=o.recorded_at) AS document_available, (o.fetched_at<=o.recorded_at) AS source_available
      FROM sports_soccer_striker_observations_v1 o JOIN sports_soccer_striker_documents_v1 d USING(content_hash)
      JOIN sports_soccer_striker_credit_reservations_v1 r ON r.request_id=o.request_id
      WHERE o.capture_id=$1::uuid ORDER BY o.page_index`, [binding.captureId]);
    if (rows.length !== entries.length || rows.some((row, index) => {
      const e = entries[index];
      return row.receipt_id !== e.receiptId || seal(row.binding) !== e.receiptId || row.content_hash !== e.binding.contentHash
        || row.document_hex !== Buffer.from(e.text,'utf8').toString('hex') || bytesHash(Buffer.from(row.document_hex,'hex')) !== row.content_hash
        || Number(row.document_bytes) !== e.bytes || row.representation !== 'FETCH_DECODED_UTF8_BODY_BYTES'
        || row.document_available !== true || row.source_available !== true
        || row.request_id !== e.binding.requestId || row.budget_id !== e.binding.budgetId || Number(row.credits) !== 10
        || new Date(row.window_start).toISOString() !== e.binding.windowStart
        || new Date(row.fetched_at).toISOString() !== e.binding.fetchedAt || new Date(row.recorded_at).getTime() < Date.parse(e.binding.fetchedAt);
    })) return fail('STRIKER_ARCHIVE_READBACK_FAILED');
    return { ok: true, version: VERSION, status: 'ARCHIVED_RESEARCH_ONLY', captureId: binding.captureId,
      receipts: rows.map(row => ({ receiptId: row.receipt_id, contentHash: row.content_hash,
        recordedAt: new Date(row.recorded_at).toISOString(), recordedAtUpperBound: new Date(row.recorded_at_upper_bound).toISOString(), fetchedAt: new Date(row.fetched_at).toISOString() })),
      representation: binding.representation, sourceModelNotice: binding.sourceModelNotice, ...flags };
  } catch { return fail('STRIKER_ARCHIVE_UNAVAILABLE'); }
}

/** Internal audit only. No HTTP route exposes these licensed source documents.
 * Recheck every page, binding, reservation and source clock after process restart.
 * A successful audit is never a historical PIT or xG completeness approval. */
export async function loadStrikerResearchCapture(captureId) {
  if (typeof captureId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(captureId)) return fail('STRIKER_CAPTURE_ID_INVALID');
  try {
    // Needed on a fresh process before archive DDL references reservation table.
    await (await import('./striker-credit-budget.js')).ensureStrikerCreditBudgetStore();
    await ensureStore();
    const rows = await query(`SELECT o.receipt_id,o.binding,o.recorded_at,o.fetched_at,o.page_index,o.league,o.game_id,
      d.content_hash,encode(d.document_data,'hex') AS document_hex,d.document_bytes,d.representation,r.request_id,r.budget_id,r.window_start,r.credits,
      date_trunc('milliseconds',o.recorded_at)+CASE WHEN o.recorded_at>date_trunc('milliseconds',o.recorded_at) THEN interval '1 millisecond' ELSE interval '0 milliseconds' END AS recorded_at_upper_bound,
      (d.recorded_at<=o.recorded_at) AS document_available,(o.fetched_at<=o.recorded_at) AS source_available
      FROM sports_soccer_striker_observations_v1 o JOIN sports_soccer_striker_documents_v1 d USING(content_hash)
      JOIN sports_soccer_striker_credit_reservations_v1 r ON r.request_id=o.request_id
      WHERE o.capture_id=$1::uuid ORDER BY o.page_index LIMIT 6`, [captureId]);
    if (!rows.length || rows.length > 5) return fail('STRIKER_AUDIT_NOT_FOUND_OR_INCOMPLETE');
    const first = rows[0].binding, scope = first?.scope;
    if (!scope || !['epl', 'ucl'].includes(scope.league) || ![scope.gameId, scope.homeTeamId, scope.awayTeamId].every(value => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value))
      || scope.homeTeamId === scope.awayTeamId || first.pageCount !== rows.length) return fail('STRIKER_AUDIT_SCOPE_INVALID');
    const common = b => ({ version: b.version, captureId: b.captureId, provider: b.provider, endpoint: b.endpoint,
      scope: b.scope, pageCount: b.pageCount, representation: b.representation, sourceModelNotice: b.sourceModelNotice,
      ...Object.fromEntries(Object.keys(flags).map(key => [key, b[key]])) });
    const required = { version: VERSION, captureId, provider: 'STRIKER_API', endpoint: ENDPOINT,
      scope: scopeFields(scope), pageCount: rows.length, representation: 'FETCH_DECODED_UTF8_BODY_BYTES',
      sourceModelNotice: 'PROVIDER_XG_REFITTED_WITH_LATER_SEASONS_NOT_STRICT_OOS', ...flags };
    if (canonical(common(first)) !== canonical(required)) return fail('STRIKER_AUDIT_BINDING_INVALID');
    const pages = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i], b = row.binding;
      if (canonical(common(b)) !== canonical(required) || b.pageIndex !== i || Number(row.page_index) !== i
        || row.league !== scope.league || row.game_id !== scope.gameId || seal(b) !== row.receipt_id
        || row.request_id !== b.requestId || row.budget_id !== b.budgetId || new Date(row.window_start).toISOString() !== b.windowStart
        || !Number.isFinite(Date.parse(b.requestedAt)) || Date.parse(b.requestedAt) > Date.parse(b.fetchedAt)
        || Number(row.credits) !== 10 || b.reservedCredits !== 10 || row.document_available !== true || row.source_available !== true
        || row.representation !== required.representation || b.contentHash !== row.content_hash
        || typeof row.document_hex !== 'string' || !/^(?:[a-f0-9]{2})+$/.test(row.document_hex) || row.document_hex.length / 2 !== Number(row.document_bytes)
        || Number(row.document_bytes) < 1 || Number(row.document_bytes) > 1048576 || bytesHash(Buffer.from(row.document_hex,'hex')) !== row.content_hash
        || new Date(row.fetched_at).toISOString() !== b.fetchedAt || new Date(row.recorded_at).getTime() < Date.parse(b.fetchedAt)) return fail('STRIKER_AUDIT_DOCUMENT_INVALID');
      const rawBody = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.from(row.document_hex,'hex'));
      pages.push({ offset: b.offset, rawBody, sha256: b.contentHash, fetchedAt: b.fetchedAt });
    }
    const source = { ok: true, version: 'STRIKER-EVENT-XG-RESEARCH-v1', endpoint: ENDPOINT, scope: scopeFields(scope), pages };
    if (!summarizeStrikerEventPages({ capture: source }).ok) return fail('STRIKER_AUDIT_PAGINATION_INVALID');
    return { ok: true, version: VERSION, status: 'ARCHIVED_RESEARCH_AUDIT_ONLY', captureId, scope: scopeFields(scope),
      documents: pages, receipts: rows.map(row => ({ receiptId: row.receipt_id, recordedAt: new Date(row.recorded_at).toISOString(),
        recordedAtUpperBound: new Date(row.recorded_at_upper_bound).toISOString() })),
      sourceModelNotice: required.sourceModelNotice, ...flags };
  } catch { return fail('STRIKER_AUDIT_UNAVAILABLE'); }
}
