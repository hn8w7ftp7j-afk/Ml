import assert from 'node:assert/strict';
import {
  ANALYSIS_IDEMPOTENCY_CACHE_TTL_MS,
  ANALYSIS_RESPONSE_CACHE_TTL_MS,
  assessAnalysisCacheEntryV110,
} from '../lib/analysis-response-cache-policy-v110.js';

const now = Date.parse('2026-08-25T08:00:00.000Z');
const payload = {
  league: 'MLB',
  game: { league: 'MLB', gamePk: 123, gameDate: new Date(now + 60 * 60_000).toISOString() },
  context: {
    fetchedAt: new Date(now - 10_000).toISOString(),
    game: { gameDate: new Date(now + 60 * 60_000).toISOString() },
    away: { lineup: { official: true }, bullpen: { status: 'CONFIRMED' } },
    home: { lineup: { official: true }, bullpen: { status: 'CONFIRMED' } },
    umpire: { status: 'CONFIRMED' }, weather: { roofConfirmed: true },
  },
  analysis: { results: [{ sourceType: 'ACTUAL_TW_CREDIT', lineAsOf: new Date(now - 10_000).toISOString() }] },
};
const entry = { payload, cachedAt: now - 5_000 };

assert.equal(assessAnalysisCacheEntryV110(entry, { league: 'MLB', gamePk: 123, now }).fresh, true);
assert.equal(assessAnalysisCacheEntryV110(entry, {
  league: 'MLB', gamePk: 123, now: now + ANALYSIS_RESPONSE_CACHE_TTL_MS + 1,
}).fresh, false, 'response cache must expire even when the input hash is unchanged');
assert.match(assessAnalysisCacheEntryV110(entry, {
  league: 'MLB', gamePk: 123, now: now + 60 * 60_000,
}).reasons.join('|'), /GAME_ALREADY_STARTED/);
assert.match(assessAnalysisCacheEntryV110(entry, {
  league: 'MLB', gamePk: 123, now: now + ANALYSIS_IDEMPOTENCY_CACHE_TTL_MS + 1,
  maxAgeMs: ANALYSIS_IDEMPOTENCY_CACHE_TTL_MS,
}).reasons.join('|'), /CACHE_TTL_EXPIRED/);
assert.match(assessAnalysisCacheEntryV110({ ...entry, payload: { ...payload, context: { ...payload.context, fetchedAt: new Date(now - 10 * 60_000).toISOString() } } }, {
  league: 'MLB', gamePk: 123, now,
}).reasons.join('|'), /CORE_SNAPSHOT_TTL_EXPIRED/);
assert.match(assessAnalysisCacheEntryV110({ ...entry, payload: { ...payload, analysis: { results: [{ sourceType: 'ACTUAL_TW_CREDIT', lineAsOf: new Date(now - 6 * 60_000).toISOString() }] } } }, {
  league: 'MLB', gamePk: 123, now,
}).reasons.join('|'), /ACTUAL_LINE_TTL_EXPIRED/);
assert.equal(assessAnalysisCacheEntryV110(entry, { league: 'NPB', gamePk: 123, now }).fresh, false);
assert.equal(assessAnalysisCacheEntryV110(entry, { league: 'MLB', gamePk: 456, now }).fresh, false);

console.log('Analysis response/idempotency cache TTL, prestart, core and line freshness gates PASS');
