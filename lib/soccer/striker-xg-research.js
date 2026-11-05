import { createHash } from 'node:crypto';

// Opt-in research connector only: never imported by the production scoring path.
// Provider xG is retroactively refitted using later seasons, so neither the data
// nor a retrieval timestamp makes historical xG a strict OOS/PIT observation.
export const STRIKER_RESEARCH_VERSION = 'STRIKER-EVENT-XG-RESEARCH-v1';
const endpoint = 'https://mcp.strikerapi.com/v1/get_events';
const hash = data => createHash('sha256').update(data).digest('hex');
const id = value => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value);
const flags = Object.freeze({ accepted: false, formalEligible: false, modelEffectApplied: false,
  executable: false, historicalAvailabilityVerified: false, strictOosEligible: false, W: null, R: null, S: null });
const publicScope = ({ league, gameId, homeTeamId, awayTeamId }) => ({ league, gameId, homeTeamId, awayTeamId });
const failure = code => ({ ok: false, version: STRIKER_RESEARCH_VERSION, code, ...flags });
const parseJson = text => JSON.parse(text.startsWith('\ufeff') ? text.slice(1) : text);
const validScope = scope => scope && ['epl', 'ucl'].includes(scope.league) && id(scope.gameId)
  && id(scope.homeTeamId) && id(scope.awayTeamId) && scope.homeTeamId !== scope.awayTeamId;

