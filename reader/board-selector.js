import { canonicalReaderPayload, readerMarketProperties } from './parser.js';
import { buildSoccerAuthorityDiagnostics } from './soccer-authority-diagnostics.js';
import { buildNbaAuthorityDiagnostics } from './nba-authority-diagnostics.js';
import { scopeSoccerPayload, SOCCER_SOURCE_SCOPE_VERSION } from './soccer-parser.js';

export const BOARD_ACTIVITY_TTL_MS = 5 * 60 * 1000;
// Kept for diagnostic compatibility only. Candidate selection is board-based,
// never blocked merely because the user opened a fifth Tai888 page.
export const MAX_TAI888_TABS = Number.POSITIVE_INFINITY;

export function withinTai888TabScanLimit(value) {
  return Number.isInteger(value) && value >= 0;
}

const LINE_TOKEN = /^(?:\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?)(?:平|[+-]\d{1,3})?$/;
const DATE_TOKEN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_TOKEN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const TEAM_CODE = /^[A-Z][A-Z0-9]{0,11}$/;
const LEAGUES = new Set(['MLB', 'NPB', 'KBO', 'CPBL', 'NBA', 'NHL', 'EPL', 'UCL']);

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

export function validateStandardReaderGame(game, league = '') {
  if (['EPL','UCL'].includes(league)) return validateAvailableReaderGame(game, league);
  if (league === 'NHL') return validateAvailableReaderGame(game, league);
  const issues = [];
  if (!TEAM_CODE.test(String(game?.awayCode || ''))) issues.push('invalid-away-code');
  if (!TEAM_CODE.test(String(game?.homeCode || ''))) issues.push('invalid-home-code');
  if (game?.awayCode === game?.homeCode) issues.push('same-team');
  if (!DATE_TOKEN.test(String(game?.boardDate || ''))) issues.push('invalid-date');
  if (!TIME_TOKEN.test(String(game?.boardTime || ''))) issues.push('invalid-time');

  let directionCount = 0;
  directionCount += validateRunline(game?.fullRunline, 'full-runline', issues);
  directionCount += validateTotal(game?.fullTotal, 'full-total', issues);
  directionCount += validateRunline(game?.[readerMarketProperties(league)[2]], league === 'NBA' ? 'first-half-runline' : 'first5-runline', issues);
  directionCount += validateTotal(game?.[readerMarketProperties(league)[3]], league === 'NBA' ? 'first-half-total' : 'first5-total', issues);
  if (directionCount !== 8) issues.push(`direction-count:${directionCount}`);

  return { ok: issues.length === 0, issues, directionCount };
}

function validateLockedReaderGame(game, league = '') {
  const issues = [];
  if (!TEAM_CODE.test(String(game?.awayCode || ''))) issues.push('invalid-away-code');
  if (!TEAM_CODE.test(String(game?.homeCode || ''))) issues.push('invalid-home-code');
  if (game?.awayCode === game?.homeCode) issues.push('same-team');
  if (!DATE_TOKEN.test(String(game?.boardDate || ''))) issues.push('invalid-date');
  if (!TIME_TOKEN.test(String(game?.boardTime || ''))) issues.push('invalid-time');
  if (game?.marketStatus !== 'locked') issues.push('missing-explicit-lock');
  if (['EPL', 'UCL'].includes(league)) {
    if (game?.league !== league || game?.executable !== false || !Array.isArray(game?.markets) || game.markets.length) issues.push('locked-game-has-market');
    if (!Array.isArray(game?.periodsCovered) || !game.periodsCovered.length || game.periodsCovered.some(period => !['FT', 'HT', 'UNKNOWN'].includes(period))) issues.push('locked-game-period-evidence-missing');
  } else if (readerMarketProperties(league).some(property => game?.[property])) {
    issues.push('locked-game-has-market');
  }
  return { ok: issues.length === 0, issues, directionCount: 0 };
}

