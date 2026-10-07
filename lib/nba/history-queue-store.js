import {neon} from '@neondatabase/serverless';
import {durableDatabaseUrl} from '../database-url.js';
import {assertNba,validDate,taipeiDate,ESPN_NBA_TEAMS} from './identity.js';
import {nbaLiveHistoryHash} from './live-history.js';
import {NBA_LIVE_HISTORY_SCHEMA} from './live-history-store.js';

const fail = (ok,message) => assertNba(ok,'NBA_HISTORY_QUEUE_INVALID',message);
const clock = now => Number(typeof now === 'function' ? now() : now);
const identity = game => ({gameId:game.id,startTime:game.startTime,date:game.taipeiDate,year:game.season?.year,seasonType:game.seasonType,homeId:game.home?.id,awayId:game.away?.id,homeScore:game.home?.score,awayScore:game.away?.score,neutralSite:game.neutralSite});
export function validateNbaHistoryCandidate(row,now = Date.now()) {
  const game = row?.game,captured = Date.parse(row?.capturedAt),start = Date.parse(game?.startTime);
  fail(row?.kind === 'NBA_PROVIDER_FINAL_PENDING_OFFICIAL' && row.league === 'NBA' && row.modelInputEnabled === false && row.strictPointInTime === false,'候選排程不能冒充已官方核對訓練資料');
  fail(game?.league === 'NBA' && game.status === 'final' && game.completed === true && game.timeConfirmed === true && game.id === row.gameId && game.id === `nba:espn:game:${game.sourceId}` && /^[1-9]\d{0,14}$/.test(game.sourceId || ''),'只保存 NBA 已完賽排程候選');
  fail(validDate(row.date) && row.date === game.taipeiDate && row.date === taipeiDate(game.startTime) && row.year === game.season?.year && Number.isInteger(row.year) && row.year >= 1947 && row.year <= 2200 && ['regular','postseason','preseason'].includes(row.seasonType) && game.seasonType === row.seasonType && game.season?.type === row.seasonType && typeof game.neutralSite === 'boolean','候選日期或賽季身分錯誤');
  fail([game.home,game.away].every(team => team?.league === 'NBA' && team.id === `nba:espn:team:${team.sourceId}` && ESPN_NBA_TEAMS[team.sourceId] === team.abbreviation && Number.isInteger(team.score) && team.score >= 0) && game.home.id !== game.away.id && game.home.score !== game.away.score,'候選球隊或 final 比分身分錯誤');
  fail(Number.isFinite(start) && Number.isFinite(captured) && captured > start && captured <= now,'候選擷取時間不可提前或晚於目前');
  fail(Array.isArray(row.sources) && row.sources.length > 0 && row.sources.every(source => {
    try {const url = new URL(source.url),time = Date.parse(source.fetchedAt);return source.provider === 'ESPN' && url.origin === 'https://site.api.espn.com' && url.pathname === '/apis/site/v2/sports/basketball/nba/scoreboard' && !url.username && !url.password && !url.hash && source.status === 'ready' && /^[a-f0-9]{64}$/.test(source.hash || '') && Number.isFinite(time) && time >= start && time <= captured && captured-time <= 900000;} catch {return false;}
  }),'候選缺少新鮮排程來源 hash 與實際取得時間');
  fail(row.identityHash === nbaLiveHistoryHash(identity(game)),'候選排程身分 hash 不符');
  const {recordHash,revision,lastAttemptAt,...content} = row;
  fail(recordHash === nbaLiveHistoryHash(content) && (!revision || revision === recordHash),'候選排程記錄 hash 不符');
  fail(lastAttemptAt == null || Number.isFinite(Date.parse(lastAttemptAt)) && Date.parse(lastAttemptAt) <= now,'候選重試時間錯誤');
  return row;
}
export function buildNbaHistoryCandidate(game,sources,{now = Date.now} = {}) {
  const pick = (value,keys) => Object.fromEntries(keys.map(key => [key,value[key]]));
  const team = value => pick(value,['id','sourceId','league','abbreviation','score']);
  const factual = {...pick(game,['id','sourceId','league','name','startTime','taipeiDate','seasonType','status','completed','timeConfirmed','neutralSite']),season:structuredClone(game.season),home:team(game.home),away:team(game.away)};
  const row = {kind:'NBA_PROVIDER_FINAL_PENDING_OFFICIAL',league:'NBA',gameId:game.id,date:game.taipeiDate,year:game.season?.year,seasonType:game.seasonType,game:factual,sources:sources.filter(source => source.status === 'ready').map(source => pick(source,['provider','url','hash','fetchedAt','status'])),capturedAt:new Date(clock(now)).toISOString(),modelInputEnabled:false,strictPointInTime:false};
  row.identityHash = nbaLiveHistoryHash(identity(factual)); row.recordHash = nbaLiveHistoryHash(row);
  return validateNbaHistoryCandidate(row,clock(now));
}
export const NBA_HISTORY_QUEUE_SCHEMA = `CREATE TABLE IF NOT EXISTS sports_nba_history_candidates_v1 (
 game_id TEXT PRIMARY KEY, revision TEXT NOT NULL, identity_hash TEXT NOT NULL,
 game_date DATE NOT NULL, captured_at TIMESTAMPTZ NOT NULL, payload JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), CHECK (payload->>'kind'='NBA_PROVIDER_FINAL_PENDING_OFFICIAL'))`;
