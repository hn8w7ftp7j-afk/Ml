export const ACTUAL_LINE_FRESHNESS_MS = 5 * 60 * 1000;
export const ALLOWED_FUTURE_SKEW_MS = 90 * 1000;

export function applyMarketFreshness(row, now = Date.now()) {
  const result = { ...(row || {}) };
  const actual = result.sourceType === 'ACTUAL_TW_CREDIT';
  if (!actual) {
    return {
      ...result,
      executable: result.executable === true,
      lineFresh: true,
      lineAgeSeconds: null,
      executionStatus: result.executable === true ? 'REFERENCE_ONLY' : 'NON_EXECUTABLE',
    };
  }

  const timestamp = Date.parse(result.lineAsOf || '');
  if (!Number.isFinite(timestamp)) {
    return {
      ...result,
      executable: false,
      lineFresh: false,
      lineAgeSeconds: null,
      executionStatus: 'UNCONFIRMED_LINE_TIME',
    };
  }

  const ageMs = now - timestamp;
  const fresh = ageMs >= -ALLOWED_FUTURE_SKEW_MS && ageMs <= ACTUAL_LINE_FRESHNESS_MS;
  return {
    ...result,
    executable: result.executable !== false && fresh,
    lineFresh: fresh,
    lineAgeSeconds: Math.max(0, Math.floor(ageMs / 1000)),
    executionStatus: fresh
      ? result.executable === false ? 'UNCONFIRMED' : 'EXECUTABLE'
      : ageMs < 0 ? 'FUTURE_TIMESTAMP_REJECTED' : 'EXPIRED',
  };
}
