import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fetchStrikerEventPages, summarizeStrikerEventPages } from '../lib/soccer/striker-xg-research.js';

const scope = { league: 'epl', gameId: '740916', homeTeamId: '382', awayTeamId: '359' };
const shot = (seq, team_id, period, xg, penalty = false) => ({ seq, type: 'shot', team_id, period,
  shot: { xg, penalty }, own_goal: false, shootout: false });
// Official REST response-format docs require a data envelope; the endpoint's
// unwrapped example represents the result content, not a verified REST body.
const page = (events, next_offset) => ({ data: { events, count: events.length, next_offset } });
const jsonResponse = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const responses = [page([shot(1, '382', 1, 0.2), shot(2, '359', 1, 0.76, true)], 2),
  page([shot(3, '359', 2, 0.4), { seq: 4, type: 'corner', shot: null }], null)];
let calls = [];
const fake = async (url, init) => { calls.push({ url, ...init, body: JSON.parse(init.body) }); return jsonResponse(responses.shift()); };
assert.equal((await fetchStrikerEventPages({ scope, apiKey: 'example', fetchImpl: fake })).code, 'STRIKER_DISABLED');
assert.equal(calls.length, 0);
const capture = await fetchStrikerEventPages({ enabled: true, scope: { ...scope, sensitiveExtra: 'must-not-escape' }, apiKey: 'example', fetchImpl: fake, pageSize: 2 });
assert.equal(JSON.stringify(capture).includes('must-not-escape'), false);
assert.equal(capture.ok, true);
assert.equal(calls.length, 2);
assert.equal(calls[0].url, 'https://mcp.strikerapi.com/v1/get_events');
assert.deepEqual(calls.map(c => c.body.offset), [0, 2]);
assert.equal(calls[0].body.kind, 'all');
assert.equal(calls[0].body.league, 'soccer');
assert.equal(capture.estimatedCredits, 20);
assert.equal(JSON.stringify(capture).includes('example'), false);
const result = summarizeStrikerEventPages({ capture, referenceShotCounts: { home: 1, away: 2 } });
assert.equal(result.ok, true);
assert.equal(result.observedPeriods.HT.home.npxg, 0.2);
assert.equal(result.observedPeriods.HT.away.npxg, 0);
assert.ok(Math.abs(result.observedPeriods.FT.away.xg - 1.16) < 1e-12);
assert.equal(result.observedPeriods.FT.away.npxg, 0.4);
assert.equal(result.countComparison, 'MATCHED_REGULATION_ASSUMED_NOT_VERIFIED');
assert.equal(result.regulationCompletenessVerified, false);
assert.equal(result.observedShots[0].x, null);
assert.equal(result.observedShots[0].outcome, null);
assert.equal(result.identityIndependentlyVerified, false);
assert.equal(result.strictOosEligible, false);
assert.equal(result.formalEligible, false);
assert.equal(result.W, null);
assert.equal(result.R, null);
assert.equal(result.S, null);
const mismatch = summarizeStrikerEventPages({ capture, referenceShotCounts: { home: 2, away: 2 } });
assert.equal(mismatch.countComparison, 'MISMATCH');
assert.equal(mismatch.observedPeriods, null);
assert.ok(mismatch.gaps.includes('SHOT_COUNT_MISMATCH'));
const tampered = structuredClone(capture); tampered.pages[0].rawBody += ' ';
assert.equal(summarizeStrikerEventPages({ capture: tampered }).code, 'STRIKER_CAPTURE_DOCUMENT_INVALID');
const modify = (capture, fn) => {
  const copy = structuredClone(capture), data = JSON.parse(copy.pages[0].rawBody);
  fn(data); copy.pages[0].rawBody = JSON.stringify(data);
  copy.pages[0].sha256 = createHash('sha256').update(copy.pages[0].rawBody).digest('hex'); return copy;
};
const features = modify(capture, d => Object.assign(d.data.events[0].shot, { x: 0.2, y: 0.6, outcome: 'goal', body_part: 'head' }));
const f = summarizeStrikerEventPages({ capture: features }).observedShots[0];
assert.deepEqual([f.x, f.y, f.outcome, f.bodyPart], [0.2, 0.6, 'goal', 'head']);
const extraTime = modify(capture, d => { d.data.events[0].period = 3; });
assert.equal(summarizeStrikerEventPages({ capture: extraTime }).observedPeriods.FT.home.shots, 0);
const missing = modify(capture, d => { d.data.events[0].shot = null; });
assert.deepEqual(summarizeStrikerEventPages({ capture: missing }).gaps, ['SHOT_DETAIL_MISSING']);
const badPenalty = modify(capture, d => { d.data.events[0].shot.penalty = null; });
assert.equal(summarizeStrikerEventPages({ capture: badPenalty }).code, 'STRIKER_SHOT_VALUE_OR_IDENTITY_INVALID');
const wrongTeam = modify(capture, d => { d.data.events[0].team_id = '12345'; });
assert.equal(summarizeStrikerEventPages({ capture: wrongTeam }).code, 'STRIKER_SHOT_VALUE_OR_IDENTITY_INVALID');
const duplicate = modify(capture, d => { d.data.events[1].seq = d.data.events[0].seq; });
assert.equal(summarizeStrikerEventPages({ capture: duplicate }).code, 'STRIKER_EVENT_DUPLICATE_OR_ID_INVALID');
for (const data of [page([shot(1, '382', 1, 0.2)], 0), { data: { events: [] } }, { data: { events: [], count: -1, next_offset: null } }, page([shot(1, '382', 1, 0.2)], 2)]) {
  assert.equal((await fetchStrikerEventPages({ enabled: true, scope, apiKey: 'example', fetchImpl: async () => jsonResponse(data) })).code, 'STRIKER_PAGE_INVALID');
}
assert.equal((await fetchStrikerEventPages({ enabled: true, scope, apiKey: 'example', maxPages: 1,
  fetchImpl: async () => jsonResponse(page([shot(1, '382', 1, 0.2)], 1)) })).code, 'STRIKER_PAGE_BUDGET_EXCEEDED');
assert.equal((await fetchStrikerEventPages({ enabled: true, scope: { ...scope, league: 'nba' }, apiKey: 'example', fetchImpl: fake })).code, 'STRIKER_REQUEST_INVALID');
let uclRequest;
const ucl = await fetchStrikerEventPages({ enabled: true, scope: { ...scope, league: 'ucl' }, apiKey: 'example', fetchImpl: async (_url, init) => { uclRequest = JSON.parse(init.body); return jsonResponse(page([shot(1, '382', 1, 0.2)], null)); } });
assert.equal(ucl.ok, true);
assert.equal(uclRequest.league, 'ucl');
assert.equal((await fetchStrikerEventPages({ enabled: true, scope, apiKey: 'example', fetchImpl: async () => new Response(null, { status: 401 }) })).code, 'STRIKER_HTTP_ERROR');
// An unwrapped result is not accepted as an undocumented REST response.
assert.equal((await fetchStrikerEventPages({ enabled: true, scope, apiKey: 'example', fetchImpl: async () => jsonResponse({ events: [], count: 0, next_offset: null }) })).code, 'STRIKER_PAGE_INVALID');
const huge = new Response(new Uint8Array(1024 * 1024 + 1), { status: 200 });
assert.equal((await fetchStrikerEventPages({ enabled: true, scope, apiKey: 'example', fetchImpl: async () => huge })).code, 'STRIKER_FETCH_OR_BODY_ERROR');
console.log('soccer striker xg research: PASS');
