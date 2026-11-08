// Private runtime diagnostics contain machine codes only, never provider bodies,
// database URLs, SQL, stacks or arbitrary error messages.
export function recordSoccerCalibrationFailure(operation, error, log = console.error) {
  const valid = value => typeof value === 'string' && /^(?:CALIBRATION|SOCCER)_[A-Z0-9_]{1,110}$/.test(value);
  const code = valid(error?.message) ? error.message : valid(error?.code) ? error.code : 'CALIBRATION_OPERATION_FAILED';
  // Only fixed normalizer field names may accompany a mismatch. Never log
  // values, arbitrary object keys, URLs, provider bodies, SQL or identifiers.
  const safePath = /^(?:game|source|sourceEvidence|rawSource|referee|teams|teams\.(?:home|away)\.(?:id|sourceId|name|injuries|suspensions|minutes|lineup\.(?:status|reason|formation|starters|bench|source|rawSource|sourcePublishedAt|sourceEvidence|independentlyConfirmed)))$/;
  const mismatchFields = code === 'CALIBRATION_SHADOW_SOURCE_RECOMPUTE_FAILED' && Array.isArray(error?.mismatchFields)
    ? [...new Set(error.mismatchFields.filter(value => typeof value === 'string' && safePath.test(value)))].slice(0, 40) : [];
  log('soccer.calibration.failed', { operation: operation === 'read' ? 'read' : 'evaluate', code,
    ...(mismatchFields.length ? { mismatchFields } : {}) });
  return code;
}
