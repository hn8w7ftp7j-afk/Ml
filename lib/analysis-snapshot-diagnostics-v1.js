import { requestedLeagueId } from './leagues.js';
import { compareFrozenAnalyses } from './frozen-analysis-comparison-v1.js';

export function parseSnapshotDiagnosticQuery(params) {
  const rawLeague = params.get('league');
  const league = typeof rawLeague === 'string' && rawLeague.trim() ? requestedLeagueId(rawLeague) : null;
  const rawGame = params.get('gamePk');
  const gamePk = Number(rawGame);
  if (!league || !/^[1-9]\d*$/.test(rawGame || '') || !Number.isSafeInteger(gamePk)) throw new Error('請提供有效聯盟與gamePk');
  const order = params.get('order') || 'latest';
  if (!['latest', 'oldest'].includes(order)) throw new Error('order只接受latest或oldest');
  const before = params.get('before'), after = params.get('after');
  if ((before !== null) !== (after !== null)) throw new Error('比較必須同時指定before與after');
  if (before !== null) {
    const pattern = new RegExp(`^${league}:${gamePk}:FULL:[a-f0-9]{64}$`);
    if (!pattern.test(before) || !pattern.test(after)) throw new Error('比較快照必須是同聯盟、同場次的完整FULL快照ID');
    if (before === after) throw new Error('請選擇兩份不同的原始快照');
  }
  return { league, gamePk, order, before, after };
}

export async function readSnapshotDiagnostics(query, { listSnapshots, loadSnapshot }) {
  const base = { version: 'PIT-SNAPSHOT-DIAGNOSTICS-v1', readOnly: true, historicalValidationPassed: false,
    fetchedCurrentData: false, league: query.league, gamePk: query.gamePk };
  if (query.before === null) {
    const result = await listSnapshots(query);
    return { ...base, status: result.snapshots.length ? 'SAVED_FULL_SNAPSHOT_METADATA' : 'NO_SAVED_FULL_SNAPSHOTS',
      order: query.order, ...result,
      limitation: '僅列原始保存紀錄，未逐筆驗證payload；每次最多20筆，可切換oldest/latest。缺快照不能用今日資料補建。' };
  }
  const [before, after] = await Promise.all([query.before, query.after].map(snapshotId => loadSnapshot({ ...query, snapshotId })));
  if (!before || !after) return { ...base, status: 'UNRECONSTRUCTABLE_MISSING_SNAPSHOT',
    missing: [!before ? query.before : null, !after ? query.after : null].filter(Boolean) };
  const comparison = compareFrozenAnalyses(before, after);
  return { ...base, status: comparison.status, comparison };
}