function validateAvailableReaderGame(game, league = '') {
  const identity = [];
  if (!TEAM_CODE.test(String(game?.awayCode || ''))) identity.push('invalid-away-code');
  if (!TEAM_CODE.test(String(game?.homeCode || ''))) identity.push('invalid-home-code');
  if (game?.awayCode === game?.homeCode) identity.push('same-team');
  if (!DATE_TOKEN.test(String(game?.boardDate || ''))) identity.push('invalid-date');
  if (!TIME_TOKEN.test(String(game?.boardTime || ''))) identity.push('invalid-time');
  const issues = [...identity];
  if (['EPL','UCL'].includes(league)) {
    if (game.executable!==false || game.league!==league || !Array.isArray(game.markets) || !game.markets.length || game.markets.some(m=>m.unit!=='GOALS')) issues.push('soccer-contract-evidence-invalid');
    return {ok:issues.length===0,issues,directionCount:0};
  }
  if (league === 'NHL') {
    // Captured text is evidence even if its quote grammar is unknown. This
    // intake never upgrades it to an executable NHL contract.
    if (!game.rawMarketEvidence?.some(value => value.rawRows?.some(Boolean))) issues.push('nhl-market-evidence-missing');
    if (game.executable !== false) issues.push('nhl-capture-cannot-execute');
    return { ok: issues.length === 0, issues, directionCount: 0 };
  }
  let directionCount = 0;
  const definitions = [
    ['full-runline', game?.fullRunline, validateRunline],
    ['full-total', game?.fullTotal, validateTotal],
    [league === 'NBA' ? 'first-half-runline' : 'first5-runline', game?.[readerMarketProperties(league)[2]], validateRunline],
    [league === 'NBA' ? 'first-half-total' : 'first5-total', game?.[readerMarketProperties(league)[3]], validateTotal],
  ];
  for (const [name, value, validate] of definitions) {
    if (value == null) continue;
    directionCount += validate(value, name, issues);
  }
  if (directionCount < 2) issues.push(`direction-count:${directionCount}`);
  return { ok: issues.length === 0, issues, directionCount };
}

