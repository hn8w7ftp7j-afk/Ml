// RESEARCH ONLY: not imported by application; not validated for production.
import { detailSide } from '../lib/asian-production-features-v1.js';
const clean = value => String(value ?? '').trim();
const number = value => value == null || String(value).trim() === '' || !Number.isFinite(Number(value)) ? null : Number(value);
const mean = values => values.length ? values.reduce((a,b)=>a+b,0)/values.length : null;
// Calendar-date gaps describe CPBL scheduling; elapsed hours are retained only
// as evidence. The cadence distribution is learned exclusively from prior
// repeat starts, never a fixed five/seven-day peak or the target outcome.
export function projectCpblRotationStarter(details, teamId, firstPitch, { asOf = firstPitch } = {}) {
  const firstPitchAt = Date.parse(firstPitch || '');
  const cutoff = Math.min(firstPitchAt, Date.parse(asOf || ''));
  if (!Number.isFinite(cutoff)) return null;
  const localDay = at => Math.floor((at + 8 * 3_600_000) / 86_400_000);
  const grouped = new Map();
  const seen = new Set();
  for (const item of Array.isArray(details) ? details : []) {
    const gameAt = Date.parse(item?.game?.gameDate || '');
    if (!Number.isFinite(gameAt) || gameAt >= cutoff) continue;
    for (const row of detailSide(item?.detail, item?.game, teamId)?.pitchers || []) {
      const id = clean(row?.officialPlayerId || row?.id);
      // A scorebook starter with no participation can be a pre-pitch scratch.
      if (row?.starter !== true || !id || !clean(row.name)
        || !(number(row.inningsPitched) > 0 || number(row.battersFaced) > 0 || number(row.pitchCount) > 0)) continue;
      const key = `${item.game.providerGameId || item.game.gamePk || item.game.gameDate}|${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!grouped.has(id)) grouped.set(id, []);
      grouped.get(id).push({ ...row, id, gameAt, gameDate: item.game.gameDate,
        gamePk: item.game.gamePk || null, providerGameId: item.game.providerGameId || null });
    }
  }
  const intervalsByPitcher = new Map();
  for (const [id, starts] of grouped) {
    starts.sort((a, b) => b.gameAt - a.gameAt);
    const intervals = starts.slice(0, -1).map((row, index) => ({
      days: localDay(row.gameAt) - localDay(starts[index + 1].gameAt),
      fromGamePk: starts[index + 1].gamePk, toGamePk: row.gamePk,
      fromDate: starts[index + 1].gameDate, toDate: row.gameDate,
    })).filter(row => row.days >= 4 && row.days <= 21).slice(0, 5);
    intervalsByPitcher.set(id, intervals);
  }
  const teamIntervals = [...intervalsByPitcher.values()].flat();
  if (!teamIntervals.length) return null;
  // One-day Laplace smoothing and three prior intervals are declared heuristic
  // regularization, not accuracy-calibrated start probabilities.
  const fit = (gap, intervals) => mean(intervals.map(row => Math.exp(-Math.abs(gap - row.days))));
  const candidates = [...grouped.entries()].map(([id, starts]) => {
    const latest = starts[0];
    const gap = localDay(firstPitchAt) - localDay(latest.gameAt);
    if (gap < 4 || gap > 21) return null;
    const intervals = intervalsByPitcher.get(id);
    const ownWeight = intervals.length / (intervals.length + 3);
    const score = ownWeight * (fit(gap, intervals) || 0) + (1 - ownWeight) * fit(gap, teamIntervals);
    const sampled = starts.slice(0, 5);
    const sumObserved = key => sampled.every(row => number(row[key]) != null)
      ? sampled.reduce((sum, row) => sum + number(row[key]), 0) : null;
    const inningsPitched = sumObserved('inningsPitched');
    const earnedRuns = sumObserved('earnedRuns'), hits = sumObserved('hits'), walks = sumObserved('walks');
    return {
      id, officialPlayerId: id, teamId: Number(teamId), name: clean(latest.name),
      lastStart: latest.gameDate, lastStartAt: latest.gameDate,
      restDays: Number(((firstPitchAt - latest.gameAt) / 86_400_000).toFixed(2)),
      calendarDaysSinceLastStart: gap, fullRestCalendarDays: gap - 1,
      cadenceIntervals: intervals, teamCadenceIntervalCount: teamIntervals.length,
      cadenceOwnWeight: ownWeight, cadenceMethod: 'PRIOR_REPEAT_START_INTERVAL_KERNEL',
      probabilityKind: 'HEURISTIC_CANDIDATE_WEIGHT', confidenceCalibrated: false,
      probabilityScope: 'CONDITIONAL_ON_OBSERVED_CANDIDATE_SET', activeRosterVerified: false,
      priorStarts: sampled.length, inningsPitched, battersFaced: sumObserved('battersFaced'),
      era: inningsPitched > 0 && earnedRuns != null ? earnedRuns * 9 / inningsPitched : null,
      whip: inningsPitched > 0 && hits != null && walks != null ? (hits + walks) / inningsPitched : null,
      expectedInnings: inningsPitched > 0 ? inningsPitched / sampled.length : null,
      performanceAvailable: inningsPitched > 0 && earnedRuns != null && sumObserved('battersFaced') > 0,
      evidenceGamePks: sampled.map(row => row.gamePk).filter(Boolean),
      evidenceProviderGameIds: sampled.map(row => row.providerGameId).filter(Boolean),
      rotationScore: score,
    };
  }).filter(row => row && row.rotationScore > 0)
    .sort((a, b) => b.rotationScore - a.rotationScore || a.id.localeCompare(b.id));
  const total = candidates.reduce((sum, row) => sum + row.rotationScore, 0);
  if (!(total > 0)) return null;
  const weighted = candidates.map(({ rotationScore, ...row }) => ({
    ...row, weight: rotationScore / total, probability: rotationScore / total,
  }));
  const primary = weighted[0];
  return {
    id: primary.id, name: primary.name,
    source: 'CPBL_OFFICIAL_ROTATION_PROJECTED_STARTER', projected: true,
    confirmed: false, identityConfirmed: false, playerIdentityVerified: true,
    assignmentStatus: 'PROJECTED_ROTATION_SCENARIO',
    projectionMethod: 'OFFICIAL_PRIOR_REPEAT_START_CADENCE_ASOF_V1',
    projectionConfidence: primary.weight,
    projectionConfidenceKind: 'HEURISTIC_CANDIDATE_WEIGHT', confidenceCalibrated: false,
    probabilityScope: 'CONDITIONAL_ON_OBSERVED_CANDIDATE_SET', candidateSetComplete: false,
    rotationEvidence: { asOf: new Date(cutoff).toISOString(), targetFirstPitch: firstPitch,
      teamCadenceIntervalCount: teamIntervals.length, teamCadenceIntervals: teamIntervals,
      observedPitcherCount: grouped.size, observedStartCount: seen.size,
      intervalRangeDays: [4, 21], kernelBandwidthDays: 1, shrinkagePriorIntervals: 3,
      cadenceCalibrated: false, activeRosterVerified: false },
    candidates: weighted,
  };
}
