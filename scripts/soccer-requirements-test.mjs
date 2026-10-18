import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizeSoccerSchedule } from '../lib/soccer/data.js';
import { normalizeSoccerPrematch } from '../lib/soccer/prematch.js';
import { scoreDistribution } from '../lib/soccer/score-model.js';
import { SOCCER_REQUIREMENTS_VERSION, SOCCER_REQUIREMENT_LAYERS, SOCCER_REQUIREMENTS_GATES, buildSoccerRequirementAudit } from '../lib/soccer/requirements.js';

const source = { provider: 'ESPN', url: 'https://fixture.invalid/provider', fetchedAt: '2026-10-18T13:35:00.000Z', contentHash: 'a'.repeat(64) };
const now = Date.parse(source.fetchedAt);
const payload = JSON.parse(fs.readFileSync(new URL('./fixtures/soccer/lineup-announced.json', import.meta.url)));
const league = payload.header.league.slug === 'eng.1' ? 'epl' : 'ucl';
const competition = payload.header.competitions[0];
const board = normalizeSoccerSchedule({ leagues: [payload.header.league], events: [{ ...payload.header, date: competition.date, status: competition.status }] }, league, source);
assert.equal(board.ok, true);
const evidence = normalizeSoccerPrematch(payload, board.games[0], source, now);
assert.equal(evidence.ok, true);
const prediction = { ...scoreDistribution(1.5, 1.1, -.05), modelVersion: 'SOCCER-POISSON-DC-RESEARCH-v1', trainingHash: 'b'.repeat(64), status: 'RESEARCH_ONLY', executable: false };
const find = (audit, key) => audit.layers.flatMap(layer => layer.items).find(item => item.key === key);

assert.equal(SOCCER_REQUIREMENTS_VERSION, '2.2');
assert.equal(SOCCER_REQUIREMENT_LAYERS.length, 6);
assert.deepEqual(SOCCER_REQUIREMENT_LAYERS.map(layer => layer.key), ['history', 'personnel', 'conditions', 'score', 'payoff', 'reliability']);
assert.deepEqual(SOCCER_REQUIREMENT_LAYERS.map(layer => layer.title), ['歷史實力', '當場人員', '比賽條件', '比分機率', '實際收益', '可靠程度']);
assert.ok(Object.isFrozen(SOCCER_REQUIREMENT_LAYERS));
assert.ok(SOCCER_REQUIREMENTS_GATES.some(gate => gate.code === 'SOCCER_MARKET_CONTRACT_UNVERIFIED'));
const empty = buildSoccerRequirementAudit();
assert.equal(empty.formalReady, false);
assert.ok(empty.layers.flatMap(layer => layer.items).every(item => item.status === 'UNKNOWN' && item.modelUsage === 'NOT_AVAILABLE'));
const audit = buildSoccerRequirementAudit({ evidence, prediction });
assert.equal(audit.formalReady, false);
assert.equal(find(audit, 'strength').modelUsage, 'USED_BASELINE');
assert.equal(find(audit, 'scoreDistribution').status, 'AVAILABLE');
assert.equal(find(audit, 'lineups').status, 'PARTIAL');
assert.equal(find(audit, 'lineups').modelUsage, 'OBSERVED_ONLY');
for (const key of ['xg', 'minutes', 'rotation', 'injuries', 'suspensions', 'halfTime', 'contract', 'rebate', 'wrs']) assert.equal(find(audit, key).status, 'UNKNOWN', key);
assert.ok(audit.layers.flatMap(layer => layer.items).every(item => typeof item.reason === 'string' && item.reason.length > 0));

