// Operational diagnostics only: never retained as market data or model input.
const observations = new Map();
export function classifyReferenceFailure(message) {
  const text = String(message || '');
  if (/quota|out of.*credits|usage.*limit|credits.*exhaust|requests.*exhaust|insufficient.*credits/i.test(text)) return 'QUOTA_EXHAUSTED';
  if (/401|403|unauthori[sz]ed|forbidden|invalid.*(?:key|token)|(?:key|token).*invalid|authentication/i.test(text)) return 'AUTHORIZATION_FAILED';
  if (/429|rate.?limit|too many requests/i.test(text)) return 'RATE_LIMITED';
  if (/abort|timeout|timed out|逾時/i.test(text)) return 'TIMEOUT';
  if (/格式|schema|json/i.test(text)) return 'SOURCE_FORMAT_ERROR';
  if (/fetch failed|network|connection|ENOTFOUND|ECONN/i.test(text)) return 'NETWORK_ERROR';
  return 'UPSTREAM_FAILURE_UNCLASSIFIED';
}
export function recordReferenceSourceHealth(league, failures, { now = Date.now(), games = 0 } = {}) {
  if (league !== 'MLB' || !Array.isArray(failures) || !Number.isFinite(now) || !Number.isFinite(new Date(now).getTime())) return null;
  // Raw provider messages can contain URLs/tokens: retain only fixed categories.
  const reasons = [...new Set(failures.map(classifyReferenceFailure))];
  const value = { league, observedAt: new Date(now).toISOString(), status: reasons.length ? 'SOURCE_FAILURE' : 'SOURCE_RESPONDED',
    reasons, matchedGames: Number.isSafeInteger(games) && games >= 0 ? games : null };
  observations.set(league, value);
  return structuredClone(value);
}
export function referenceSourceHealth(league, { now = Date.now() } = {}) {
  const value = observations.get(league);
  if (!value || !Number.isFinite(now) || now < Date.parse(value.observedAt) || now - Date.parse(value.observedAt) > 10 * 60_000) {
    return { status: 'NO_RECENT_PROCESS_OBSERVATION', reasons: [], scope: 'CURRENT_FUNCTION_PROCESS_ONLY' };
  }
  return { ...structuredClone(value), scope: 'CURRENT_FUNCTION_PROCESS_ONLY' };
}
