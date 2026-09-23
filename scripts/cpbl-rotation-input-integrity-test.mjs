import assert from 'node:assert/strict';
import {
  buildAsianProductionFeatureSnapshot, selectedCpblRotationGames, parseCpblReservedStarterAppearances,
  projectCpblRotationStarter, rotationPrediction,
} from '../lib/asian-production-features-v1.js';
import { buildAsianGameContext, parseCpblSchedulePayload } from '../lib/asian-baseball.js';

// Representative fields from official 2026-A-326: calendar RESERVED while the
// unfinished detail says START. The archived receipt was collected September23,
// so it may never be claimed as evidence available to a September18 forecast.
const raw326 = { Data: { Game: { GameId: '2026-A-326', GameStatus: 'START', PreExeDate: '2026-09-12T17:05:00',
  Visiting: { Team: { Code: 'ADD011' }, Pitchers: [{ PitcherAcnt: '0000007597', PitcherName: '獅帝芬', RoleType: '先發',
    PitchCnt: 39, PlateAppearances: 8, InningPitchedCnt: 2, InningPitchedDiv3Cnt: 0, EarnedRunCnt: 0 }] },
  Home: { Team: { Code: 'AAA011' }, Pitchers: [{ PitcherAcnt: '0000007779', PitcherName: '蔣銲', RoleType: '先發',
    PitchCnt: 38, PlateAppearances: 10, InningPitchedCnt: 3, InningPitchedDiv3Cnt: 0, EarnedRunCnt: 0 }] },
  LiveLog: [
    { Year: '2026', KindCode: 'A', GameSno: 326, InningSeq: 1, VisitingHomeType: '1', PitcherAcnt: '0000007779', PitchCnt: 1, IsChangePlayer: '0' },
    { Year: '2026', KindCode: 'A', GameSno: 326, InningSeq: 1, VisitingHomeType: '2', PitcherAcnt: '0000007597', PitchCnt: 1, IsChangePlayer: '0' },
  ] } } };
const calendar326 = { ...raw326.Data.Game, GameStatus: 'RESERVED', KindCode: 'A', InningSeq: 3,
  Visiting: { ...raw326.Data.Game.Visiting, Score: 99 }, Home: { ...raw326.Data.Game.Home, Score: 98 } };
const suspended = parseCpblSchedulePayload({ Data: { Games: [calendar326] } })[0];
assert.equal(suspended.statusCode, 'D');
assert.equal(suspended.statusEnglish, 'RESERVED');
assert.equal(suspended.awayScore, null, '保留賽進行中分數不得進入完賽得分樣本');
assert.equal(suspended.homeScore, null);
const receipt326 = { id: 'official326', success: true,
  url: 'https://stats.cpbl.com.tw/api/proxy/v1/games/2026-A-326',
  contentHash: '91590346ad859b844d5e9cdc2a04b8753bf52756e38570de30209f061712206e',
  fetchedAt: '2026-09-23T03:30:46.844Z' };
const futureTarget = { gameDate: '2026-09-24T10:35:00Z' };
const verified326 = parseCpblReservedStarterAppearances(raw326, suspended, futureTarget, receipt326);
assert.equal(verified326.detail.away.pitchers[0].id, '0000007597');
assert.equal(verified326.detail.home.pitchers[0].id, '0000007779');
assert.equal(verified326.detail.away.pitchers[0].inningsPitched, null, '未確認補賽時間時不能當成原日工作量');
assert.equal(verified326.detail.away.pitchers[0].appearanceEvidence.latestAppearanceAt, null);
assert.equal(verified326.detail.away.pitchers[0].appearanceEvidence.aggregateWorkloadUsed, false);
assert.equal(parseCpblReservedStarterAppearances(raw326, suspended,
  { gameDate: '2026-09-18T10:35:00Z' }, receipt326).reason, 'MISSING_PRE_TARGET_SOURCE_RECEIPT');
