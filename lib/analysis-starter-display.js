import { npbStarterEvidence } from './npb-identity-display.js';
import { assignmentEvidenceView } from './personnel-evidence-display.js';
// Display frozen analysis personnel separately from the live schedule.
// Roster identity confirmation does not confirm today's assignment.
export function analysisStarterDisplay(item, side) {
  const game = item?.game || {};
  const context = item?.customData?.context;
  const league = String(game.leagueId || game.league || 'MLB');
  const sameGame = game.gamePk != null && context?.game?.gamePk != null
    && String(context.game.gamePk) === String(game.gamePk)
    && (!context.game.gameDate || !game.gameDate || context.game.gameDate === game.gameDate)
    && String(context?.leagueId || context?.game?.leagueId || 'MLB') === league;
  const receipt = sameGame ? item?.customData?.analysis?.dataAudit?.rows?.find(row => row.category === 'starter' && row.side === side) : null;
  const assignmentLabel = receipt?.assignmentEvidence ? assignmentEvidenceView(receipt).label : null;
  if (league === 'NPB') {
    const evidence = npbStarterEvidence(item, side);
    const name = evidence?.starter?.name;
    if (name) return `${name}（${evidence.status === 'PROJECTED_ROTATION_MIXTURE' ? '輪值推估' : assignmentLabel || '當場未核對'}）`;
    return game[`${side}Probable`] ? `${game[`${side}Probable`]}（賽程人選／未核對）` : '先發未提供';
  }
  const starter = sameGame ? context?.[side]?.starter : null;
  const teamId = game[`${side}TeamId`];
  const sameTeam = (!starter?.teamId || String(starter.teamId) === String(teamId))
    && (context?.game?.[`${side}TeamId`] == null || String(context.game[`${side}TeamId`]) === String(teamId));
  if (starter?.name && sameTeam && starter.identityMismatch !== true) {
    const source = String(starter.identitySource || '');
    const projected = starter.projected === true || starter.confirmed === false || /PROJECTED|FORECAST/.test(String(starter.assignmentStatus || '') + source);
    const label = projected ? '輪值推估' : assignmentLabel
      || (source.includes('TAI888') ? 'Reader人選／未核對' : '當場未核對');
    return `${starter.name}（${label}）`;
  }
  return game[`${side}Probable`] ? `${game[`${side}Probable`]}（賽程人選／未核對）` : '先發未提供';
}
