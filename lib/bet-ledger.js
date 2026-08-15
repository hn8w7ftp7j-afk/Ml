import { parseTaiwanLine } from './markets.js';

const clean = value => String(value || '').replace(/\s+/g, '').trim();
const leagueId = value => String(value || 'MLB').trim().toUpperCase() || 'MLB';

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

function legacyBetIdentity(date, gamePk, row) {
  return `${clean(date)}|||${Number(gamePk) || ''}|||${clean(row?.market)}|||${canonicalBetPick(row?.pick)}`;
}

export function betIdentity(date, gamePk, row, league = 'MLB') {
  return `${leagueId(league)}|||${legacyBetIdentity(date, gamePk, row)}`;
}

export function betMatches(bet, date, gamePk, row, league = 'MLB') {
  const targetLeague = leagueId(league);
  if (bet?.identity) {
    if (bet.identity === betIdentity(date, gamePk, row, targetLeague)) return true;
    return targetLeague === 'MLB'
      && !bet?.league
      && bet.identity === legacyBetIdentity(date, gamePk, row);
  }
  if (leagueId(bet?.league) !== targetLeague) return false;
  if (bet?.date && clean(bet.date) !== clean(date)) return false;
  return Number(bet?.gamePk) === Number(gamePk)
    && clean(bet?.market) === clean(row?.market)
    && canonicalBetPick(bet?.pick) === canonicalBetPick(row?.pick);
}
