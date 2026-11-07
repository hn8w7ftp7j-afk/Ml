import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { STRIKER_SHOT_MAP_ENDPOINT as endpoint, STRIKER_SHOT_MAP_FRAME as frame,
  STRIKER_SHOT_MAP_FRAME_SHA256 as frameHash, deriveStrikerShotMapLocation as location,
  auditStrikerShotMapDocument as audit, fetchStrikerShotMapResearch as capture,
  auditStrikerShotMapCapture as auditCapture } from '../lib/soccer/shot-xg-target-adapter.js';

const scope = { league: 'epl', gameId: '740916', homeTeamId: '382', awayTeamId: '359',
  homeAbbreviation: 'MNC', awayAbbreviation: 'ARS' };
const fixture = JSON.parse(readFileSync(new URL('./fixtures/soccer/striker-shot-map-schema-excerpt.json', import.meta.url)));
assert.equal(frameHash, fixture.frameSha256, 'Documented frame changes require explicit review');
assert.equal(frame.documentationHtmlSha256, '517512d8066c52987170680ccc65ba851ba2906c52673eba3def36b0ffdbefa1');
const coordinate = (x, y, extra = {}) => location({ endpoint, coordinateContract: frame.contract, x, y, ...extra });
assert.equal(coordinate(0, 0.5).inferredFullPitchX, 1);
assert.equal(coordinate(2, 0.5).inferredFullPitchX, 0);
assert.equal(coordinate(1.2, 0.5).inferredFullPitchX, 0.4, 'Own-half shots must not be clipped or silently lost');
assert.equal(coordinate(0.23, 0.5).inferredFullPitchX, 0.885);
assert.ok(Math.abs(coordinate(0.2, 0.2).inferredCentrelineDistance - coordinate(0.2, 0.8).inferredCentrelineDistance) < 1e-15);
for (const [x, y] of [[null, 0.5], [undefined, 0.5], ['0.2', 0.5], [NaN, 0.5], [Infinity, 0.5],
  [-0.01, 0.5], [2.01, 0.5], [0.2, -0.1], [0.2, 1.1]]) assert.equal(coordinate(x, y).ok, false);
assert.equal(coordinate(0.2, 0.5, { endpoint: 'https://mcp.strikerapi.com/v1/get_events' }).ok, false);
assert.equal(coordinate(0.2, 0.5, { coordinateContract: 'WYSCOUT_ATTACK_RIGHT_UNIT_SQUARE-v1' }).ok, false);
assert.equal(coordinate(0.2, 0.5).accepted, false);
assert.equal(coordinate(0.2, 0.5).conversionStatus, 'DOCUMENTATION_INFERENCE_NOT_PROVIDER_VERIFIED');
const schemaAudit = audit({ rawBody: JSON.stringify(fixture.result), endpoint, scope, documentKind: fixture.documentKind });
assert.equal(schemaAudit.parsed, true);
assert.equal(schemaAudit.ok, false);
assert.equal(schemaAudit.coverage.returnedRows, 3);
assert.equal(schemaAudit.coverage.rowCountMatchesProviderTotals, false);
assert.ok(schemaAudit.blockers.includes('SCHEMA_EXCERPT_NOT_ACTUAL'));
assert.ok(schemaAudit.blockers.includes('SHOT_ROWS_DO_NOT_COVER_PROVIDER_TOTALS'));
assert.equal(schemaAudit.observedShots[0].period, null);
assert.equal(schemaAudit.observedShots[0].ownGoal, null);
assert.equal(schemaAudit.observedShots[0].penalty, false);
assert.equal(schemaAudit.modelObservations.length, 0);
// Synthetic complete totals still do not prove period, identity or completeness.
const result = structuredClone(fixture.result);
result.shots_total = result.totals.shots = result.totals.located = result.shots.length;
const document = data => ({ rawBody: JSON.stringify({ data }), endpoint, scope });
const complete = audit(document(result));
assert.equal(complete.coverage.rowCountMatchesProviderTotals, true);
for (const key of ['accepted', 'formalEligible', 'executable', 'modelEffectApplied', 'sourceAuthenticationVerified',
  'identityIndependentlyVerified', 'completenessVerified', 'periodCompletenessVerified', 'crossProviderTransferValidated'])
  assert.equal(complete[key], false, key);
