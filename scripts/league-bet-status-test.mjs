import assert from 'node:assert/strict';
import fs from 'node:fs';
import { BET_ORDER_MIN_SCORE, buildBetOrderEntries } from '../lib/bet-order.js';
import { betIdentity } from '../lib/bet-ledger.js';
import { leagueAnalysisReminderReady, summarizeBaseballHighScoreBets, summarizeHighScoreBets } from '../lib/league-bet-status.js';

const date = '2099-10-18';
const league = 'MLB';
const game = { leagueId: league, gamePk: 777001, gameDate: `${date}T12:00:00.000Z` };
const makeEntry = (stableKey, pick, overrides = {}) => {
  const row = { market: '全場大小', pick, water: 0.95 };
  return { stableKey, item: { game }, gamePk: game.gamePk, row,
    ...row, score: BET_ORDER_MIN_SCORE, weightedEV: 0.02, robustEV: 0.01, ...overrides };
};
const over = makeEntry('full-total-over', '大8平');
const under = makeEntry('full-total-under', '小8平');
const ticket = (entry, overrides = {}) => ({
  id: `ticket-${entry.stableKey}`, league, date, gamePk: game.gamePk,
  ...entry.row, identity: betIdentity(date, game.gamePk, entry.row, league), status: 'OPEN', ...overrides,
});
const candidates = buildBetOrderEntries([
  over, under,
  makeEntry('below-threshold', '大8平', { score: BET_ORDER_MIN_SCORE - 0.1 }),
  makeEntry('missing-score', '大8平', { score: null }),
  makeEntry('zero-w', '大8平', { weightedEV: 0 }),
  makeEntry('negative-r', '大8平', { robustEV: -0.01 }),
]);
assert.equal(candidates.length, 2, 'badges must consume existing score/W/R candidate filtering');
assert.equal(BET_ORDER_MIN_SCORE, 7, 'this display change must preserve the existing candidate threshold');
const summarize = (bets = [], extra = {}) => summarizeBaseballHighScoreBets(candidates, {
  bets, league, date, ledgerReady: true, ...extra,
});
assert.deepEqual(summarize(), { state: 'unbet', label: '有高分未下注', total: 2, recorded: 0, unbet: 2 });
assert.equal(summarize([ticket(over)]).unbet, 1, 'one recorded direction must not hide another unbet direction');
assert.deepEqual(summarize([ticket(over), ticket(under)]), {
  state: 'all_bet', label: '高分已全下注', total: 2, recorded: 2, unbet: 0,
});
assert.equal(summarize([ticket(over, { status: 'CANCELLED' }), ticket(under)]).unbet, 1,
  'cancelled tickets must immediately return their direction to unbet');
assert.equal(summarize([
  ticket(over, { status: 'CANCELLED' }), ticket(over, { id: 'rebet' }), ticket(under),
]).state, 'all_bet', 'a later confirmed rebet must restore all-bet despite retained cancelled evidence');
assert.equal(summarize([ticket(over, { status: 'SETTLED' }), ticket(under)]).state, 'all_bet',
  'settled tickets remain previously recorded bets');
assert.equal(summarize([ticket(over), ticket(under)], { ledgerReady: false }).state, 'pending',
  'unavailable ledger must not declare all-bet using old records');
assert.equal(summarize([ticket(over), ticket(under)], { ledgerReady: false }).recorded, null);
assert.deepEqual(summarizeHighScoreBets([], { ledgerReady: true, isRecorded: () => true }), {
  state: 'none', label: '', total: 0, recorded: 0, unbet: 0,
}, 'zero candidates must not vacuously display all-bet');
assert.equal(summarizeHighScoreBets([], { ledgerReady: false }).state, 'none');
assert.equal(summarizeHighScoreBets([over, { ...over }], {
  ledgerReady: true, isRecorded: () => true,
}).total, 1, 'duplicate direction rows must count once');
assert.equal(summarizeHighScoreBets([over], { ledgerReady: true }).state, 'unbet',
  'a pending or absent confirmation callback cannot claim recorded');

