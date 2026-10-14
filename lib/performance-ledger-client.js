import { LEAGUE_IDS, leagueConfig } from './leagues.js';
import { loadCompactCloudLedger } from './compact-cloud-ledger-client.js';

// A display registry only: basketball must not enter baseball adapters/models.
export const PERFORMANCE_LEAGUE_IDS = Object.freeze([...LEAGUE_IDS, 'NBA']);
export function performanceLeagueId(value) {
  const id = String(value || '').trim().toUpperCase();
  return id === '' ? 'MLB' : PERFORMANCE_LEAGUE_IDS.includes(id) ? id : null;
}
export function performanceLeagueConfig(value) {
  if (value === 'NBA') return { id: 'NBA', label: 'NBA 美籃', shortLabel: '美籃' };
  return leagueConfig(value);
}
export function isNbaPerformanceBet(bet) {
  return bet?.league === 'NBA' && bet?.ledgerSource === 'NBA_MANUAL_V1';
}

export async function loadNbaPerformanceLedger(requestJSON, options) {
  // Share completeness checks, deadlines and duplicate/cursor protection with
  // the baseball readback, while retaining the independent NBA storage API.
  const result = await loadCompactCloudLedger((url, init, timeout) =>
    requestJSON(url.replace('/api/bets?view=compact&', '/api/nba/performance?'), init, timeout), options);
  if (result.bets.some(bet => !isNbaPerformanceBet(bet) || !bet.nativeRecordId)) {
    throw Object.assign(new Error('NBA 帳本聯盟或識別不正確；原有紀錄已保留。'), { code: 'LEDGER_RESPONSE_INVALID' });
  }
  return result;
}
