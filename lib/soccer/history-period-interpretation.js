import { createHash } from 'node:crypto';
import { canonicalSoccerPayload, parseSoccerCapture, scopeSoccerPayload, soccerMarket } from '../../reader/soccer-parser.js';
import { soccerJournalHash } from './journal.js';

export const SOCCER_HISTORY_PERIOD_INTERPRETATION_VERSION = 'SOCCER-HISTORY-PERIOD-INTERPRETATION-v1';
export const SOCCER_HISTORY_PERIOD_INTERPRETATION_BASIS = 'SAME_OBSERVATION_PRIMARY_AND_EXPLICIT_HT';
const PRIMARY = ['時間', '主客隊伍', '讓球', '大小盤', '獨贏', '單雙', '備註'];
const HALF = ['時間', '主客隊伍', '上半讓球', '上半大小', '', '單雙', '備註'];
const KEYS = { HANDICAP: 'runline', TOTAL: 'total', MONEYLINE: 'moneyline' };
const HEADERS = { HANDICAP: '讓球', TOTAL: '大小盤', MONEYLINE: '獨贏' };
const HALF_HEADERS = { HANDICAP: '上半讓球', TOTAL: '上半大小' };
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const equal = (left, right) => canonical(left) === canonical(right);
const stamp = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const keyFor = game => `${game?.boardTime}|${game?.awayKey || game?.awayCode}|${game?.homeKey || game?.homeCode}`;
const detach = value => JSON.parse(JSON.stringify(value));

function parsedMarketBody(market) {
  if (!KEYS[market?.kind] || market.unit !== 'GOALS' || market.serverObservation != null) return null;
  const parsed = soccerMarket(KEYS[market.kind], market.rawRows);
  if (!parsed) return null;
  // Match the saved quote to the original cells, including both prices and the
  // giving side. A plausible header cannot validate changed quote values.
  return Object.keys(parsed).every(key => equal(parsed[key], market[key])) ? parsed : null;
}

function profile(market, league, half = false) {
  const proof = market?.periodEvidence;
  if (!parsedMarketBody(market) || !proof || proof.truncated
    || !equal(proof.tableHeaders, half ? HALF : PRIMARY)
    || proof.marketHeader !== (half ? HALF_HEADERS[market.kind] : HEADERS[market.kind])
    || !globalThis.Tai888LeagueRegistry.standardMarker(proof.sectionTitle, league)) return false;
  const evidence = globalThis.Tai888LeagueRegistry.soccerPeriodEvidence({ sectionTitle: proof.sectionTitle,
    headers: proof.tableHeaders, marketHeader: proof.marketHeader, truncated: proof.truncated });
  return market.period === (half ? 'HT' : 'UNKNOWN')
    && proof.period === (half ? 'HT' : 'UNKNOWN') && proof.status === (half ? 'EXPLICIT' : 'UNKNOWN')
    && evidence.period === proof.period && evidence.status === proof.status;
}

