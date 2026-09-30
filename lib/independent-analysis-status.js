// Reconcile only server status for inactive tabs. Loading boards and validating
// Reader prices remain responsibilities of the selected league's recovery flow.
export async function reconcileInactiveIndependentRuns(runs, {
  getVisibleScope,
  readStatus,
  isActive = () => true,
} = {}) {
  const candidates = [...runs.entries()].filter(([scope, run]) => (
    scope !== getVisibleScope() && run?.status === 'running' && run?.runId
  ));
  const updates = await Promise.all(candidates.map(async ([scope, owner]) => {
    const runId = owner.runId;
    const stillOwned = () => isActive()
      && scope !== getVisibleScope()
      && runs.get(scope) === owner
      && owner.runId === runId
      && owner.status === 'running';
    let state;
    try { state = await readStatus(runId); }
    catch (error) {
      if (!stillOwned() || Number(error?.status) !== 404) return false;
      owner.status = 'failed';
      owner.message = '找不到伺服器背景工作，可重新分析';
      owner.needsRecovery = true;
      return true;
    }
    if (!stillOwned() || state?.runId !== runId) return false;
    if (state.status === 'completed') {
      const separator = scope.indexOf(':');
      const league = scope.slice(0, separator);
      const date = scope.slice(separator + 1);
      if (separator < 1 || state.result?.league !== league || state.result?.date !== date) return false;
      owner.status = 'completed';
      owner.message = '分析完成｜切回聯盟載入結果';
      owner.needsRecovery = true;
      return true;
    }
    if (['failed', 'cancelled'].includes(state.status)) {
      owner.status = 'failed';
      owner.message = state.status === 'cancelled' ? '背景分析已取消，可重新分析' : '背景分析未完成，可重新分析';
      owner.needsRecovery = true;
      return true;
    }
    return false;
  }));
  return updates.filter(Boolean).length;
}
