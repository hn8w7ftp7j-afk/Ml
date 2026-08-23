import assert from 'node:assert/strict';
import {
  LEAGUE_IDS,
  LEAGUE_REGISTRY_VERSION,
  leagueCanAnalyze,
  leagueConfig,
  isLeagueId,
  normalizeLeagueId,
  publicLeagueRegistry,
  requestedLeagueId,
} from '../lib/leagues.js';

assert.equal(LEAGUE_REGISTRY_VERSION, 'SPORTS-LEAGUE-REGISTRY-2026-08-v2.2.1');
assert.deepEqual(LEAGUE_IDS, ['MLB', 'NPB', 'KBO', 'CPBL']);
assert.equal(normalizeLeagueId('npb'), 'NPB');
assert.equal(normalizeLeagueId('unknown'), 'MLB');
assert.equal(isLeagueId('cpbl'), true);
assert.equal(isLeagueId('unknown'), false);
assert.equal(isLeagueId(['MLB']), false);
assert.equal(requestedLeagueId(undefined), 'MLB');
assert.equal(requestedLeagueId(null), 'MLB');
assert.equal(requestedLeagueId(''), 'MLB');
assert.equal(requestedLeagueId(' npb '), 'NPB');
assert.equal(requestedLeagueId('unknown'), null);
assert.equal(requestedLeagueId([]), null);
assert.equal(requestedLeagueId(['MLB']), null);
assert.equal(requestedLeagueId({ league: 'MLB' }), null);
assert.equal(requestedLeagueId(0), null);
assert.equal(leagueCanAnalyze('MLB'), true);
assert.equal(leagueCanAnalyze('unknown'), false);
assert.equal(leagueCanAnalyze(['MLB']), false);

for (const id of LEAGUE_IDS) {
  const item = leagueConfig(id);
  assert.equal(item.status, 'shadow');
  assert.deepEqual(item.capabilities, {
    schedule: true,
    reader: true,
    analysis: true,
    ranking: true,
    bets: true,
    formalRecommendations: false,
  });
  assert.equal(item.readerProvider, 'TAI888_READER_AUTO');
  assert.equal(item.scheduleEndpoint, '/api/schedule');
}

assert.equal(leagueConfig('MLB').scheduleProvider, 'MLB_STATS_API');
assert.equal(leagueConfig('MLB').modelFamily, 'MLB_JOINT_SCORE_DISTRIBUTION_REBUILD');
for (const id of ['NPB', 'KBO', 'CPBL']) {
  const item = leagueConfig(id);
  assert.match(item.scheduleProvider, new RegExp(`^${id}_OFFICIAL`));
  assert.match(item.modelFamily, new RegExp(`^${id}_SHADOW_`));
}

const publicRows = publicLeagueRegistry();
assert.equal(publicRows.length, 4);
assert.equal(publicRows.every(row => row.capabilities && typeof row.capabilities === 'object'), true);
assert.deepEqual(publicRows.map(row => row.id), LEAGUE_IDS);
assert.equal(publicRows.find(row => row.id === 'MLB').capabilities.analysis, true);
assert.equal(publicRows.find(row => row.id === 'NPB').capabilities.analysis, true);
assert.equal(publicRows.find(row => row.id === 'CPBL').capabilities.analysis, true);
assert.equal(publicRows.find(row => row.id === 'KBO').capabilities.analysis, true);
assert.equal(publicRows.every(row => row.capabilities.bets === true), true, 'Shadow只停用模型推薦，不得停用使用者真實下注帳本');
assert.equal(publicRows.every(row => row.capabilities.formalRecommendations === false), true);

console.log('multi-league registry: MLB Shadow, Asian model setup, ledgers available and formal recommendations off PASS');
