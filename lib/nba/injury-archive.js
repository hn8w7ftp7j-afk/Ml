// Factual subset of the official PDF, visually checked on pages 6–7.
// This is a recovered archive, NOT a system snapshot captured before tip-off.
const report = {
  officialGameId: '0022501187', gameId: 'nba:espn:game:401811042', startTime: '2026-04-12T22:00:00.000Z',
  source: { provider: 'NBA', url: 'https://ak-static.cms.nba.com/referee/injury/Injury-Report_2026-04-12_01_00PM.pdf', hash: '5b82da285ec1be7122b2d3d12164d799dea7b34200e3ab353c254e2020dc5b4d', fetchedAt: '2026-09-07T21:46:34.653Z', reportHeader: '04/12/26 01:00 PM', publishedAt: null, timestampBasis: 'printed_report_time_timezone_not_independently_verified', pages: [6, 7] },
  rows: [
    ['27', 'Bilal Coulibaly', 'Out'], ['27', 'Anthony Davis', 'Out'], ['27', 'Kyshawn George', 'Out'], ['27', 'Anthony Gill', 'Available'], ['27', 'Tre Johnson', 'Out'], ['27', "D'Angelo Russell", 'Out'], ['27', 'Alex Sarr', 'Out'], ['27', 'Tristan Vukcevic', 'Out'], ['27', 'Cam Whitmore', 'Out'], ['27', 'Trae Young', 'Out'],
    ['5', 'Jarrett Allen', 'Out'], ['5', 'Thomas Bryant', 'Out'], ['5', 'Keon Ellis', 'Out'], ['5', 'James Harden', 'Out'], ['5', 'Sam Merrill', 'Out'], ['5', 'Donovan Mitchell', 'Out'], ['5', 'Evan Mobley', 'Out'], ['5', 'Dennis Schroder', 'Out'], ['5', 'Dean Wade', 'Out'],
  ],
};
const key = value => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]/g, '');
export function archivedNbaInjuryReport(game, players) {
  if (game?.league !== 'NBA' || game.id !== report.gameId || game.startTime !== report.startTime || game.away?.sourceId !== '27' || game.home?.sourceId !== '5') return null;
  return { gameId: game.id, source: report.source, temporalBasis: 'official_archive_recovered_after_game', capturedPregame: false, modelInputEnabled: false, coverage: 'one_report_one_game_not_final_availability_or_lineup', rows: report.rows.map(([team, name, status]) => {
    const teamId = `nba:espn:team:${team}`; const matches = players.filter(p => p.teamId === teamId && key(p.name) === key(name));
    return { teamId, name, status, playerId: matches.length === 1 ? matches[0].id : null, identityBasis: matches.length === 1 ? 'same_game_team_unique_name' : 'unresolved_not_guessed' };
  }) };
}