async function boundedBody(response, maximum) {
  const length = response.headers?.get?.('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > maximum)) throw Error('BODY_LIMIT');
  if (!response.body?.getReader) throw Error('BODY_STREAM_REQUIRED');
  const reader = response.body.getReader(), chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) { await reader.cancel(); throw Error('BODY_LIMIT'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
}

/** Explicitly enabled call only. No environment lookup, registration or retries.
 * Credit budget: up to maxPages * 10 credits; no partial data on any failure. */
export async function fetchStrikerEventPages({ enabled = false, apiKey, scope, fetchImpl = globalThis.fetch,
  maxPages = 3, pageSize = 300, timeoutMs = 10000 } = {}) {
  if (enabled !== true) return failure('STRIKER_DISABLED');
  if (!validScope(scope) || typeof apiKey !== 'string' || !apiKey.trim() || apiKey.length > 512
    || typeof fetchImpl !== 'function' || !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 5
    || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 300
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) return failure('STRIKER_REQUEST_INVALID');
  const pages = [], seen = new Set();
  let offset = 0;
  for (let i = 0; i < maxPages; i++) {
    if (seen.has(offset)) return failure('STRIKER_PAGINATION_INVALID');
    seen.add(offset);
    let response, rawBody;
    try {
      response = await fetchImpl(endpoint, { method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify({ game_id: scope.gameId, league: scope.league === 'epl' ? 'soccer' : 'ucl', kind: 'all', limit: pageSize, offset }),
        signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
      if (!response.ok) return failure('STRIKER_HTTP_ERROR');
      rawBody = await boundedBody(response, 1024 * 1024);
    } catch { return failure('STRIKER_FETCH_OR_BODY_ERROR'); }
    let data;
    try { data = parseJson(rawBody)?.data; } catch { return failure('STRIKER_JSON_INVALID'); }
    if (!data || !Array.isArray(data.events) || data.events.length > pageSize || !Number.isSafeInteger(data.count) || data.count < 0 || !Object.hasOwn(data, 'next_offset')
      || !(data.next_offset === null || Number.isSafeInteger(data.next_offset) && data.next_offset > offset)
      || data.next_offset !== null && (!data.events.length || data.next_offset !== offset + data.events.length)) return failure('STRIKER_PAGE_INVALID');
    pages.push({ offset, rawBody, sha256: hash(rawBody), fetchedAt: new Date().toISOString() });
    if (data.next_offset === null) return { ok: true, version: STRIKER_RESEARCH_VERSION,
      scope: publicScope(scope), pages, endpoint, estimatedCredits: pages.length * 10, ...flags };
    offset = data.next_offset;
  }
  return failure('STRIKER_PAGE_BUDGET_EXCEEDED');
}

/** Report only observed shots. Neither team IDs supplied by a caller nor a
 * same-provider count can independently prove match identity or coverage. */
export function summarizeStrikerEventPages({ capture, referenceShotCounts } = {}) {
  if (!capture?.ok || capture.version !== STRIKER_RESEARCH_VERSION || !validScope(capture.scope)
    || capture.endpoint !== endpoint || !Array.isArray(capture.pages) || !capture.pages.length || capture.pages.length > 5) return failure('STRIKER_CAPTURE_INVALID');
  const { scope } = capture, seen = new Set(), shots = [], gaps = [];
  let expectedOffset = 0;
  for (let i = 0; i < capture.pages.length; i++) {
    const page = capture.pages[i];
    if (page.offset !== expectedOffset || typeof page.rawBody !== 'string' || Buffer.byteLength(page.rawBody) > 1024 * 1024
      || hash(page.rawBody) !== page.sha256 || !Number.isFinite(Date.parse(page.fetchedAt))) return failure('STRIKER_CAPTURE_DOCUMENT_INVALID');
    let data;
    try { data = parseJson(page.rawBody)?.data; } catch { return failure('STRIKER_CAPTURE_DOCUMENT_INVALID'); }
    if (!data || !Array.isArray(data.events) || data.events.length > 300 || !Number.isSafeInteger(data.count) || data.count < 0 || !Object.hasOwn(data, 'next_offset')) return failure('STRIKER_CAPTURE_DOCUMENT_INVALID');
    if (i === capture.pages.length - 1 ? data.next_offset !== null : data.next_offset !== page.offset + data.events.length || !data.events.length) return failure('STRIKER_CAPTURE_PAGINATION_INVALID');
    expectedOffset = data.next_offset;
    for (const event of data.events) {
      if (!Number.isSafeInteger(event?.seq) || event.seq < 0 || seen.has(event.seq)) return failure('STRIKER_EVENT_DUPLICATE_OR_ID_INVALID');
      seen.add(event.seq);
      if (!event.shot) {
        if (['goal', 'shot'].includes(event.type) && event.own_goal !== true && event.shootout !== true) gaps.push('SHOT_DETAIL_MISSING');
        continue;
      }
      if (event.own_goal === true || event.shootout === true) continue;
      if (event.shootout !== false || event.own_goal !== false || ![1, 2, 3, 4].includes(event.period)
        || ![scope.homeTeamId, scope.awayTeamId].includes(event.team_id)
        || typeof event.shot.penalty !== 'boolean' || typeof event.shot.xg !== 'number'
        || !Number.isFinite(event.shot.xg) || event.shot.xg < 0 || event.shot.xg > 1) return failure('STRIKER_SHOT_VALUE_OR_IDENTITY_INVALID');
      if (![1, 2].includes(event.period)) continue;
      // Coordinate/outcome fields are optional; null explicitly means unusable
      // for a future independently fitted shot model, not a zero or a miss.
      const coordinate = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
      const text = value => typeof value === 'string' && value.length <= 80 ? value : null;
      shots.push({ seq: event.seq, teamId: event.team_id, period: event.period, penalty: event.shot.penalty, xg: event.shot.xg,
        x: coordinate(event.shot.x), y: coordinate(event.shot.y), outcome: text(event.shot.outcome), bodyPart: text(event.shot.body_part) });
    }
  }
  if (!shots.length) gaps.push('NO_REGULATION_SHOTS_OBSERVED');
  const sums = {};
  for (const [label, periods] of [['HT', [1]], ['FT', [1, 2]]]) {
    sums[label] = {};
    for (const [side, teamId] of [['home', scope.homeTeamId], ['away', scope.awayTeamId]]) {
      const selected = shots.filter(shot => shot.teamId === teamId && periods.includes(shot.period));
      sums[label][side] = { shots: selected.length, penaltyShots: selected.filter(shot => shot.penalty).length,
        xg: selected.reduce((sum, shot) => sum + shot.xg, 0), npxg: selected.filter(shot => !shot.penalty).reduce((sum, shot) => sum + shot.xg, 0) };
    }
  }
  let countComparison = 'NOT_PROVIDED';
  if (referenceShotCounts !== undefined) {
    if (!Number.isSafeInteger(referenceShotCounts?.home) || referenceShotCounts.home < 0
      || !Number.isSafeInteger(referenceShotCounts?.away) || referenceShotCounts.away < 0) return failure('STRIKER_REFERENCE_COUNTS_INVALID');
    countComparison = ['home', 'away'].every(side => sums.FT[side].shots === referenceShotCounts[side]) ? 'MATCHED_REGULATION_ASSUMED_NOT_VERIFIED' : 'MISMATCH';
    if (countComparison === 'MISMATCH') gaps.push('SHOT_COUNT_MISMATCH');
  }
  return { ok: true, version: STRIKER_RESEARCH_VERSION, provider: 'STRIKER_API', status: 'RESEARCH_OBSERVATION_INCOMPLETE',
    scope: publicScope(scope), observedPeriods: gaps.length ? null : sums, observedShots: shots, gaps, countComparison,
    identityIndependentlyVerified: false, regulationCompletenessVerified: false, sourceModelHistoricalLookahead: true,
    sourceModelNotice: 'PROVIDER_XG_REFITTED_WITH_LATER_SEASONS_NOT_STRICT_OOS',
    trainingNote: 'SHOT_COORDINATES_AND_OUTCOMES_ARE_OPTIONAL_NO_INDEPENDENT_MODEL_FITTED',
    sourceDocumentation: 'https://strikerapi.com/docs/timing-and-rights',
    sourcePages: capture.pages.map(({ offset, sha256, fetchedAt }) => ({ offset, sha256, fetchedAt })),
    originalDocumentsRetained: false, ...flags };
}
