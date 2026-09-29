// Availability receipts are not roster dates, statistical periods or forecast
// valid times. Read only frozen evidence; never refresh/backdate it here.
export function receiptInstant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day
    || Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function frozenNeutralBranch(context, row, name) {
  if (String(context.leagueId || context.game?.leagueId || 'MLB').toUpperCase() !== 'MLB') return false;
  // Only the existing, versioned no-weather / inactive-wind branches qualify.
  // A MISSING label by itself must never exempt an observed model input.
  if (name === 'weather') return row.normalizationVersion === 'MLB-STANDALONE-POINT-IN-TIME-CONTEXT-2026-09-v11.0.2'
    && row.status === 'MISSING' && row.value === null
    && context.weather?.available === false && context.weather?.meanRunFactor === 1;
  if (name === 'parkWindOrientation') return row.normalizationVersion === 'MLB-PIT-LINEUP-PLATOON-RELIEF-CONTEXT-2026-09-v11.0.9'
    && row.value?.version === 'MLB-PARK-WIND-ORIENTATION-2026-08-v2.0.0'
    && row.value?.validationStatus === 'PENDING'
    && row.value?.appliedValue?.runDelta === 0
    && row.value?.appliedValue?.reason === 'PARK_SPECIFIC_CENTERED_OOS_COEFFICIENT_PENDING';
  return false;
}

export function inspectPitFeatureTimes(context = {}, cutoff = null) {
  const errors = [];
  const times = Object.create(null);
  const neutralFeatures = [];
  const rows = Array.isArray(context.featureProvenance) ? context.featureProvenance : [];
  const seen = new Set();
  const asian = ['NPB', 'KBO', 'CPBL'].includes(String(context.leagueId || context.game?.leagueId || '').toUpperCase());
  const limit = cutoff == null ? null : receiptInstant(cutoff);
  if (cutoff != null && !limit) errors.push('FEATURE_CUTOFF_INVALID');
  if (!rows.length) errors.push('FEATURE_PROVENANCE_MISSING');
  for (const row of rows) {
    const name = typeof (row?.featureName || row?.feature) === 'string' ? (row.featureName || row.feature).trim() : '';
    if (!name) { errors.push('FEATURE_NAME_MISSING'); continue; }
    if (seen.has(name)) { errors.push(`FEATURE_DUPLICATE:${name}`); continue; }
    seen.add(name);
    if (frozenNeutralBranch(context, row, name)) {
      // This is when the frozen fallback state was recorded, NOT a fabricated
      // provider observation. Keep the distinction in the ledger evidence key.
      const stateTime = receiptInstant(context.fetchedAt);
      times[`neutralState:${name}`] = stateTime;
      neutralFeatures.push(name);
      if (!stateTime) errors.push(`NEUTRAL_STATE_TIME_MISSING:${name}`);
      else if (limit && stateTime > limit) errors.push(`FEATURE_FROM_FUTURE:${name}`);
      continue;
    }
    const values = [];
    // Explicit receipt-bearing fields may not be replaced by asOf or context time.
    if (Object.hasOwn(row, 'fetchedAt')) values.push(row.fetchedAt);
    if (asian && !receiptInstant(row.fetchedAt)) errors.push(`FEATURE_RECEIPT_REQUIRED:${name}`);
    if ((!asian || row.fetchedAt != null) && row.observedAt != null) values.push(row.observedAt);
    for (const field of ['dependencyReceipts', 'sourceReceipts']) {
      if (row[field] == null) continue;
      if (!Array.isArray(row[field])) { errors.push(`FEATURE_RECEIPTS_INVALID:${name}`); continue; }
      for (const receipt of row[field]) values.push(receipt?.fetchedAt);
    }
    // Asian provenance binds actual acquisition events. Do not inspect unrelated
    // later audit fetches, and do not reinterpret PENDING as failed model data.
    if (row.sourceEventIds != null && !Array.isArray(row.sourceEventIds)) errors.push(`FEATURE_EVENT_IDS_INVALID:${name}`);
    if (Array.isArray(row.sourceEventIds) && row.sourceEventIds.length) {
      const events = Array.isArray(context.sourceEvidence?.events) ? context.sourceEvidence.events : [];
      for (const id of new Set(row.sourceEventIds)) {
        const matches = events.filter(event => event.id === id);
        if (!matches.length) { errors.push(`FEATURE_SOURCE_EVENT_MISSING:${name}`); continue; }
        for (const event of matches) {
          values.push(event.fetchedAt);
          if (event.publishedAt != null) values.push(event.publishedAt);
          if (event.dataCutoff != null) values.push(event.dataCutoff);
        }
      }
    }
    const instants = values.map(receiptInstant);
    const invalid = !instants.length || instants.some(value => value === null);
    // Keep invalid entries visible so map-only callers cannot silently drop them.
    times[name] = invalid ? null : instants.sort().at(-1);
    if (invalid) errors.push(`FEATURE_TIMESTAMP_INVALID:${name}`);
    if (limit && instants.some(value => value && value > limit)) errors.push(`FEATURE_FROM_FUTURE:${name}`);
  }
  return { ok: errors.length === 0, errors: [...new Set(errors)], featureObservedAts: { ...times }, neutralFeatures };
}
