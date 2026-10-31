import assert from 'node:assert/strict';
import { soccerFormalEvidenceReadiness } from '../lib/soccer/formal-evidence-readiness.js';
import { scoreSoccerQuote } from '../lib/soccer/soccer-scoring.js';

const now = Date.parse('2026-11-01T00:00:00.000Z');
const iso = delta => new Date(now + delta).toISOString();
const source = { provider: 'SYNTHETIC_ENGINEERING_FIXTURE', url: 'https://fixture.invalid/evidence', contentHash: 'a'.repeat(64),
  sourcePublishedAt: iso(-3000), fetchedAt: iso(-2000), availableAt: iso(-1000) };
const game = { id: 'soccer:epl:123', sourceId: '123', league: 'epl', home: { sourceId: '1' }, away: { sourceId: '2' } };
const verified = () => ({ status: 'VERIFIED', source: structuredClone(source) });
const evidence = { ok: true, phase: 'PREMATCH_OBSERVATION', game: structuredClone(game), pointInTimeAvailabilityVerified: true,
  source: structuredClone(source), teams: {}, xg: verified(), travel: verified(), weather: verified(), referee: verified(), uclContext: verified() };
for (const [side, offset] of [['home', 100], ['away', 200]]) evidence.teams[side] = {
  sourceId: game[side].sourceId, lineup: { ...verified(), starters: Array.from({ length: 11 }, (_, index) => ({ id: String(offset + index) })) },
  injuries: verified(), suspensions: verified(), minutes: { ...verified(), modelEffectApplied: true },
};

