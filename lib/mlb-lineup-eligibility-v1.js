import { injuryMembership } from './mlb-roster-status-v1.js';

const VERSION = 'MLB-PROJECTED-LINEUP-ROSTER-ELIGIBILITY-v1';
const playerId = row => Number(row?.person?.id || 0);
const instant = value => typeof value === 'string' && /(Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;

function rosterEvidence(response, { teamId, officialDate, firstPitch, cutoffAt, rosterType }) {
  let reason = null;
  let url;
  try { url = new URL(response?.sourceRecord); } catch { reason = 'ROSTER_SOURCE_MISSING'; }
  if (!reason && (url.origin !== 'https://statsapi.mlb.com' || url.username || url.password
    || url.pathname !== `/api/v1/teams/${teamId}/roster`
    || url.searchParams.get('date') !== officialDate
    || url.searchParams.get('rosterType') !== rosterType)) reason = 'ROSTER_SOURCE_SCOPE_MISMATCH';
  if (!reason && (response?.ok !== true || response.statusCode < 200 || response.statusCode >= 300
    || !Number.isFinite(response.statusCode))) reason = 'ROSTER_FETCH_UNSUCCESSFUL';
  if (!reason && !/^[a-f\d]{64}$/i.test(String(response.rawPayloadHash || ''))) reason = 'ROSTER_PAYLOAD_RECEIPT_MISSING';
  const observedAt = instant(response?.fetchedAt);
  const cutoff = instant(cutoffAt);
  const starts = instant(firstPitch);
  if (!reason && (!Number.isFinite(observedAt) || !Number.isFinite(cutoff) || !Number.isFinite(starts)
    || observedAt > cutoff || cutoff >= starts)) reason = 'ROSTER_NOT_OBSERVED_BEFORE_FORECAST_AND_FIRST_PITCH';
  const rows = response?.data?.roster;
  if (!reason && (!Array.isArray(rows) || rows.some(row => !Number.isSafeInteger(playerId(row)) || playerId(row) <= 0)
    || new Set(rows.map(playerId)).size !== rows.length)) reason = 'ROSTER_PLAYER_IDENTITIES_INCOMPLETE';
  const responseTeam = response?.data?.team?.id ?? response?.data?.teamId;
  if (!reason && ((responseTeam != null && Number(responseTeam) !== Number(teamId))
    || rows.some(row => row.team?.id != null && Number(row.team.id) !== Number(teamId)))) reason = 'ROSTER_PAYLOAD_TEAM_MISMATCH';
  return {
    verified: !reason,
    reason,
    rows: reason ? [] : rows,
    receipt: response?.sourceRecord ? {
      source: rosterType === 'active' ? 'MLB_GAME_DAY_ACTIVE_ROSTER' : 'MLB_GAME_DAY_EXPLICIT_INJURED_MEMBERSHIP',
      sourceRecord: response.sourceRecord,
      rawPayloadHash: response.rawPayloadHash || null,
      fetchedAt: response.fetchedAt || null,
      fetchStatus: response.ok === true ? 'FETCHED' : 'FAILED',
      accepted: !reason,
      rejectionReason: reason,
      teamId, asOf: officialDate,
      purpose: 'PROJECTED_LINEUP_CANDIDATE_ELIGIBILITY',
      temporalContract: 'OFFICIAL_GAME_DAY_ROSTER_OBSERVED_BEFORE_FORECAST_AND_FIRST_PITCH',
    } : null,
  };
}

export function evaluateMlbLineupEligibilityV1({
  candidateIds = [], teamId, officialDate, firstPitch, cutoffAt,
  activeRosterResponse, injuredRosterResponse,
} = {}) {
  const scope = { teamId, officialDate, firstPitch, cutoffAt };
  const active = rosterEvidence(activeRosterResponse, { ...scope, rosterType: 'active' });
  const injured = rosterEvidence(injuredRosterResponse, { ...scope, rosterType: '40Man' });
  // Nine valid names are the minimum possible full opening lineup. A shorter
  // roster response cannot be used as evidence that all omitted hitters departed.
  const activeComplete = active.verified && active.rows.length >= 9;
  const activeIds = new Set(active.rows.map(playerId));
  const injuredIds = new Set(injured.rows.filter(row => injuryMembership(row) === true).map(playerId));
  const membershipConflicts = [...injuredIds].filter(id => activeIds.has(id)).sort((a, b) => a - b);
  const excluded = [];
  const eligiblePlayerIds = [];
  for (const id of [...new Set(candidateIds.map(Number))].sort((a, b) => a - b)) {
    const exclusionReason = activeComplete && !activeIds.has(id)
      ? 'ABSENT_FROM_VERIFIED_GAME_DAY_ACTIVE_ROSTER'
      : injuredIds.has(id) && !activeIds.has(id) ? 'EXPLICIT_GAME_DAY_INJURED_LIST_MEMBERSHIP' : null;
    if (exclusionReason) excluded.push({ id, reason: exclusionReason });
    else eligiblePlayerIds.push(id);
  }
  return {
    version: VERSION,
    teamId, officialDate, firstPitch, cutoffAt,
    applied: activeComplete || injuredIds.size > 0,
    activeRosterStatus: activeComplete ? 'VERIFIED_COMPLETE'
      : active.verified ? 'VERIFIED_PARTIAL_NO_ABSENCE_INFERENCE' : 'UNVERIFIED',
    activeRosterReason: active.reason,
    injuredRosterStatus: injured.verified ? 'VERIFIED_EXPLICIT_STATUSES_ONLY' : 'UNVERIFIED',
    injuredRosterReason: injured.reason,
    activeRosterCount: active.rows.length,
    eligiblePlayerIds,
    excluded,
    // Acquisition order alone is not a provider transaction timestamp. Conflicting
    // active/IL observations stay unresolved; the projected candidate is retained.
    membershipConflicts,
    sourceReceipts: [active.receipt, injured.receipt].filter(Boolean),
  };
}