export function assessBoardCandidate(candidate, now = Date.now()) {
  const capture = candidate?.capture || {};
  const parsed = candidate?.parsed || {};
  const diagnostics = capture?.diagnostics || {};
  const issues = [];
  const games = Array.isArray(parsed.games) ? parsed.games : [];
  const normalizedCandidate = candidate;
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
  if (['EPL', 'UCL'].includes(parsed.league) && Array.isArray(diagnostics.tableIssues)) {
    issues.push(...diagnostics.tableIssues.slice(0, 8).map(issue => `table:${String(issue).slice(0, 100)}`));
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
  if (ignoredDuplicateGameCount) issues.push('conflicting-normalized-rows');
  if (Array.isArray(parsed.parseIssues) && parsed.parseIssues.length) {
    issues.push(...parsed.parseIssues
      .map(issue => `parser:${issue}`));
  }

  const identities = new Set();
  const dates = new Set();
  for (const [index, game] of games.entries()) {
    const validation = game?.marketStatus === 'locked'
      ? validateLockedReaderGame(game, parsed.league)
      : validateAvailableReaderGame(game, parsed.league);
    issues.push(...validation.issues.map(issue => `game-${index + 1}:${issue}`));
    const identity = `${game?.boardDate || ''}|${game?.boardTime || ''}|${game?.awayCode || ''}|${game?.homeCode || ''}`;
    if (identities.has(identity)) issues.push(`duplicate-game:${identity}`);
    identities.add(identity);
    if (game?.boardDate) dates.add(game.boardDate);
  }
  // NBA standard boards legitimately list today and tomorrow together.
  // Validate the entire source before splitting for date-keyed storage.
  if (dates.size !== 1 && (!['NBA', 'NHL', 'EPL', 'UCL'].includes(parsed.league) || dates.size === 0)) issues.push(`board-date-count:${dates.size}`);
  if (dates.size > 1 && !dates.has(parsed.boardDate)) issues.push('board-date-mismatch');
  if (dates.size === 1 && parsed.boardDate !== [...dates][0]) issues.push('board-date-mismatch');

  const observedTime = Date.parse(capture.observedAt || '');
  const observedAgeMs = Number(now) - observedTime;
  if (!Number.isFinite(observedTime)) issues.push('missing-observed-time');
  else if (observedAgeMs < -30_000 || observedAgeMs > 60_000) issues.push('stale-observation');

  // A fresh, fully validated DOM capture is a new observation of the displayed
  // quote even when Tai888 has not changed the price.  Using only mutation time
  // made an unchanged but continuously re-read board expire every five minutes.
  // Connection loss is still fail-closed because a capture must answer now and
  // pass the host, timestamp, slate, market and water validations above.
  const marketActivityAt = String(diagnostics.lastMutationAt || '');
  const marketActivityTime = Date.parse(marketActivityAt);
  if (Number.isFinite(marketActivityTime) && marketActivityTime > Number(now) + 30_000) {
    issues.push('future-market-activity');
  }
  const pageActivityAt = Number.isFinite(observedTime) ? new Date(observedTime).toISOString() : '';
  const pageActivityTime = observedTime;

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
    marketActivityAt,
    marketActivityTime,
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

// Compare shared contracts even when one frame contains fewer games/markets.
// Capture completion time is not evidence that its prices are newer.
function sharedContractsDisagree(left, right) {
  const canonicalGames = row => JSON.parse(row.payloadFingerprint).games;
  const identity = game => [game.boardDate, game.boardTime, game.awayCode, game.homeCode].join('|');
  const rightGames = new Map(canonicalGames(right).map(game => [identity(game), game]));
  return canonicalGames(left).some(game => {
    const other = rightGames.get(identity(game));
    if (!other) return false;
    if (game.marketStatus !== other.marketStatus) return true;
    if (['EPL','UCL'].includes(left.candidate?.parsed?.league)) {
      const key=m=>[m.kind,m.unit,m.line||'',m.lineSide||''].join(':');
      return (game.markets||[]).some(m=>{const r=(other.markets||[]).find(v=>key(v)===key(m));return r&&JSON.stringify(m)!==JSON.stringify(r);});
    }
    return readerMarketProperties(left.candidate?.parsed?.league).some(key =>
      game[key] != null && other[key] != null
      && JSON.stringify(game[key]) !== JSON.stringify(other[key]));
  });
}

// A partial NBA DOM board is not evidence of contradictory prices. It can
// only be ignored when one intact source contains every captured contract,
// including explicit locks. Disjoint fragments are never stitched together.
function coversNbaContracts(left, right) {
  const canonical = row => JSON.parse(row.payloadFingerprint).games;
  const identity = game => [game.boardDate, game.boardTime, game.awayCode, game.homeCode].join('|');
  const leftGames = new Map(canonical(left).map(game => [identity(game), game]));
  return canonical(right).every(game => {
    const other = leftGames.get(identity(game));
    if (!other || game.marketStatus !== other.marketStatus) return false;
    if (Object.entries(game.marketStates || {}).some(([key, value]) => other.marketStates?.[key] !== value)) return false;
    return readerMarketProperties('NBA').every(key => game[key] == null
      || other[key] != null && JSON.stringify(game[key]) === JSON.stringify(other[key]));
  });
}

/**
 * Pick one board from one frame in one authoritative tab.  The function never
 * combines tables or games across frames.  If two complete frames in that tab
 * disagree, it fails closed instead of guessing which contract is current.
 */
export function selectAuthoritativeBoard(candidates, options = {}) {
  // NBA standard pages may independently display today's and tomorrow's
  // slates. Compare authority within the stored date, retaining one complete
  // source per date; an unrelated dated slate is not contradictory evidence.
  if (options.league === 'NBA') {
    const selection = selectAuthoritativeNbaDates(candidates, options);
    if (!selection.ok) {
      // Bounded source/contract diagnostics are observational only and must
      // never turn a rejected quote into an authorized upload.
      try { selection.diagnosticEvidence = buildNbaAuthorityDiagnostics(candidates); } catch {}
    }
    return selection;
  }
  if (options.dateScoped && ['MLB', 'NPB', 'KBO', 'CPBL'].includes(options.league)) {
    return selectAuthoritativeDatedBoards(candidates, options);
  }
  return selectSingleAuthoritativeBoard(candidates, options);
}

function selectAuthoritativeNbaDates(candidates, { now = Date.now(), preferredTabId = null, league = 'NBA' } = {}) {
  const sources = (Array.isArray(candidates) ? candidates : []).filter(candidate =>
    candidate?.parsed?.league === league && Array.isArray(candidate?.capture?.tables) && candidate.capture.tables.length > 0);
  const assessed = sources.map(candidate => assessBoardCandidate(candidate, now));
  if (!sources.length) return { ok: false, error: 'no-board-candidates', assessed, selections: [] };
  // A malformed/conflicting original cannot become valid by projecting away
  // its bad row. Validate the complete source before date-scoped selection.
  if (assessed.some(row => row.issues.some(issue => issue.includes('conflicting-')))) {
    return { ok: false, error: 'conflicting-duplicate-rows', assessed, selections: [] };
  }
  const valid = assessed.filter(row => row.ok);
  const dates = [...new Set(valid.flatMap(row => row.candidate.parsed.games.map(game => game.boardDate)))].sort();
  const selections = [];
  for (const boardDate of dates) {
    const projections = valid.flatMap(row => {
      const games = row.candidate.parsed.games.filter(game => game.boardDate === boardDate);
      return games.length ? [{ ...row.candidate, parsed: { ...row.candidate.parsed, boardDate, games } }] : [];
    });
    const selection = selectSingleAuthoritativeBoard(projections, { now, preferredTabId, league });
    if (!selection.ok) return { ...selection, boardDate, assessed, selections: [] };
    // The projection retains the original frame and every selected game's
    // untouched marketEvidence. Never union markets or prices across sources.
    selections.push({ selected: selection.selected, authorityTabId: selection.authorityTabId, boardDate,
      ignoredDuplicateTabCount: selection.ignoredDuplicateTabCount,
      ignoredDuplicateFrameCount: selection.ignoredDuplicateFrameCount });
  }
  if (!selections.length) return { ok: false, error: 'no-complete-tab', assessed, selections: [] };
  return { ok: true, ...selections[0], selections, assessed };
}

function selectSingleAuthoritativeBoard(candidates, { now = Date.now(), preferredTabId = null, league = '' } = {}) {
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
  // Never rescue an explicitly conflicting source with another frame/tab.
  if (assessed.some(row => row.issues.some(issue => issue.includes('conflicting-')))) {
    return { ok: false, error: 'conflicting-duplicate-rows', assessed };
  }
  const usableTabs = [];
  for (const tab of tabs) {
    const tabFrames = assessed.filter(row => row.candidate.tabId === tab.tabId);
    const validTabFrames = tabFrames.filter(row => row.ok);
    const bestCoverage = Math.max(0, ...validTabFrames.map(row => row.detectedGameCount || 0));
    const complete = validTabFrames.filter(row => row.detectedGameCount === bestCoverage);
    if (!complete.length) continue;
    const fullBoards = complete.filter(row => row.detectedGameCount === row.expectedGameCount
      && row.candidate.parsed.games.every(game => game.marketStatus === 'locked'
        || validateStandardReaderGame(game, row.candidate.parsed.league).ok));
    const completeDisagree = new Set(fullBoards.map(row => row.payloadFingerprint)).size > 1;
    const overlapDisagrees = validTabFrames.some((left, index) =>
      validTabFrames.slice(index + 1).some(right => sharedContractsDisagree(left, right)));
    if ((league !== 'NBA' && completeDisagree) || overlapDisagrees) {
      return {
        ok: false,
        error: 'conflicting-duplicate-frames',
        authorityTabId: tab.tabId,
        conflictingFrameIds: validTabFrames.map(row => row.candidate.frameId),
        assessed,
      };
    }
    const authoritativeFrames = league === 'NBA'
      ? validTabFrames.filter(row => validTabFrames.every(other => coversNbaContracts(row, other))) : complete;
    if (!authoritativeFrames.length) return { ok: false, error: 'no-complete-tab', authorityTabId: tab.tabId, assessed };
    usableTabs.push({
      tab,
      selected: [...authoritativeFrames].sort(framePriority)[0],
      duplicateFrameCount: Math.max(0, authoritativeFrames.length - 1),
    });
  }

  // Multiple tabs for the same league are safe only when they expose the exact
  // same canonical contracts. Never select a stale duplicate by focus/access
  // order when another usable tab shows a different price.
  const fingerprints = new Set(usableTabs.map(row => row.selected.payloadFingerprint).filter(Boolean));
  const nbaConflict = league === 'NBA' && usableTabs.some((left, index) =>
    usableTabs.slice(index + 1).some(right => sharedContractsDisagree(left.selected, right.selected)));
  if ((league !== 'NBA' && fingerprints.size > 1) || nbaConflict) {
    return {
      ok: false,
      error: 'conflicting-duplicate-tabs',
      authorityTabId: null,
      conflictingTabIds: usableTabs.map(row => row.tab.tabId),
      assessed,
    };
  }

  if (usableTabs.length) {
    const authoritativeTabs = league === 'NBA' ? usableTabs.filter(row =>
      usableTabs.every(other => coversNbaContracts(row.selected, other.selected))) : usableTabs;
    if (!authoritativeTabs.length) return { ok: false, error: 'no-complete-tab', authorityTabId: null, assessed };
    const authority = [...authoritativeTabs].sort((left, right) =>
      tabPriority(left.tab, right.tab, preferredTabId))[0];
    return {
      ok: true,
      authorityTabId: authority.tab.tabId,
      selected: authority.selected,
      ignoredDuplicateTabCount: Math.max(0, usableTabs.length - 1),
      ignoredDuplicateFrameCount: authority.duplicateFrameCount,
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

// Different board dates have independent authority. Validate every complete
// original first, then compare date-only projections without splicing rows
// across sources. The transport must honor each original's selected dates.
export function selectAuthoritativeDatedBoards(candidates, { now = Date.now(), preferredTabId = null, league = '' } = {}) {
  if (!['MLB', 'NPB', 'KBO', 'CPBL'].includes(league)) {
    return { ok: false, error: 'unknown-league', assessed: [], selections: [] };
  }
  const sources = (Array.isArray(candidates) ? candidates : []).filter(candidate =>
    candidate?.parsed?.league === league && Array.isArray(candidate?.capture?.tables) && candidate.capture.tables.length > 0);
  const assessed = sources.map(candidate => assessBoardCandidate(candidate, now));
  if (!sources.length) return { ok: false, error: 'no-board-candidates', assessed, selections: [] };
  if (assessed.some(row => row.issues.some(issue => /conflict/i.test(issue)))) {
    return { ok: false, error: 'conflicting-duplicate-rows', assessed, selections: [] };
  }
  const valid = assessed.filter(row => row.ok);
  const dates = [...new Set(valid.flatMap(row => row.candidate.parsed.games.map(game => game.boardDate)))].sort();
  const selectedSources = new Map(), scopeSelections = [];
  for (const boardDate of dates) {
    const projections = valid.map(original => ({ original, projection: {
      ...original.candidate, parsed: { ...original.candidate.parsed, boardDate,
        games: original.candidate.parsed.games.filter(game => game.boardDate === boardDate) },
    } })).filter(row => row.projection.parsed.games.length);
    const selection = selectSingleAuthoritativeBoard(projections.map(row => row.projection), { now, preferredTabId, league });
    if (!selection.ok) return { ...selection, ok: false, boardDate, assessed, selections: [], scopeSelections };
    const original = projections.find(row => row.projection === selection.selected.candidate)?.original;
    if (!original) return { ok: false, error: 'date-authority-source-missing', boardDate, assessed, selections: [] };
    scopeSelections.push({ boardDate, authorityTabId: selection.authorityTabId });
    if (!selectedSources.has(original.candidate)) selectedSources.set(original.candidate, {
      selected: original, authorityTabId: original.candidate.tabId, boardDates: [],
    });
    selectedSources.get(original.candidate).boardDates.push(boardDate);
  }
  const selections = [...selectedSources.values()];
  return selections.length ? { ok: true, selections, scopeSelections, assessed }
    : { ok: false, error: 'no-complete-tab', assessed, selections: [] };
}


// Soccer periods are contracts with separate authority. A full-time frame and
// a first-half frame cannot disagree solely because their prices differ.
// This derives scopes from parsed identity rows, never a caller-only label.
function soccerGamePeriods(game) {
  const scopes = new Set();
  for (const period of Array.isArray(game?.periodsCovered) ? game.periodsCovered : []) {
    if (['FT', 'HT', 'UNKNOWN'].includes(period)) scopes.add(period);
  }
  for (const market of Array.isArray(game?.markets) ? game.markets : []) {
    scopes.add(['FT', 'HT'].includes(market?.period) ? market.period : 'UNKNOWN');
  }
  if (!scopes.size) scopes.add('UNKNOWN');
  return ['FT', 'HT', 'UNKNOWN'].filter(period => scopes.has(period));
}

function soccerAuthorityProjection(candidate, period, boardDate) {
  const games = (candidate.parsed.games || []).flatMap(game => {
    if (game.boardDate !== boardDate || !soccerGamePeriods(game).includes(period)) return [];
    const markets = (game.markets || []).filter(market =>
      (['FT', 'HT'].includes(market.period) ? market.period : 'UNKNOWN') === period)
      .map(market => Object.fromEntries(['period', 'kind', 'unit', 'line', 'lineSide',
        'awayWater', 'homeWater', 'overWater', 'underWater', 'drawWater']
        .filter(key => market[key] !== undefined).map(key => [key, market[key]])));
    // A period may be locked while another period of the same match is open.
    // Only the parser's row-backed state can establish that scoped tombstone.
    const marketStatus = game.periodStates?.[period] || (markets.length ? 'open' : game.marketStatus);
    if (!markets.length && marketStatus !== 'locked') return [];
    return [{ league: game.league, boardDate: game.boardDate, boardTime: game.boardTime,
      awayCode: game.awayCode, homeCode: game.homeCode, marketStatus,
      markets, periodsCovered: [period], periodStates: { [period]: marketStatus }, executable: false }];
  });
  return { ...candidate, parsed: { ...candidate.parsed, games,
    boardDate,
    pageLeagueLabel: candidate.parsed.league, periodsCovered: [period] } };
}

function soccerConflictEvidence(sources, league, period) {
  // Optional observability must not change the rejection or abort other
  // leagues if a malformed diagnostic input cannot be summarized.
  try { return buildSoccerAuthorityDiagnostics(sources, { league, period }); }
  catch { return null; }
}

/**
 * Validate each dated soccer period independently, then return the original
 * source captures with their selected date allow-list. Projections are only
 * comparisons; the transport retains the original for server-side reparse.
 * A conflict in any covered scope rejects the whole league, preserving the
 * existing fail-closed policy. The same selected frame is returned only once.
 */
export function selectAuthoritativeSoccerBoards(candidates, { now = Date.now(), preferredTabId = null, league = '' } = {}) {
  if (!['EPL', 'UCL'].includes(league)) return { ok: false, error: 'unknown-league', assessed: [], selections: [] };
  const sources = (Array.isArray(candidates) ? candidates : []).filter(candidate =>
    candidate?.parsed?.league === league && Array.isArray(candidate?.capture?.tables) && candidate.capture.tables.length > 0);
  const assessed = sources.map(candidate => assessBoardCandidate(candidate, now));
  if (!sources.length) return { ok: false, error: 'no-board-candidates', assessed, selections: [] };
  if (assessed.some(row => row.issues.some(issue => /conflict/i.test(issue)))) {
    return { ok: false, error: 'conflicting-duplicate-rows', assessed, selections: [] };
  }
  const valid = assessed.filter(row => row.ok);
  const dates = [...new Set(valid.flatMap(row => row.candidate.parsed.games.map(game => game.boardDate)))].sort();
  const selectedSources = new Map(), scopeSelections = [];
  for (const boardDate of dates) for (const period of ['FT', 'HT', 'UNKNOWN']) {
    const projections = valid.map(row => ({ original: row, projection: soccerAuthorityProjection(row.candidate, period, boardDate) }))
      .filter(row => row.projection.parsed.games.length);
    if (!projections.length) continue;
    const selection = selectAuthoritativeBoard(projections.map(row => row.projection), { now, preferredTabId, league });
    if (!selection.ok) return { ...selection, ok: false, boardDate, period, assessed, selections: [], scopeSelections,
      diagnosticEvidence: soccerConflictEvidence(sources, league, period) };
    const original = projections.find(row => row.projection === selection.selected.candidate)?.original;
    if (!original) return { ok: false, error: 'soccer-authority-source-missing', period, assessed, selections: [] };
    scopeSelections.push({ boardDate, period, authorityTabId: selection.authorityTabId });
    if (!selectedSources.has(original.candidate)) selectedSources.set(original.candidate, {
      selected: original, authorityTabId: original.candidate.tabId,
      periodsCovered: ['FT', 'HT', 'UNKNOWN'].filter(value => original.candidate.parsed.games.some(game => soccerGamePeriods(game).includes(value))),
      boardDates: [],
      sourceScopes: [],
    });
    const source = selectedSources.get(original.candidate);
    if (!source.boardDates.includes(boardDate)) source.boardDates.push(boardDate);
    let scope = source.sourceScopes.find(value => value.boardDate === boardDate);
    if (!scope) { scope = { boardDate, periodsCovered: [] }; source.sourceScopes.push(scope); }
    if (!scope.periodsCovered.includes(period)) scope.periodsCovered.push(period);
  }
  const selections = [...selectedSources.values()];
  return selections.length ? { ok: true, selections, scopeSelections, assessed }
    : { ok: false, error: 'no-complete-tab', assessed, selections: [] };
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

// Called only after source-wide authority/conflict validation. Each upload
// preserves the game date and contracts; never relabel tomorrow as today.
export function readerPayloadsByDate(payload, { soccerScopes = null } = {}) {
  if (!['NBA', 'NHL', 'EPL', 'UCL'].includes(payload.league)) return [payload];
  const dates = [...new Set(payload.games.map(game => game.boardDate))].sort();
  const dated = dates.map(boardDate => {
    const games = payload.games.filter(game => game.boardDate === boardDate);
    return { ...payload, boardDate, games,
      ...(['EPL', 'UCL'].includes(payload.league) ? { periodsCovered: ['FT', 'HT', 'UNKNOWN']
        .filter(period => games.some(game => soccerGamePeriods(game).includes(period))) } : {}),
      expectedGameCount: games.length, detectedGameCount: games.length };
  });
  if (!['EPL', 'UCL'].includes(payload.league) || soccerScopes === null) return dated;
  if (!Array.isArray(soccerScopes)) return [];
  return dated.flatMap(value => {
    const scopes = soccerScopes.filter(scope => scope?.boardDate === value.boardDate);
    if (scopes.length !== 1) return [];
    const scoped = scopeSoccerPayload(value, { version: SOCCER_SOURCE_SCOPE_VERSION,
      boardDate: value.boardDate, periodsCovered: scopes[0].periodsCovered });
    return scoped ? [scoped] : [];
  });
}
