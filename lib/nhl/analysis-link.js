import { validNhlDate } from './identity.js';

// Recovery links carry only the validated Taiwan date and workflow identity.
// Opening one loads prior output; it does not submit a new analysis request.
export function nhlAnalysisResultHref(date, runId = '') {
  if (!validNhlDate(date) || (runId && !/^[a-zA-Z0-9_:-]{8,300}$/.test(runId))) return null;
  return `/nhl?date=${encodeURIComponent(date)}${runId ? `&analysisRun=${encodeURIComponent(runId)}` : ''}`;
}
