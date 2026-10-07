import {createHash} from 'node:crypto';
import {assertNba, validDate, taipeiDate, ESPN_NBA_TEAMS} from './identity.js';
import {deriveNbaBoxscore} from './basketball.js';
import {NBA_OFFICIAL_VERSION} from './official.js';

export const NBA_LIVE_HISTORY_KIND = 'NBA_VERIFIED_LIVE_HISTORY';
const ordered = value => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(ordered).join(',')}]` : `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${ordered(value[key])}`).join(',')}}`;
export const nbaLiveHistoryHash = value => createHash('sha256').update(ordered(value)).digest('hex');
const fail = (condition, message) => assertNba(condition, 'NBA_LIVE_HISTORY_INVALID', message);
const aliases = {GS:'GSW', NO:'NOP', NY:'NYK', SA:'SAS', UTAH:'UTA', WSH:'WAS'};
const teamValid = team => team?.league === 'NBA' && team.id === `nba:espn:team:${team.sourceId}` && ESPN_NBA_TEAMS[team.sourceId] === team.abbreviation;
const outcome = row => ({gameId:row.gameId, date:row.date, year:row.year, seasonType:row.seasonType, homeId:row.homeId, awayId:row.awayId, homeScore:row.homeScore, awayScore:row.awayScore, homeHalf:row.homeHalf, awayHalf:row.awayHalf, neutralSite:row.neutralSite, pace:row.pace, officialGameId:row.officialGameId, homePeriods:row.game.home.periodScores, awayPeriods:row.game.away.periodScores});
export const nbaLiveOutcomeHash = row => nbaLiveHistoryHash(outcome(row));