function verifiedOriginal({ payload, game, league, boardDate, gameKey, observationId, contentHash, observedAt, persistedAt, now }) {
  if (!['EPL', 'UCL'].includes(league) || !Number.isFinite(now)
    || !stamp(observedAt) || now < Date.parse(observedAt)
    || persistedAt != null && (!stamp(persistedAt) || now < Date.parse(persistedAt))
    || !/^[a-f0-9]{64}$/.test(observationId || '') || !/^[a-f0-9]{64}$/.test(contentHash || '')
    || payload?.league !== league || payload.boardDate !== boardDate || stamp(payload.observedAt) !== stamp(observedAt)
    || payload.sourceHost !== 'www.tai888.in' || !Array.isArray(payload.games)
    || game?.league !== league || game.boardDate !== boardDate || keyFor(game) !== gameKey
    || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(game.boardTime || '')
    || typeof game.awayKey !== 'string' || !game.awayKey || typeof game.homeKey !== 'string' || !game.homeKey
    || game.awayKey === game.homeKey || !Array.isArray(game.markets)
    || game.marketStatus !== 'open' || ['UNKNOWN', 'HT', 'FT'].some(period => game.periodStates?.[period] === 'locked')) return false;
  const url = new URL(payload.pageUrl);
  if (url.protocol !== 'https:' || url.hostname !== payload.sourceHost || url.username || url.password || url.port
    || url.pathname !== '/newapp/') return false;
  if (soccerJournalHash(payload) !== observationId || payload.contentHash !== contentHash
    || createHash('sha256').update(canonicalSoccerPayload(payload)).digest('hex') !== contentHash) return false;
  const sameGame = payload.games.filter(value => keyFor(value) === gameKey && value.boardDate === boardDate);
  if (sameGame.length !== 1 || !equal(sameGame[0], game)) return false;

  // The immutable journal hash covers original source tables as well as parsed
  // output. Reparse those very tables; never borrow a companion from another
  // observation, the current board, or caller-supplied approval metadata.
  const source = payload.sourceCapture;
  if (source?.league !== league || source.pageLeagueLabel !== payload.pageLeagueLabel || !Array.isArray(source.tables)) return false;
  let parsed = parseSoccerCapture({ ...source, sourceHost: payload.sourceHost,
    pageUrl: payload.pageUrl, observedAt: payload.observedAt }, new Date(payload.observedAt));
  if (parsed.parseIssues.length) return false;
  parsed.boardDate = boardDate;
  parsed.games = parsed.games.filter(value => value.boardDate === boardDate);
  parsed.periodsCovered = [...new Set(parsed.games.flatMap(value => value.periodsCovered))].sort();
  if (Object.hasOwn(payload, 'sourceScope')) parsed = scopeSoccerPayload(parsed, payload.sourceScope);
  if (!parsed || canonicalSoccerPayload(parsed) !== canonicalSoccerPayload(payload)) return false;
  const reparsed = parsed.games.filter(value => keyFor(value) === gameKey);
  return reparsed.length === 1 && equal(reparsed[0].markets, game.markets);
}

/** Retrospective display annotation only. This does not bind a source device,
 * issue a signed trading quote, change a journal entry or establish availability
 * at the original observation time. Consumers must keep it out of analysis. */
export function interpretSoccerHistoryPeriods({ payload, game, league, boardDate, gameKey,
  observationId, contentHash, observedAt, persistedAt = null, now = Date.now() }) {
  const originalMarkets = Array.isArray(game?.markets) ? game.markets : [];
  const unchanged = () => ({ displayContracts: detach(originalMarkets), historyInterpretation: null });
  try {
    if (!verifiedOriginal({ payload, game, league, boardDate, gameKey, observationId, contentHash, observedAt, persistedAt, now })) return unchanged();
    const interpretedAt = new Date(now).toISOString();
    let interpretedContractCount = 0;
    const displayContracts = originalMarkets.map(market => {
      if (!profile(market, league)) return detach(market);
      const companions = originalMarkets.filter(value => profile(value, league, true)
        && value.periodEvidence.sectionTitle === market.periodEvidence.sectionTitle);
      const hasCompanion = market.kind === 'MONEYLINE'
        ? ['HANDICAP', 'TOTAL'].every(kind => companions.some(value => value.kind === kind))
        : companions.some(value => value.kind === market.kind);
      if (!hasCompanion) return detach(market);
      interpretedContractCount++;
      return { ...detach(market), period: 'FT', historyPeriodInterpretation: {
        version: SOCCER_HISTORY_PERIOD_INTERPRETATION_VERSION, basis: SOCCER_HISTORY_PERIOD_INTERPRETATION_BASIS,
        originalPeriod: 'UNKNOWN', displayPeriod: 'FT', interpretedAt, observationId,
        historicalAvailabilityVerified: false, executable: false } };
    });
    return { displayContracts, historyInterpretation: interpretedContractCount ? {
      version: SOCCER_HISTORY_PERIOD_INTERPRETATION_VERSION, status: 'RETROSPECTIVE_INTERPRETATION',
      basis: SOCCER_HISTORY_PERIOD_INTERPRETATION_BASIS, interpretedAt, interpretedContractCount,
      originalPeriods: ['UNKNOWN'], displayPeriods: ['FT'], observationId,
      historicalAvailabilityVerified: false, executable: false } : null };
  } catch { return unchanged(); }
}