assert.deepEqual([complete.W, complete.R, complete.S, complete.observedPeriods], [null, null, null, null]);
assert.equal(complete.observedShots[0].provider, 'STRIKER_API');
assert.equal(complete.observedShots[0].teamId, undefined, 'Caller abbreviation binding must remain a claim');
assert.equal(complete.observedShots[0].claimedTeamId, '382');
assert.equal(complete.observedShots[0].x, undefined, 'Derived hypotheses are not generic accepted model features');
const mutate = fn => { const copy = structuredClone(result); fn(copy); return audit(document(copy)); };
assert.equal(mutate(d => { d.shots[0].game_id = '9999'; }).code, 'STRIKER_SHOT_MAP_ROW_SCOPE_MISMATCH');
assert.equal(mutate(d => { d.shots[0].team = 'OTHER'; }).code, 'STRIKER_SHOT_MAP_ROW_SCOPE_MISMATCH');
assert.ok(mutate(d => { delete d.shots[0].penalty; }).blockers.includes('PENALTY_CLASSIFICATION_UNKNOWN'));
assert.equal(mutate(d => { delete d.shots[0].penalty; }).observedShots[0].penalty, null);
assert.ok(mutate(d => { d.shots[0].x = null; }).blockers.includes('SHOT_COORDINATES_UNKNOWN_OR_INVALID'));
assert.equal(mutate(d => { d.shots[0].x = null; }).observedShots[0].locationHypothesis, null);
assert.equal(mutate(d => { d.shots[0].x = 1.4; }).observedShots[0].locationHypothesis.nativeX, 1.4);
assert.equal(mutate(d => { d.shots[0].minute = 47; d.shots[0].period = 1; d.shots[0].own_goal = false;
  d.shots[0].shootout = false; }).observedShots[0].period, null, 'Undocumented extensions must not invent a period contract');
assert.equal(mutate(d => { d.shots[0].penalty = true; }).observedShots[0].penalty, true);
assert.equal(mutate(d => { d.shots[0].outcome = 'unrecognised-provider-value'; }).observedShots[0].outcome, 'unrecognised-provider-value');
assert.equal(complete.observedShots[0].goal, undefined, 'Do not convert missing/non-exhaustive outcome vocabulary into a negative label');
assert.ok(mutate(d => { d.shots.push(structuredClone(d.shots[0])); }).blockers.includes('DUPLICATE_ROWS_WITHOUT_STABLE_SHOT_IDS'));
assert.equal(mutate(d => { d.next_offset = 3; }).code, 'STRIKER_SHOT_MAP_UNDOCUMENTED_PAGINATION');
assert.ok(mutate(d => { d.totals.shots = 2000; }).blockers.includes('NEWEST_2000_CAP_CANNOT_PROVE_COMPLETE_COVERAGE'));
assert.ok(mutate(d => { d.totals.shots++; }).blockers.includes('UNLOCATED_SHOTS_PRESENT'));
assert.equal(audit({ rawBody: JSON.stringify(result), endpoint, scope }).code, 'STRIKER_SHOT_MAP_RESPONSE_SCHEMA_INVALID');
assert.equal(audit({ rawBody: '{broken', endpoint, scope }).code, 'STRIKER_SHOT_MAP_JSON_INVALID');
assert.equal(audit({ ...document(result), endpoint: endpoint.replace('get_shot_map', 'get_events') }).ok, false);
assert.equal(audit({ ...document(result), scope: { ...scope, league: 'mlb' } }).ok, false);
// Provider xG, end coordinates and metres cannot change the geometric input.
const leaked = mutate(d => Object.assign(d.shots[0], { xg: 0.999, end_x: 0, end_y: 0.5, distance_m: 1, zone: 'goal' }));
assert.deepEqual(leaked.observedShots[0].locationHypothesis, complete.observedShots[0].locationHypothesis);
assert.equal(leaked.observedShots[0].xg, undefined);

const budget = { budgetId: '783f9008-92e4-4cd6-adca-1d945d07a812', windowStart: '2026-11-07T00:00:00.000Z' };
const reservations = [], calls = [];
const reserve = async options => { reservations.push(options); return { allowed: true, status: 'RESERVED' }; };
const fake = async (url, init) => { calls.push({ url, ...init, body: JSON.parse(init.body) });
  assert.equal(reservations.length, calls.length, 'Reserve before every request');
  return new Response(JSON.stringify({ data: result }), { headers: { 'content-type': 'application/json' } }); };
const options = { enabled: true, apiKey: 'synthetic-key-do-not-store', scope, budget, fetchImpl: fake, reserveCreditsImpl: reserve };
assert.equal((await capture({ ...options, enabled: false })).code, 'STRIKER_SHOT_MAP_DISABLED');
for (const extra of [{ apiKey: undefined }, { budget: undefined }, { budget: { ...budget, budgetId: 'bad' } },
  { budget: { ...budget, windowStart: '2026-11-07' } }, { scope: { ...scope, league: 'nba' } }])
  assert.equal((await capture({ ...options, ...extra })).code, 'STRIKER_SHOT_MAP_CONFIG_MISSING_OR_INVALID');
assert.equal(calls.length, 0);
assert.equal(reservations.length, 0);
assert.equal((await capture({ ...options, reserveCreditsImpl: async () => ({ allowed: false, status: 'BUDGET_EXHAUSTED' }) })).code,
  'STRIKER_SHOT_MAP_CREDIT_RESERVATION_REJECTED');
