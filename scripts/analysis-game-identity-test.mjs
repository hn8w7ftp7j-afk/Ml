import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { analysisStarterDisplay } from '../lib/analysis-starter-display.js';
import { analysisDisplayGame, analysisGameIdentity, sameAnalysisGame } from '../lib/analysis-game-identity-v1.js';
import { preserveCompletedReaderResult, mergePreparedLeagueBoard } from '../lib/all-league-analysis-v117.js';
import { shouldPreserveCalculatedAnalysis, analysisIsUnopenedOnly } from '../lib/analysis-display-state-v116.js';

const game = { gamePk: 123, leagueId: 'KBO', awayTeamId: 604, homeTeamId: 608, gameDate: '2099-09-08T09:30:00Z', awayProbable: null, homeProbable: null };
const frozen = { ...game, awayProbable: '최승용', homeProbable: '류현진' };
const analysis = { calculatedDirectionCount: 1, results: [{ market: 'first5_total', modelEV: .2011 }] };
const payload = { game: frozen, analysis, repriceSnapshot: { inputHash: 'snapshot-A' } };
assert.equal(analysisGameIdentity(game, frozen).awayProbable, '최승용');
assert.equal(analysisGameIdentity(frozen, game).awayProbable, null, 'explicit unknown must not revive a previous pitcher');
assert.equal(analysisGameIdentity(frozen, { gamePk: game.gamePk }).homeProbable, null, 'legacy missing name must not borrow a newer schedule');
assert.throws(() => analysisGameIdentity(game, { ...frozen, homeTeamId: 999 }), /IDENTITY_MISMATCH/);
assert.equal(sameAnalysisGame(game, { ...game, leagueId: 'MLB' }), false);
const original = JSON.stringify(payload);
const preserved = preserveCompletedReaderResult(null, { ok: true, task: { game }, payload }, { markets: [{ market: 'first5_total' }] });
assert.equal(preserved.game.awayProbable, '최승용');
assert.equal(preserved.readerPayloadHash, null, 'preserving a result cannot grant Reader authority');
const refreshed = mergePreparedLeagueBoard([preserved], [{ game: { ...game, awayProbable: 'new pitcher' }, status: 'queued' }])[0];
assert.equal(analysisDisplayGame(refreshed).awayProbable, '최승용', 'header must show the retained analysis identity');
assert.equal(JSON.stringify(payload), original);
const displayItem = { ...refreshed, game: analysisDisplayGame(refreshed), customData: { ...payload, context: { game: frozen, leagueId: 'KBO', away: { starter: { id: 10, teamId: 604, name: '최승용', assignmentStatus: 'PROJECTED' } } } } };
assert.equal(analysisStarterDisplay(displayItem, 'away'), '최승용（輪值推估）', 'retained header must preserve assignment provenance labels');
assert.equal(analysisStarterDisplay(displayItem, 'home'), '류현진', 'fallback must use retained identity, not the live schedule');
assert.equal(preserveCompletedReaderResult(preserved, { ok: true, task: { game }, payload: { ...payload, game: { ...game, gamePk: 456 } } }), preserved);

// Exercise the actual synchronous commit path, including stale-result rejection.
const page = fs.readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');
const start = page.indexOf('  function commitAnalysisPayload(');
const end = page.indexOf('\n  function commitAnalysisFailure', start);
assert.ok(start > 0 && end > start);
const boardRef = { current: [{ game, customData: payload, pendingReaderEvidenceHash: 'new-price' }] };
let stale = true;
const context = vm.createContext({
  analysisGameIdentity, sameAnalysisGame, shouldPreserveCalculatedAnalysis, analysisIsUnopenedOnly,
  boardRef, taskReaderStateIsStale: () => stale, setBoard: board => { boardRef.current = board; },
  storageReady: false, coreDataBlockRetryRef: { current: new Map() },
  coreDataBlockKey: () => 'key', readerGameEvidenceHash: () => 'new-price',
  league: 'KBO', currentDateRef: { current: '2099-09-08' },
  snapshots: { current: new Map() }, compactAnalysisData: value => value,
});
vm.runInContext(page.slice(start, end), context);
const task = { game, actualMarkets: [{ market: 'first5_total', pick: '大5.5', water: .92 }], readerPayloadHash: 'current-reader' };
const before = boardRef.current;
assert.equal(context.commitAnalysisPayload(task, payload), false);
assert.equal(boardRef.current, before, 'late result must not replace the current board');
stale = false;
assert.equal(context.commitAnalysisPayload(task, { ...payload, game: { ...frozen, gamePk: 456 } }), false);
assert.equal(boardRef.current, before, 'wrong-game result must be rejected');
assert.equal(context.commitAnalysisPayload(task, payload), true);
assert.equal(boardRef.current[0].game.homeProbable, '류현진');
assert.equal(boardRef.current[0].pendingReaderEvidenceHash, null);
assert.equal(boardRef.current[0].customData.analysis, analysis, 'identity repair must not recalculate scores');
console.log('PASS frozen analysis identity, retained header, wrong-game rejection and stale commit');
