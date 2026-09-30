import assert from 'node:assert/strict';
import { buildAsianGameContext } from '../lib/asian-baseball.js';

// Synthetic adapter handoff, not a claim about any historical game.
const game = { league: 'CPBL', leagueId: 'CPBL', gamePk: 991701,
  gameDate: '2099-08-25T10:00:00.000Z', officialDate: '2099-08-25',
  away: '中信兄弟', home: '樂天桃猿', awayTeamId: 701, homeTeamId: 703,
  awayCode: 'CTB', homeCode: 'RKM', statusCode: 'S', gameNumber: 1,
  awayProbableId: 'AWAY-ID', homeProbableId: 'HOME-ID',
  awayProbable: 'Synthetic Away', homeProbable: 'Synthetic Home',
  probableSource: 'CPBL_OFFICIAL_SYNTHETIC_FIXTURE' };
const historyGames = Array.from({ length: 16 }, (_, index) => ({ ...game,
  gamePk: 910000 + index, statusCode: 'F', awayScore: 3, homeScore: 4,
  gameDate: `2099-08-${String(index + 1).padStart(2, '0')}T10:00:00.000Z`,
  officialDate: `2099-08-${String(index + 1).padStart(2, '0')}` }));
const evidence = { status: 'REJECTED', reason: 'PLAYER_ID_MISMATCH', expectedPlayerId: 'AWAY-ID' };
const featureSnapshot = { asOf: '2099-08-25T08:00:00.000Z',
  away: { starter: { id: game.awayProbableId, name: game.awayProbable, teamId: game.awayTeamId,
    identityConfirmed: true, identitySource: game.probableSource,
    performanceAvailable: false, performanceIdentityEvidence: evidence,
    performanceMissingReason: 'PLAYER_ID_MISMATCH' } },
  home: { starter: { id: game.homeProbableId, name: game.homeProbable, teamId: game.homeTeamId,
    identityConfirmed: true, identitySource: game.probableSource, performanceAvailable: false } },
  weather: { available: true, source: 'SYNTHETIC_WEATHER' },
  rules: { foreignPlayerConstraint: { status: 'DIAGNOSTIC_ONLY', applies: null,
    source: 'SYNTHETIC_PROFILE_REJECTED', identityEvidence: evidence } } };
const context = await buildAsianGameContext('CPBL', game, { historyGames, featureSnapshot });
assert.equal(context.away.starter.identityConfirmed, true);
assert.equal(context.away.starter.performanceAvailable, false);
assert.deepEqual(context.away.starter.performanceIdentityEvidence, evidence);
assert.equal(context.away.starter.performanceMissingReason, 'PLAYER_ID_MISMATCH');
assert.equal(context.home.starter.performanceMissingReason, 'OFFICIAL_STARTER_PERFORMANCE_UNAVAILABLE_OR_INSUFFICIENT');
assert.equal(context.leagueRuleState.cpbl.foreignPlayerConstraint.applies, null, 'unknown nationality must not become domestic');
assert.deepEqual(context.leagueRuleState.cpbl.foreignPlayerConstraint.identityEvidence, evidence);
assert.equal(context.featureProvenance.find(row => row.feature === '天氣').status, '已建模／預測');
const umpire = context.featureProvenance.find(row => row.feature === '主審');
assert.equal(umpire.status, '缺失', 'weather availability cannot confirm an umpire');
assert.equal(umpire.timeEvidenceStatus, 'PENDING');
assert.deepEqual(umpire.sourceEventIds, []);
assert.equal(context.featureProvenance.some(row => row.feature === '天氣／主審'), false);
console.log('Asian personnel evidence handoff: rejected ability, unknown foreign status and independent umpire provenance PASS');
