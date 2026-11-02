// Private runtime diagnostics contain machine codes only, never provider bodies,
// database URLs, SQL, stacks or arbitrary error messages.
export function recordSoccerCalibrationFailure(operation, error, log = console.error) {
  const valid = value => typeof value === 'string' && /^(?:CALIBRATION|SOCCER)_[A-Z0-9_]{1,110}$/.test(value);
  const code = valid(error?.message) ? error.message : valid(error?.code) ? error.code : 'CALIBRATION_OPERATION_FAILED';
  log('soccer.calibration.failed', { operation: operation === 'read' ? 'read' : 'evaluate', code });
  return code;
}