assert.equal(parseCpblReservedStarterAppearances(raw326, suspended, futureTarget,
  { ...receipt326, contentHash:null }).reason, 'MISSING_PRE_TARGET_SOURCE_RECEIPT');
for (const mutate of [
  root => { root.GameStatus = 'FINISHED'; },
  root => { root.GameId = '2026-A-327'; },
  root => { root.Visiting.Team.Code = 'ACN011'; },
  root => { root.PreExeDate = '2026-09-13T17:05:00'; },
  root => { root.LiveLog = []; },
  root => { root.LiveLog.forEach(row => { row.InningSeq = 3; }); },
  root => { root.LiveLog.forEach(row => { row.Year = '2025'; }); },
  root => { root.LiveLog.forEach(row => { row.VisitingHomeType = row.VisitingHomeType === '1' ? '2' : '1'; }); },
]) {
  const changed = structuredClone(raw326); mutate(changed.Data.Game);
  assert.equal(parseCpblReservedStarterAppearances(changed, suspended, futureTarget, receipt326).detail, null);
}

// Synthetic current timeline exercises full pipeline with real collection time.
const day = 86_400_000, kickoff = Date.now() + 60 * 60 * 1000;
const iso = offset => new Date(kickoff - offset * day).toISOString();
const year = new Date(kickoff).getUTCFullYear();
const target = { ...suspended, gamePk: 'cpbl-rotation-coverage-target', providerGameId: `${year}-A-950`,
  officialDate: iso(0).slice(0, 10), gameDate: iso(0), statusCode: 'S', statusEnglish: 'SCHEDULED', venue: '天母' };
const completedGames = [1,2,3,4,5,6,9].map((rest, i) => ({ ...target, gamePk: `cpbl-completed-${i+1}`,
  providerGameId: `${year}-A-${901+i}`, officialDate: iso(rest).slice(0,10), gameDate: iso(rest),
  statusCode: 'F', statusEnglish: 'FINISHED', awayScore: 4, homeScore: 3 }));
const priorSuspended = { ...target, gamePk: 'cpbl-suspended-current', providerGameId: `${year}-A-940`,
  gameDate: iso(2), officialDate: iso(2).slice(0,10), statusCode: 'D', statusEnglish: 'RESERVED', awayScore: null, homeScore: null };
assert.equal(selectedCpblRotationGames(completedGames, target).length, 7, '第七場但仍在既有十天輪值窗內必須讀取');
assert.ok(selectedCpblRotationGames([...completedGames, { ...completedGames[0], gamePk: 'other', providerGameId: 'other',
  awayTeamId: -1, homeTeamId: -2 }], target).every(row => row.providerGameId !== 'other'));
