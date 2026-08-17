import { canonicalReaderPayload } from './parser.js';

export const BOARD_ACTIVITY_TTL_MS = 3 * 60 * 1000;
export const MAX_TAI888_TABS = 4;

export function withinTai888TabScanLimit(value) {
  return Number.isInteger(value) && value >= 0 && value <= MAX_TAI888_TABS;
}

const LINE_TOKEN = /^(?:\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?)(?:平|[+-]\d{1,3})?$/;
const DATE_TOKEN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_TOKEN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const TEAM_CODE = /^[A-Z][A-Z0-9]{0,11}$/;
const LEAGUES = new Set(['MLB', 'NPB', 'KBO', 'CPBL']);

const finiteInteger = value => {
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
};

export function validReaderWater(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0.01 && value <= 3;
}

function validLine(value) {
  return LINE_TOKEN.test(String(value || '').trim());
}

function validateRunline(value, name, issues) {
  if (!value || typeof value !== 'object') {
    issues.push(`${name}:missing`);
    return 0;
  }
  if (value.lineSide !== 'away' && value.lineSide !== 'home') issues.push(`${name}:ambiguous-side`);
  if (!validLine(value.line)) issues.push(`${name}:invalid-line`);
  if (!validReaderWater(value.awayWater)) issues.push(`${name}:invalid-away-water`);
  if (!validReaderWater(value.homeWater)) issues.push(`${name}:invalid-home-water`);
  return 2;
}

function validateTotal(value, name, issues) {
  if (!value || typeof value !== 'object') {
    issues.push(`${name}:missing`);
    return 0;
  }
  if (!validLine(value.line)) issues.push(`${name}:invalid-line`);
  if (!validReaderWater(value.overWater)) issues.push(`${name}:invalid-over-water`);
  if (!validReaderWater(value.underWater)) issues.push(`${name}:invalid-under-water`);
  return 2;
}

export function validateStandardReaderGame(game) {
  const issues = [];
  if (!TEAM_CODE.test(String(game?.awayCode || ''))) issues.push('invalid-away-code');
  if (!TEAM_CODE.test(String(game?.homeCode || ''))) issues.push('invalid-home-code');
  if (game?.awayCode === game?.homeCode) issues.push('same-team');
  if (!DATE_TOKEN.test(String(game?.boardDate || ''))) issues.push('invalid-date');
  if (!TIME_TOKEN.test(String(game?.boardTime || ''))) issues.push('invalid-time');

  let directionCount = 0;
  directionCount += validateRunline(game?.fullRunline, 'full-runline', issues);
  directionCount += validateTotal(game?.fullTotal, 'full-total', issues);
  directionCount += validateRunline(game?.first5Runline, 'first5-runline', issues);
  directionCount += validateTotal(game?.first5Total, 'first5-total', issues);
  if (directionCount !== 8) issues.push(`direction-count:${directionCount}`);

  return { ok: issues.length === 0, issues, directionCount };
}

function validateLockedReaderGame(game) {
  const issues = [];
  if (!TEAM_CODE.test(String(game?.awayCode || ''))) issues.push('invalid-away-code');
  if (!TEAM_CODE.test(String(game?.homeCode || ''))) issues.push('invalid-home-code');
  if (game?.awayCode === game?.homeCode) issues.push('same-team');
  if (!DATE_TOKEN.test(String(game?.boardDate || ''))) issues.push('invalid-date');
  if (!TIME_TOKEN.test(String(game?.boardTime || ''))) issues.push('invalid-time');
  if (game?.marketStatus !== 'locked') issues.push('missing-explicit-lock');
  if ([game?.fullRunline, game?.fullTotal, game?.first5Runline, game?.first5Total].some(Boolean)) {
    issues.push('locked-game-has-market');
  }
  return { ok: issues.length === 0, issues, directionCount: 0 };
}

function normalizePartialGameAsUnavailable(game) {
  if (game?.marketStatus === 'locked') return game;
  const validation = validateStandardReaderGame(game);
  if (validation.ok || validation.directionCount <= 0 || validation.directionCount >= 8) return game;
  const nonMissingIssues = validation.issues.filter(issue => (
    !/:missing$/.test(issue) && !/^direction-count:\d+$/.test(issue)
  ));
  if (nonMissingIssues.length) return game;
  // Tai888 may open only the full-game or first-five pair for an event. Never
  // upload that half-board as executable and never fabricate the missing
  // directions. Preserve only its identity as an unavailable event so the
  // remaining complete games can still sync safely.
  return {
    ...game,
    marketStatus: 'locked',
    fullRunline: null,
    fullTotal: null,
    first5Runline: null,
    first5Total: null,
  };
}

