// Browser-only display snapshots. Never a betting ledger or source authority.
export const NHL_WORKSPACE_KEY = 'sports:nhl:workspace:v1';
export const NHL_WORKSPACE_EVENT = 'nhl-workspace-updated';
const limits = { boards: 8, details: 12, personnel: 12, contexts: 12, rosters: 8, teamSummaries: 12, shotResearch: 12 };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const gameId = value => /^(?:19|20)\d{2}0[123]\d{4}$/.test(value || '') && Number(value.slice(6)) > 0;
const league = value => object(value) && (value.league === 'NHL' || value.leagueId === 'NHL')
  && (!value.league || value.league === 'NHL') && (!value.leagueId || value.leagueId === 'NHL');
const date = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

export function validNhlWorkspaceRecord(section, key, value) {
  if (!league(value) || value.league !== 'NHL') return false;
  if (section === 'boards') return date(key) && value.date === key && Array.isArray(value.games)
    && value.games.every(row => league(row) && gameId(row.gameId) && row.taipeiDate === key);
  if (section === 'details') return gameId(key) && league(value.game) && value.game.gameId === key;
  if (section === 'personnel') return gameId(key) && value.gameId === key && league(value.personnel) && value.personnel.gameId === key;
  if (section === 'contexts') return gameId(key) && value.gameId === key;
  if (section === 'rosters') return league(value.roster) && `${value.roster.abbrev}:${value.roster.season}` === key
    && Array.isArray(value.roster.players) && value.roster.players.every(row => league(row) && row.teamId === value.roster.teamId);
  if (section === 'teamSummaries') return `${value.teamId}:${value.season}:${value.gameType}` === key && value.league === 'NHL';
  if (section === 'shotResearch') return gameId(key) && value.gameId === key && league(value.research) && league(value.research.game)
    && value.research?.game?.gameId === key && value.research.pregameModel === false;
  return false;
}

function acquired(value) {
  const source = value?.personnel?.source || value?.game?.source || value?.research?.source || value?.source || value?.roster?.source;
  const time = Date.parse(source?.observedAt || source?.fetchedAt);
  return Number.isFinite(time) ? time : null;
}

export function preferNhlWorkspaceRecord(previous, incoming) {
  if (!previous) return incoming;
  if (previous.personnel?.matched && incoming?.personnel?.matched) {
    const beforeRevision = Date.parse(previous.personnel.source?.availableAt);
    const afterRevision = Date.parse(incoming.personnel.source?.availableAt);
    if (Number.isFinite(beforeRevision) && (!Number.isFinite(afterRevision) || afterRevision < beforeRevision)) return previous;
  }
  if (previous.game && incoming?.game && previous.acquisition === 'OFFICIAL_LIVE_FETCH'
    && incoming.acquisition === 'ARCHIVED_OFFICIAL_HISTORICAL_SAMPLE') return previous;
  if (previous.games && incoming?.games && previous.sampleOnly !== true && incoming.sampleOnly === true) return previous;
  const before = acquired(previous); const after = acquired(incoming);
  if (before != null && (after == null || after < before)) return previous;
  return incoming;
}

export function mergeNhlWorkspace(saved, patch = {}) {
  const before = saved?.league === 'NHL' ? saved : {};
  const next = { league: 'NHL', date: patch.date ?? before.date, selectedGame: patch.selectedGame === undefined ? before.selectedGame : patch.selectedGame };
  for (const [section, limit] of Object.entries(limits)) {
    const rows = {};
    for (const origin of [before[section], patch[section]]) for (const [key, value] of Object.entries(object(origin) ? origin : {})) {
      if (validNhlWorkspaceRecord(section, key, value)) rows[key] = preferNhlWorkspaceRecord(rows[key], value);
    }
    next[section] = Object.fromEntries(Object.entries(rows).slice(-limit));
  }
  return next;
}

export function readNhlWorkspace(storage) {
  try { return mergeNhlWorkspace(JSON.parse(storage?.getItem(NHL_WORKSPACE_KEY) || 'null')); }
  catch { return mergeNhlWorkspace(null); }
}

export function saveNhlWorkspace(patch, storage) {
  const next = mergeNhlWorkspace(readNhlWorkspace(storage), patch);
  // Failure is visible to the caller; never claim a display snapshot was saved.
  storage.setItem(NHL_WORKSPACE_KEY, JSON.stringify(next));
  return next;
}

export function persistNhlWorkspaceResult(section, key, value) {
  if (!validNhlWorkspaceRecord(section, key, value)) throw new Error('NHL 顯示資料身分不符，已停止保存。');
  if (typeof window === 'undefined') return;
  saveNhlWorkspace({ [section]: { [key]: value } }, window.localStorage);
  window.dispatchEvent(new Event(NHL_WORKSPACE_EVENT));
}
