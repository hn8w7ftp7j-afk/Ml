// No URLs, keys or provider response bodies are retained here.
export function referenceFailureCode(error) {
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return 'TIMEOUT';
  if (error?.code === 'INVALID_JSON') return 'INVALID_JSON';
  if (error?.code === 'EVENT_ID_MISMATCH') return 'EVENT_ID_MISMATCH';
  const status = Number(error?.httpStatus);
  if (/quota|usage.*(reached|limit)|out.of.*credits/i.test(String(error?.message || ''))) return 'QUOTA_EXHAUSTED';
  if (status === 401 || status === 403) return 'AUTH_REJECTED';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 404) return 'HTTP_404';
  if (status >= 400) return 'HTTP_ERROR';
  return 'REQUEST_FAILED';
}

export function referenceAttempt(provider, stage, { gamePk = null, status = 'FETCHED', reasonCode = 'SUCCESS', httpStatus = null } = {}) {
  return { provider, stage, gamePk, status, reasonCode, httpStatus, recordedAt: new Date().toISOString() };
}

// Client transport helper. Signed receipts survive even when no prices exist.
export function referenceGameMap(result = {}) {
  const map = new Map((result.games || []).map(row => [Number(row.gamePk), row]));
  for (const row of result.receipts || []) map.set(Number(row.gamePk), { ...map.get(Number(row.gamePk)), gamePk: Number(row.gamePk), referenceEvidence: row.receipt });
  return map;
}