// A known home side must never hide missing away data, and observed positions are not model effects.
const partial = structuredClone(evidence);
partial.teams.home.injuries = { status: 'PROVIDER_REPORTED', value: [] };
assert.match(find(buildSoccerRequirementAudit({ evidence: partial, prediction }), 'injuries').reason, /客隊/);
partial.teams.away.lineup.starters = [];
assert.equal(find(buildSoccerRequirementAudit({ evidence: partial, prediction }), 'lineups').status, 'PARTIAL');
partial.teams.home.minutes = { status: 'PROVIDER_REPORTED', value: { expected: 90 } };
const minutes = find(buildSoccerRequirementAudit({ evidence: partial, prediction }), 'minutes');
assert.equal(minutes.status, 'PARTIAL');
assert.equal(minutes.modelUsage, 'OBSERVED_ONLY');
const foreignPrediction = { ...prediction, modelVersion: 'OTHER-SPORT-v1' };
assert.equal(find(buildSoccerRequirementAudit({ evidence, prediction: foreignPrediction }), 'strength').modelUsage, 'NOT_AVAILABLE');
const futureLineup = structuredClone(evidence);
for (const side of ['home', 'away']) {
  futureLineup.teams[side].lineup.independentlyConfirmed = true;
  futureLineup.teams[side].lineup.sourcePublishedAt = '2026-10-19T00:00:00.000Z';
}
assert.equal(find(buildSoccerRequirementAudit({ evidence: futureLineup }), 'lineups').status, 'PARTIAL', 'future publication cannot complete an earlier observation');
const wrongIdentity = structuredClone(evidence);
wrongIdentity.game.away.sourceId = wrongIdentity.game.home.sourceId;
assert.equal(find(buildSoccerRequirementAudit({ evidence: wrongIdentity, prediction }), 'strength').modelUsage, 'NOT_AVAILABLE');

// A real matched quote is still neither a verified football contract nor an accepted transaction.
const reader = { games: [{ officialGameId: evidence.game.id, matchStatus: 'MATCHED', fresh: true, markets: [{ kind: 'TOTAL', line: '2+50' }] }] };
const withReader = buildSoccerRequirementAudit({ evidence, prediction, reader, validation: { rolling: { folds: [{ metrics: { count: 3 } }] }, formalPromotion: true } });
assert.equal(find(withReader, 'readerQuotes').status, 'PARTIAL');
assert.equal(find(withReader, 'rolling').status, 'PARTIAL');
assert.equal(find(withReader, 'contract').status, 'UNKNOWN');
assert.equal(withReader.formalReady, false);
const wrongMatch = structuredClone(reader);
wrongMatch.games[0].officialGameId = 'soccer:ucl:other';
assert.ok(buildSoccerRequirementAudit({ evidence, prediction, reader: wrongMatch }).blockers.some(gate => gate.code === 'SOCCER_MATCHED_READER_QUOTE_MISSING'));

// Observed half-time scores and post-match clock minutes are not a half-time or minutes forecast.
const after = structuredClone(evidence);
after.phase = 'POSTSTART_AUDIT';
after.game.halfTime = { home: 1, away: 0, verified: true };
after.minutesAudit = { status: 'REGULATION_CLOCK_RECONSTRUCTED', teams: { home: { players: [{ id: '1' }] }, away: { players: [{ id: '2' }] } } };
const afterAudit = buildSoccerRequirementAudit({ evidence: after });
assert.equal(find(afterAudit, 'actualMinutes').status, 'PARTIAL');
assert.equal(find(afterAudit, 'minutes').status, 'UNKNOWN');
assert.equal(find(afterAudit, 'halfTime').status, 'UNKNOWN');
assert.equal(find(afterAudit, 'prematch').status, 'UNKNOWN');

// Client import stays static and input snapshots stay unchanged.
const before = JSON.stringify({ evidence, prediction, reader });
buildSoccerRequirementAudit({ evidence, prediction, reader });
assert.equal(JSON.stringify({ evidence, prediction, reader }), before);
const moduleText = fs.readFileSync(new URL('../lib/soccer/requirements.js', import.meta.url), 'utf8');
assert.doesNotMatch(moduleText, /(?:from\s*['"]node:|process\.env|@neondatabase|\bfetch\s*\()/);
assert.equal(new Set(audit.layers.flatMap(layer => layer.items.map(item => item.key))).size, audit.layers.flatMap(layer => layer.items).length);
console.log('PASS soccer 2.2 requirements: six layers, both teams, observations distinct from model usage, contract/PIT/half-time fail-closed, immutable inputs and client-safe exports');
