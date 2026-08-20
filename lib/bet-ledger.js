import { parseTaiwanLine } from './markets.js';

const clean = value => String(value || '').replace(/\s+/g, '').trim();
const leagueId = value => String(value || 'MLB').trim().toUpperCase() || 'MLB';
const finiteWater = value => Number.isFinite(Number(value)) ? Number(value) : null;

export function canonicalBetPick(pick) {
  const parsed = parseTaiwanLine(pick);
  if (!parsed.valid) return clean(pick).toLowerCase();
  const side = parsed.isTotal
    ? parsed.isOver ? 'over' : 'under'
    : `${clean(parsed.team).toLowerCase()}:${parsed.isGiving ? 'giving' : 'receiving'}`;
  const tail = ['none', 'flat'].includes(parsed.tailSign)
    ? 'flat:0'
    : `${parsed.tailSign}:${Number(parsed.tailPercent)}`;
  const line = parsed.legs.length === 1 ? String(Number(parsed.legs[0])) : parsed.lineText;
  return `${side}:${line}:${tail}`;
}

export function canonicalBetPosition(pick) {
  const parsed = parseTaiwanLine(pick);
  if (!parsed.valid) return clean(pick).toLowerCase();
  if (parsed.isTotal) return parsed.isOver ? 'over' : 'under';
  return `${clean(parsed.team).toLowerCase()}:${parsed.isGiving ? 'giving' : 'receiving'}`;
}

function legacyBetIdentity(date, gamePk, row) {
  return `${clean(date)}|||${Number(gamePk) || ''}|||${clean(row?.market)}|||${canonicalBetPick(row?.pick)}`;
}

export function betIdentity(date, gamePk, row, league = 'MLB') {
  return `${leagueId(league)}|||${legacyBetIdentity(date, gamePk, row)}`;
}

export function betPositionIdentity(date, gamePk, row, league = 'MLB') {
  return `${leagueId(league)}|||${clean(date)}|||${Number(gamePk) || ''}|||${clean(row?.market)}|||${canonicalBetPosition(row?.pick)}`;
}

export function betPriceIdentity(date, gamePk, row, league = 'MLB') {
  const water = finiteWater(row?.water);
  return `${betPositionIdentity(date, gamePk, row, league)}|||${canonicalBetPick(row?.pick)}|||${water == null ? 'missing' : water.toFixed(6)}`;
}

export function betMatches(bet, date, gamePk, row, league = 'MLB') {
  const targetLeague = leagueId(league);
  if (bet?.identity) {
    if (bet.identity === betIdentity(date, gamePk, row, targetLeague)) return true;
    if (targetLeague === 'MLB'
      && !bet?.league
      && bet.identity === legacyBetIdentity(date, gamePk, row)) return true;
  }
  if (leagueId(bet?.league) !== targetLeague) return false;
  if (bet?.date && clean(bet.date) !== clean(date)) return false;
  return Number(bet?.gamePk) === Number(gamePk)
    && clean(bet?.market) === clean(row?.market)
    && canonicalBetPosition(bet?.pick) === canonicalBetPosition(row?.pick);
}

export function betPriceMatches(bet, date, gamePk, row, league = 'MLB') {
  if (!betMatches(bet, date, gamePk, row, league)) return false;
  const placedWater = finiteWater(bet?.water);
  const currentWater = finiteWater(row?.water);
  return canonicalBetPick(bet?.pick) === canonicalBetPick(row?.pick)
    && placedWater != null
    && currentWater != null
    && Math.abs(placedWater - currentWater) <= 1e-9;
}
