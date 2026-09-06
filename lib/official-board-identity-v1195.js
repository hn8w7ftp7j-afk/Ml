export const OFFICIAL_BOARD_IDENTITY_VERSION = 'OFFICIAL-BOARD-IDENTITY-v11.9.5';
export const OFFICIAL_BOARD_IDENTITY_MAX_AGE_MS = 5 * 60_000;
const CONFLICT_STATUS = 'HISTORICAL_IDENTITY_CONFLICT';
const leagueId = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9]{1,9}$/.test(value.trim()) ? value.trim().toUpperCase() : null;
const positiveInteger = value => {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value))) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};
function calendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value ? value : null;
}
function zonedTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)
    || !/(Z|[+-]\d{2}:\d{2})$/.test(value) || !calendarDate(value.slice(0, 10))) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function gameIdentity(game, league, date) {
  if (!game || typeof game !== 'object') return null;
  const leagues = [game.league, game.leagueId].filter(value => value != null);
  if (!leagues.length || leagues.some(value => leagueId(value) !== league)) return null;
  const gamePk = positiveInteger(game.gamePk);
  const awayTeamId = positiveInteger(game.awayTeamId);
  const homeTeamId = positiveInteger(game.homeTeamId);
  const gameNumber = positiveInteger(game.gameNumber);
  if (gamePk == null || awayTeamId == null || homeTeamId == null || gameNumber == null || awayTeamId === homeTeamId) return null;
  const starts = [game.gameDate, game.startTimeUTC].filter(value => value != null).map(zonedTime);
  if (!starts.length || starts.some(value => value == null) || new Set(starts).size !== 1) return null;
  const startTimeUTC = new Date(starts[0]).toISOString();
  const boardDates = [game.taipeiDate, game.boardDate, game.date].filter(value => value != null);
  if (boardDates.some(value => calendarDate(value) !== date)) return null;
  const taipeiDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(starts[0]));
  if (taipeiDate !== date) return null;
  return { gamePk, awayTeamId, homeTeamId, gameNumber, startTimeUTC,
    identityKey: JSON.stringify([league, date, awayTeamId, homeTeamId, startTimeUTC, gameNumber]) };
}

export function isHistoricalIdentityConflict(item) {
  return item?.identityConflict?.status === CONFLICT_STATUS;
}

const CLEARED_READER_AUTHORITY = Object.freeze({
  readerPayloadHash: null,
  latestMarketCoverage: null,
  latestReaderSource: null,
  pendingReaderEvidenceHash: null,
  pendingReaderAnalysis: false,
  resumedCurrentReaderGame: false,
  preservedCurrentReaderGame: false,
  readerWaitingHandled: false,
});

function readerAuthorityIsCleared(item) {
  return Object.entries(CLEARED_READER_AUTHORITY).every(([key, value]) => item[key] === value);
}

/** Compare immutable historical board rows against a successful, complete
 * official slate supplied by the caller. A changed provider PK is quarantined,
 * never aliased, merged into another game, or used to rewrite PIT/math payloads.
 * Empty/failed/partial/malformed evidence cannot create or clear quarantine. */
export function reconcileOfficialBoardIdentity(board, {
  league, date, identitySlate, identityAsOf, now = Date.now(),
} = {}) {
  if (!Array.isArray(board)) return board;
  const requestedLeague = leagueId(league);
  const requestedDate = calendarDate(date);
  const verifiedTime = zonedTime(identityAsOf);
  if (!requestedLeague || !requestedDate || !Number.isFinite(now) || verifiedTime == null
    || verifiedTime > now || now - verifiedTime > OFFICIAL_BOARD_IDENTITY_MAX_AGE_MS
    || !Array.isArray(identitySlate) || !identitySlate.length) return board;
  const officialByPk = new Map();
  const officialByTuple = new Map();
  for (const game of identitySlate) {
    const identity = gameIdentity(game, requestedLeague, requestedDate);
    // Reject the entire evidence batch on ambiguity. A partial "good subset"
    // would falsely prove that an old PK was absent from the complete slate.
    if (!identity || officialByPk.has(identity.gamePk) || officialByTuple.has(identity.identityKey)) return board;
    officialByPk.set(identity.gamePk, identity);
    officialByTuple.set(identity.identityKey, identity);
  }
  let changed = false;
  const next = board.map(item => {
    const historical = gameIdentity(item?.game, requestedLeague, requestedDate);
    if (!historical) return item;
    const samePk = officialByPk.get(historical.gamePk);
    if (samePk) {
      if (!isHistoricalIdentityConflict(item) || samePk.identityKey !== historical.identityKey) return item;
      changed = true;
      // Reappearance releases isolation, but cannot resurrect old Reader
      // authorization. Current actual quotes must be independently revalidated.
      return { ...item, ...CLEARED_READER_AUTHORITY, identityConflict: null };
    }
    const counterpart = officialByTuple.get(historical.identityKey);
    if (!counterpart || counterpart.gamePk === historical.gamePk) return item;
    const previous = item.identityConflict;
    const sameConflict = isHistoricalIdentityConflict(item)
      && previous.league === requestedLeague && previous.date === requestedDate
      && previous.historicalGamePk === historical.gamePk && previous.officialGamePk === counterpart.gamePk
      && previous.identityKey === historical.identityKey;
    if (sameConflict && readerAuthorityIsCleared(item)) return item;
    changed = true;
    return {
      ...item, ...CLEARED_READER_AUTHORITY,
      identityConflict: sameConflict ? previous : {
        status: CONFLICT_STATUS, version: OFFICIAL_BOARD_IDENTITY_VERSION,
        league: requestedLeague, date: requestedDate, historicalGamePk: historical.gamePk,
        officialGamePk: counterpart.gamePk, identityKey: historical.identityKey,
        verifiedAt: new Date(verifiedTime).toISOString(), reason: 'OFFICIAL_SCHEDULE_PK_CHANGED_FOR_SAME_EXACT_GAME_IDENTITY',
      },
    };
  });
  return changed ? next : board;
}
