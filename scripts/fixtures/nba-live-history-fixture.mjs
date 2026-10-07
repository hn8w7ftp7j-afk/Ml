// Synthetic temporal variations of a saved, real CLE@NYK final box. These are
// test fixtures only; generated identities/sources are never production data.
import fs from 'node:fs';
import {crosswalkOfficialGame} from '../../lib/nba/official.js';
import {buildNbaLiveHistoryRow, nbaLiveHistoryHash, nbaLiveOutcomeHash} from '../../lib/nba/live-history.js';

const saved = JSON.parse(fs.readFileSync(new URL('./nba-onoff-401809234.json',import.meta.url)));
const raw = JSON.parse(fs.readFileSync(new URL('./nba-official-0022500003.json',import.meta.url)));
export function createLiveHistoryFixture({date = '2025-10-23', year = 2026, seasonType = 'regular', gameId = '401809234'} = {}) {
  const game = structuredClone(saved.game);
  game.sourceId = gameId.replace('nba:espn:game:',''); game.id = `nba:espn:game:${game.sourceId}`;
  game.startTime = `${date}T02:00:00.000Z`; game.taipeiDate = date; game.season = {year,type:seasonType}; game.seasonType = seasonType;
  const now = Date.parse(`${date}T06:00:00.000Z`), fetchedAt = new Date(now).toISOString();
  const officialGameId = `${{preseason:'001',regular:'002',postseason:'004'}[seasonType]}${String(year-1).slice(-2)}${game.sourceId.slice(-5).padStart(5,'0')}`;
  const officialBox = structuredClone(raw.game); officialBox.gameId = officialGameId; officialBox.gameTimeUTC = game.startTime;
  const card = {gameId:officialGameId,homeTeam:{teamId:officialBox.homeTeam.teamId},awayTeam:{teamId:officialBox.awayTeam.teamId}};
  const official = crosswalkOfficialGame(officialBox,card,game,saved.players);
  const easternDate = new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(game.startTime));
  official.sources = [{provider:'NBA',url:`https://www.nba.com/games?date=${easternDate}`,hash:nbaLiveHistoryHash(card),fetchedAt,status:'ready'}, {provider:'NBA',url:`https://www.nba.com/game/cle-vs-nyk-${officialGameId}/box-score`,hash:nbaLiveHistoryHash(officialBox),fetchedAt,status:'ready'}];
  const result = {league:'NBA',status:'ready',qa:{status:'WARNING',issues:[]},data:{game,players:structuredClone(saved.players)},sources:[{provider:'ESPN',url:`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${game.sourceId}`,hash:nbaLiveHistoryHash(game),fetchedAt,status:'ready'}]};
  return {row:buildNbaLiveHistoryRow(result,official,{now}), result, official, now};
}
export function resealLiveHistoryFixture(row) {
  delete row.recordHash; delete row.revision;
  row.checkpointSha256 = nbaLiveHistoryHash({game:row.game,sources:row.sources});
  row.outcomeHash = nbaLiveOutcomeHash(row); row.recordHash = nbaLiveHistoryHash(row); return row;
}
