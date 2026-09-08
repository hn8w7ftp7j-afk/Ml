// Read-only presentation of evidence. Never rewrite a saved result or model input.
export function npbStarterEvidence(item, side) {
  const game = item?.game;
  const context = item?.customData?.context;
  if (String(game?.leagueId || game?.league) !== 'NPB') return null;
  const sameGame = Number.isSafeInteger(Number(game?.gamePk)) && Number(game.gamePk) > 0
    && String(context?.game?.gamePk) === String(game.gamePk)
    && String(context?.leagueId || context?.game?.leagueId) === 'NPB'
    && Number.isFinite(Date.parse(game.gameDate)) && context?.game?.gameDate === game.gameDate;
  if (!sameGame) return { status: 'UNVERIFIED', starter: null };
  const starter = context?.[side]?.starter;
  const expectedTeam = game[`${side}TeamId`];
  const contextTeam = context.game[`${side}TeamId`];
  const teamMatches = expectedTeam != null && contextTeam != null && String(expectedTeam) === String(contextTeam)
    && (starter?.teamId == null || String(starter.teamId) === String(expectedTeam));
  if (!starter || !teamMatches || starter.identityMismatch === true) return { status: 'UNVERIFIED', starter: null };
  const projected = starter.confirmed === false || starter.projected === true
    || /PROJECTED|FORECAST|ROTATION_MIXTURE|NEUTRAL.*SCENARIO/.test([starter.status, starter.assignmentStatus, starter.projectionMode, starter.identitySource, starter.source].join(' '));
  const id = starter.id || starter.officialPlayerId;
  // Match compact transport precedence: an explicit upstream false cannot be
  // replaced by a legacy true on the starter object.
  const identityReady = (context[side]?.upstreamReadiness?.starterIdentity ?? starter.identityReady) === true;
  const confirmed = identityReady && starter.identityConfirmed === true && /^(?=.*[1-9])\d+$/.test(String(id || '')) && starter.name;
  return { status: projected ? 'PROJECTED_ROTATION_MIXTURE' : confirmed ? 'CONFIRMED' : 'UNVERIFIED', starter };
}

export function analysisSourceStatusDisplay(item) {
  const original = item?.customData?.analysis?.sourceStatuses || {};
  const away = npbStarterEvidence(item, 'away'); const home = npbStarterEvidence(item, 'home');
  if (!away || !home) return original;
  const status = away.status === 'CONFIRMED' && home.status === 'CONFIRMED' ? 'CONFIRMED'
    : away.status === 'PROJECTED_ROTATION_MIXTURE' || home.status === 'PROJECTED_ROTATION_MIXTURE' ? 'PROJECTED_OR_UNVERIFIED'
      : 'UNVERIFIED';
  return { ...original, starterIdentity: status };
}
