// Require explicit provider status evidence; absence from a lineup is not an injury.
export function injuryMembership(row) {
  const description = String(row?.status?.description || '').trim();
  const code = String(row?.status?.code || row?.rosterStatus || '').trim().toUpperCase();
  if (/\b(?:injured|disabled) list\b/i.test(description)) return true;
  if (/^(?:D7|D10|D15|D60)$/.test(code)) return true;
  if (description || code) return false;
  return null;
}
export function verifiedInjuredRoster(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.some(row => injuryMembership(row) === null))
    return { available: false, roster: [], reason: 'ROSTER_STATUS_UNVERIFIED' };
  return { available: true, roster: rows.filter(row => injuryMembership(row) === true), reason: null };
}