export function assessBoardCandidate(candidate, now = Date.now()) {
  const capture = candidate?.capture || {};
  const parsed = candidate?.parsed || {};
  const diagnostics = capture?.diagnostics || {};
  const issues = [];
  const games = (Array.isArray(parsed.games) ? parsed.games : []).map(normalizePartialGameAsUnavailable);
  const normalizedCandidate = games === parsed.games
    ? candidate
    : { ...candidate, parsed: { ...parsed, games } };
  const expectedGameCount = finiteInteger(diagnostics.expectedGameCount);
  const rawDetectedGameCount = finiteInteger(diagnostics.gameCount);
  // Tai888 renders duplicate responsive/measurement nodes for the same event.
  // `parsed.games` is already canonicalized by date/time/teams and rejects
  // conflicting duplicates, so it is the authoritative detected game count.
  const detectedGameCount = games.length;

  const sourceHost = String(capture.sourceHost || '').toLowerCase();
  if (sourceHost !== 'tai888.in' && !sourceHost.endsWith('.tai888.in')) issues.push('invalid-source-host');

  if (!Array.isArray(capture.tables) || capture.tables.length < 1) issues.push('no-board-table');
  if (!expectedGameCount || expectedGameCount < 1 || expectedGameCount > 30) {
    issues.push('missing-expected-game-count');
  }
  if (rawDetectedGameCount == null || rawDetectedGameCount < 1) issues.push('missing-detected-game-count');
  if (!games.length) issues.push('no-parsed-games');
  // Tai888 keeps locked events in the league header count, but some rendered
  // lock rows expose no usable DOM identity at all.  A smaller parsed set is
  // therefore allowed only as a fail-closed subset: every parsed event still
  // has to be a complete 4-market board (or an explicitly captured lock), and
  // the server will reconcile the absent identities against the official
  // slate as non-executable events.
  if (expectedGameCount && games.length > expectedGameCount) {
    issues.push(`expected-${expectedGameCount}-parsed-${games.length}`);
  }
  if (rawDetectedGameCount != null && rawDetectedGameCount < games.length) {
    issues.push(`raw-detected-${rawDetectedGameCount}-parsed-${games.length}`);
  }
  const ignoredDuplicateGameCount = Array.isArray(diagnostics.conflictingGameKeys)
    ? diagnostics.conflictingGameKeys.length
    : 0;
  if (Array.isArray(parsed.parseIssues) && parsed.parseIssues.length) {
    issues.push(...parsed.parseIssues
      .filter(issue => !String(issue).startsWith('conflicting-duplicate:'))
      .map(issue => `parser:${issue}`));
  }

  const identities = new Set();
  const dates = new Set();
  for (const [index, game] of games.entries()) {
    const validation = game?.marketStatus === 'locked'
      ? validateLockedReaderGame(game)
      : validateStandardReaderGame(game);
    issues.push(...validation.issues.map(issue => `game-${index + 1}:${issue}`));
    const identity = `${game?.boardDate || ''}|${game?.boardTime || ''}|${game?.awayCode || ''}|${game?.homeCode || ''}`;
    if (identities.has(identity)) issues.push(`duplicate-game:${identity}`);
    identities.add(identity);
    if (game?.boardDate) dates.add(game.boardDate);
  }
  if (dates.size !== 1) issues.push(`board-date-count:${dates.size}`);
  if (dates.size === 1 && parsed.boardDate !== [...dates][0]) issues.push('board-date-mismatch');

  const pageActivityAt = String(diagnostics.lastMutationAt || '');
  const pageActivityTime = Date.parse(pageActivityAt);
  const ageMs = Number(now) - pageActivityTime;
  if (!Number.isFinite(pageActivityTime)) issues.push('missing-page-activity');
  else if (ageMs < -30_000) issues.push('future-page-activity');
  else if (ageMs > BOARD_ACTIVITY_TTL_MS) issues.push('stale-page-activity');

  const observedTime = Date.parse(capture.observedAt || '');
  const observedAgeMs = Number(now) - observedTime;
  if (!Number.isFinite(observedTime)) issues.push('missing-observed-time');
  else if (observedAgeMs < -30_000 || observedAgeMs > 60_000) issues.push('stale-observation');

  return {
    ok: issues.length === 0,
    issues,
    candidate: normalizedCandidate,
    expectedGameCount,
    detectedGameCount,
    rawDetectedGameCount,
    ignoredDuplicateGameCount,
    pageActivityAt,
    pageActivityTime,
    // Host/frame metadata identifies the source but must not make two frames
    // with the exact same contracts appear to disagree.
    payloadFingerprint: games.length ? canonicalReaderPayload({ ...parsed, games, sourceHost: '' }) : '',
  };
}

