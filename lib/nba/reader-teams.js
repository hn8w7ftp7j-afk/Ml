import { ESPN_NBA_TEAMS } from './identity.js';
import { NBA_TEAM_LABELS } from './labels.js';

// Alias resolution stays in the NBA namespace. Identical baseball codes never
// provide a team ID here, and these are ESPN IDs rather than NBA official IDs.
const aliases = Object.freeze({ GSW: 'GS', NYK: 'NY', NOP: 'NO', SAS: 'SA', UTA: 'UTAH', WAS: 'WSH', PHO: 'PHX', BRK: 'BKN' });
const sourceIds = new Map(Object.entries(ESPN_NBA_TEAMS).map(([id, code]) => [code, id]));

export function resolveNbaReaderTeam(value) {
  if (typeof value !== 'string' || !/^[A-Z][A-Z0-9]{0,11}$/.test(value)) return null;
  const abbreviation = aliases[value] || value;
  const sourceId = sourceIds.get(abbreviation);
  if (!sourceId) return null;
  return {
    id: `nba:espn:team:${sourceId}`, sourceId, league: 'NBA', provider: 'ESPN',
    abbreviation, name: NBA_TEAM_LABELS[abbreviation],
    identityStatus: 'nba_team_alias_mapped_schedule_unverified',
  };
}
