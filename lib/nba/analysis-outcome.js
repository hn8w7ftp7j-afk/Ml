// A terminal workflow is not evidence that its model results succeeded.
// This also accepts the compact job-summary transport's analysisStatus field.
export function nbaBatchFinished(batch) {
  return batch?.league === 'NBA' && Number.isInteger(batch.total) && batch.total >= 0
    && Array.isArray(batch.results) && batch.results.length === batch.total
    && !batch.runningGamePks?.length
    && (batch.total > 0 || ['no_games', 'no_open_markets'].includes(batch.emptyReason));
}

export function summarizeNbaBatchOutcome(batch) {
  const rows = Array.isArray(batch?.results) ? batch.results : [];
  const counts = { ready: 0, reference: 0, insufficient: 0, blocked: 0, failed: 0 };
  for (const row of rows) {
    const status = row?.payload?.status || row?.analysisStatus;
    if (row?.ok === true && ['ready', 'reference'].includes(status)) counts[status]++;
    else if (row?.ok !== true && ['insufficient', 'blocked'].includes(status)) counts[status]++;
    else counts.failed++;
  }
  const total = Number.isInteger(batch?.total) && batch.total >= 0 ? batch.total : rows.length;
  const finished = nbaBatchFinished(batch);
  const status = !finished ? 'result_pending'
    : total === 0 ? batch.emptyReason
    : counts.ready === total ? 'done'
    : counts.reference + counts.insufficient === total ? 'insufficient_data'
    : counts.ready + counts.reference > 0 ? 'partial' : 'failed';
  return { status, total, completed: counts.ready + counts.reference,
    blocked: counts.insufficient + counts.blocked, failed: counts.failed,
    ready: counts.ready, reference: counts.reference, insufficient: counts.insufficient,
    verificationBlocked: counts.blocked };
}
