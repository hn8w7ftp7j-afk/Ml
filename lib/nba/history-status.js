import { loadNbaLiveHistory } from './live-history-store.js';
import { taipeiDate } from './identity.js';
import { readNbaHistoryQueueStatus } from './history-queue-store.js';

export async function readNbaHistoryStatus({ now = Date.now, list = loadNbaLiveHistory } = {}) {
  const time = Number(typeof now === 'function' ? now() : now);
  const beforeDate = taipeiDate(time + 86400000);
  const rows = await list({ beforeDate });
  const queue = list === loadNbaLiveHistory ? await readNbaHistoryQueueStatus({ throughDate: taipeiDate(time) }, { now: time })
    : { pendingGames: null, oldestPendingDate: null, lastAttemptAt: null };
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.year}:${row.seasonType}`;
    const group = groups.get(key) ?? { seasonYear: row.year, seasonType: row.seasonType, games: 0, through: null };
    group.games++;
    if (!group.through || group.through < row.date) group.through = row.date;
    groups.set(key, group);
  }
  return { status: 'ready', games: rows.length, groups: [...groups.values()], queue,
    latestCapturedAt: rows.map(row => row.capturedAt).sort().at(-1) ?? null,
    basis: 'verified_completed_games_for_strictly_later_dates', strictPointInTime: false,
    source: 'NBA official + ESPN; team box pace is an estimated proxy', automaticSchedule: '35 * * * *',
    modelInputRule: 'game date before target date; acquisition no later than prediction; never backfilled as pregame knowledge' };
}
