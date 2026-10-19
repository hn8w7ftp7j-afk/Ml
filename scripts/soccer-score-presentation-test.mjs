import assert from 'node:assert/strict';
import { deterministicScore, SCORE_FORMULA_VERSION } from '../lib/deterministic-score.js';
import { soccerQuoteScorePresentation } from '../lib/soccer/score-presentation.js';
import { candidateFixture } from './helpers/soccer-candidate-fixture.mjs';
import { scoreSoccerQuote } from '../lib/soccer/soccer-scoring.js';

const now = Date.parse('2026-10-20T00:00:00Z'), at = new Date(now).toISOString();
const game = { id: 'soccer:epl:123', sourceId: '123', league: 'epl', date: '2026-10-20', status: 'scheduled',
  startTime: new Date(now + 3600000).toISOString(), home: { sourceId: '359' }, away: { sourceId: '364' } };
function fixture(W = .0435, R = .024) {
  const score = deterministicScore({ weightedEV: W, robustEV: R, actualWater: true, qaPassed: true, executable: false }).score;
  const raw = { gameId: game.id, league: game.league, date: game.date, observedAt: at, persisted: true, publishedCurrent: true,
    analysisStatus: 'COMPLETED', evidence: { game }, formalScoringEnabled: true, qualification: { eligible: true },
    directions: [{ period: 'FT', direction: 'TOTAL_OVER', eligible: score >= 7.2 && W > 0 && R > 0, score, W, R, qaFlag: 'WARN',
      quotes: [{ key: 'original-quote', period: 'FT', unit: 'GOALS', kind: 'TOTAL', side: 'over', line: '3+50',
        lineSide: null, rawRows: ['大 3+50 0.95'], water: .95, fresh: true, prestart: true,
        provenance: { gameId: game.id, observedAt: at } }] }] };
  const result = candidateFixture(raw, now);
  for (const direction of result.directions) for (const quote of direction.quotes) quote.scoring.scoreFormulaVersion = SCORE_FORMULA_VERSION;
  // Candidate receipt identity includes the whole original quote, not scoring.
  for (const direction of result.directions) if (direction.quote) direction.quote.scoring.scoreFormulaVersion = SCORE_FORMULA_VERSION;
  return result;
}
const show = (result, extra = {}) => soccerQuoteScorePresentation({ result, direction: result.directions[0],
  quote: result.directions[0].quotes[0], now, ...extra });
