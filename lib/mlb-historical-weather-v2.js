export const MLB_HISTORICAL_WEATHER_V2_VERSION = 'MLB-HISTORICAL-WEATHER-RECONSTRUCTION-2026-08-v2.1.0';

const finite = value => Number.isFinite(Number(value)) ? Number(value) : null;

export function buildHistoricalWindFeatureV2(weather = {}) {
  const temperatureF = finite(weather?.temp);
  const windText = String(weather?.wind || '').trim();
  const speedMatch = windText.match(/([\d.]+)\s*mph/i);
  const windSpeedMph = finite(speedMatch?.[1]) ?? (/calm|none/i.test(windText) ? 0 : null);
  const direction = windText.split(',').slice(1).join(',').trim().toLowerCase();
  let alignment = null;
  if (/out to (cf|center)/.test(direction)) alignment = 1;
  else if (/out to (lf|left|rf|right)/.test(direction)) alignment = 0.72;
  else if (/in from (cf|center)/.test(direction)) alignment = -1;
  else if (/in from (lf|left|rf|right)/.test(direction)) alignment = -0.72;
  else if (/left to right|right to left|l to r|r to l|varies|variable|calm|none/.test(direction) || /calm|none/i.test(windText)) alignment = 0;
  const dome = /dome|indoor/i.test(String(weather?.condition || ''));
  if (dome) alignment = 0;
  const available = temperatureF != null && windSpeedMph != null && alignment != null;
  const composite = available ? alignment * windSpeedMph / 10 + (dome ? 0 : (temperatureF - 70) / 20) : 0;
  return {
    raw: composite,
    regressed: composite,
    sample: available ? 1 : 0,
    available,
    windSpeedMph,
    relativeFieldAlignment: alignment,
    temperatureF,
    condition: String(weather?.condition || ''),
    orientationMethod: 'MLB_GAMEDAY_FIELD_RELATIVE_DIRECTION',
    reconstructionSource: 'MLB_STATSAPI_SCHEDULE_WEATHER_ARCHIVE',
    neutralReason: available ? '' : 'OFFICIAL_GAMEDAY_WEATHER_INCOMPLETE',
  };
}
