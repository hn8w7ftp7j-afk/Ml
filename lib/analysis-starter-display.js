import { npbStarterEvidence } from './npb-identity-display.js';
// Display frozen analysis personnel separately from the live schedule.
// Roster identity confirmation does not confirm today's assignment.
export function analysisStarterDisplay(item, side) {
  const game = item?.game || {};
  const context = item?.customData?.context;
  const league = String(game.leagueId || game.league || 'MLB');
  if (league === 'NPB') {
    const evidence = npbStarterEvidence(item, side);
    const name = evidence?.starter?.name;
    if (name) return `${name}（${evidence.status === 'CONFIRMED' ? '身分已核對' : evidence.status === 'PROJECTED_ROTATION_MIXTURE' ? '輪值推估／未確認' : '身分未核對'}）`;
    return game[`${side}Probable`] ? `${game[`${side}Probable`]}（賽程人選／身分未核對）` : '賽程未提供先發';
  }
  const sameGame = String(context?.game?.gamePk || '') === String(game.gamePk || '')
    && String(context?.leagueId || context?.game?.leagueId || 'MLB') === league;
  const starter = sameGame ? context?.[side]?.starter : null;
  const teamId = game[`${side}TeamId`];
  const sameTeam = !starter?.teamId || String(starter.teamId) === String(teamId);
  if (starter?.name && starter?.id && sameTeam) {
    const source = String(starter.identitySource || '');
    const projected = /PROJECTED|FORECAST/.test(String(starter.assignmentStatus || '') + source);
    const label = projected ? '輪值推估'
      : source.includes('TAI888') ? 'Reader人選／名冊核對'
        : source === 'CPBL_OFFICIAL_CURRENT_GAME_STARTER' ? '官方當場先發'
          : '分析使用人選';
    return `${starter.name}（${label}）`;
  }
  return game[`${side}Probable`] || '賽程未提供先發';
}
