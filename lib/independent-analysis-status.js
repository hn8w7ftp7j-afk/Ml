// Inactive tabs may load immutable results for display. Current Reader prices
// and execution authority still belong to the selected league's recovery flow.
export async function reconcileInactiveIndependentRuns(runs, {
  getVisibleScope,
  readStatus,
  readCompletedResult,
  onCompleted,
  isActive = () => true,
} = {}) {
  const canLoadResults = typeof readCompletedResult === 'function' && typeof onCompleted === 'function';
  const candidates = [...runs.entries()].filter(([scope, run]) => (
    scope !== getVisibleScope() && run?.runId && (run.status === 'running'
      || canLoadResults && run.status === 'completed' && run.needsRecovery === true && run.resultLoaded !== true)
  ));
  const updates = await Promise.all(candidates.map(async ([scope, owner]) => {
    const runId = owner.runId;
    const before = { status: owner.status, message: owner.message, needsRecovery: owner.needsRecovery, resultLoaded: owner.resultLoaded };
    const ownerChanged = () => Object.entries(before).some(([key, value]) => owner[key] !== value);
    let expectedStatus = owner.status;
    const stillOwned = () => isActive()
      && scope !== getVisibleScope()
      && runs.get(scope) === owner
      && owner.runId === runId
      && owner.status === expectedStatus;
    const separator = scope.indexOf(':');
    const league = scope.slice(0, separator);
    const date = scope.slice(separator + 1);
    if (separator < 1) return false;
    let state;
    try {
      state = expectedStatus === 'completed'
        ? { runId, status: 'completed', result: { league, date } }
        : await readStatus(runId);
    }
    catch (error) {
      if (!stillOwned() || Number(error?.status) !== 404) return false;
      owner.status = 'failed';
      owner.message = '找不到伺服器背景工作，可重新分析';
      owner.needsRecovery = true;
      return ownerChanged();
    }
    if (!stillOwned() || state?.runId !== runId) return false;
    if (state.status === 'completed') {
      if (state.result?.league !== league || state.result?.date !== date) return false;
      owner.status = 'completed';
      expectedStatus = 'completed';
      owner.message = canLoadResults ? '分析完成｜結果待載入' : '分析完成｜切回聯盟載入結果';
      owner.needsRecovery = true;
      owner.resultLoaded = false;
      if (!canLoadResults) return true;
      try {
        const full = await readCompletedResult(runId, league, date);
        if (!stillOwned()) return false;
        if (full?.runId !== runId || full.status !== 'completed'
          || full.result?.league !== league || full.result?.date !== date
          || !Array.isArray(full.result?.results)) throw new Error('分析結果工作或聯盟日期不符');
        // The callback installs display data only. It must not grant current
        // Reader authority or erase the recovery requirement for record buttons.
        await onCompleted({ scope, runId, league, date, result: full.result, owner });
        if (!stillOwned()) return false;
        owner.resultLoaded = true;
        owner.message = '分析完成';
      } catch {
        if (!stillOwned()) return false;
        owner.resultLoaded = false;
        owner.message = '分析完成｜結果待載入';
      }
      return ownerChanged();
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
