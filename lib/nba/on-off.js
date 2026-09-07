import { deriveNbaBoxscore } from './basketball.js';

export const NBA_ON_OFF_VERSION = 'nba-observed-on-off-v2';
const nameKey = value => String(value || '').normalize('NFKC').replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim();
function requireValue(condition, code, message) {
  if (!condition) throw Object.assign(new Error(message), { code });
}
function clockMilliseconds(value, duration) {
  const match = String(value || '').match(/^(?:(\d{1,2}):)?(\d{1,2})(?:\.(\d{1,3}))?$/);
  requireValue(match && (!match[1] || Number(match[2]) < 60), 'CLOCK_INVALID', '逐事件時間格式無法核對');
  const ms = Number(match[1] || 0) * 60000 + Number(match[2]) * 1000 + Number((match[3] || '').padEnd(3, '0'));
  requireValue(ms <= duration, 'CLOCK_INVALID', '逐事件時間超過該節長度');
  return ms;
}

// Descriptive completed-game reconstruction only. No prospective output,
// possession attribution, causal player effect or official NBA metric claim.
export function deriveNbaOnOff(game, players, plays) {
  const base = { version: NBA_ON_OFF_VERSION, league: 'NBA', gameId: game?.id || null, temporalBasis: 'postgame_play_by_play', officialMetric: false, pointInTimeReplay: false, players: [] };
  try {
    requireValue(game?.league === 'NBA' && /^nba:espn:game:[1-9]\d*$/.test(game.id) && game.id === `nba:espn:game:${game.sourceId}`, 'IDENTITY_INVALID', '逐事件研究的 NBA 場次身分無效');
    if (game.status !== 'final') return { ...base, status: 'unavailable', qa: { status: 'WARNING', issues: ['只在完賽後重建完整 On/Off，不將進行中資料當成全場結果。'] } };
    const box = deriveNbaBoxscore(game);
    requireValue(box.status !== 'blocked', 'SCORE_INVALID', '球隊 box score 數學核對失敗');
    if (box.minutes == null || !Array.isArray(plays) || !plays.length) return { ...base, status: 'unavailable', qa: { status: 'WARNING', issues: ['缺少完整分節時間或逐事件資料。'] } };
    const durationMs = box.minutes * 60000;
    requireValue(Array.isArray(players), 'IDENTITY_INVALID', '球員名單缺失');
    const roster = new Map(); const on = new Map([[game.home.id, new Set()], [game.away.id, new Set()]]);
    const totals = new Map();
    for (const player of players) {
      requireValue(/^nba:espn:player:[1-9]\d*$/.test(player.id) && player.id === `nba:espn:player:${player.sourceId}` && on.has(player.teamId) && !roster.has(player.sourceId), 'IDENTITY_INVALID', '球員身分重複、缺失或跨隊衝突');
      roster.set(player.sourceId, player);
      totals.set(player.sourceId, { onMs: 0, pointsFor: 0, pointsAgainst: 0 });
      if (player.starter) {
        requireValue(!player.didNotPlay, 'LINEUP_INVALID', '來源同時標示先發與未上場');
        on.get(player.teamId).add(player.sourceId);
      }
    }
    if ([...on.values()].some(set => set.size !== 5)) return { ...base, status: 'unavailable', qa: { status: 'WARNING', issues: ['需要兩隊各五位可核對的實際先發；不推測缺少球員。'] } };
    const events = new Map(); const sequences = new Set();
    for (const play of plays) {
      requireValue(typeof play?.id === 'string' && play.id.startsWith(game.sourceId) && /^\d+$/.test(play.id) && /^\d+$/.test(play.sequenceNumber), 'IDENTITY_INVALID', '逐事件場次或順序身分無效');
      const previous = events.get(play.id);
      if (previous) { requireValue(JSON.stringify(previous) === JSON.stringify(play), 'EVENT_CONFLICT', '同一事件有互相衝突的版本'); continue; }
      requireValue(Number.isSafeInteger(Number(play.sequenceNumber)) && !sequences.has(play.sequenceNumber), 'EVENT_CONFLICT', '事件順序識別重複或無效');
      sequences.add(play.sequenceNumber); events.set(play.id, play);
    }
    // ESPN inserts later editorial corrections into the chronological array.
    // sequenceNumber is an event identifier, not a reliable time sort key.
    // Preserve supplied order and validate every clock/score transition below.
    const ordered = [...events.values()];
    let previousElapsed = 0; let homeScore = 0; let awayScore = 0; let substitutions = 0;
    const ended = new Set(); let gameEnded = false;
    const fouls = new Map(); const trips = new Map(); const freeThrowAttributions = [];
    for (const play of ordered) {
      const period = play.period?.number;
      requireValue(Number.isSafeInteger(period) && period >= 1 && period <= game.home.periodScores.length, 'CLOCK_INVALID', '事件節次無效');
      const periodDuration = period <= 4 ? 720000 : 300000;
      const remaining = clockMilliseconds(play.clock?.displayValue, periodDuration);
      const elapsed = (period <= 4 ? (period - 1) * 720000 : 2880000 + (period - 5) * 300000) + periodDuration - remaining;
      requireValue(elapsed >= previousElapsed && elapsed <= durationMs, 'CLOCK_INVALID', '事件時間倒退或超出完賽時間');
      requireValue(Number.isSafeInteger(play.homeScore) && Number.isSafeInteger(play.awayScore) && play.homeScore >= homeScore && play.awayScore >= awayScore, 'SCORE_INVALID', '逐事件比分缺失或有待核對的倒退修正');
      const homeDelta = play.homeScore - homeScore; const awayDelta = play.awayScore - awayScore;
      requireValue(!(homeDelta && awayDelta), 'SCORE_INVALID', '單一事件同時變更兩隊比分，無法歸屬上場陣容');
      // Playing time follows substitutions. Free-throw +/- follows the lineup
      // at the originating foul, even when a substitution occurs between shots.
      // See pbpstats FreeThrow.event_for_efficiency_stats; never reorder events.
      const type = play.type?.text || '';
      if (/ Foul$/.test(type) || type === 'Defensive 3-Seconds Technical') {
        requireValue(homeDelta === 0 && awayDelta === 0, 'SCORE_INVALID', '犯規事件同時改分，無法確認罰球歸屬');
        fouls.set(/Technical/.test(type), { id: play.id, elapsed, period, teamId: `nba:espn:team:${play.team?.id}`, lineup: new Map([...on].map(([team, ids]) => [team, new Set(ids)])) });
      }
      let scoringLineup = on;
      if (type.startsWith('Free Throw')) {
        const technical = type === 'Free Throw - Technical';
        const match = type.match(/^Free Throw - ([1-3]) of ([1-3])$/);
        requireValue(technical || match, 'FT_ATTRIBUTION_INVALID', '罰球類型未確認，不推測歸屬');
        const foul = fouls.get(technical); const shootingTeam = `nba:espn:team:${play.team?.id}`;
        const shooter = play.participants?.[0]?.athlete?.id;
        requireValue(foul && foul.elapsed === elapsed && foul.period === period && on.has(shootingTeam) && on.has(foul.teamId) && foul.teamId !== shootingTeam && roster.get(shooter)?.teamId === shootingTeam, 'FT_ATTRIBUTION_INVALID', '罰球無法核對同節同時間的犯規、球隊或球員身分');
        const attempt = technical ? 1 : Number(match[1]); const total = technical ? 1 : Number(match[2]);
        const trip = trips.get(foul.id);
        requireValue(attempt <= total && (trip ? trip.next === attempt && trip.total === total && trip.shooter === shooter : attempt === 1), 'FT_ATTRIBUTION_INVALID', '罰球序列缺漏、重複或球員衝突');
        trips.set(foul.id, { next: attempt + 1, total, shooter });
        requireValue(homeDelta + awayDelta <= 1 && (shootingTeam === game.home.id ? awayDelta === 0 : homeDelta === 0), 'SCORE_INVALID', '罰球比分增量或得分球隊不一致');
        scoringLineup = foul.lineup;
        freeThrowAttributions.push({ eventId: play.id, foulEventId: foul.id, playerId: `nba:espn:player:${shooter}`, attempt, total, points: homeDelta + awayDelta });
      }
      for (const ids of on.values()) for (const id of ids) totals.get(id).onMs += elapsed - previousElapsed;
      for (const [teamId, ids] of scoringLineup) for (const id of ids) {
        const row = totals.get(id);
        row.pointsFor += teamId === game.home.id ? homeDelta : awayDelta;
        row.pointsAgainst += teamId === game.home.id ? awayDelta : homeDelta;
      }
      if (play.type?.text === 'Substitution') {
        requireValue(homeDelta === 0 && awayDelta === 0 && play.participants?.length === 2, 'LINEUP_INVALID', '換人事件同時改分或缺少上下場識別');
        const [enter, leave] = play.participants.map(row => row.athlete?.id);
        const incoming = roster.get(enter); const outgoing = roster.get(leave); const teamId = `nba:espn:team:${play.team?.id}`;
        const set = on.get(teamId); const names = String(play.text || '').split(' enters the game for ');
        requireValue(incoming && outgoing && incoming.teamId === teamId && outgoing.teamId === teamId && !incoming.didNotPlay && set?.has(leave) && !set.has(enter), 'LINEUP_INVALID', '換人鏈不連續、跨隊或球員身分未確認');
        requireValue(names.length === 2 && nameKey(names[0]) === nameKey(incoming.name) && nameKey(names[1]) === nameKey(outgoing.name), 'IDENTITY_INVALID', '換人參與者順序與來源文字無法交叉核對');
        set.delete(leave); set.add(enter); substitutions++;
      }
      if (play.type?.text === 'End Period') {
        requireValue(remaining === 0 && !ended.has(period), 'CLOCK_INVALID', '分節結束事件無效或重複');
        const sum = side => game[side].periodScores.slice(0, period).reduce((total, row) => total + row.score, 0);
        requireValue(play.homeScore === sum('home') && play.awayScore === sum('away'), 'SCORE_INVALID', '逐事件分節比分與 box score 不一致');
        ended.add(period);
      }
      if (play.type?.text === 'End Game') {
        requireValue(elapsed === durationMs && remaining === 0, 'CLOCK_INVALID', '完賽事件時間無效'); gameEnded = true;
      }
      homeScore = play.homeScore; awayScore = play.awayScore; previousElapsed = elapsed;
    }
    requireValue(gameEnded && ended.size === game.home.periodScores.length && previousElapsed === durationMs && homeScore === game.home.score && awayScore === game.away.score, 'SCORE_INVALID', '逐事件資料未完整覆蓋每節與正式完賽比分');
    requireValue([...trips.values()].every(trip => trip.next === trip.total + 1), 'FT_ATTRIBUTION_INVALID', '罰球序列尚未完整結束');
    const warnings = []; const result = [];
    for (const [id, player] of roster) {
      const row = totals.get(id); const isHome = player.teamId === game.home.id;
      const ownScore = isHome ? homeScore : awayScore; const opponentScore = isHome ? awayScore : homeScore;
      requireValue(row.onMs >= 0 && row.onMs <= durationMs && row.pointsFor <= ownScore && row.pointsAgainst <= opponentScore, 'SCORE_INVALID', 'On/Off 時間或得失分超過全場總數');
      if (player.didNotPlay) { requireValue(row.onMs === 0 && row.pointsFor === 0 && row.pointsAgainst === 0, 'LINEUP_INVALID', '未上場球員出現在場上事件'); continue; }
      const plusMinusRows = (player.statistics || []).filter(stat => stat.name === 'plusMinus');
      requireValue(plusMinusRows.length <= 1, 'SCORE_INVALID', '球員正負值欄位重複');
      const raw = plusMinusRows[0]?.displayValue;
      const plusMinusVerified = typeof raw === 'string' && /^[+-]?\d+$/.test(raw.trim());
      if (plusMinusVerified) requireValue(Number(raw) === row.pointsFor - row.pointsAgainst, 'SCORE_INVALID', `${player.name} 逐事件場上淨分 ${row.pointsFor - row.pointsAgainst} 與 box score 正負值 ${raw} 不一致`);
      else warnings.push(`${player.name} 缺少可獨立核對的 box score 正負值。`);
      const offMs = durationMs - row.onMs; const offFor = ownScore - row.pointsFor; const offAgainst = opponentScore - row.pointsAgainst;
      const onNetPer48 = row.onMs ? (row.pointsFor - row.pointsAgainst) * 2880000 / row.onMs : null;
      const offNetPer48 = offMs ? (offFor - offAgainst) * 2880000 / offMs : null;
      result.push({ playerId: player.id, teamId: player.teamId, onSeconds: row.onMs / 1000, offSeconds: offMs / 1000, onPointsFor: row.pointsFor, onPointsAgainst: row.pointsAgainst, offPointsFor: offFor, offPointsAgainst: offAgainst, plusMinus: row.pointsFor - row.pointsAgainst, plusMinusVerified, onNetPer48, offNetPer48, differencePer48: onNetPer48 == null || offNetPer48 == null ? null : onNetPer48 - offNetPer48 });
    }
    for (const teamId of on.keys()) {
      const ids = [...roster].filter(([, player]) => player.teamId === teamId).map(([id]) => id);
      requireValue(ids.reduce((sum, id) => sum + totals.get(id).onMs, 0) === durationMs * 5, 'CLOCK_INVALID', '球隊球員時間合計不等於五人完整比賽時間');
      requireValue(ids.reduce((sum, id) => sum + totals.get(id).pointsFor, 0) === (teamId === game.home.id ? homeScore : awayScore) * 5, 'SCORE_INVALID', '球員場上得分合計與球隊比分不一致');
    }
    return { ...base, status: 'ready', durationSeconds: durationMs / 1000, events: ordered.length, substitutions, freeThrowAttributions, scoringAttribution: 'free_throws_to_originating_foul_lineup', players: result, qa: { status: warnings.length ? 'WARNING' : 'PASS', issues: warnings }, limitations: ['賽後描述性 On/Off；不是球員因果貢獻、賽前能力預測或 NBA 官方指標。', '每 48 分鐘淨分不等於每 100 回合 Net Rating；未估造球員在場回合數。', '分鐘由逐事件時鐘重建；罰球得失分歸屬造成罰球的犯規當下陣容，不改寫換人時間。'] };
  } catch (error) {
    return { ...base, status: 'blocked', qa: { status: 'BLOCK', issues: [error.message], code: error.code || 'ON_OFF_INVALID' } };
  }
}
