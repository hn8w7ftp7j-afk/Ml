import { LEAGUE_IDS, leagueConfig } from './leagues.js';
import { loadCompactCloudLedger } from './compact-cloud-ledger-client.js';

// A display registry only: native sports retain independent adapters/models.
export const PERFORMANCE_LEAGUE_IDS = Object.freeze([...LEAGUE_IDS, 'NBA', 'EPL', 'UCL']);
export function performanceLeagueId(value) {
  const id = String(value || '').trim().toUpperCase();
  return id === '' ? 'MLB' : PERFORMANCE_LEAGUE_IDS.includes(id) ? id : null;
}
export function performanceLeagueConfig(value) {
  if (value === 'NBA') return { id: 'NBA', label: 'NBA 美籃', shortLabel: '美籃' };
  if (value === 'EPL') return { id: 'EPL', label: 'EPL 英超', shortLabel: '英超' };
  if (value === 'UCL') return { id: 'UCL', label: 'UCL 歐冠', shortLabel: '歐冠' };
  return leagueConfig(value);
}
export function isNbaPerformanceBet(bet) {
  return bet?.league === 'NBA' && bet?.ledgerSource === 'NBA_MANUAL_V1';
}

export function isSoccerPerformanceBet(bet) {
  return ['EPL', 'UCL'].includes(bet?.league) && bet?.ledgerSource === 'SOCCER_MANUAL_V1';
}
export function isNativePerformanceBet(bet) {
  return isNbaPerformanceBet(bet) || isSoccerPerformanceBet(bet);
}

export function performanceStatsReady(selectedLeague, { baseball, nba, epl, ucl }) {
  const states = { NBA: nba, EPL: epl, UCL: ucl };
  if (selectedLeague === 'ALL') return [baseball, nba, epl, ucl].every(state => state === 'ready');
  return (states[selectedLeague] ?? (LEAGUE_IDS.includes(selectedLeague) ? baseball : null)) === 'ready';
}

export async function loadSoccerPerformanceLedger(requestJSON, league, options) {
  const id = String(league || '').toUpperCase();
  if (!['EPL', 'UCL'].includes(id)) throw new Error('足球聯盟不正確。');
  const result = await loadCompactCloudLedger(async (url, init, timeout) => {
    const page = await requestJSON(url.replace('/api/bets?view=compact&', `/api/soccer/performance?league=${id.toLowerCase()}&`), init, timeout);
    if (page?.league !== id.toLowerCase()) throw Object.assign(new Error('足球帳本聯盟不符；原有紀錄已保留。'), { code: 'LEDGER_RESPONSE_INVALID' });
    return page;
  }, options);
  if (result.bets.some(bet => !isSoccerPerformanceBet(bet) || bet.league !== id || bet.nativeLeague !== id.toLowerCase() || !bet.nativeRecordId || bet.id !== `soccer-manual:${bet.nativeLeague}:${bet.nativeRecordId}`)) {
    throw Object.assign(new Error('足球帳本聯盟或識別不正確；原有紀錄已保留。'), { code: 'LEDGER_RESPONSE_INVALID' });
  }
  return result;
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
