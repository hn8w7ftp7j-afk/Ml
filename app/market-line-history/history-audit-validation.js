export const auditInteger = value => Number.isSafeInteger(value) && value >= 0;
export const auditDay = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
export const auditInstant = value => typeof value === 'string' && auditDay(value.slice(0, 10))
  && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?Z$/.test(value) && Number.isFinite(Date.parse(value));
export const auditHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const auditCode = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,120}$/.test(value);
export const auditText = value => typeof value === 'string';
export const auditNumber = value => auditInteger(value) ? value.toLocaleString('zh-TW') : '未確認';
export const auditFlags = {
  archiveOnly: true, currentBoardUpdated: false, historicalAvailabilityVerified: false, executable: false,
  coverageComplete: false, formalEligible: false, calibrationEligible: false,
  closingCoverage: 'NOT_VERIFIED', indexCoverage: 'NOT_VERIFIED',
};
export function auditReadonly(value, required = auditFlags, requireAll = true) {
  return value && typeof value === 'object' && Object.entries(required).every(([key, expected]) =>
    !Object.hasOwn(value, key) ? !requireAll : value[key] === expected)
    && (!Object.hasOwn(value, 'identityVerified') || value.identityVerified === false);
}
