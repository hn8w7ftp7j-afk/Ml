import { fetchLeagueTaipeiSlate, buildLeagueGameContext } from '../lib/league-provider.js';
import { estimateRunProfileV11 } from '../lib/joint-score-v11.js';
import { analyzeMarkets } from '../lib/analysis-v11.js';
import { finalizeDeterministicAnalysis } from '../lib/deterministic-finalizer-v10.js';

const date = process.argv[2] || '2026-08-21';
const slate = await fetchLeagueTaipeiSlate('MLB', date);
console.log(JSON.stringify({ audit: 'LIVE_SCORE_MODEL', date, gameCount: slate.length, games: slate.map(game => ({ gamePk: game.gamePk, away: game.away, home: game.home, awayTeamId: game.awayTeamId, homeTeamId: game.homeTeamId, venueId: game.venueId, awayProbableId: game.awayProbableId, homeProbableId: game.homeProbableId, gameDate: game.gameDate })) }, null, 2));

const summaries = [];
for (const game of slate) {
  const context = await buildLeagueGameContext('MLB', game);
  const profile = estimateRunProfileV11(context);
  summaries.push({
    gamePk: game.gamePk,
    matchup: `${game.away} @ ${game.home}`,
    teamIds: [game.awayTeamId, game.homeTeamId],
    gate: context.dataGateV10,
    league: {
      teamCount: context.league?.teamCount,
      sampleSize: context.league?.sampleSize,
      runsPerTeamGame: context.league?.runsPerTeamGame,
      era: context.league?.era,
      whip: context.league?.whip,
      ops: context.league?.ops,
    },
    away: {
      seasonHitting: context.away?.hitting,
      recentHitting: context.away?.recentHitting,
      seasonPitching: context.away?.pitching,
      recentPitching: context.away?.recentPitching,
      starter: context.away?.starter,
      schedule: context.away?.scoring,
      injuriesAvailable: context.away?.injuriesAvailable,
      injuryCount: context.away?.injuries?.length,
    },
    home: {
      seasonHitting: context.home?.hitting,
      recentHitting: context.home?.recentHitting,
      seasonPitching: context.home?.pitching,
      recentPitching: context.home?.recentPitching,
      starter: context.home?.starter,
      schedule: context.home?.scoring,
      injuriesAvailable: context.home?.injuriesAvailable,
      injuryCount: context.home?.injuries?.length,
    },
    park: context.park,
    weather: context.weather,
    profile,
  });
}

console.log('=== PROFILE_SUMMARY ===');
console.table(summaries.map(row => ({
  gamePk: row.gamePk,
  matchup: row.matchup,
  leagueR: Number(row.league.runsPerTeamGame || 0).toFixed(3),
  awayR: Number(row.away.seasonHitting?.runsPerGame || 0).toFixed(3),
  homeR: Number(row.home.seasonHitting?.runsPerGame || 0).toFixed(3),
  awayStarterERA: Number(row.away.starter?.era || 0).toFixed(2),
  homeStarterERA: Number(row.home.starter?.era || 0).toFixed(2),
  park: Number(row.park?.runFactor || 0).toFixed(3),
  weather: Number(row.weather?.meanRunFactor || 0).toFixed(3),
  f5Total: Number((row.profile?.first5?.away || 0) + (row.profile?.first5?.home || 0)).toFixed(3),
  fullTotal: Number((row.profile?.full?.away || 0) + (row.profile?.full?.home || 0)).toFixed(3),
  gate: row.gate?.passedForShadowScore,
  blocking: (row.gate?.blocking || []).join(','),
})));

const target = summaries.find(row => row.teamIds.includes(138) && row.teamIds.includes(113));
if (target) {
  console.log('=== STL_CIN_CONTEXT ===');
  console.log(JSON.stringify(target, null, 2));
  const game = slate.find(item => item.gamePk === target.gamePk);
  const context = await buildLeagueGameContext('MLB', game);
  const market = (marketName, pick, water) => ({
    market: marketName,
    pick,
    water,
    waterEstimated: false,
    sourceType: 'ACTUAL_TW_CREDIT',
    executable: true,
    marketVerification: { verified: false },
  });
  const markets = [
    market('全場大小', '大9平', 0.94), market('全場大小', '小9平', 0.94),
    market('上半讓分', `${game.away}受讓0平`, 0.94), market('上半讓分', `${game.home}讓0平`, 0.94),
    market('上半大小', '大5+80', 0.93), market('上半大小', '小5+80', 0.93),
  ];
  const analysis = analyzeMarkets({ context, markets, settings: { rebateRate: 0.015 } });
  const finalized = finalizeDeterministicAnalysis({ analysis, game, settings: { candidateThreshold: 7.2 } });
  console.log('=== STL_CIN_MARKETS ===');
  console.log(JSON.stringify(finalized.results.map(row => ({
    market: row.market,
    pick: row.pick,
    modelProbability: row.modelProbability,
    marketAnchorProbability: row.marketAnchorProbability,
    rawMarketProbabilityGap: row.rawMarketProbabilityGap,
    weightedEV: row.weightedEV,
    robustEV: row.robustEV,
    q10: row.conservativeEV,
    modelErrorMarginEV: row.modelErrorMarginEV,
    score: row.shadowDiagnosticScore,
    scoreStatus: row.scoreStatus,
    qa: row.scoreAudit,
    fullWin: row.fullWinProbability,
    partialWin: row.partialWinProbability,
    push: row.pushProbability,
    partialLoss: row.partialLossProbability,
    fullLoss: row.fullLossProbability,
  })), null, 2));
}