const idFor = (side, index) => String((side === 'away' ? 1000 : 2000) + index).padStart(10, '0');
const completePayload = (game, index) => ({ Data: { Game: { GameId: game.providerGameId, GameStatus: 'FINISHED', PreExeDate: game.gameDate,
  Visiting: { Team: { Code: 'ADD011' }, Hitters: [], Pitchers: [
    { PitcherAcnt: idFor('away', index), PitcherName: `客先發${index}`, RoleType: '先發',
      InningPitchedCnt: 5, InningPitchedDiv3Cnt: 0, PlateAppearances: 22, EarnedRunCnt: 1, HittingCnt: 4, BasesONBallsCnt: 1 },
    { PitcherAcnt: '0000009001', PitcherName: '客後援', RoleType: '中繼',
      InningPitchedCnt: index === 7 ? 40 : 1, InningPitchedDiv3Cnt: 0, PlateAppearances: 4, EarnedRunCnt: 1 },
  ] },
  Home: { Team: { Code: 'AAA011' }, Hitters: [], Pitchers: [
    { PitcherAcnt: idFor('home', index), PitcherName: `主先發${index}`, RoleType: '先發',
      InningPitchedCnt: 5, InningPitchedDiv3Cnt: 0, PlateAppearances: 22, EarnedRunCnt: 2, HittingCnt: 5, BasesONBallsCnt: 1 },
    { PitcherAcnt: '0000009002', PitcherName: '主後援', RoleType: '中繼',
      InningPitchedCnt: index === 7 ? 40 : 1, InningPitchedDiv3Cnt: 0, PlateAppearances: 4, EarnedRunCnt: 1 },
  ] },
} } });
const priorPayload = structuredClone(raw326);
Object.assign(priorPayload.Data.Game, { GameId: priorSuspended.providerGameId, PreExeDate: priorSuspended.gameDate });
for (const [side, key] of [['away','Visiting'], ['home','Home']]) {
  Object.assign(priorPayload.Data.Game[key].Pitchers[0], { PitcherAcnt: idFor(side,5), PitcherName: `${side}先發5` });
}
priorPayload.Data.Game.LiveLog.forEach(row => {
  row.Year = String(year); row.GameSno = 940;
  row.PitcherAcnt = idFor(row.VisitingHomeType === '2' ? 'away' : 'home',5);
});
const payloadById = new Map(completedGames.map((g,i) => [g.providerGameId, completePayload(g,i+1)]));
payloadById.set(priorSuspended.providerGameId, priorPayload);
const calls = [];
const fetchImpl = async url => {
  calls.push(url);
  const id = String(url).split('/').at(-1);
  let data = payloadById.get(id) || { Data: [] };
  if (String(url).includes('/players/')) data = { Data: { Player: { Basic: { Acnt: id,
    Team: { Code: id.startsWith('0000001') ? 'ADD011' : 'AAA011' }, PitchingHabbit: 'R', IsForeign: '0' } } } };
  return { ok: true, status: 200, text: async () => JSON.stringify(data) };
};
const result = await buildAsianProductionFeatureSnapshot({ leagueId: 'CPBL', game: target,
  history: [...completedGames, { ...priorSuspended, awayScore: 99, homeScore: 98 }],
  appearanceHistory: [...completedGames, priorSuspended], fetchImpl });
const snapshot = result.featureSnapshot;
assert.equal(snapshot.away.teamStrength.currentSeasonGames, 7);
assert.equal(snapshot.away.teamStrength.seasonHitting.runsPerGame, 4);
assert.equal(snapshot.away.bullpen.sampleInnings, 6, '新增第七場只擴充投手候選能力，不改既有六場牛棚樣本');
assert.equal(snapshot.rotationInputDiagnostics.completedDetailsFetched, 7);
assert.equal(snapshot.rotationInputDiagnostics.reserved.verifiedStarterAppearances, 2);
assert.equal(snapshot.rotationInputDiagnostics.fullCandidateCoverageVerified, false);
assert.ok(snapshot.away.starter.candidates.some(row => row.id === idFor('away',7)), '第七場先發補回候選');
assert.ok(!snapshot.away.starter.candidates.some(row => row.id === idFor('away',5)), '已於兩天前保留賽先發不能繼續沿用五天前紀錄');
assert.ok(calls.some(url => url.endsWith(completedGames[6].providerGameId)));
const urlByEvent = new Map(snapshot.sourceEvidence.events.map(row => [row.id,row.url]));
const bullpenBinding = snapshot.sourceEvidence.features.find(row => row.featureName === 'away.bullpen');
assert.equal(bullpenBinding.sourceScope.completedGameIds.length, 6);
assert.ok(bullpenBinding.sourceBindings.every(row => !urlByEvent.get(row.eventId).endsWith(priorSuspended.providerGameId)
  && !urlByEvent.get(row.eventId).endsWith(completedGames[6].providerGameId)));