assert.equal(calls.length, 0);
const handle = await capture(options);
assert.equal(handle.ok, true);
assert.equal(handle.reservedCredits, 10);
assert.equal(handle.transport, 'SYNTHETIC_CUSTOM_IMPLEMENTATION_NOT_AUTHENTIC');
assert.equal(handle.sourceAuthenticationVerified, false);
assert.equal(JSON.stringify(handle).includes(options.apiKey), false);
assert.equal(handle.rawBody, undefined, 'Do not publish raw licensed documents');
assert.equal(calls[0].url, endpoint);
assert.deepEqual(calls[0].body, { game_id: '740916', league: 'soccer', include_shots: true });
assert.equal(calls[0].redirect, 'error');
assert.equal(reservations[0].credits, 10);
assert.equal(auditCapture(handle).sourceAuthenticationVerified, false);
assert.equal(auditCapture(handle).coverage.rowCountMatchesProviderTotals, true);
assert.equal(auditCapture(structuredClone(handle)).code, 'STRIKER_SHOT_MAP_PRIVATE_CAPTURE_MISSING_OR_CHANGED');
assert.throws(() => { handle.scope.gameId = '999'; }, TypeError);
handle.reservedCredits = 0;
assert.equal(auditCapture(handle).code, 'STRIKER_SHOT_MAP_PRIVATE_CAPTURE_MISSING_OR_CHANGED');
assert.equal((await capture({ ...options, scope: { ...scope, league: 'ucl' } })).ok, true);
assert.equal(calls[1].body.league, 'ucl');
const allow = async () => ({ allowed: true, status: 'RESERVED' });
const attempt = fetchImpl => capture({ ...options, fetchImpl, reserveCreditsImpl: allow });
assert.equal((await attempt(async () => new Response(null, { status: 401 }))).code, 'STRIKER_SHOT_MAP_HTTP_ERROR');
assert.equal((await attempt(async () => { throw Error(options.apiKey); })).code, 'STRIKER_SHOT_MAP_FETCH_OR_BODY_ERROR');
assert.equal((await attempt(async () => new Response('a'.repeat(1048577)))).code, 'STRIKER_SHOT_MAP_FETCH_OR_BODY_ERROR');
assert.equal((await attempt(async () => new Response('small', { headers: { 'content-length': '1048577' } }))).code,
  'STRIKER_SHOT_MAP_FETCH_OR_BODY_ERROR');
assert.equal((await attempt(async () => new Response(JSON.stringify({ data: result, key: options.apiKey })))).code,
  'STRIKER_SHOT_MAP_SECRET_REFLECTED');
const escapedKey = options.apiKey.replace('s', '\\u0073');
assert.equal((await attempt(async () => new Response(`{"data":${JSON.stringify(result)},"key":"${escapedKey}"}`))).code,
  'STRIKER_SHOT_MAP_SECRET_REFLECTED');
assert.equal((await attempt(async () => new Response(JSON.stringify(fixture.result)))).code,
  'STRIKER_SHOT_MAP_RESPONSE_SCHEMA_INVALID', 'Documentation result excerpts do not establish an actual REST body');
let timeoutRequests = 0;
assert.equal((await capture({ ...options, timeoutMs: 100, reserveCreditsImpl: () => new Promise(() => {}),
  fetchImpl: async () => { timeoutRequests++; throw Error('must not run'); } })).code,
  'STRIKER_SHOT_MAP_CREDIT_RESERVATION_UNAVAILABLE');
assert.equal(timeoutRequests, 0);
const mutableScope = { ...scope }, mutableBudget = { ...budget };
const immutable = await capture({ ...options, scope: mutableScope, budget: mutableBudget,
  reserveCreditsImpl: async reservation => {
    mutableScope.gameId = '999'; mutableScope.league = 'ucl'; mutableBudget.budgetId = 'bad';
    assert.equal(reservation.budgetId, budget.budgetId);
    return { allowed: true, status: 'RESERVED' };
  }, fetchImpl: async (_url, request) => {
    assert.deepEqual(JSON.parse(request.body), { game_id: '740916', league: 'soccer', include_shots: true });
    return new Response('\ufeff' + JSON.stringify({ data: result }));
  } });
assert.equal(immutable.ok, true);
assert.equal(auditCapture(immutable).parsed, true);
assert.equal(immutable.scope.gameId, '740916');
const deeplyNested = document(result);
deeplyNested.rawBody = deeplyNested.rawBody.replace('"outcome":"blocked"', '"outcome":"blocked","unknown":' + '['.repeat(15000) + '0' + ']'.repeat(15000));
assert.equal(audit(deeplyNested).code, 'STRIKER_SHOT_MAP_ROW_STRUCTURE_INVALID', 'Unbounded unknown nesting fails closed instead of throwing');
console.log('soccer shot xG target adapter: PASS (synthetic/schema only; no actual provider request or source/model acceptance)');
