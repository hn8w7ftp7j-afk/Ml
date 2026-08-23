export const MLB_PARK_WIND_ORIENTATION_V2_VERSION = 'MLB-PARK-WIND-ORIENTATION-2026-08-v2.0.0';

const PARKS = Object.freeze({
  1: [58, 'OPEN'], 2: [45, 'RETRACTABLE'], 3: [29, 'OPEN'], 4: [31, 'OPEN'], 5: [62, 'OPEN'],
  7: [50, 'OPEN'], 10: [65, 'RETRACTABLE'], 12: [44, 'RETRACTABLE'], 14: [35, 'RETRACTABLE'], 15: [22, 'OPEN'],
  17: [25, 'OPEN'], 19: [47, 'OPEN'], 22: [43, 'OPEN'], 31: [50, 'OPEN'], 32: [28, 'RETRACTABLE'],
  2392: [20, 'OPEN'], 2394: [47, 'OPEN'], 2395: [31, 'OPEN'], 2397: [20, 'OPEN'], 2399: [45, 'OPEN'],
  2602: [28, 'RETRACTABLE'], 2603: [63, 'RETRACTABLE'], 2680: [42, 'OPEN'], 2889: [50, 'OPEN'], 3289: [26, 'OPEN'],
  3309: [54, 'OPEN'], 3312: [49, 'OPEN'], 3313: [42, 'OPEN'], 3314: [25, 'OPEN'], 3315: [38, 'OPEN'],
});

const finite = (value, fallback = null) => Number.isFinite(Number(value)) ? Number(value) : fallback;

export function buildParkWindOrientationV2({ venueId, weather = {}, gameStart = '', observedAt = '' } = {}) {
  const park = PARKS[Number(venueId)] || null;
  const windFromDegrees = finite(weather?.windDirection, null);
  const windSpeedMph = finite(weather?.windSpeed, null);
  const temperatureF = finite(weather?.temperature, null);
  const roofStatus = String(weather?.roofStatus || '').toUpperCase();
  const roofType = park?.[1] || 'UNKNOWN';
  const roofOpenProbability = roofStatus === 'CLOSED' ? 0 : roofStatus === 'OPEN' ? 1 : roofType === 'RETRACTABLE' ? 0.5 : 1;
  const complete = park && windFromDegrees != null && windSpeedMph != null && temperatureF != null;
  return {
    status: complete ? 'PROJECTED' : 'MISSING',
    validationStatus: 'PENDING',
    observedAt,
    gameStart,
    venueId: Number(venueId) || null,
    fieldBearingDegrees: park?.[0] ?? null,
    roofType,
    roofOpenProbability,
    windFromDegrees,
    windSpeedMph,
    temperatureF,
    validatedRunsPerMphAlignment: null,
    // Must be learned per park from PIT historical weather while controlling
    // for the existing park factor. Raw aligned wind is never applied twice.
    parkBaselineAlignedWindMph: null,
    rawValue: { windFromDegrees, windSpeedMph, temperatureF, roofStatus, roofType },
    regressedValue: { roofOpenProbability },
    appliedValue: { runDelta: 0, reason: 'PARK_SPECIFIC_CENTERED_OOS_COEFFICIENT_PENDING' },
    overlapRule: 'DIRECTIONAL_WIND_MUST_BE_CENTERED_AGAINST_PARK_CLIMATOLOGY',
    source: 'OPEN_METEO_PLUS_VERIFIED_PARK_HOME_PLATE_TO_CENTER_BEARING',
    version: MLB_PARK_WIND_ORIENTATION_V2_VERSION,
  };
}