const starterBinding = snapshot.sourceEvidence.features.find(row => row.featureName === 'away.starter');
const reservedBindings = starterBinding.sourceBindings.filter(row => urlByEvent.get(row.eventId).endsWith(priorSuspended.providerGameId));
assert.ok(reservedBindings.some(row => row.path.at(-1) === 'LiveLog'));
assert.ok(reservedBindings.some(row => row.path.at(-1) === 'PreExeDate'));
assert.ok(reservedBindings.every(row => row.transformation.includes('ORIGINAL_START_ONLY') && !row.transformation.includes('RECENT_START_INNINGS_MEAN')));
assert.equal(snapshot.sourceEvidence.features.find(row => row.featureName === 'away.lineup').sourceBindings.length, 0);

const context = await buildAsianGameContext('CPBL', target, {
  historyGames: [...completedGames, priorSuspended], productionFeatures: true, fetchImpl,
});
assert.equal(context.league.runsPerTeamGame, 3.5, '保留賽比分不得污染正式聯盟基準');
const historyInput = context.sourceEvidence.features.find(row => row.featureName === 'history').parsedInput;
assert.equal(historyInput.length, 7);
assert.ok(historyInput.every(row => row.statusCode === 'F'));
assert.ok(context.sourceEvidence.features.find(row => row.featureName === 'away.starter').sourceScope.appearanceGameIds.includes(priorSuspended.providerGameId));

// Reserved cumulative totals deliberately absurd: capability must remain the
// last completed performance sample while original-start date advances.
const partial = parseCpblReservedStarterAppearances(priorPayload, priorSuspended, target,
  { ...receipt326, url: `https://stats.cpbl.com.tw/api/proxy/v1/games/${priorSuspended.providerGameId}`, fetchedAt: new Date().toISOString() });
const old = { game: completedGames[4], detail: { away: { pitchers: [{ id: idFor('away',5), name: '候選', starter:true,
  inningsPitched:5, battersFaced:22, earnedRuns:1, hits:4, walks:1 }] } } };
const combined = [old, { game: priorSuspended, detail: partial.detail, appearanceOnly:true }];
const laterTarget = new Date(Date.parse(priorSuspended.gameDate)+6*day).toISOString();
const candidate = projectCpblRotationStarter(combined,target.awayTeamId,laterTarget).candidates[0];
assert.equal(candidate.lastStart, priorSuspended.gameDate);
assert.equal(candidate.priorStarts,1);
assert.equal(candidate.era,1.8);
assert.equal(candidate.expectedInnings,5);
assert.equal(candidate.possibleResumptionTimeUnknown,true);
assert.equal(candidate.restDaysBasis,'ORIGINAL_GAME_START_ONLY_LATEST_APPEARANCE_UNVERIFIED');
const fallback = rotationPrediction(combined,target.awayTeamId,laterTarget,'CPBL').candidates[0];
assert.equal(fallback.lastStartAt,priorSuspended.gameDate);
assert.equal(fallback.priorStarts,1);
assert.equal(fallback.expectedInnings,5);

const invalidGame = { ...completedGames[6], providerGameId: `${year}-A-999`, gamePk:'wrong-completed-source' };
const invalidResult = (await buildAsianProductionFeatureSnapshot({ leagueId:'CPBL', game:target,
  history:[...completedGames.slice(0,6),invalidGame], appearanceHistory:[],
  fetchImpl: async url => url.endsWith(invalidGame.providerGameId)
    ? { ok:true, status:200, text:async()=>JSON.stringify(completePayload(completedGames[6],7)) } : fetchImpl(url),
})).featureSnapshot;
assert.deepEqual(invalidResult.rotationInputDiagnostics.missingCompletedDetails,
  [{ providerGameId:invalidGame.providerGameId, reason:'CPBL_DETAIL_IDENTITY_NOT_VERIFIED' }]);
assert.equal(invalidResult.rotationInputDiagnostics.completedDetailsFetched,6);
assert.equal(invalidResult.rotationInputDiagnostics.fullCandidateCoverageVerified,false);
console.log('CPBL seventh-game coverage, reserved original starter evidence/cutoff, completed-only baselines and consumed-source scopes PASS');