const control = fixture(), original = JSON.stringify(control);
assert.deepEqual(show(control), { score: 8, W: .0435, R: .024, status: 'QUALIFIED', label: '通過排名門檻', tone: 'qualified', eligible: true });
assert.equal(JSON.stringify(control), original, 'presentation must not mutate the saved/current result');
assert.equal(show(control, { displayGame: structuredClone(game) }).status, 'QUALIFIED');
for (const changed of [null, { ...game, id: 'soccer:epl:124' }, { ...game, league: 'ucl' },
  { ...game, date: '2026-10-21' }, { ...game, sourceId: '124' },
  { ...game, startTime: new Date(now + 7200000).toISOString() }, { ...game, startTime: 'invalid' },
  { ...game, home: game.away, away: game.home }, { ...game, home: { sourceId: '999' } },
  { ...game, away: { sourceId: '999' } }, { ...game, away: {} }, { ...game, neutralSite: true }]) {
  const display = show(control, { displayGame: changed });
  assert.equal(display.status, 'CONTEXT_CHANGED');
  assert.equal(display.label, '賽事資料已更新・待重新評分');
  assert.equal(display.score, null); assert.equal(display.eligible, false);
}
for (const status of ['live', 'final']) {
  const display = show(control, { displayGame: { ...game, status }, now: Date.parse(game.startTime) + 1000 });
  assert.equal(display.status, 'HISTORICAL'); assert.equal(display.score, 8);
  assert.equal(display.eligible, false, 'started/finished games retain genuine prior S only as historical');
}
for (const [W, R] of [[-.01, -.02], [.01, -.01]]) {
  const result = fixture(W, R), display = show(result);
  assert.equal(display.status, 'BELOW_THRESHOLD'); assert.equal(display.label, '未達排名門檻');
  assert.equal(display.score, deterministicScore({ weightedEV: W, robustEV: R, executable: false }).score);
  assert.equal(display.eligible, false, 'valid formal low scores remain visible without borrowing candidate proof');
}
assert.equal(show(control, { now: now + 180000 }).status, 'HISTORICAL');
const pending = fixture(); pending.formalScoringEnabled = false; pending.qualification.eligible = false;
assert.equal(show(pending).status, 'UNPUBLISHED'); assert.equal(show(pending).eligible, false);
for (const alter of [s => { s.qaFlag = 'BLOCKED'; }, s => { s.directions[0].qaFlag = 'BLOCKED'; }]) {
  const result = fixture(); alter(result); const value = show(result);
  assert.equal(value.score, null); assert.equal(value.status, 'BLOCKED');
}
assert.equal(show(control, { periodConfirmed: false }).score, null);
for (const alter of [
  s => { s.directions[0].period = 'UNKNOWN'; }, s => { s.directions[0].quotes[0].period = 'HT'; },
  s => { s.directions[0].quotes[0].side = 'under'; }, s => { s.directions[0].quotes[0].water = 1.1; },
  s => { s.directions[0].quotes[0].line = '4+50'; }, s => { s.directions[0].quotes[0].lineSide = 'away'; },
  s => { s.directions[0].quotes[0].sourceQuoteKey = 'a'.repeat(64); },
  s => { s.directions[0].quotes[0].scoring.sourceQuoteKey = 'a'.repeat(64); },
  s => { s.directions[0].quotes[0].scoring.gameId = 'soccer:epl:124'; },
  s => { s.directions[0].quotes[0].scoring.league = 'ucl'; },
  s => { s.directions[0].quotes[0].scoring.period = 'HT'; },
  s => { s.directions[0].quotes[0].scoring.provenance.quoteHash = 'a'.repeat(64); },
  s => { s.directions[0].quotes[0].scoring.provenance.distributionHash = 'invalid'; },
  s => { s.directions[0].quotes[0].qualification.distributionHash = 'a'.repeat(64); },
  s => { s.directions[0].quotes[0].scoring.conditionalPayoff.ok = false; },
  s => { s.directions[0].quotes[0].scoring.conditionalPayoff.quote.direction = 'UNDER'; },
  s => { s.directions[0].quotes[0].scoring.score = 9; s.directions[0].quotes[0].scoring.S = 9; },
  s => { s.directions[0].quotes[0].scoring.W = NaN; },
  s => { s.directions[0].quotes[0].scoring.R = Infinity; },
  s => { s.directions[0].quotes[0].scoring.scoreFormulaVersion = 'other'; },
  s => { s.directions[0].quotes[0].scoring.formalScoringEnabled = false; },
  s => { s.directions[0].quotes[0].scoring.status = 'RESEARCH_FIXED_SCORE'; },
  s => { s.directions[0].quotes[0].scoring.provenance.calculatedAt = new Date(now + 1).toISOString(); },
]) {
  const result = fixture(); alter(result);
  assert.equal(show(result).score, null, alter.toString());
  assert.equal(show(result).eligible, false, alter.toString());
}
for (const alter of [s => { s.currentResearch.quoteGeneration = '2'; },
  s => { s.directions[0].score = 8.9; }, s => { s.qualification.eligible = false; },
  s => { s.directions[0].quotes[0].eligible = false; }, s => { s.persisted = false; }]) {
  const result = fixture(); alter(result);
  assert.equal(show(result).eligible, false, 'display cannot create publication authority');
}
const research = fixture();
research.directions[0].score = 8.9;
research.prediction = { outcomes: { home: .9, draw: .05, away: .05 } };
const q = research.directions[0].quotes[0];
q.thresholdProbabilities = { above: .99, equal: 0, below: .01 };
q.scoring = { fixedScoreDiagnostic: { score: 8.9 }, formalScoringEnabled: false };
assert.equal(show(research).score, null, 'never derive a score from direction summary, probabilities or unauthorized diagnostics');
q.scoring = scoreSoccerQuote({ quote: q, distribution: research.prediction, game, now });
assert.equal(q.scoring.score, null);
assert.equal(show(research).label, '尚未產生評分', 'actual shipped scorer remains unavailable without accepted evidence');
console.log('PASS football score presentation: actual fixed S only, visible low scores, exact original-quote scope, QA/period guards, current candidate receipt, stale history and no probability/diagnostic substitution');
