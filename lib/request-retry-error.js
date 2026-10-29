// Exhausting retries does not change an HTTP/API failure into a browser network
// failure. Preserve the server's actionable reason and the explicit timeout.
export function exhaustedRequestRetryError(failure) {
  const status = failure?.status == null ? NaN : Number(failure.status);
  if ((Number.isFinite(status) && status >= 100 && status <= 599)
    || failure?.code === 'REQUEST_TIMEOUT') return failure;
  const error = new Error('網路暫時中斷；已自動重試仍無法載入，請按重新分析全部聯盟');
  error.code = 'TRANSIENT_BROWSER_LOAD_FAILED';
  error.cause = failure;
  return error;
}
