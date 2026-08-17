import { isLeagueId } from './leagues.js';

export const LEAGUE_TEAM_REGISTRY_VERSION = 'BASEBALL-LEAGUE-TEAM-ALIASES-2026-08-v2.0.0';
export const TEAM_CODE_PATTERN = '[A-Z][A-Z0-9]{0,11}';
export const TEAM_CODE_RE = /^[A-Z][A-Z0-9]{0,11}$/;

const teams = Object.freeze({
  MLB: Object.freeze([
    ['LAA', 108, ['LAA']], ['ARI', 109, ['ARI', 'AZ']], ['BAL', 110, ['BAL']],
    ['BOS', 111, ['BOS']], ['CHC', 112, ['CHC']], ['CIN', 113, ['CIN']],
    ['CLE', 114, ['CLE']], ['COL', 115, ['COL']], ['DET', 116, ['DET']],
    ['HOU', 117, ['HOU']], ['KC', 118, ['KC', 'KCR', 'KAN']], ['LAD', 119, ['LAD']],
    ['WSH', 120, ['WSH', 'WAS', 'WSN']], ['NYM', 121, ['NYM']], ['OAK', 133, ['OAK', 'ATH']],
    ['PIT', 134, ['PIT']], ['SD', 135, ['SD', 'SDP', 'SDG']], ['SEA', 136, ['SEA']],
    ['SF', 137, ['SF', 'SFG', 'SFO']], ['STL', 138, ['STL']], ['TB', 139, ['TB', 'TBR', 'TAM']],
    ['TEX', 140, ['TEX']], ['TOR', 141, ['TOR']], ['MIN', 142, ['MIN']],
    ['PHI', 143, ['PHI']], ['ATL', 144, ['ATL']], ['CWS', 145, ['CWS', 'CHW']],
    ['MIA', 146, ['MIA']], ['NYY', 147, ['NYY']], ['MIL', 158, ['MIL']],
  ]),
  NPB: Object.freeze([
    ['YOM', 501, ['YOM', 'YG', 'G']],
    ['HAN', 502, ['HAN', 'HT', 'T']],
    ['YDB', 503, ['YDB', 'YOK', 'BAY', 'DB']],
    ['HIR', 504, ['HIR', 'HC', 'HIC', 'C']],
    ['YAK', 505, ['YAK', 'YS', 'SYB', 'S']],
    ['CHU', 506, ['CHU', 'CD', 'CHD', 'D']],
    ['SOF', 507, ['SOF', 'SBH', 'FSH', 'H']],
    ['NIP', 508, ['NIP', 'NHF', 'F']],
    ['LOM', 509, ['LOM', 'LOT', 'CLM', 'M']],
    ['RAK', 510, ['RAK', 'TRE', 'TRG', 'E']],
    ['ORI', 511, ['ORI', 'ORB', 'B']],
    ['SEI', 512, ['SEI', 'SBL', 'SSL', 'L']],
  ]),
  KBO: Object.freeze([
    ['KIA', 601, ['KIA']],
    ['SAM', 602, ['SAM', 'SLI']],
    ['LGT', 603, ['LGT', 'LG']],
    ['DOO', 604, ['DOO', 'DOB']],
    ['KTW', 605, ['KTW', 'KT']],
    ['SSG', 606, ['SSG']],
    ['LOG', 607, ['LOG', 'LOT']],
    ['HAN', 608, ['HAN', 'HWE']],
    ['NCD', 609, ['NCD', 'NC']],
    ['KIW', 610, ['KIW', 'KWH']],
  ]),
  CPBL: Object.freeze([
    ['CTB', 701, ['CTB', 'CTBC', 'BRO', 'ACN011']],
    ['UNI', 702, ['UNI', 'ULI', 'UL', 'ADD011']],
    ['RKM', 703, ['RKM', 'RAK', 'RM', 'AJL011']],
    ['FUB', 704, ['FUB', 'FBG', 'FG', 'AEO011']],
    ['WCD', 705, ['WCD', 'WCG', 'WC', 'AAA011']],
    ['TSG', 706, ['TSG', 'TSH', 'AKP011']],
  ]),
});

function buildLeagueIndex(rows) {
  const aliases = new Map();
  const byId = new Map();
  for (const [canonicalCode, id, rawAliases] of rows) {
    const entry = Object.freeze({ canonicalCode, id, aliases: Object.freeze([...rawAliases]) });
    if (!Number.isSafeInteger(id) || id <= 0 || byId.has(id)) throw new Error('League team registry has a duplicate id');
    byId.set(id, entry);
    for (const raw of rawAliases) {
      const alias = String(raw || '').trim().toUpperCase();
      if (!TEAM_CODE_RE.test(alias) || aliases.has(alias)) throw new Error('League team registry has an invalid or duplicate alias');
      aliases.set(alias, entry);
    }
  }
  return Object.freeze({ aliases, byId });
}

const indexes = Object.freeze(Object.fromEntries(
  Object.entries(teams).map(([league, rows]) => [league, buildLeagueIndex(rows)]),
));

export function normalizeTeamCode(value) {
  const code = String(value || '').trim().toUpperCase();
  return TEAM_CODE_RE.test(code) ? code : '';
}

export function resolveLeagueTeam(league, value) {
  if (!isLeagueId(league)) return null;
  const code = normalizeTeamCode(value);
  return code ? indexes[league].aliases.get(code) || null : null;
}

export function resolveLeagueTeamId(league, value) {
  return resolveLeagueTeam(league, value)?.id || null;
}

export function leagueTeamById(league, value) {
  if (!isLeagueId(league)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? indexes[league].byId.get(id) || null : null;
}

export function leagueTeamEntries(league) {
  if (!isLeagueId(league)) return [];
  return [...indexes[league].byId.values()];
}