// Frozen reference to the pre-extraction gate. Parity matters for time ordering,
// short-circuit XI identity behavior and missing/partially observed fields.
function legacyReasons(evidence, game, now) {
  const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const instant = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
  function sourceKnown(source, cutoff) {
    if (!source || !sha(source.contentHash) || typeof source.provider !== 'string' || !source.provider.trim()) return false;
    try { const url = new URL(source.url); if (url.protocol !== 'https:' || url.username || url.password) return false; } catch { return false; }
    const times = [source.sourcePublishedAt, source.fetchedAt, source.availableAt].map(instant);
    return times.every(time => Number.isFinite(time) && time <= cutoff) && times[0] <= times[1] && times[1] <= times[2];
  }
  const reasons = [];
  if (evidence?.ok !== true || evidence.phase !== 'PREMATCH_OBSERVATION' || evidence.game?.id !== game?.id
      || evidence.game?.league !== game?.league || evidence.pointInTimeAvailabilityVerified !== true
      || !sourceKnown(evidence.source, now)) reasons.push('SOCCER_SCORE_PREMATCH_PIT_EVIDENCE_INCOMPLETE');
  const playerIds = new Set();
  for (const side of ['home', 'away']) {
    const team = evidence?.teams?.[side];
    if (team?.sourceId !== game?.[side]?.sourceId) reasons.push(`SOCCER_SCORE_${side.toUpperCase()}_IDENTITY_UNVERIFIED`);
    for (const field of ['lineup', 'injuries', 'suspensions', 'minutes']) {
      const observation = team?.[field];
      if (observation?.status !== 'VERIFIED' || !sourceKnown(observation?.source, now)) reasons.push(`SOCCER_SCORE_${side.toUpperCase()}_${field.toUpperCase()}_UNVERIFIED`);
    }
    const starters = team?.lineup?.starters;
    if (!Array.isArray(starters) || starters.length !== 11 || starters.some(player => typeof player?.id !== 'string'
        || !/^\d{1,16}$/.test(player.id) || playerIds.has(player.id) || (playerIds.add(player.id), false))) reasons.push(`SOCCER_SCORE_${side.toUpperCase()}_STARTING_XI_UNVERIFIED`);
    if (team?.minutes?.modelEffectApplied !== true) reasons.push(`SOCCER_SCORE_${side.toUpperCase()}_PERSONNEL_MODEL_EFFECT_UNVERIFIED`);
  }
  for (const field of ['xg', 'travel', 'weather', 'referee', ...(game?.league === 'ucl' ? ['uclContext'] : [])]) {
    if (evidence?.[field]?.status !== 'VERIFIED' || !sourceKnown(evidence[field]?.source, now)) reasons.push(`SOCCER_SCORE_${field.toUpperCase()}_UNVERIFIED`);
  }
  return reasons;
}
const check = (value, displayGame = game, cutoff = now) => {
  const before = JSON.stringify(value), result = soccerFormalEvidenceReadiness({ evidence: value, game: displayGame, now: cutoff });
  assert.deepEqual(result.reasons, legacyReasons(value, displayGame, cutoff));
  assert.equal(result.ok, result.reasons.length === 0);
  assert.equal(result.status, result.ok ? 'READY' : 'BLOCKED');
  assert.equal(result.blockers.length, result.reasons.length);
  assert.ok(result.checks.every(row => typeof row.label === 'string' && Array.isArray(row.details)));
  assert.equal(JSON.stringify(value), before, 'audit never mutates saved evidence');
  return result;
};
assert.equal(check(evidence).status, 'READY');
assert.equal(soccerFormalEvidenceReadiness({ evidence, now }).status, 'READY', 'quote-independent default uses the evidence game');
check(null); check(undefined); check({});
for (const league of ['epl', 'ucl']) {
  const value = structuredClone(evidence), displayGame = { ...game, league, id: `soccer:${league}:123` };
  value.game = displayGame;
  const paths = [[], ['teams', 'home', 'lineup'], ['teams', 'home', 'injuries'], ['teams', 'home', 'suspensions'], ['teams', 'home', 'minutes'],
    ['teams', 'away', 'lineup'], ['teams', 'away', 'injuries'], ['teams', 'away', 'suspensions'], ['teams', 'away', 'minutes'],
    ['xg'], ['travel'], ['weather'], ['referee'], ['uclContext']];
  const at = (root, path) => path.reduce((node, key) => node[key], root);
  for (const path of paths) for (const mutate of [
    node => { node.source = null; },
    node => { node.source.contentHash = 'not-a-hash'; },
    node => { node.source.provider = ' '; },
    node => { node.source.url = 'http://fixture.invalid/evidence'; },
    node => { node.source.url = 'https://user:secret@fixture.invalid/evidence'; },
    node => { node.source.sourcePublishedAt = null; },
    node => { node.source.sourcePublishedAt = '2026-11-01T00:00:00'; },
    node => { node.source.fetchedAt = iso(1); },
    node => { node.source.availableAt = iso(1); },
    node => { node.source.sourcePublishedAt = iso(-500); },
    node => { node.source.availableAt = iso(-2500); },
  ]) {
    const changed = structuredClone(value); mutate(at(changed, path)); check(changed, displayGame);
  }
  for (const path of paths.filter(path => path.length)) for (const status of [undefined, 'UNKNOWN', 'PROVIDER_REPORTED', 'PROVIDER_REPORTED_XI', 'POSTSTART_XI']) {
    const changed = structuredClone(value); at(changed, path).status = status; check(changed, displayGame);
  }
  for (const mutate of [
    changed => { changed.pointInTimeAvailabilityVerified = false; },
    changed => { changed.phase = 'POSTSTART_AUDIT'; },
    changed => { changed.teams.home.sourceId = '999'; },
    changed => { changed.teams.home.minutes.modelEffectApplied = false; },
    changed => { changed.teams.away.lineup.starters.pop(); },
    changed => { changed.teams.home.lineup.starters[0].id = 'invalid'; },
    changed => { changed.teams.home.lineup.starters[1].id = changed.teams.home.lineup.starters[0].id; },
    changed => { changed.teams.away.lineup.starters[0].id = changed.teams.home.lineup.starters[0].id; },
    changed => { changed.teams.home.lineup.starters[0].id = 'invalid'; changed.teams.away.lineup.starters[0].id = changed.teams.home.lineup.starters[10].id; },
  ]) { const changed = structuredClone(value); mutate(changed); check(changed, displayGame); }
}
for (const cutoff of [now - 5000, now - 1000, now, now + 86400000, NaN, Infinity]) check(evidence, game, cutoff);
const actual = structuredClone(evidence);
actual.pointInTimeAvailabilityVerified = false; actual.source.sourcePublishedAt = null;
actual.teams.home.lineup.status = 'PROVIDER_REPORTED_XI';
actual.teams.home.minutes = { status: 'UNKNOWN', reason: 'MINUTES_MODEL_NOT_VALIDATED', modelEffectApplied: false };
actual.weather = { status: 'UNKNOWN', reason: 'PREMATCH_FORECAST_NOT_CONNECTED' };
const audit = check(actual);
assert.ok(audit.blockers.find(row => row.field === 'evidence').details.some(row => row.code === 'SOURCEPUBLISHEDAT_MISSING_OR_INVALID'));
assert.ok(audit.blockers.find(row => row.field === 'teams.home.lineup').details.some(row => row.code === 'PROVIDER_REPORTED_ONLY'));
assert.equal(audit.blockers.find(row => row.field === 'weather').reportedReason, 'PREMATCH_FORECAST_NOT_CONNECTED');
assert.ok(audit.blockers.find(row => row.field === 'teams.home.minutes.modelEffectApplied').details.some(row => row.code === 'PERSONNEL_EFFECT_NOT_APPLIED'));
const scoring = scoreSoccerQuote({ evidence: actual, game, now });
const acceptance = scoring.stages.find(stage => stage.stage === 'FORMAL_ACCEPTANCE');
assert.deepEqual(acceptance.reasons.filter(code => audit.reasons.includes(code)), audit.reasons, 'the actual scorer consumes this exact shared evidence audit');
for (const absentGame of [undefined, null]) {
  const expected = legacyReasons(evidence, absentGame, now);
  const missingGame = scoreSoccerQuote({ evidence, game: absentGame, now });
  const reasons = missingGame.stages.find(stage => stage.stage === 'FORMAL_ACCEPTANCE').reasons;
  assert.deepEqual(reasons.filter(code => expected.includes(code)), expected,
    'the formal scorer must not substitute evidence.game for an absent scoring game');
}
console.log('PASS quote-independent formal football evidence audit: unchanged legacy gates and order across EPL/UCL, publication/source cutoffs, player/team identity, provider-only and missing fields; no eligibility is fabricated');
