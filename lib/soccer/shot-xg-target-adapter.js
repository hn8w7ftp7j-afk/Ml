import { createHash, randomUUID } from 'node:crypto';

// Research only. No route, scheduler, environment lookup, or scoring import.
export const SHOT_XG_TARGET_ADAPTER_VERSION = 'SOCCER-SHOT-XG-TARGET-ADAPTER-v1';
export const STRIKER_SHOT_MAP_ENDPOINT = 'https://mcp.strikerapi.com/v1/get_shot_map';
export const STRIKER_SHOT_MAP_FRAME = Object.freeze({
  provider: 'STRIKER_API', endpoint: STRIKER_SHOT_MAP_ENDPOINT,
  contract: 'STRIKER_GET_SHOT_MAP_GOAL_DISTANCE_HALF_PITCH-v1',
  xUnit: 'DISTANCE_FROM_TARGET_GOAL_LINE_DIVIDED_BY_HALF_PITCH_LENGTH',
  yUnit: 'PITCH_WIDTH_FRACTION', centreY: 0.5, documentedPenaltySpotX: 0.23,
  inferredFullPitchX: '1 - nativeX / 2', inferredNativeXBounds: Object.freeze([0, 2]),
  nativeYBounds: Object.freeze([0, 1]),
  conversionStatus: 'DOCUMENTATION_INFERENCE_NOT_PROVIDER_VERIFIED',
  documentationUrl: 'https://strikerapi.com/docs/get-shot-map',
  documentationRetrievedAt: '2026-11-07T12:40:10.794Z',
  documentationHtmlSha256: '517512d8066c52987170680ccc65ba851ba2906c52673eba3def36b0ffdbefa1',
});
const hash = text => createHash('sha256').update(text, 'utf8').digest('hex');
export const STRIKER_SHOT_MAP_FRAME_SHA256 = hash(JSON.stringify(STRIKER_SHOT_MAP_FRAME));
const restrictions = Object.freeze({ accepted: false, formalEligible: false, executable: false,
  modelEffectApplied: false, sourceAuthenticationVerified: false, identityIndependentlyVerified: false,
  completenessVerified: false, periodCompletenessVerified: false, strictOosEligible: false,
  providerRightsVerified: false, crossProviderTransferValidated: false, W: null, R: null, S: null });
const failure = (code, extra = {}) => ({ ok: false, version: SHOT_XG_TARGET_ADAPTER_VERSION, code, ...extra, ...restrictions });
const positiveId = value => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const instant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const abbreviation = value => typeof value === 'string' && /^[A-Z0-9]{2,8}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const bounded = (value, maximum) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum;
const publicScope = scope => ({ league: scope.league, gameId: scope.gameId, homeTeamId: scope.homeTeamId,
  awayTeamId: scope.awayTeamId, homeAbbreviation: scope.homeAbbreviation, awayAbbreviation: scope.awayAbbreviation });
const validScope = scope => scope && ['epl', 'ucl'].includes(scope.league) && positiveId(scope.gameId)
  && positiveId(scope.homeTeamId) && positiveId(scope.awayTeamId) && scope.homeTeamId !== scope.awayTeamId
  && abbreviation(scope.homeAbbreviation) && abbreviation(scope.awayAbbreviation)
  && scope.homeAbbreviation !== scope.awayAbbreviation;

/** Endpoint-specific coordinate hypothesis, not a source or model approval.
 * Units stay relative: no assumed pitch metres, goal width, angle, or y direction.
 * A native x greater than 1 can be an own-half attempt; do not discard it. */
export function deriveStrikerShotMapLocation({ endpoint, coordinateContract, x, y } = {}) {
  if (endpoint !== STRIKER_SHOT_MAP_ENDPOINT || coordinateContract !== STRIKER_SHOT_MAP_FRAME.contract)
    return failure('STRIKER_SHOT_MAP_COORDINATE_SCOPE_INVALID');
  if (!bounded(x, 2) || !bounded(y, 1)) return failure('STRIKER_SHOT_MAP_COORDINATES_UNKNOWN_OR_INVALID');
  return { ok: true, version: SHOT_XG_TARGET_ADAPTER_VERSION, provider: 'STRIKER_API',
    coordinateContract: STRIKER_SHOT_MAP_FRAME.contract, frameSha256: STRIKER_SHOT_MAP_FRAME_SHA256,
    nativeX: x, nativeY: y, inferredFullPitchX: 1 - x / 2, inferredCentrelineDistance: Math.abs(y - 0.5),
    conversionStatus: STRIKER_SHOT_MAP_FRAME.conversionStatus, ...restrictions };
}

