// NBA-only descriptive box-score features. No market or wagering imports.
export const NBA_FEATURE_VERSION = 'nba-boxscore-features-v1';
export const NBA_FEATURE_METHOD = Object.freeze({
  id: NBA_FEATURE_VERSION,
  possessions: 'mean of both teams (FGA + 0.44 * FTA - OREB + total turnovers)',
  pace: 'estimated possessions * 48 / actual game minutes',
  rating: '100 * points / shared estimated possessions',
  usage: '100 * (player FGA + 0.44 * player FTA + player TO) * game minutes / (player minutes * (team FGA + 0.44 * team FTA + team total TO))',
  freeThrowWeight: 0.44,
  officialMetric: false,
  references: ['https://www.nba.com/stats/help/glossary', 'https://www.basketball-reference.com/about/glossary.html'],
});
const FG = 'fieldGoalsMade-fieldGoalsAttempted';
const THREE = 'threePointFieldGoalsMade-threePointFieldGoalsAttempted';
const FT = 'freeThrowsMade-freeThrowsAttempted';
const integer = value => typeof value === 'string' && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
function statsMap(rows) {
  const result = new Map();
  for (const row of rows || []) {
    if (result.has(row.name)) throw new Error(`STAT_IDENTITY_CONFLICT:${row.name}`);
    result.set(row.name, row.displayValue);
  }
  return result;
}
function shooting(map, key) {
  const match = map.get(key)?.match(/^(\d+)-(\d+)$/);
  if (!match) return null;
  const made = integer(match[1]); const attempted = integer(match[2]);
  if (made === null || attempted === null || made > attempted) throw new Error(`BOX_SCORE_INVALID:${key}`);
  return { made, attempted };
}
function counts(team) {
  const map = statsMap(team.statistics);
  const fg = shooting(map, FG); const three = shooting(map, THREE); const ft = shooting(map, FT);
  const oreb = integer(map.get('offensiveRebounds'));
  const dreb = integer(map.get('defensiveRebounds'));
  // totalTurnovers includes team turnovers. Never silently substitute player TO.
  const turnovers = integer(map.get('totalTurnovers'));
  if (!fg || !three || !ft || [oreb, dreb, turnovers].includes(null)) return null;
  if (three.made > fg.made || three.attempted > fg.attempted || fg.made - three.made > fg.attempted - three.attempted
      || fg.made * 2 + three.made + ft.made !== team.score) throw new Error('BOX_SCORE_INVALID:shooting_points');
  const rebounds = integer(map.get('totalRebounds'));
  if (rebounds !== null && rebounds !== oreb + dreb) throw new Error('BOX_SCORE_INVALID:rebounds');
  const playerTo = integer(map.get('turnovers')); const teamTo = integer(map.get('teamTurnovers'));
  if (playerTo !== null && teamTo !== null && playerTo + teamTo !== turnovers) throw new Error('BOX_SCORE_INVALID:turnovers');
  return { fg, three, ft, oreb, dreb, turnovers };
}
function duration(game) {
  const home = game.home.periodScores || []; const away = game.away.periodScores || [];
  if (home.length < 4 || home.length !== away.length) return null;
  for (const rows of [home, away]) {
    if (rows.some((row, i) => row.period !== i + 1 || !Number.isInteger(row.score) || row.score < 0)) throw new Error('BOX_SCORE_INVALID:periods');
  }
  if (home.reduce((s, r) => s + r.score, 0) !== game.home.score || away.reduce((s, r) => s + r.score, 0) !== game.away.score) throw new Error('BOX_SCORE_INVALID:period_total');
  // Every overtime must have started tied; a completed NBA game cannot be tied.
  for (let end = 4; end < home.length; end += 1) {
    if (home.slice(0, end).reduce((s, r) => s + r.score, 0) !== away.slice(0, end).reduce((s, r) => s + r.score, 0)) throw new Error('BOX_SCORE_INVALID:overtime_not_tied');
  }
  if (game.home.score === game.away.score) throw new Error('BOX_SCORE_INVALID:final_tie');
  return 48 + 5 * (home.length - 4);
}
export function deriveNbaBoxscore(game, players = []) {
  const issues = [];
  const output = { version: NBA_FEATURE_VERSION, method: NBA_FEATURE_METHOD, status: 'unavailable', gameId: game?.id || null, temporalBasis: 'postgame_only', minutes: null, possessions: null, pace: null, home: null, away: null, players: [], qa: { status: 'WARNING', issues } };
  const warn = (code, message) => issues.push({ code, severity: 'WARNING', message });
  if (game?.league !== 'NBA' || !/^nba:espn:game:[1-9]\d*$/.test(game.id || '') || ![game.home, game.away].every(t => /^nba:espn:team:[1-9]\d*$/.test(t?.id || '')) || game.home.id === game.away.id) {
    output.status = 'blocked'; output.qa.status = 'BLOCK'; issues.push({ code: 'FEATURE_IDENTITY_MISMATCH', severity: 'BLOCK', message: '回合數特徵的 NBA 賽事／球隊身分無法核對。' }); return output;
  }
  if (game.completed !== true || game.status !== 'final') { warn('POSTGAME_ONLY', '單場進階研究僅使用已完賽資料。'); return output; }
  try {
    const home = counts(game.home); const away = counts(game.away);
    output.minutes = duration(game);
    if (!home || !away) { warn('BOX_INPUT_MISSING', '缺少完整投籃、罰球、籃板或球隊總失誤；不以零值替代。'); return output; }
    const estimate = c => c.fg.attempted + 0.44 * c.ft.attempted - c.oreb + c.turnovers;
    if (estimate(home) <= 0 || estimate(away) <= 0) throw new Error('BOX_SCORE_INVALID:possessions');
    output.possessions = (estimate(home) + estimate(away)) / 2;
    output.pace = output.minutes ? output.possessions * 48 / output.minutes : null;
    for (const [side, c, opp] of [['home', home, away], ['away', away, home]]) {
      const offense = game[side].score * 100 / output.possessions;
      const defense = game[side === 'home' ? 'away' : 'home'].score * 100 / output.possessions;
      output[side] = { teamId: game[side].id, inputs: c, offensiveRating: offense, defensiveRating: defense, netRating: offense - defense,
        effectiveFieldGoalPct: c.fg.attempted ? 100 * (c.fg.made + 0.5 * c.three.made) / c.fg.attempted : null,
        offensiveReboundPct: c.oreb + opp.dreb ? 100 * c.oreb / (c.oreb + opp.dreb) : null,
        freeThrowAttemptRate: c.fg.attempted ? c.ft.attempted / c.fg.attempted : null,
        turnoversPer100EstimatedPossessions: 100 * c.turnovers / output.possessions };
    }
    const seen = new Set();
    for (const player of players) {
      if (!/^nba:espn:player:[1-9]\d*$/.test(player.id || '') || seen.has(player.id) || ![game.home.id, game.away.id].includes(player.teamId)) throw new Error('PLAYER_IDENTITY_CONFLICT');
      seen.add(player.id);
      if (player.didNotPlay) { output.players.push({ playerId: player.id, usageEstimate: null, reason: 'did_not_play' }); continue; }
      const map = statsMap(player.statistics); const fg = shooting(map, FG); const ft = shooting(map, FT);
      const to = integer(map.get('turnovers'));
      const text = map.get('minutes');
      const clock = typeof text === 'string' ? text.match(/^(\d+):(\d{2})$/) : null;
      const minutes = clock && Number(clock[2]) < 60 ? Number(clock[1]) + Number(clock[2]) / 60 : integer(text);
      if (minutes !== null && output.minutes && minutes > output.minutes) throw new Error('BOX_SCORE_INVALID:player_minutes');
      const c = player.teamId === game.home.id ? home : away;
      const used = c.fg.attempted + 0.44 * c.ft.attempted + c.turnovers;
      const valid = fg && ft && to !== null && minutes > 0 && output.minutes && used > 0;
      output.players.push({ playerId: player.id, minutes, usageEstimate: valid ? 100 * (fg.attempted + 0.44 * ft.attempted + to) * output.minutes / (minutes * used) : null, reason: valid ? 'boxscore_estimate_not_official_usage' : 'missing_or_zero_minutes', minutePrecision: clock ? 'seconds' : 'provider_rounded_minutes' });
    }
    output.status = 'ready';
    warn('ESTIMATED_NOT_OFFICIAL', '回合數及 Usage 為 box score 估算，不等於官方逐回合統計；沒有封頂或修正輸出。');
    if (!output.minutes) warn('GAME_DURATION_MISSING', '缺少完整分節，Pace 與 Usage 保留空值。');
  } catch (error) {
    output.status = 'blocked'; output.qa.status = 'BLOCK';
    output.possessions = null; output.pace = null; output.home = null; output.away = null; output.players = [];
    issues.push({ code: error.message.split(':')[0], severity: 'BLOCK', message: `Box score 完整性檢查失敗：${error.message}` });
  }
  return output;
}
