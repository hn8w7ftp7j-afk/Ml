import { loadNbaData } from './data.js';
import { loadOfficialNbaEvidence } from './official.js';
import { taipeiDate } from './identity.js';
import { listUnsettledNbaManualRecords, archiveNbaManualSettlement } from './manual-bet-store.js';
import { settleNbaManualBet } from './manual-bet-settlement.js';

export async function settleOpenNbaManualRecords({ date = null, limit = 100, timeBudgetMs = 35000,
  now = Date.now, list = listUnsettledNbaManualRecords, load = loadNbaData,
  official = loadOfficialNbaEvidence, archive = archiveNbaManualSettlement } = {}) {
  const started = now(), deadline = started + timeBudgetMs;
  const records = await list({ date, throughDate: taipeiDate(started), limit });
  const summary = { checked: 0, settled: 0, pending: 0, deferred: 0, reasons: {} };
  const groups = new Map();
  for (const record of records) groups.set(record.gameId, [...(groups.get(record.gameId) || []), record]);
  for (const [id, group] of groups) {
    if (now() >= deadline) { summary.deferred += group.length; continue; }
    let result, evidence;
    try {
      result = await load({ view: 'game', id }, { timeoutMs: 10000 });
      if (result?.data?.game?.status === 'final') evidence = await official(result.data.game, []);
    } catch { /* Unavailable or conflicting evidence remains pending. */ }
    for (const record of group) {
      summary.checked++;
      const settlement = settleNbaManualBet(record, result, evidence, now());
      if (settlement.status !== 'SETTLED') {
        summary.pending++; summary.reasons[settlement.reason] = (summary.reasons[settlement.reason] || 0) + 1;
        continue;
      }
      const receipt = await archive(record, settlement);
      if (receipt.settlement?.status === 'SETTLED') summary.settled++;
      else { summary.pending++; summary.reasons.RECORD_CHANGED = (summary.reasons.RECORD_CHANGED || 0) + 1; }
    }
  }
  return summary;
}
