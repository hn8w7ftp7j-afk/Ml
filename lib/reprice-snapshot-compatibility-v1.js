// Version compatibility is independent of HMAC validity. An authentic historical
// snapshot stays authentic, but cannot be rebuilt by a different active model.
export function assessRepriceSnapshotCompatibilityV1(snapshot, expected = {}) {
  const version = value => typeof value === 'string' && value.trim() ? value : null;
  const expectedVersions = {
    modelVersion: version(expected.modelVersion),
    dataVersion: version(expected.dataVersion),
  };
  const snapshotVersions = {
    modelVersion: version(snapshot?.versions?.modelVersion),
    dataVersion: version(snapshot?.versions?.dataVersion),
    contextModelVersion: version(snapshot?.frozenContext?.modelVersion),
  };
  const reasons = [];
  if (!expectedVersions.modelVersion || snapshotVersions.modelVersion !== expectedVersions.modelVersion) reasons.push('MODEL_VERSION_CHANGED');
  if (!expectedVersions.dataVersion || snapshotVersions.dataVersion !== expectedVersions.dataVersion) reasons.push('DATA_VERSION_CHANGED');
  if (snapshotVersions.contextModelVersion && snapshotVersions.contextModelVersion !== expectedVersions.modelVersion) reasons.push('CONTEXT_MODEL_VERSION_MISMATCH');
  return { compatible: reasons.length === 0, reasons, expectedVersions, snapshotVersions };
}
