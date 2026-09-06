import { NBA_SHADOW_VERSION, analyzeNbaShadow } from './shadow.js';
import { nbaRequestKey, requestNbaScreen } from './client-cache.js';
import { deriveNbaBoxscore } from './basketball.js';

const jobs = new Map();
const listeners = new Set();
const STORAGE = 'sports-data:nba:v1:shadow-reports';
const MAX_JOBS = 4;
let active = null;
export function nbaShadowKey(games, teamId, seasonType) {
  return `${NBA_SHADOW_VERSION}:${teamId}:${seasonType}:${JSON.stringify(games.map(g => [g.id, g.startTime, g.season?.year, g.seasonType, g.home?.id, g.away?.id, g.home?.score, g.away?.score]).sort((a, b) => a[0].localeCompare(b[0])))}`;
}
export function subscribeNbaShadow(listener) { listeners.add(listener); return () => listeners.delete(listener); }
function emit() { for (const listener of listeners) listener(); }
export function readNbaShadow(key) {
  if (jobs.has(key)) return jobs.get(key);
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORAGE) || '[]');
    const row = Array.isArray(saved) && saved.find(r => r.key === key && r.version === NBA_SHADOW_VERSION && r.job?.league === 'NBA' && Array.isArray(r.job.errors) && Array.isArray(r.job.sources) && ['running', 'paused', 'completed', 'partial', 'cancelled', 'blocked', 'failed'].includes(r.job.status) && (!r.job.report || r.job.report.version === NBA_SHADOW_VERSION) && r.savedAt <= Date.now() && Date.now() - r.savedAt < 24 * 3600000);
    if (row) {
      // A saved running job is not a live task after a document reload.
      if (row.job.status === 'running') row.job.status = 'paused';
      jobs.set(key, row.job); return row.job;
    }
  } catch { /* optional storage only */ }
  return null;
}
function persist(key, job) {
  try {
    job.persistence = 'session_storage';
    const raw = JSON.parse(sessionStorage.getItem(STORAGE) || '[]');
    const previous = Array.isArray(raw) ? raw.filter(r => r.key !== key) : [];
    const serialized = JSON.stringify([...previous.slice(-2), { key, version: NBA_SHADOW_VERSION, savedAt: Date.now(), job }]);
    if (serialized.length > 2_000_000) throw new Error('NBA research storage budget exceeded');
    sessionStorage.setItem(STORAGE, serialized);
  } catch { job.persistence = 'memory_only'; /* Never delete another league's storage. */ }
}
export function cancelNbaShadow(key) { if (active?.key === key) { active.cancelled = true; emit(); } }
export function nbaShadowIsBusy() { return Boolean(active); }
export function canResumeNbaShadow(job, now = Date.now()) {
  const age = now - Date.parse(job?.checkpointAt || '');
  return age >= 0 && age < 24 * 3600000 && ['paused', 'cancelled', 'partial', 'failed'].includes(job?.status) && Array.isArray(job.checkpoint) && job.checkpoint.length > 0;
}

function assertSameGame(actual, scheduled) {
  const fatal = message => { const error = new Error(message); error.code = 'IDENTITY_BLOCK'; throw error; };
  for (const field of ['id', 'startTime', 'taipeiDate', 'seasonType']) if (actual?.[field] !== scheduled[field]) fatal(`歷史身分衝突：${field}`);
  if (actual?.league !== 'NBA' || actual.status !== 'final' || actual.season?.year !== scheduled.season?.year || actual.home?.id !== scheduled.home?.id || actual.away?.id !== scheduled.away?.id || actual.home?.score !== scheduled.home?.score || actual.away?.score !== scheduled.away?.score) fatal('賽程與 box score 的球季／隊伍／比分衝突');
  if (deriveNbaBoxscore(actual).status === 'blocked') fatal('Box score 數學完整性錯誤');
}
function sourceSnapshots(sources, game) {
  if (!Array.isArray(sources) || !sources.length) throw new Error('Box score 缺少可追溯來源，需重新取得');
  return sources.map(source => {
    const url = new URL(source.url);
    if (url.origin !== 'https://site.api.espn.com' || url.pathname !== '/apis/site/v2/sports/basketball/nba/summary' || url.searchParams.get('event') !== game.sourceId) {
      const error = new Error('Box score 來源網址與賽事身分衝突'); error.code = 'IDENTITY_BLOCK'; throw error;
    }
    if (!source.hash || !Number.isFinite(Date.parse(source.fetchedAt))) throw new Error('Box score 缺少來源雜湊或取得時間');
    return { gameId: game.id, url: source.url, fetchedAt: source.fetchedAt, publishedAt: source.publishedAt, hash: source.hash, status: source.status };
  });
}

