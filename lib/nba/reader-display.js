import { validDate, taipeiDate } from './identity.js';

// A price may be displayed before schedule reconciliation, but never assigned
// to a different official event on team-name similarity alone.
export function matchNbaReaderGame(row, scheduleResult) {
  if (scheduleResult?.league !== 'NBA' || scheduleResult?.qa?.status === 'BLOCK'
    || !['ready', 'empty'].includes(scheduleResult?.status)) return { status: 'unverified', game: null };
  if (!validDate(row?.boardDate) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(row?.boardTime || '')) return { status: 'conflict', game: null };
  const boardTime = Date.parse(`${row.boardDate}T${row.boardTime}:00+08:00`);
  const matches = (scheduleResult.data?.games || []).filter(game => game.league === 'NBA'
    && game.away?.id === row.away?.id && game.home?.id === row.home?.id
    && Number.isFinite(Date.parse(game.startTime || '')) && taipeiDate(game.startTime) === row.boardDate
    && Math.abs(Date.parse(game.startTime) - boardTime) <= 5 * 60_000);
  return matches.length === 1 ? { status: 'matched', game: matches[0] } : { status: 'conflict', game: null };
}

export function nbaReaderDisplayStatus(board, now = Date.now()) {
  if (!board || board.status === 'waiting') return 'waiting';
  const observed = Date.parse(board.observedAt || '');
  const activity = Date.parse(board.pageActivityAt || board.observedAt || '');
  return board.status === 'fresh' && Number.isFinite(observed) && observed <= now + 5_000
    && now - observed <= 3 * 60_000 && Number.isFinite(activity) && activity <= now + 5_000
    && now - activity <= 3 * 60_000 ? 'fresh' : 'stale';
}