/** Audit a single-match document. The public schema has no shot ID, period,
 * own-goal or shootout flags, or complete outcome enum. Minute is not a period.
 * Caller-provided team abbreviations are only claimed bindings. Even a full
 * row/count match cannot authenticate a source, prove coverage, or transfer a
 * Wyscout model. No training/prediction observations are emitted. */
export function auditStrikerShotMapDocument({ rawBody, endpoint, scope, documentKind = 'IMPORTED_UNAUTHENTICATED' } = {}) {
  if (endpoint !== STRIKER_SHOT_MAP_ENDPOINT || !validScope(scope)
    || !['IMPORTED_UNAUTHENTICATED', 'SCHEMA_EXCERPT_NOT_ACTUAL'].includes(documentKind)
    || typeof rawBody !== 'string' || !Buffer.byteLength(rawBody) || Buffer.byteLength(rawBody) > 1048576)
    return failure('STRIKER_SHOT_MAP_DOCUMENT_INVALID');
  let root;
  try { root = JSON.parse(rawBody.startsWith('\ufeff') ? rawBody.slice(1) : rawBody); }
  catch { return failure('STRIKER_SHOT_MAP_JSON_INVALID'); }
  // The reference page shows unwrapped result content; REST uses data envelope.
  const data = documentKind === 'SCHEMA_EXCERPT_NOT_ACTUAL' ? root : root?.data;
  if (!data || !Array.isArray(data.shots) || data.shots.length > 2000 || !integer(data.shots_total)
    || !integer(data.totals?.shots) || !integer(data.totals?.located) || data.totals.located > data.totals.shots)
    return failure('STRIKER_SHOT_MAP_RESPONSE_SCHEMA_INVALID');
  if (Object.hasOwn(data, 'next_offset') && data.next_offset !== null)
    return failure('STRIKER_SHOT_MAP_UNDOCUMENTED_PAGINATION');
  const blockers = new Set(['PERIOD_SEMANTICS_NOT_IN_SHOT_MAP_SCHEMA', 'OWN_GOAL_AND_SHOOTOUT_SCOPE_UNKNOWN',
    'STABLE_SHOT_ID_NOT_IN_SHOT_MAP_SCHEMA', 'TEAM_BINDINGS_NOT_INDEPENDENTLY_VERIFIED',
    'OUTCOME_VOCABULARY_NOT_VERIFIED', 'CROSS_PROVIDER_MODEL_TRANSFER_NOT_VALIDATED']);
  if (documentKind === 'SCHEMA_EXCERPT_NOT_ACTUAL') blockers.add('SCHEMA_EXCERPT_NOT_ACTUAL');
  const seen = new Set(), observedShots = [];
  for (let index = 0; index < data.shots.length; index++) {
    const row = data.shots[index];
    if (!row || row.game_id !== scope.gameId || !abbreviation(row.team)
      || ![scope.homeAbbreviation, scope.awayAbbreviation].includes(row.team))
      return failure('STRIKER_SHOT_MAP_ROW_SCOPE_MISMATCH');
    let rowHash;
    try { rowHash = hash(JSON.stringify(row)); }
    catch { return failure('STRIKER_SHOT_MAP_ROW_STRUCTURE_INVALID'); }
    if (seen.has(rowHash)) blockers.add('DUPLICATE_ROWS_WITHOUT_STABLE_SHOT_IDS');
    seen.add(rowHash);
    const location = deriveStrikerShotMapLocation({ endpoint, coordinateContract: STRIKER_SHOT_MAP_FRAME.contract, x: row.x, y: row.y });
    if (!location.ok) blockers.add('SHOT_COORDINATES_UNKNOWN_OR_INVALID');
    if (typeof row.penalty !== 'boolean') blockers.add('PENALTY_CLASSIFICATION_UNKNOWN');
    if (typeof row.minute !== 'number' || !Number.isFinite(row.minute) || row.minute < 0) blockers.add('SHOT_MINUTE_UNKNOWN');
    const text = value => typeof value === 'string' && value.length > 0 && value.length <= 80 ? value : null;
    if (!text(row.outcome)) blockers.add('SHOT_OUTCOME_UNKNOWN');
    if (!text(row.body_part)) blockers.add('SHOT_BODY_PART_UNKNOWN');
    observedShots.push({ sourceRowIndex: index, sourceRowSha256: rowHash, provider: 'STRIKER_API',
      gameId: row.game_id, teamAbbreviation: row.team,
      claimedTeamId: row.team === scope.homeAbbreviation ? scope.homeTeamId : scope.awayTeamId,
      penalty: typeof row.penalty === 'boolean' ? row.penalty : null,
      minute: typeof row.minute === 'number' && Number.isFinite(row.minute) && row.minute >= 0 ? row.minute : null,
      period: null, ownGoal: null, shootout: null, outcome: text(row.outcome), bodyPart: text(row.body_part),
      locationHypothesis: location.ok ? { nativeX: location.nativeX, nativeY: location.nativeY,
        inferredFullPitchX: location.inferredFullPitchX, inferredCentrelineDistance: location.inferredCentrelineDistance,
        coordinateContract: location.coordinateContract, frameSha256: location.frameSha256,
        conversionStatus: location.conversionStatus } : null });
  }
  const countMatch = data.shots.length === data.shots_total && data.shots.length === data.totals.located
    && data.shots.length === data.totals.shots;
  if (!countMatch) blockers.add('SHOT_ROWS_DO_NOT_COVER_PROVIDER_TOTALS');
  if (data.shots.length >= 2000 || data.shots_total >= 2000 || data.totals.shots >= 2000)
    blockers.add('NEWEST_2000_CAP_CANNOT_PROVE_COMPLETE_COVERAGE');
  if (data.totals.located !== data.totals.shots) blockers.add('UNLOCATED_SHOTS_PRESENT');
  return failure('STRIKER_TARGET_SCHEMA_INCOMPLETE', { parsed: true, status: 'RESEARCH_ONLY_UNSUPPORTED_FOR_PERIOD_AGGREGATION',
    provider: 'STRIKER_API', endpoint, scope: publicScope(scope), documentKind, contentSha256: hash(rawBody),
    frameSha256: STRIKER_SHOT_MAP_FRAME_SHA256, observedShots,
    coverage: { returnedRows: data.shots.length, declaredShotRows: data.shots_total,
      declaredAllShots: data.totals.shots, declaredLocatedShots: data.totals.located,
      rowCountMatchesProviderTotals: countMatch, independentlyVerified: false, complete: false,
      paginationContract: 'SINGLE_MATCH_REQUEST_NO_DOCUMENTED_OFFSET_NEWEST_2000_CAP' },
    blockers: [...blockers], observedPeriods: null, modelObservations: [] });
}

