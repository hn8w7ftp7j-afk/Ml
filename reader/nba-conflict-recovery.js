// Recovery never chooses a price or grants upload authority. A new capture
// must pass the unchanged selector after the source pages finish loading.
export const NBA_CONFLICT_RECOVERY_KEY = 'nbaConflictRecoveryV1';
const MAX_AUTOMATIC_ATTEMPTS = 3;
const RETRY_INTERVAL_MS = 90_000;
export async function recoverNbaConflict(selection, { tabs, storage, reload, now = Date.now(), manual = false }) {
  if (selection?.error !== 'conflicting-duplicate-tabs') return null;
  const ids = [...new Set(selection.conflictingTabIds || [])].filter(id =>
    selection.assessed?.some(row => row.ok && row.candidate?.tabId === id
      && row.candidate.parsed?.league === 'NBA') && tabs.some(tab => {
      if (tab.id !== id) return false;
      try { const url = new URL(tab.url); return url.protocol === 'https:' && !url.username && !url.password && !url.port
        && (url.hostname === 'tai888.in' || url.hostname.endsWith('.tai888.in')); } catch { return false; }
    }));
  if (ids.length < 2) return null;
  const stored = (await storage.get(NBA_CONFLICT_RECOVERY_KEY))[NBA_CONFLICT_RECOVERY_KEY];
  const boardDate = selection.boardDate || '';
  const saved = stored && (!stored.boardDate || stored.boardDate === boardDate) ? stored : null;
  const attemptCount = saved ? Math.max(1, Number(saved.attemptCount) || 1) : 0;
  const result = (state, value) => ({ version: 'NBA-CONFLICT-RECOVERY-v1', state,
    attemptedAt: new Date(Number(value.at)).toISOString(), attemptCount: value.attemptCount || 1,
    maxAutomaticAttempts: MAX_AUTOMATIC_ATTEMPTS,
    attemptedTabCount: value.attemptedTabCount || ids.length, refreshedTabCount: value.refreshedTabCount || 0 });
  // A failed first refresh must not disable recovery for the whole incident.
  // Persist the bounded retry budget before reloading; worker restarts cannot
  // turn it into an infinite loop. A confirmed live save still clears it.
  if (saved && !manual && attemptCount >= MAX_AUTOMATIC_ATTEMPTS) return result('EXHAUSTED', saved);
  if (saved && now - Number(saved.at) < RETRY_INTERVAL_MS) return result('ALREADY_ATTEMPTED', saved);
  const attempt = { at: now, boardDate, attemptCount: Math.min(attemptCount + 1, 100000),
    attemptedTabCount: ids.length, refreshedTabCount: 0 };
  await storage.set({ [NBA_CONFLICT_RECOVERY_KEY]: attempt });
  for (const id of ids) { try { await reload(id); attempt.refreshedTabCount++; } catch {} }
  await storage.set({ [NBA_CONFLICT_RECOVERY_KEY]: attempt });
  return result(attempt.refreshedTabCount ? 'REQUESTED' : 'FAILED', attempt);
}