const movedOver = { ...over, row: { ...over.row, pick: '大9-30', water: 0.82 } };
assert.equal(summarizeBaseballHighScoreBets([movedOver], {
  bets: [ticket(over)], league, date, ledgerReady: true,
}).state, 'all_bet', 'changed price or line must preserve the existing direction ticket');
const runline = makeEntry('full-runline-away', '道奇讓1-20');
runline.row = { market: '全場讓分', pick: runline.pick, water: 0.95 };
const receiving = { ...runline, row: { ...runline.row, pick: '道奇受讓1+20' } };
assert.equal(summarizeBaseballHighScoreBets([receiving], {
  bets: [ticket(runline)], league, date, ledgerReady: true,
}).state, 'all_bet', 'giving-to-receiving price flips must retain the original same-team record');
for (const wrong of [
  ticket(over, { league: 'NPB', identity: betIdentity(date, game.gamePk, over.row, 'NPB') }),
  ticket(over, { date: '2099-10-19', identity: betIdentity('2099-10-19', game.gamePk, over.row, league) }),
  ticket(over, { gamePk: game.gamePk + 1, identity: betIdentity(date, game.gamePk + 1, over.row, league) }),
  ticket(under),
]) {
  assert.equal(summarizeBaseballHighScoreBets([over], {
    bets: [wrong], league, date, ledgerReady: true,
  }).state, 'unbet', 'a different league/date/game/direction ticket must not satisfy the candidate');
}

const page = fs.readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');
const reminderStart = page.indexOf('const leagueReminderBoards = useMemo');
const reminderEnd = page.indexOf('const rankingLayoutRevision = useMemo', reminderStart);
assert.ok(reminderStart >= 0 && reminderEnd > reminderStart);
const reminders = page.slice(reminderStart, reminderEnd);
assert.match(reminders, /analysisItemMatchesScope\(item, \{ league: id, date: scopeDate \}\)/,
  'every reminder board must exclude other league/date analysis rows');
assert.match(reminders, /buildBetOrderEntries\(buildShadowRanking\(scope\.board, id, clockNow, \{\}\)\)/,
  'active and inactive league badges must use the same scope-filtered candidate source');
assert.match(reminders, /summarizeBaseballHighScoreBets\(candidates, \{[\s\S]*bets, league: id, date: scope\.date/,
  'the displayed badge must use durable bet matching in its own league/date scope');
assert.doesNotMatch(reminders, /id === league \? shadowBetOrder/,
  'changing the selected date must not reuse candidates from the previous active board');
assert.match(page, /<LeagueBetBadge summary=\{leagueBetStatuses\[id\]\}/,
  'outer league cards must display the derived status');
console.log('High-score league badges: existing candidates, durable ticket state, cancel/rebet, price changes and scope isolation PASS');

const oldTime = '2099-10-18T01:00:00Z', newTime = '2099-10-18T02:00:00Z';
const earlierComplete = { status: 'completed', startedAt: oldTime, needsRecovery: false, resultLoaded: true };
const newerRunning = { status: 'running', startedAt: newTime };
const readyBatch = { status: 'done', resultLoaded: true };
for (const status of ['preparing', 'queued', 'running', 'result_pending', 'failed']) {
  const ready = leagueAnalysisReminderReady(null, { status, resultLoaded: false }, newTime);
  assert.equal(ready, false, status);
  const label = summarizeHighScoreBets([over], { ledgerReady: true, isRecorded: () => true, analysisReady: ready });
  assert.equal(label.state, 'analysis_pending', 'earlier all-bet must not survive unfinished current results');
  assert.notEqual(label.label, '高分已全下注');
}
assert.equal(leagueAnalysisReminderReady(earlierComplete, { status: 'running' }, newTime), false,
  'newer all-league run wins over an old independent run');
assert.equal(leagueAnalysisReminderReady(newerRunning, readyBatch, oldTime), false,
  'newer independent run wins over an old all-league run');
assert.equal(leagueAnalysisReminderReady({ ...earlierComplete, startedAt: newTime, resultLoaded: false, needsRecovery: true }, readyBatch, oldTime), false,
  'completed server summary is not a loaded analysis result');
assert.equal(leagueAnalysisReminderReady({ ...earlierComplete, startedAt: newTime, needsRecovery: true }, readyBatch, oldTime), true,
  'loaded immutable display results may summarize bets without granting Reader authority');
assert.equal(leagueAnalysisReminderReady(earlierComplete, readyBatch, newTime), true);
assert.equal(leagueAnalysisReminderReady(null, null), true);
assert.equal(summarizeHighScoreBets([], { analysisReady: false }).state, 'analysis_pending',
  'unknown current results must not be confused with a confirmed empty candidate set');
console.log('High-score reminders fence older all-bet state during newer runs and pending result loading PASS');