const trustedFetch = globalThis.fetch?.bind(globalThis), captures = new WeakMap();
async function boundedBody(response) {
  const length = response.headers?.get?.('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > 1048576)) throw Error('BODY_LIMIT');
  if (!response.body?.getReader) throw Error('BODY_STREAM_REQUIRED');
  const reader = response.body.getReader(), chunks = []; let count = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      count += value.byteLength;
      if (count > 1048576) { await reader.cancel(); throw Error('BODY_LIMIT'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
}

/** One match, one request, at most 10 reserved credits. No retries, signup,
 * secret discovery, fallback endpoint, arbitrary URL or season-wide fetching.
 * The existing atomic local credit ledger is used unless a synthetic test
 * implementation is supplied. No key or raw licensed body is returned. */
export async function fetchStrikerShotMapResearch({ enabled = false, apiKey, scope, budget,
  fetchImpl, reserveCreditsImpl, timeoutMs = 10000 } = {}) {
  if (enabled !== true) return failure('STRIKER_SHOT_MAP_DISABLED');
  if (!validScope(scope) || typeof apiKey !== 'string' || !apiKey.trim() || apiKey.length > 512
    || !uuid(budget?.budgetId) || !instant(budget?.windowStart)
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000
    || fetchImpl !== undefined && typeof fetchImpl !== 'function'
    || reserveCreditsImpl !== undefined && typeof reserveCreditsImpl !== 'function')
    return failure('STRIKER_SHOT_MAP_CONFIG_MISSING_OR_INVALID');
  scope = Object.freeze(publicScope(scope));
  budget = Object.freeze({ budgetId: budget.budgetId, windowStart: budget.windowStart });
  const synthetic = fetchImpl !== undefined || reserveCreditsImpl !== undefined;
  const send = fetchImpl || trustedFetch;
  if (typeof send !== 'function') return failure('STRIKER_SHOT_MAP_FETCH_UNAVAILABLE');
  const requestId = randomUUID();
  let reservation, deadline;
  try {
    const reserve = reserveCreditsImpl || (await import('./striker-credit-budget.js')).reserveStrikerCredits;
    reservation = await Promise.race([reserve({ enabled: true, ...budget, requestId, credits: 10 }),
      new Promise((_, reject) => { deadline = setTimeout(() => reject(Error('BUDGET_TIMEOUT')), timeoutMs); })]);
  } catch { return failure('STRIKER_SHOT_MAP_CREDIT_RESERVATION_UNAVAILABLE'); }
  finally { clearTimeout(deadline); }
  if (reservation?.allowed !== true || reservation.status !== 'RESERVED')
    return failure('STRIKER_SHOT_MAP_CREDIT_RESERVATION_REJECTED');
  let rawBody;
  try {
    const response = await send(STRIKER_SHOT_MAP_ENDPOINT, { method: 'POST', redirect: 'error', cache: 'no-store',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'x-idempotency-key': requestId },
      body: JSON.stringify({ game_id: scope.gameId, league: scope.league === 'epl' ? 'soccer' : 'ucl', include_shots: true }),
      signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return failure('STRIKER_SHOT_MAP_HTTP_ERROR');
    rawBody = await boundedBody(response);
    // Reject a key reflected either verbatim or through JSON escaping.
    if (rawBody.includes(apiKey)) return failure('STRIKER_SHOT_MAP_SECRET_REFLECTED');
    const value = JSON.parse(rawBody.startsWith('\ufeff') ? rawBody.slice(1) : rawBody); const pending = [value];
    while (pending.length) {
      const item = pending.pop();
      if (typeof item === 'string' && item.includes(apiKey)) return failure('STRIKER_SHOT_MAP_SECRET_REFLECTED');
      if (item && typeof item === 'object') for (const [key, child] of Object.entries(item)) {
        if (key.includes(apiKey)) return failure('STRIKER_SHOT_MAP_SECRET_REFLECTED');
        pending.push(child);
      }
    }
  } catch { return failure('STRIKER_SHOT_MAP_FETCH_OR_BODY_ERROR'); }
  const audited = auditStrikerShotMapDocument({ rawBody, endpoint: STRIKER_SHOT_MAP_ENDPOINT, scope });
  if (!audited.parsed) return audited;
  const handle = { ok: true, version: SHOT_XG_TARGET_ADAPTER_VERSION,
    status: 'PRIVATE_RESEARCH_DOCUMENT_CAPTURED_NOT_ACCEPTED', endpoint: STRIKER_SHOT_MAP_ENDPOINT,
    scope, contentSha256: hash(rawBody), fetchedAt: new Date().toISOString(), reservedCredits: 10,
    transport: synthetic ? 'SYNTHETIC_CUSTOM_IMPLEMENTATION_NOT_AUTHENTIC' : 'NATIVE_FETCH_NOT_INDEPENDENTLY_AUTHENTICATED',
    originalDocumentsArchived: false, ...restrictions };
  captures.set(handle, { rawBody, seal: hash(JSON.stringify(handle)), scope, synthetic });
  return handle;
}

/** Same-process private capture only; cloning/editing cannot manufacture proof. */
export function auditStrikerShotMapCapture(handle) {
  const privateCapture = captures.get(handle);
  if (!privateCapture || privateCapture.seal !== hash(JSON.stringify(handle)))
    return failure('STRIKER_SHOT_MAP_PRIVATE_CAPTURE_MISSING_OR_CHANGED');
  return { ...auditStrikerShotMapDocument({ rawBody: privateCapture.rawBody,
    endpoint: STRIKER_SHOT_MAP_ENDPOINT, scope: privateCapture.scope }), transport: handle.transport };
}