function tabPriority(left, right, preferredTabId) {
  // A delayed mutation from a background/old tab must never outrank the tab
  // the user is currently viewing.  `preferredTabId` is only a tie-breaker
  // among tabs that Chrome still reports as active at capture time.
  const leftPreferred = left.active && left.tabId === preferredTabId ? 1 : 0;
  const rightPreferred = right.active && right.tabId === preferredTabId ? 1 : 0;
  if (leftPreferred !== rightPreferred) return rightPreferred - leftPreferred;
  if (Boolean(left.active) !== Boolean(right.active)) return Number(Boolean(right.active)) - Number(Boolean(left.active));
  const accessed = Number(right.lastAccessed || 0) - Number(left.lastAccessed || 0);
  if (accessed) return accessed;
  return Number(left.tabId || 0) - Number(right.tabId || 0);
}

function framePriority(left, right) {
  const leftBoardUrl = /\/newapp\/(?:#\/)?BS(?:\b|[/?#])/i.test(String(left.candidate?.capture?.pageUrl || '')) ? 1 : 0;
  const rightBoardUrl = /\/newapp\/(?:#\/)?BS(?:\b|[/?#])/i.test(String(right.candidate?.capture?.pageUrl || '')) ? 1 : 0;
  if (leftBoardUrl !== rightBoardUrl) return rightBoardUrl - leftBoardUrl;
  if (left.pageActivityTime !== right.pageActivityTime) return right.pageActivityTime - left.pageActivityTime;
  const leftObserved = Date.parse(left.candidate?.capture?.observedAt || '') || 0;
  const rightObserved = Date.parse(right.candidate?.capture?.observedAt || '') || 0;
  if (leftObserved !== rightObserved) return rightObserved - leftObserved;
  return Number(left.candidate?.frameId || 0) - Number(right.candidate?.frameId || 0);
}

/**
 * Pick one board from one frame in one authoritative tab.  The function never
 * combines tables or games across frames.  If two complete frames in that tab
 * disagree, it fails closed instead of guessing which contract is current.
 */
export function selectAuthoritativeBoard(candidates, { now = Date.now(), preferredTabId = null, league = '' } = {}) {
  if (league && !LEAGUES.has(league)) return { ok: false, error: 'unknown-league', assessed: [] };
  const boardCandidates = (Array.isArray(candidates) ? candidates : [])
    .filter(candidate => (!league || candidate?.parsed?.league === league)
      && Array.isArray(candidate?.capture?.tables) && candidate.capture.tables.length > 0);
  if (!boardCandidates.length) {
    return { ok: false, error: 'no-board-candidates', assessed: [] };
  }

  const tabs = [...new Map(boardCandidates.map(candidate => [candidate.tabId, {
    tabId: candidate.tabId,
    active: candidate.active,
    lastAccessed: candidate.lastAccessed,
  }])).values()].sort((left, right) => tabPriority(left, right, preferredTabId));
  const assessed = boardCandidates.map(candidate => assessBoardCandidate(candidate, now));
  // A user can legitimately have the same league open in more than one tab
  // while preparing the four league boards. Pick the highest-priority usable
  // tab and ignore the other tabs instead of treating normal price movement
  // between duplicate tabs as a league-wide conflict. Tai888 can also expose
  // the same board through a host frame and a hidden/measurement iframe; pick
  // one authoritative frame by URL/activity priority instead of letting that
  // implementation detail block the whole league.
  for (const tab of tabs) {
    const tabFrames = assessed.filter(row => row.candidate.tabId === tab.tabId);
    const validTabFrames = tabFrames.filter(row => row.ok);
    const bestCoverage = Math.max(0, ...validTabFrames.map(row => row.detectedGameCount || 0));
    const complete = validTabFrames.filter(row => row.detectedGameCount === bestCoverage);
    if (!complete.length) continue;

    const selected = [...complete].sort(framePriority)[0];
    return {
      ok: true,
      authorityTabId: tab.tabId,
      selected,
      ignoredDuplicateTabCount: Math.max(0, tabs.length - 1),
      ignoredDuplicateFrameCount: Math.max(0, complete.length - 1),
      assessed,
    };
  }

  return {
    ok: false,
    error: 'no-complete-tab',
    authorityTabId: tabs[0]?.tabId,
    assessed,
  };
}

export function shouldSkipSuccessfulPayload({
  reason,
  payloadHash,
  lastSuccessfulPayloadHash,
  lastSuccessfulSyncAt,
  now = Date.now(),
  minimumHeartbeatMs = 45_000,
} = {}) {
  const ageMs = Number(now) - Number(lastSuccessfulSyncAt || 0);
  return reason !== 'manual'
    && Boolean(payloadHash)
    && payloadHash === lastSuccessfulPayloadHash
    && ageMs >= 0
    && ageMs < minimumHeartbeatMs;
}
