import { loadNbaData } from './data.js';
import { loadOfficialNbaEvidence, NBA_OFFICIAL_ESPN_SCORE_CONFLICT } from './official.js';
import { taipeiDate } from './identity.js';
import { listUnsettledNbaManualRecords, archiveNbaManualSettlement } from './manual-bet-store.js';
import { settleNbaManualBet } from './manual-bet-settlement.js';

async function checkedResultForStart(result, startTime, official) {
  const game = result.data.game;
  const options = Date.parse(startTime) === Date.parse(game.startTime) ? {} : { expectedScheduledStartTime: startTime };
  const evidence = await official(game, [], options);
  const playScore = result.data.settlementPlayScore;
  if (evidence?.code !== 'OFFICIAL_SCORE_CONFLICT' || evidence.conflictBasis !== NBA_OFFICIAL_ESPN_SCORE_CONFLICT
    || playScore?.gameId !== game.id) {
    return { result, evidence };
  }

  const candidate = { ...game, away: { ...game.away, ...playScore.away }, home: { ...game.home, ...playScore.home } };
  // Supplying the contract time also requires the official schedule card to
  // agree with the box score on every period, even when the start time matches.
  const corroboration = await official(candidate, [], { expectedScheduledStartTime: startTime });
  if (corroboration?.startTimeVerification?.status !== 'verified') return { result, evidence };

  const headerScore = side => ({ score: game[side].score, periodScores: game[side].periodScores });
  return { evidence: corroboration, result: {
    ...result, data: { ...result.data, game: candidate },
    settlementScoreEvidence: {
      basis: 'ESPN_FINAL_PLAY_MARKERS_NBA_SCHEDULE_AND_BOX_SCORE',
      espnHeader: { away: headerScore('away'), home: headerScore('home') },
      espnFinalPlays: playScore,
    },
  } };
}

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
    if (group.every(record => Date.parse(record.startTime) > now())) {
      summary.checked += group.length; summary.pending += group.length;
      summary.reasons.NOT_STARTED = (summary.reasons.NOT_STARTED || 0) + group.length;
      continue;
    }
    let result;
    const checkedByStart = new Map();
    try {
      result = await load({ view: 'game', id }, { timeoutMs: 10000, includeSettlementPlayScore: true });
      if (result?.data?.game?.status === 'final') {
        // Contracts keep the originally saved scheduled time. A changed ESPN
        // report must be bound to that exact time by both official documents.
        for (const startTime of new Set(group.map(record => record.startTime))) {
          if (!Number.isFinite(Date.parse(startTime || ''))) continue;
          try { checkedByStart.set(startTime, await checkedResultForStart(result, startTime, official)); }
          catch { /* This contract remains pending without official evidence. */ }
        }
      }
    } catch { /* Unavailable or conflicting evidence remains pending. */ }
    for (const record of group) {
      summary.checked++;
      const checked = checkedByStart.get(record.startTime);
      const settlement = settleNbaManualBet(record, checked?.result || result, checked?.evidence, now());
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
