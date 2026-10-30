// Recovery never chooses a price or grants upload authority. A new capture
// must pass the unchanged selector after the source pages finish loading.
export const NBA_CONFLICT_RECOVERY_KEY = 'nbaConflictRecoveryV1';
export async function recoverNbaConflict(selection, { tabs, storage, reload, now = Date.now(), manual = false }) {
  if (selection?.error !== 'conflicting-duplicate-tabs') return [];
  const ids = [...new Set(selection.conflictingTabIds || [])].filter(id =>
    selection.assessed?.some(row => row.ok && row.candidate?.tabId === id
      && row.candidate.parsed?.league === 'NBA') && tabs.some(tab => {
      if (tab.id !== id) return false;
      try { const url = new URL(tab.url); return url.protocol === 'https:' && !url.username && !url.password && !url.port
        && (url.hostname === 'tai888.in' || url.hostname.endsWith('.tai888.in')); } catch { return false; }
    }));
  if (ids.length < 2) return [];
  const saved = (await storage.get(NBA_CONFLICT_RECOVERY_KEY))[NBA_CONFLICT_RECOVERY_KEY];
  // One automatic recovery per unresolved incident, persisted across worker
  // restarts. Only a confirmed live save resets it. Manual retries are bounded.
  if (saved && (!manual || now - Number(saved.at) < 90_000)) return [];
  await storage.set({ [NBA_CONFLICT_RECOVERY_KEY]: { at: now } });
  const refreshed = [];
  for (const id of ids) { try { await reload(id); refreshed.push(id); } catch {} }
  return refreshed;
}
