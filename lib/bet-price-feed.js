import { canonicalBetPosition } from './bet-ledger.js';
import { isLeagueId } from './leagues.js';

const clean = value => String(value || '').replace(/\s+/g, '').trim();
const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;

function sanitizePrice(row, fallback = {}) {
  const pick = clean(row?.pick);
  const market = clean(row?.market || fallback.market);
  const water = finite(row?.water);
  if (!pick || !market || water == null || water <= 0 || water > 5) return null;
  return {
    market,
    pick,
    water,
    lineAsOf: String(row?.lineAsOf || fallback.lineAsOf || '').slice(0, 40) || null,
    sourceType: String(row?.sourceType || fallback.sourceType || '').slice(0, 40) || null,
    provider: String(row?.provider || fallback.provider || '').slice(0, 60) || null,
  };
}

export function currentReaderPriceForBet(bet, snapshot) {
  const league = clean(bet?.league).toUpperCase();
  if (!bet || !snapshot || !isLeagueId(league) || clean(snapshot?.league).toUpperCase() !== league) return null;
  if (clean(bet?.date) !== clean(snapshot?.boardDate)) return null;
  const game = (snapshot?.games || []).find(item => Number(item?.gamePk || item?.game?.gamePk) === Number(bet?.gamePk));
  if (!game) return null;
  const position = canonicalBetPosition(bet?.pick);
  const row = (game?.markets || []).find(item => clean(item?.market) === clean(bet?.market)
    && canonicalBetPosition(item?.pick) === position);
  return sanitizePrice(row, {
    market: bet?.market,
    lineAsOf: snapshot?.pageActivityAt,
    sourceType: 'ACTUAL_TW_CREDIT',
    provider: 'TAI888_READER_AUTO',
  });
}

export function verifiedClosingPriceForBet(bet) {
  const snapshot = bet?.closingContractSnapshot;
  if (!snapshot || snapshot?.verified !== true) return null;
  const provider = String(snapshot?.provider || '').toUpperCase();
  const sourceType = String(snapshot?.sourceType || '').toUpperCase();
  if (provider !== 'TAI888_READER_AUTO' && sourceType !== 'ACTUAL_TW_CREDIT') return null;
  const lineAsOf = Date.parse(snapshot?.lineAsOf || '');
  const gameStart = Date.parse(bet?.gameDate || '');
  if (!Number.isFinite(lineAsOf) || (Number.isFinite(gameStart) && lineAsOf > gameStart)) return null;
  if (clean(snapshot?.market || bet?.market) !== clean(bet?.market)
    || canonicalBetPosition(snapshot?.pick) !== canonicalBetPosition(bet?.pick)) return null;
  return sanitizePrice(snapshot, {
    market: bet?.market,
    sourceType: 'ACTUAL_TW_CREDIT',
    provider: 'TAI888_READER_AUTO',
  });
}

export function priceComparisonLabel(status) {
  if (status === 'BETTER') return '原下注盤優';
  if (status === 'WORSE') return '原下注盤劣';
  if (status === 'EQUIVALENT') return '相同';
  if (status === 'MIXED') return '混合';
  return '無法比較';
}