// A postgame record is useful only for subsequent dates. Its acquisition time is
// never backdated, and the derived pace remains a box-score proxy, not NBA pace.
export function validateNbaLiveHistoryRow(row, now = Date.now()) {
  const game = row?.game;
  fail(row?.kind === NBA_LIVE_HISTORY_KIND && row.league === 'NBA' && row.strictPointInTime === false && row.promotionEligible === false && row.temporalBasis === 'verified_postgame_history_for_later_dates', '歷史資料不能冒充賽前快照或正式投注驗證');
  fail(game?.league === 'NBA' && game.status === 'final' && game.completed === true && game.timeConfirmed === true && game.id === row.gameId && game.id === `nba:espn:game:${game.sourceId}` && /^[1-9]\d{0,14}$/.test(game.sourceId || ''), '僅接受身分核對且已完賽的 NBA 比分');
  fail(validDate(row.date) && row.date === game.taipeiDate && row.date === taipeiDate(game.startTime) && Number.isInteger(row.year) && row.year >= 1947 && row.year <= 2200 && row.year === game.season?.year && ['preseason','regular','postseason'].includes(row.seasonType) && row.seasonType === game.seasonType && row.seasonType === game.season?.type, '賽季、賽制或台北比賽日期不一致');
  fail(teamValid(game.home) && teamValid(game.away) && game.home.id !== game.away.id && row.homeId === game.home.id && row.awayId === game.away.id && row.homeScore === game.home.score && row.awayScore === game.away.score && typeof game.neutralSite === 'boolean' && row.neutralSite === game.neutralSite, 'NBA 球隊、主客或比分身分衝突');
  const captured = Date.parse(row.capturedAt), start = Date.parse(game.startTime);
  fail(Number.isFinite(captured) && Number.isFinite(start) && captured <= now && captured > start, '賽後取得时间不得提前或晚於目前');
  const official = row.official;
  const prefixes = {preseason:'001', regular:'002', postseason:'004'};
  fail(official?.version === NBA_OFFICIAL_VERSION && ['ready','partial'].includes(official.status) && official.gameId === game.id && official.temporalBasis === 'postgame_crosscheck' && official.pregameLineupVerified === false && /^00[124]\d{7}$/.test(row.officialGameId || '') && row.officialGameId === official.officialGameId && row.officialGameId.startsWith(prefixes[row.seasonType]) && row.officialGameId.slice(3,5) === String(row.year-1).slice(-2), '官方 final／球隊／賽制核對缺失；附加賽及 Cup 決賽不納入');
  const name = game.name || '';
  const cupFinal = /(?:nba|emirates|in[ -]?season)[ -]?(?:cup|tournament).*?\b(?:finals?|championship)\b|(?:cup|tournament)[ -]?\b(?:finals?|championship)\b/i.test(name) && !/\b(?:semi|quarter)[ -]?finals?\b/i.test(name);
  fail(!/play[ -]?in/i.test(name) && !cupFinal, '附加賽或 Cup 決賽不屬於此固定訓練範圍');
  fail(Array.isArray(official.teams) && official.teams.length === 2 && new Set(official.teams.map(team => team.officialId)).size === 2 && [game.home, game.away].every(team => official.teams.filter(item => item.providerId === team.id && /^nba:official:team:[1-9]\d+$/.test(item.officialId || '') && item.officialId === `nba:official:team:${item.officialSourceId}` && item.tricode === (aliases[team.abbreviation] || team.abbreviation)).length === 1), '官方與 ESPN 球隊 crosswalk 不完整');
  fail(Array.isArray(row.sources) && row.sources.length >= 3 && row.sources.every(source => {
    let url; try {url = new URL(source.url);} catch {return false;}
    const fetched = Date.parse(source.fetchedAt);
    const espn = source.provider === 'ESPN' && url.origin === 'https://site.api.espn.com' && url.pathname === '/apis/site/v2/sports/basketball/nba/summary' && url.searchParams.get('event') === game.sourceId;
    const nba = source.provider === 'NBA' && url.origin === 'https://www.nba.com' && (url.pathname === '/games' || new RegExp(`^/game/[a-z0-9-]+-${row.officialGameId}/box-score$`).test(url.pathname));
    return (espn || nba) && !url.username && !url.password && !url.hash && source.status === 'ready' && /^[a-f0-9]{64}$/.test(source.hash || '') && Number.isFinite(fetched) && fetched >= start && fetched <= captured && captured - fetched <= 900000 && (!source.publishedAt || Number.isFinite(Date.parse(source.publishedAt)) && Date.parse(source.publishedAt) <= captured);
  }), '來源 hash、身分、取得時間或新鮮度無法核對');
  const easternDate = new Intl.DateTimeFormat('en-CA', {timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(game.startTime));
  fail(row.sources.some(source => source.provider === 'ESPN') && row.sources.some(source => source.provider === 'NBA' && new URL(source.url).pathname === '/games' && new URL(source.url).searchParams.get('date') === easternDate) && row.sources.some(source => source.provider === 'NBA' && new URL(source.url).pathname.endsWith(`-${row.officialGameId}/box-score`)), '缺少同場官方賽程、官方 box score 或 ESPN summary');
  const basketball = deriveNbaBoxscore(game);
  fail(basketball.status === 'ready' && basketball.minutes >= 48 && Number.isFinite(basketball.pace) && basketball.pace > 0 && row.pace === basketball.pace && row.paceOfficialMetric === false && row.homeHalf === game.home.periodScores.slice(0,2).reduce((sum, period) => sum + period.score, 0) && row.awayHalf === game.away.periodScores.slice(0,2).reduce((sum, period) => sum + period.score, 0), '完整分節、前兩節或 box-derived pace 無法重算');
  fail(row.checkpointSha256 === nbaLiveHistoryHash({game, sources:row.sources}) && row.outcomeHash === nbaLiveOutcomeHash(row), '歷史原始證據或比分 hash 不符');
  const {recordHash, revision, ...content} = row;
  fail(recordHash === nbaLiveHistoryHash(content) && (!revision || revision === recordHash), 'append-only 歷史記錄 hash 不符');
  return row;
}

export function buildNbaLiveHistoryRow(result, official, {now = Date.now} = {}) {
  const clock = typeof now === 'function' ? now() : now;
  fail(result?.league === 'NBA' && result.status === 'ready' && result.qa?.status !== 'BLOCK' && result.data?.game, 'ESPN final 或球隊 box score QA 未通過');
  // Store only the factual identities, complete quarters and box inputs needed
  // to independently recalculate this model. Player lists/editorial/play-by-play
  // are intentionally not duplicated in the training archive.
  const pick = (value, keys) => Object.fromEntries(keys.map(key => [key,value[key]]));
  const input = result.data.game;
  const statNames = new Set(['fieldGoalsMade-fieldGoalsAttempted','threePointFieldGoalsMade-threePointFieldGoalsAttempted','freeThrowsMade-freeThrowsAttempted','offensiveRebounds','defensiveRebounds','totalRebounds','totalTurnovers','turnovers','teamTurnovers']);
  const team = value => ({...pick(value,['id','sourceId','league','abbreviation']),score:value.score,periodScores:structuredClone(value.periodScores),statistics:(value.statistics || []).filter(stat => statNames.has(stat.name)).map(stat => pick(stat,['name','displayValue']))});
  const game = {...pick(input,['id','sourceId','league','name','startTime','taipeiDate','seasonType','status','completed','neutralSite','timeConfirmed']),season:structuredClone(input.season),home:team(input.home),away:team(input.away)};
  const basketball = deriveNbaBoxscore(game);
  const sources = [...(result.sources || []).filter(source => source.status === 'ready'), ...(official?.sources || [])].map(source => ({provider:source.provider, url:source.url, hash:source.hash, fetchedAt:source.fetchedAt, publishedAt:source.publishedAt || null, status:source.status}));
  const officialFacts = official ? {...pick(official,['version','gameId','officialGameId','status','temporalBasis','pregameLineupVerified']),teams:structuredClone(official.teams)} : official;
  const row = {kind:NBA_LIVE_HISTORY_KIND, league:'NBA', gameId:game.id, date:game.taipeiDate, year:game.season?.year, seasonType:game.seasonType, homeId:game.home.id, awayId:game.away.id, homeScore:game.home.score, awayScore:game.away.score, homeHalf:game.home.periodScores.slice(0,2).reduce((sum, period) => sum + period.score,0), awayHalf:game.away.periodScores.slice(0,2).reduce((sum, period) => sum + period.score,0), neutralSite:game.neutralSite, pace:basketball.pace, paceOfficialMetric:false, officialGameId:official?.officialGameId, capturedAt:new Date(clock).toISOString(), temporalBasis:'verified_postgame_history_for_later_dates', strictPointInTime:false, promotionEligible:false, game, official:officialFacts, sources};
  row.checkpointSha256 = nbaLiveHistoryHash({game, sources});
  row.outcomeHash = nbaLiveOutcomeHash(row);
  row.recordHash = nbaLiveHistoryHash(row);
  return validateNbaLiveHistoryRow(row, clock);
}
