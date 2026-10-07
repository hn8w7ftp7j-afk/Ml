import { loadNbaData } from './data.js';
import { loadOfficialNbaEvidence } from './official.js';
import { listPendingNbaForwardCaptures, archiveNbaForwardEvaluation, readNbaForwardValidation, recordNbaForwardAttempt } from './forward-store.js';
import { canonicalNbaForwardCaptures, evaluateNbaForwardCapture } from './forward-validation.js';

export { readNbaForwardValidation };
async function withinDeadline(task, milliseconds) {
  let timer;
  try {
    return await Promise.race([task(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('FORWARD_EVIDENCE_TIME_BUDGET')), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
export async function evaluatePendingNbaCaptures({ date = null, from = null, through = null, limit = 50, timeBudgetMs = 35000,
  now = Date.now, list = listPendingNbaForwardCaptures, load = loadNbaData,
  official = loadOfficialNbaEvidence, archive = archiveNbaForwardEvaluation, attempt = recordNbaForwardAttempt } = {}) {
  if (typeof now !== 'function') { const fixed = Number(now); now = () => fixed; }
  if (!Number.isFinite(now()) || !Number.isFinite(limit) || !Number.isFinite(timeBudgetMs)) throw Object.assign(new Error('Invalid forward evaluation limits'), { status: 400 });
  const started = now(), deadline = started + Math.min(45000, Math.max(1, timeBudgetMs));
  const rows = await list({ date, from, through, limit: Math.min(100, Math.max(1, Math.floor(limit))), now: started });
  // Test/integration injection cannot weaken canonicalization or capture checks.
  const gameOrder = new Map();
  for (const row of rows) if (!gameOrder.has(row.payload?.gameId)) gameOrder.set(row.payload?.gameId, gameOrder.size);
  const captures = canonicalNbaForwardCaptures(rows, { now: started }).sort((a, b) => gameOrder.get(a.payload.gameId) - gameOrder.get(b.payload.gameId)), groups = new Map();
  for (const capture of captures) groups.set(capture.payload.gameId, [...(groups.get(capture.payload.gameId) || []), capture]);
  const summary = { checked: 0, evaluated: 0, created: 0, pending: 0, deferred: 0, distinctGames: groups.size, reasons: {},
    attemptRecorded: 0, attemptPersistenceFailures: 0,
    isActualBet: false, executable: false, formalEligible: false, promotionEligible: false, strictPointInTime: false };
  const remainPending = reason => { summary.pending++; summary.reasons[reason] = (summary.reasons[reason] || 0) + 1; };
  for (const [id, group] of groups) {
    if (now() >= deadline) { summary.deferred += group.length; continue; }
    if (group.every(c => Date.parse(c.payload.game.startTime) >= now())) {
      for (const capture of group) { summary.checked++; remainPending('NOT_STARTED'); } continue;
    }
    const before = { checked: summary.checked, evaluated: summary.evaluated, pending: summary.pending, deferred: summary.deferred,
      reasons: { ...summary.reasons } };
    let result, evidence;
    try {
      await withinDeadline(async () => {
        result = await load({ view: 'game', id }, { now, timeoutMs: Math.min(10000, Math.max(1, deadline - now())) });
        if (result?.status !== 'ready' && result?.qa?.issues?.some(issue => issue.code === 'PLAYER_IDENTITY_MISMATCH') && now() < deadline) {
          // This validated team-only summary is sufficient for outcomes. It
          // does not certify players, confirmed lineups, injuries or minutes.
          result = await load({ view: 'historical-team-box', id }, { now, timeoutMs: Math.min(10000, Math.max(1, deadline - now())) });
        }
        if (result?.data?.game?.status === 'final' && now() < deadline) evidence = await official(result.data.game, [], { now,
          fetchImpl: (url, options = {}) => {
            const remaining = Math.max(1, Math.min(12000, deadline - now()));
            const budget = AbortSignal.timeout(remaining);
            return fetch(url, { ...options, signal: options.signal ? AbortSignal.any([options.signal, budget]) : budget });
          } });
      }, Math.max(1, deadline - now()));
    } catch { /* Missing, conflicting or stale evidence remains pending. */ }
    for (const capture of group) {
      if (now() >= deadline) { summary.deferred++; continue; }
      summary.checked++;
      const evaluation = evaluateNbaForwardCapture(capture, result, evidence, now());
      if (evaluation.status !== 'EVALUATED') { remainPending(evaluation.reason); continue; }
      try {
        const receipt = await archive(capture, evaluation);
        if (receipt.evaluation?.status === 'EVALUATED') { summary.evaluated++; if (receipt.created) summary.created++; }
        else remainPending('CANONICAL_CAPTURE_CHANGED');
      } catch { remainPending('EVALUATION_PERSISTENCE_UNCONFIRMED'); }
    }
    const attempted = Object.fromEntries(['checked', 'evaluated', 'pending', 'deferred'].map(key => [key, summary[key] - before[key]]));
    attempted.reasons = Object.fromEntries(Object.entries(summary.reasons).map(([reason, count]) => [reason, count - (before.reasons[reason] || 0)]).filter(([, count]) => count > 0));
    if (attempted.deferred > 0) attempted.reasons.EVIDENCE_TIME_BUDGET = attempted.deferred;
    try {
      const receipt = await attempt(group[0], attempted);
      if (receipt?.persisted === true) summary.attemptRecorded++;
      else summary.attemptPersistenceFailures++;
    } catch { summary.attemptPersistenceFailures++; }
  }
  return summary;
}
