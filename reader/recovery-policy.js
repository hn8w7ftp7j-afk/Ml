export const BOARD_ACTIVITY_TTL_MS = 3 * 60 * 1000;
export const RECOVERY_COOLDOWN_MS = 90 * 1000;
export const RELOAD_SETTLE_MS = 7 * 1000;

export function uniqueTabIds(values = []) {
  return [...new Set(values
    .filter(value => typeof value === 'number' && Number.isInteger(value) && value >= 0))];
}

export function staleAssessedTabIds(assessed = []) {
  return uniqueTabIds(assessed
    .filter(item => item?.issues?.includes('stale-market-activity'))
    .map(item => item?.candidate?.tabId));
}

export function reserveRecoveryTabIds(values, cooldownByTab, { force = false, now = Date.now() } = {}) {
  const reserved = [];
  for (const tabId of uniqueTabIds(values)) {
    const last = Number(cooldownByTab.get(tabId) || 0);
    if (!force && now - last < RECOVERY_COOLDOWN_MS) continue;
    cooldownByTab.set(tabId, now);
    reserved.push(tabId);
  }
  return reserved;
}
