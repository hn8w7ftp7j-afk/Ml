import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import { parseCreditLine, fractionFor } from './analysis-core/credit-total.js';
import { normalizeNbaManualBetRecord } from './manual-bet-record.js';
import { NBA_TEAM_LABELS } from './labels.js';
import { ESPN_NBA_TEAMS } from './identity.js';

export const NBA_SETTLEMENT_VERSION = 'nba-manual-official-credit-v1';
const fields = ['gameId', 'date', 'marketKey', 'side', 'line', 'lineSide', 'water', 'stake', 'away', 'home', 'startTime'];
export function nbaManualContractHash(record) {
  return createHash('sha256').update(JSON.stringify(fields.map(key => record[key] ?? null))).digest('hex');
}
const pending = reason => ({ status: 'PENDING', reason });
function verifiedTeam(team, label) {
  return team?.id === `nba:espn:team:${team.sourceId}` && ESPN_NBA_TEAMS[team.sourceId] === team.abbreviation
    && [team.name, NBA_TEAM_LABELS[team.abbreviation]].includes(label);
}
function completePeriods(team) {
  const periods = team?.periodScores;
  return Number.isSafeInteger(team?.score) && team.score >= 0 && Array.isArray(periods) && periods.length >= 4
    && periods.every((row, i) => row.period === i + 1 && Number.isSafeInteger(row.score) && row.score >= 0)
    && periods.reduce((sum, row) => sum + row.score, 0) === team.score;
}
function sourceVerified(source, provider, now) {
  try {
    const url = new URL(source.url), at = Date.parse(source.fetchedAt);
    const host = provider === 'NBA' ? 'www.nba.com' : 'site.api.espn.com';
    return source.provider === provider && source.status === 'ready' && /^[a-f0-9]{64}$/.test(source.hash || '')
      && url.protocol === 'https:' && url.hostname === host && !url.username && !url.password
      && Number.isFinite(at) && at <= now && now - at <= 15 * 60000;
  } catch { return false; }
}

// Only verified result evidence is added. The user's original price/stake and
// the MANUAL_UNVERIFIED contract provenance never become model calibration data.
export function settleNbaManualBet(record, result, official, now = Date.now()) {
  if ((record.status || 'OPEN') !== 'OPEN') return pending('RECORD_CANCELLED');
  try { normalizeNbaManualBetRecord({ ...record, alreadyPlaced: true }); }
  catch { return pending('ORIGINAL_CONTRACT_INVALID'); }
  const game = result?.data?.game;
  if (!game || game.league !== 'NBA' || game.id !== record.gameId || game.id !== `nba:espn:game:${game.sourceId}`
    || game.taipeiDate !== record.date || !record.startTime || Date.parse(game.startTime) !== Date.parse(record.startTime)
    || !verifiedTeam(game.away, record.away) || !verifiedTeam(game.home, record.home) || game.away.id === game.home.id) return pending('GAME_IDENTITY_UNVERIFIED');
  if (game.status !== 'final' || game.completed !== true || !/^final(?:\b|\/)/i.test(game.statusText || '')
    || Date.parse(game.startTime) >= now) return pending('FINAL_RESULT_NOT_CONFIRMED');
  if (!completePeriods(game.away) || !completePeriods(game.home) || game.away.periodScores.length !== game.home.periodScores.length) return pending('PERIOD_SCORES_INCOMPLETE');
  if (game.away.score === game.home.score) return pending('ABNORMAL_TIED_FINAL_RESULT');
  if (!(result.sources || []).some(source => sourceVerified(source, 'ESPN', now))
    || (result.sources || []).some(source => ['stale', 'unavailable'].includes(source.status))) return pending('RESULT_SOURCE_UNVERIFIED');
  const officialSources = (official?.sources || []).filter(source => sourceVerified(source, 'NBA', now));
  if (!['ready', 'partial'].includes(official?.status) || official.gameId !== game.id
    || !/^00[1245]\d{7}$/.test(official.officialGameId || '') || official.temporalBasis !== 'postgame_crosscheck'
    || official.teams?.length !== 2 || !['away', 'home'].every(side => official.teams.some(team => team.providerId === game[side].id))
    || officialSources.length !== 2 || new Set(officialSources.map(source => source.url)).size !== 2) return pending('OFFICIAL_SCORE_CROSSCHECK_PENDING');
  const half = record.marketKey.startsWith('firstHalf');
  const score = side => half ? game[side].periodScores.slice(0, 2).reduce((sum, row) => sum + row.score, 0) : game[side].score;
  const away = score('away'), home = score('home'), total = record.marketKey.endsWith('Total');
  const line = parseCreditLine(record.line, total ? 'total' : 'spread');
  const quantity = total ? away + home : record.lineSide === 'home' ? home - away : away - home;
  const positive = total ? record.side === 'over' : record.side === record.lineSide;
  const fraction = fractionFor(quantity, line, positive), stake = new Decimal(record.stake);
  const exposure = stake.times(Math.abs(fraction));
  const rebate = exposure.times('0.015');
  const profit = stake.times(Math.max(fraction, 0)).times(record.water).minus(stake.times(Math.max(-fraction, 0))).plus(rebate);
  return { status: 'SETTLED', version: NBA_SETTLEMENT_VERSION, contractHash: nbaManualContractHash(record),
    result: fraction === 0 ? 'PUSH' : fraction === 1 ? 'WIN' : fraction === -1 ? 'LOSS' : fraction > 0 ? 'PARTIAL_WIN' : 'PARTIAL_LOSS',
    fraction, profit: profit.toNumber(), rebate: rebate.toNumber(), effectiveStake: exposure.toNumber(),
    scores: { away, home, period: half ? 'FIRST_HALF' : 'FULL_GAME_INCLUDING_OVERTIME' },
    fullScores: { away: game.away.score, home: game.home.score }, officialGameId: official.officialGameId,
    sources: [...result.sources.filter(source => sourceVerified(source, 'ESPN', now)), ...officialSources],
    settledAt: new Date(now).toISOString(), evidenceStatus: 'MANUAL_CONTRACT_VERIFIED_OFFICIAL_RESULT',
    executable: false, formalEligible: false, calibrationEligible: false };
}