export const NBA_HISTORY_ATTEMPTS_SCHEMA = `CREATE TABLE IF NOT EXISTS sports_nba_history_attempts_v1 (
 attempt_hash TEXT PRIMARY KEY, game_id TEXT NOT NULL REFERENCES sports_nba_history_candidates_v1(game_id),
 candidate_revision TEXT NOT NULL, attempted_at TIMESTAMPTZ NOT NULL, status TEXT NOT NULL,
 payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), CHECK (status IN ('failed','saved')))`;
let client,clientUrl; const schemas = new WeakMap();
function defaultSql() {const url = durableDatabaseUrl();if (!url) throw Error('NBA 歷史重試佇列資料庫尚未設定');if (!client || clientUrl !== url) {client = neon(url);clientUrl=url;}return client;}
async function init(db) {
  let pending = schemas.get(db);
  if (!pending) {
    const query = statement => typeof db.query === 'function' ? db.query(statement) : db([statement]);
    pending = (async () => {await query(NBA_LIVE_HISTORY_SCHEMA);await query(NBA_HISTORY_QUEUE_SCHEMA);await query(NBA_HISTORY_ATTEMPTS_SCHEMA);})().catch(error => {schemas.delete(db);throw error;});
    schemas.set(db,pending);
  }
  await pending;
}
export async function saveNbaHistoryCandidate(row,{sql:injected,now = Date.now} = {}) {
  validateNbaHistoryCandidate(row,clock(now));const db = injected || defaultSql();await init(db);
  const inserted = await db`INSERT INTO sports_nba_history_candidates_v1 (game_id,revision,identity_hash,game_date,captured_at,payload)
    SELECT ${row.gameId},${row.recordHash},${row.identityHash},${row.date}::date,${row.capturedAt}::timestamptz,${JSON.stringify(row)}::jsonb
    WHERE ${row.capturedAt}::timestamptz <= NOW() ON CONFLICT (game_id) DO NOTHING RETURNING revision,payload`;
  const records = inserted.length ? inserted : await db`SELECT revision,payload FROM sports_nba_history_candidates_v1 WHERE game_id=${row.gameId}`;
  fail(records.length === 1,'候選排程未取得永久保存回條');
  const saved = validateNbaHistoryCandidate({...records[0].payload,revision:records[0].revision},clock(now));
  assertNba(saved.gameId === row.gameId && saved.identityHash === row.identityHash,'NBA_HISTORY_CANDIDATE_CONFLICT','同場已保存排程候選身分或 final 比分衝突，禁止覆寫');
  return {persisted:true,inserted:inserted.length === 1,gameId:saved.gameId,revision:saved.recordHash,capturedAt:saved.capturedAt};
}
export async function saveNbaHistoryAttempt(attempt,{sql:injected,now = Date.now} = {}) {
  const time = Date.parse(attempt?.attemptedAt);
  fail(/^nba:espn:game:[1-9]\d{0,14}$/.test(attempt?.gameId || '') && /^[a-f0-9]{64}$/.test(attempt.candidateRevision || '') && ['failed','saved'].includes(attempt.status) && (attempt.code == null || typeof attempt.code === 'string' && attempt.code.length <= 120) && Number.isFinite(time) && time <= clock(now),'歷史重試紀錄格式或時間無效');
  const row = {gameId:attempt.gameId,candidateRevision:attempt.candidateRevision,attemptedAt:attempt.attemptedAt,status:attempt.status,code:attempt.code || null};
  const revision = nbaLiveHistoryHash(row),db = injected || defaultSql();await init(db);
  await db`INSERT INTO sports_nba_history_attempts_v1 (attempt_hash,game_id,candidate_revision,attempted_at,status,payload)
    SELECT ${revision},${row.gameId},${row.candidateRevision},${row.attemptedAt}::timestamptz,${row.status},${JSON.stringify(row)}::jsonb
    FROM sports_nba_history_candidates_v1 WHERE game_id=${row.gameId} AND revision=${row.candidateRevision}
    AND captured_at <= ${row.attemptedAt}::timestamptz AND ${row.attemptedAt}::timestamptz <= NOW()
    ON CONFLICT (attempt_hash) DO NOTHING`;
  const saved = await db`SELECT attempt_hash,payload FROM sports_nba_history_attempts_v1 WHERE attempt_hash=${revision}`;
  fail(saved.length === 1 && saved[0].attempt_hash === revision && nbaLiveHistoryHash(saved[0].payload) === revision,'歷史重試紀錄未取得可核對保存回條');
  return {persisted:true,revision};
}
export async function loadPendingNbaHistory({throughDate,limit = 200} = {},{sql:injected,now = Date.now} = {}) {
  fail(validDate(throughDate) && throughDate <= taipeiDate(clock(now)) && Number.isInteger(limit) && limit > 0 && limit <= 1000,'歷史待核對佇列查詢無效');
  const db = injected || defaultSql();await init(db);
  const rows = await db`SELECT c.revision,c.payload,a.last_attempt_at FROM sports_nba_history_candidates_v1 c
    LEFT JOIN sports_nba_live_history_v1 h ON h.game_id=c.game_id
    LEFT JOIN (SELECT game_id,MAX(attempted_at) AS last_attempt_at FROM sports_nba_history_attempts_v1 GROUP BY game_id) a ON a.game_id=c.game_id
    WHERE h.game_id IS NULL AND c.game_date <= ${throughDate}::date
    ORDER BY COALESCE(a.last_attempt_at,c.captured_at),c.game_date,c.game_id LIMIT ${limit}`;
  return rows.map(saved => validateNbaHistoryCandidate({...saved.payload,revision:saved.revision,lastAttemptAt:saved.last_attempt_at == null ? null : new Date(saved.last_attempt_at).toISOString()},clock(now)));
}
export async function readNbaHistoryQueueStatus({throughDate} = {},{sql:injected,now = Date.now} = {}) {
  fail(validDate(throughDate) && throughDate <= taipeiDate(clock(now)),'歷史待核對狀態查詢無效');
  const db = injected || defaultSql();await init(db);
  const rows = await db`SELECT COUNT(*) AS pending_games,MIN(c.game_date)::text AS oldest_pending_date,MAX(a.last_attempt_at) AS last_attempt_at
    FROM sports_nba_history_candidates_v1 c
    LEFT JOIN sports_nba_live_history_v1 h ON h.game_id=c.game_id
    LEFT JOIN (SELECT game_id,MAX(attempted_at) AS last_attempt_at FROM sports_nba_history_attempts_v1 GROUP BY game_id) a ON a.game_id=c.game_id
    WHERE h.game_id IS NULL AND c.game_date <= ${throughDate}::date`;
  fail(rows.length===1 && Number.isSafeInteger(Number(rows[0].pending_games)) && Number(rows[0].pending_games)>=0,'歷史待核對統計無法讀回');
  const oldestPendingDate = rows[0].oldest_pending_date,lastAttemptAt = rows[0].last_attempt_at==null?null:new Date(rows[0].last_attempt_at).toISOString();
  fail((oldestPendingDate==null || validDate(oldestPendingDate) && oldestPendingDate<=throughDate) && (lastAttemptAt==null || Date.parse(lastAttemptAt)<=clock(now)),'歷史待核對統計日期錯誤');
  return {pendingGames:Number(rows[0].pending_games),oldestPendingDate,lastAttemptAt};
}
