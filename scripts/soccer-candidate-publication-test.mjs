import assert from 'node:assert/strict';
import { candidateFixture } from './helpers/soccer-candidate-fixture.mjs';
import { soccerCandidatePayloadValid } from '../lib/soccer/candidate-qualification.js';
import { buildSoccerRanking } from '../lib/soccer/ranking.js';
const now = Date.now(), at = new Date(now).toISOString();
const game = { id: 'soccer:epl:123', sourceId: '123', league: 'epl', date: '2026-10-20', status: 'scheduled',
  startTime: new Date(now + 3600000).toISOString(), home: { sourceId: '359' }, away: { sourceId: '364' } };
const raw = { gameId: game.id, league: game.league, date: game.date, observedAt: at, persisted: true, publishedCurrent: true,
  analysisStatus: 'COMPLETED', evidence: { game }, formalScoringEnabled: true, qualification: { eligible: true },
  directions: [{ period: 'FT', direction: 'TOTAL_OVER', eligible: true, score: 8, W: .02, R: .01, qaFlag: 'WARN',
    quotes: [{ key: 'original-quote', period: 'FT', unit: 'GOALS', kind: 'TOTAL', side: 'over', line: '3+50',
      lineSide: null, rawRows: ['大 3+50 0.95'], water: .95, fresh: true, prestart: true,
      provenance: { gameId: game.id, observedAt: at } }] }] };
const published = candidateFixture(raw, now), rank = (s, g = game, t = now) => buildSoccerRanking([g], { [g.id]: { status: 'done', data: s } }, { now: t });
assert.equal(soccerCandidatePayloadValid(published, now), true);
assert.equal(rank(published).entries.length, 1);
assert.equal(rank(published).order.length, 1);
assert.equal(rank(published, game, now + 180000).entries.length, 0);
for (const alter of [s => { s.persisted = false; }, s => { s.publishedCurrent = false; },
  s => { s.revision = 'a'.repeat(64); }, s => { s.currentResearch.quoteGeneration = '2'; },
  s => { s.currentResearch.qualificationVersion = '2'; }, s => { s.currentResearch.analysisRunId = 'different-run'; },
  s => { s.currentResearch.checkedAt = new Date(now + 1).toISOString(); }, s => { s.currentResearch.reason = 'QUOTE_CHANGED'; },
  s => { s.directions[0].quotes[0].water = 1.1; }, s => { s.directions[0].quotes[0].rawRows = ['modified']; },
  s => { s.directions[0].quotes[0].period = 'HT'; }, s => { s.directions[0].quotes[0].side = 'under'; },
  s => { s.directions[0].quotes[0].qualification.distributionHash = 'a'.repeat(64); },
  s => { s.directions[0].quotes[0].scoring.score = 9; }, s => { s.directions[0].quotes[0].qualification.W = .03; },
  s => { s.directions[0].qaFlag = 'BLOCKED'; }, s => { s.directions[0].score = 9; },
  s => { s.directions[0].quotes = null; }]) {
  const changed = structuredClone(published); alter(changed);
  assert.equal(rank(changed).entries.length, 0, alter.toString());
  assert.equal(rank(changed).order.length, 0, alter.toString());
}
for (const changed of [{ ...game, sourceId: '124' }, { ...game, startTime: new Date(now + 7200000).toISOString() },
  { ...game, home: game.away, away: game.home }, { ...game, away: { sourceId: '999' } }, { ...game, neutralSite: true }])
  assert.equal(rank(published, changed).entries.length, 0, 'changed schedule identity invalidates former candidates');
const other = structuredClone(published.directions[0].quotes[0]);
other.key = 'b'.repeat(64); other.sourceQuoteKey = other.key;
other.water = 1.2; other.eligible = false; other.qualification = { eligible: false };
const two = structuredClone(published); two.directions[0].quotes.push(other);
assert.equal(rank(two).entries.length, 1, 'a second raw quote cannot borrow a direction score');
assert.equal(rank(two).entries[0].quote.key, published.directions[0].selectedQuoteKey);
for (const patch of [{ score: 7.19 }, { W: 0 }, { R: 0 }, { W: -1 }, { R: -1 }]) {
  const changed = structuredClone(raw); Object.assign(changed.directions[0], patch);
  assert.equal(rank(candidateFixture(changed, now)).entries.length, 0);
}
assert.equal(rank(candidateFixture({ ...raw, directions: [{ ...raw.directions[0], score: 7.2 }] }, now)).entries.length, 1);
console.log('PASS per-quote publication: immutable identity, head/sequence/generation fencing, freshness, thresholds, schedule changes, same-set sorting and no direction-score borrowing');
