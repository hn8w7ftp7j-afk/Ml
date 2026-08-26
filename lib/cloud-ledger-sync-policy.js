export const CLOUD_LEDGER_FAILURE_BACKOFF_MS = 5 * 60 * 1000;
export const CLOUD_LEDGER_VISIBLE_REFRESH_MS = 10 * 60 * 1000;
export const CLOUD_LEDGER_MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;

export function cloudLedgerRetryDelay(error) {
  const requested = Number(error?.retryAfterMs || 0);
  return Math.min(
    CLOUD_LEDGER_MAX_BACKOFF_MS,
    Math.max(CLOUD_LEDGER_FAILURE_BACKOFF_MS, Number.isFinite(requested) ? requested : 0),
  );
}

export function cloudLedgerAutomaticRefreshAllowed({
  storageReady,
  tab,
  visibilityState,
  busy = false,
  now = Date.now(),
  retryAt = 0,
} = {}) {
  return storageReady === true
    && tab === 'bets'
    && visibilityState === 'visible'
    && busy !== true
    && Number(now) >= Number(retryAt || 0);
}