// Explicit user start only. Continues across component unmount/league switches;
// never launches again from a render, a timer refresh or a restored report.
export async function runNbaShadow(games, teamId, seasonType, options = {}) {
  const key = nbaShadowKey(games, teamId, seasonType);
  if (active) return active.key === key ? active.promise : null;
  const request = options.request || requestNbaScreen;
  const pause = options.pause || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const task = { key, cancelled: false, promise: null }; active = task;
  const previous = readNbaShadow(key);
  const job = { league: 'NBA', status: 'running', completed: 0, total: games.length, errors: [], report: previous?.report || null, reportBuiltAt: previous?.reportBuiltAt || null, sources: [], checkpoint: [], resumed: 0, startedAt: new Date().toISOString(), finishedAt: null };
  jobs.set(key, job);
  while (jobs.size > MAX_JOBS) {
    const removable = [...jobs.keys()].find(k => k !== key); if (!removable) break; jobs.delete(removable);
  }
  const collected = [];
  task.promise = (async () => {
    emit();
    try {
      const preflight = analyzeNbaShadow(games, { teamId, seasonType });
      if (preflight.status === 'blocked') { job.report = preflight; job.status = 'blocked'; return job; }
      if (options.resume && canResumeNbaShadow(previous)) {
        const scheduled = new Map(games.map(game => [game.id, game]));
        const seen = new Set();
        for (const actual of previous.checkpoint || []) {
          if (!scheduled.has(actual?.id) || seen.has(actual.id)) { const error = new Error('續跑快照含未知或重複賽事'); error.code = 'IDENTITY_BLOCK'; throw error; }
          assertSameGame(actual, scheduled.get(actual.id));
          sourceSnapshots(previous.sources.filter(source => source.gameId === actual.id), actual);
          seen.add(actual.id); collected.push(actual);
        }
        job.sources = previous.sources.filter(source => seen.has(source.gameId));
        job.checkpoint = collected.slice(); job.checkpointAt = previous.checkpointAt; job.completed = collected.length; job.resumed = collected.length;
      }
      persist(key, job); emit();
      for (const scheduled of games) {
        if (task.cancelled) break;
        if (collected.some(game => game.id === scheduled.id)) continue;
        try {
          const result = await request(nbaRequestKey({ view: 'game', id: scheduled.sourceId }));
          const actual = result.data?.game;
          const fatal = message => { const error = new Error(message); error.code = 'IDENTITY_BLOCK'; throw error; };
          if (result.league !== 'NBA' || result.qa?.status === 'BLOCK') fatal('Box score 未通過聯盟／身分／完整性 QA');
          if (result.status !== 'ready' || !actual) throw new Error('Box score 來源未成功');
          assertSameGame(actual, scheduled);
          const snapshots = sourceSnapshots(result.sources, actual);
          collected.push(actual);
          job.sources.push(...snapshots);
        } catch (error) {
          job.errors.push({ gameId: scheduled.id, message: error.message, code: error.code || 'SOURCE_UNAVAILABLE' });
          if (error.code === 'IDENTITY_BLOCK') { job.completed += 1; job.status = 'blocked'; job.report = null; break; }
        }
        job.completed += 1; job.checkpoint = collected.slice(); job.checkpointAt ||= new Date().toISOString(); persist(key, job); emit();
        // Below the existing NBA API rate limit, leaving room for navigation.
        if (job.completed < games.length && !task.cancelled) await pause(1000);
      }
      if (job.status === 'blocked') { /* Never hide identity failures as missing data. */ }
      else if (task.cancelled) job.status = 'cancelled';
      else {
        // Preserve missing games as observations with missing box scores so
        // incomplete downloads cannot silently become a complete dataset.
        const map = new Map(collected.map(g => [g.id, g]));
        const report = analyzeNbaShadow(games.map(g => map.get(g.id) || { ...g, home: { ...g.home, statistics: [] }, away: { ...g.away, statistics: [] } }), { teamId, seasonType });
        job.report = report; job.reportBuiltAt = new Date().toISOString(); job.status = report.status === 'blocked' ? 'blocked' : job.errors.length ? 'partial' : 'completed';
      }
    } catch (error) { job.status = error.code === 'IDENTITY_BLOCK' ? 'blocked' : 'failed'; if (job.status === 'blocked') job.report = null; job.errors.push({ message: error.message, code: error.code || 'SOURCE_UNAVAILABLE' }); }
    finally {
      if (job.status === 'completed' || job.status === 'blocked') job.checkpoint = [];
      job.finishedAt = new Date().toISOString(); active = null; persist(key, job); emit();
    }
    return job;
  })();
  return task.promise;
}
