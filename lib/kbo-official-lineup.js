const clean = value => String(value ?? '').trim();

// GetLineUpAnalysis: flag [0], home/away identity [1]/[2], home/away rows [3]/[4].
// WAR is not a verified batting-average sample and is deliberately not used.
export function parseKboOfficialLineup(payload, game, teams) {
  if (payload?.[0]?.length !== 1 || payload[0][0]?.LINEUP_CK !== true) return null;
  const output = {};
  for (const [side, identityIndex, tableIndex] of [['away', 2, 4], ['home', 1, 3]]) {
    const identity = payload?.[identityIndex]?.[0];
    if (payload?.[identityIndex]?.length !== 1 || payload?.[tableIndex]?.length !== 1
      || clean(identity?.G_ID) !== clean(game.providerGameId)
      || clean(identity?.T_ID) !== teams[side]
      || String(identity?.SEASON_ID) !== String(game.officialDate).slice(0, 4)
      || Number(identity?.LE_ID) !== 1 || Number(identity?.SR_ID) !== 0) return null;
    let table;
    try { table = JSON.parse(payload[tableIndex][0]); } catch { return null; }
    if (!Array.isArray(table?.rows) || table.rows.length !== 9) return null;
    const orders = new Set(), names = new Set();
    const players = [];
    for (const row of table.rows) {
      if (!Array.isArray(row?.row) || row.row.length !== 4) return null;
      const [orderText, position, name] = row.row.map(cell => clean(cell?.Text));
      if (!/^[1-9]$/.test(orderText) || !position || !name || /[<>]/.test(name)
        || orders.has(orderText) || names.has(name)) return null;
      orders.add(orderText); names.add(name);
      players.push({ id: `${teams[side]}:${name}`, officialPlayerId: null, name, position,
        order: Number(orderText), teamId: Number(game[`${side}TeamId`]), statsAvailable: false,
        battingStatsStatus: 'MISSING_VERIFIED_SEASON_SAMPLE' });
    }
    output[side] = { available: true, official: true, projected: false, credibleScenario: true,
      teamId: Number(game[`${side}TeamId`]), players: players.sort((a, b) => a.order - b.order),
      assignmentStatus: 'OFFICIAL_CURRENT_GAME_LINEUP', rosterConfirmedToday: true,
      statsCoverage: 0, fullStatsCoverage: false, observedAtBats: 0, observedHits: null,
      observedBattingAverage: null, offensiveIndex: 1, offensiveIndexIsFallback: true,
      offensiveIndexMethod: 'ROSTER_ONLY_NO_UNVERIFIED_RUN_DELTA',
      source: 'KBO_OFFICIAL_CURRENT_GAME_LINEUP_PIT', asOfGamePk: game.gamePk,
      asOfProviderGameId: game.providerGameId,
      incompleteReasons: ['VERIFIED_SEASON_BATTING_MISSING_FOR_9_SLOTS', 'OFFICIAL_PLAYER_IDS_NOT_SUPPLIED',
        'INJURY_AVAILABILITY_AND_HANDEDNESS_SPLITS_NOT_VERIFIED'],
      sourcePath: `$[${tableIndex}][0].rows`, identitySourcePath: `$[${identityIndex}][0]`,
    };
  }
  return output;
}
