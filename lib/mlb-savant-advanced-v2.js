import { MLB_ADVANCED_FEATURES_V2_VERSION } from './mlb-advanced-features-v2.js';

export const MLB_SAVANT_ADVANCED_V2_VERSION = 'MLB-SAVANT-ADVANCED-SNAPSHOT-2026-08-v2.0.0';

const SAVANT = 'https://baseballsavant.mlb.com/leaderboard';
const cache = globalThis.__MLB_SAVANT_ADVANCED_V2_CACHE__ || new Map();
globalThis.__MLB_SAVANT_ADVANCED_V2_CACHE__ = cache;

const finite = (value, fallback = null) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

export function parseCsvV2(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const input = String(text || '').replace(/^\uFEFF/, '');
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quoted) {
      if (character === '"' && input[index + 1] === '"') { field += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"') quoted = true;
    else if (character === ',') { row.push(field); field = ''; }
    else if (character === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += character;
  }
  if (field || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  const headers = rows.shift() || [];
  return rows.filter(values => values.some(Boolean)).map(values => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])));
}

async function fetchCsv(url, { fetchImpl = fetch, timeoutMs = 15000, ttlMs = 30 * 60 * 1000 } = {}) {
  const key = String(url);
  const hit = cache.get(key);
  if (hit?.expiresAt > Date.now()) return hit.value;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const observedAt = new Date().toISOString();
  try {
    const response = await fetchImpl(key, { cache: 'no-store', signal: controller.signal, headers: { 'User-Agent': 'Baseball-Positive-EV-v10.8' } });
    const text = await response.text();
    const value = response.ok
      ? { ok: true, rows: parseCsvV2(text), observedAt, sourceRecord: key, error: '' }
      : { ok: false, rows: [], observedAt, sourceRecord: key, error: `HTTP ${response.status}` };
    cache.set(key, { value, expiresAt: Date.now() + (value.ok ? ttlMs : 60000) });
    return value;
  } catch (error) {
    return { ok: false, rows: [], observedAt, sourceRecord: key, error: error?.name === 'AbortError' ? '資料取得逾時' : String(error?.message || error) };
  } finally {
    clearTimeout(timer);
  }
}

function byPlayer(rows, idField) {
  const output = new Map();
  for (const row of rows || []) {
    const id = Number(row?.[idField] || 0);
    if (id) output.set(id, row);
  }
  return output;
}

function pitchByPlayer(rows) {
  const output = new Map();
  for (const row of rows || []) {
    const id = Number(row?.player_id || 0);
    const pitchType = String(row?.pitch_type || '');
    if (!id || !pitchType) continue;
    if (!output.has(id)) output.set(id, new Map());
    output.get(id).set(pitchType, row);
  }
  return output;
}

function buildFielding(lineup, fielders, framing, observedAt) {
  const players = (lineup?.players || []).map(player => {
    const row = fielders.get(Number(player.id));
    if (!row) return null;
    const outs = Math.max(0, finite(row.outs_total, 0));
    const reliability = clamp(outs / (outs + 810), 0, 0.90);
    const components = {
      range: finite(row.range_runs ?? row.oaa_runs, 0),
      throwing: finite(row.throwing_runs ?? row.arm_runs, 0),
      blocking: finite(row.blocking_runs, 0),
      framing: finite(row.framing_runs, 0),
      catcherThrowing: finite(row.catcher_throwing_runs, 0),
      doublePlay: finite(row.double_play_runs, 0),
      receiving: finite(row.receiving_runs, 0),
    };
    const rawFrv = finite(row.total_runs, Object.values(components).reduce((sum, value) => sum + value, 0));
    return {
      id: Number(player.id),
      position: String(player.position || ''),
      lineupShare: 1,
      rawFrv,
      regressedFrv: rawFrv * reliability,
      framingRuns: components.framing,
      regressedFramingRuns: components.framing * reliability,
      components,
      outs,
      reliability,
    };
  }).filter(Boolean);
  if (players.length < 7) return { status: 'MISSING', observedAt, source: 'BASEBALL_SAVANT_FRV_CSV' };
  const totalOuts = players.reduce((sum, player) => sum + player.outs, 0);
  const catcherId = Number((lineup?.players || []).find(player => player.position === 'C')?.id || 0);
  const framingRow = framing.get(catcherId);
  const rawCatcherFramingRuns = finite(framingRow?.rv_tot, players.reduce((sum, player) => sum + player.framingRuns, 0));
  const catcherReliability = players.find(player => player.id === catcherId)?.reliability ?? 0;
  // Remove the framing component embedded in this exact FRV payload.  The
  // separate framing leaderboard can differ in scope/units and is only used
  // by the standalone catcher-framing feature below.
  const embeddedFramingRuns = players.reduce((sum, player) => sum + player.regressedFramingRuns, 0);
  const rawFieldingRunValue = players.reduce((sum, player) => sum + player.rawFrv, 0);
  const regressedFieldingRunValue = players.reduce((sum, player) => sum + player.regressedFrv, 0);
  return {
    status: players.length === 9 && lineup?.official ? 'CONFIRMED' : 'PROJECTED',
    validationStatus: 'PENDING',
    observedAt,
    fieldingRunValue: regressedFieldingRunValue,
    catcherFramingRuns: embeddedFramingRuns,
    includesCatcherFraming: true,
    innings: totalOuts / 27,
    gamesEquivalent: totalOuts / (27 * 9),
    lineupCoverage: players.length / 9,
    rawValue: { fieldingRunValue: rawFieldingRunValue, embeddedFramingRuns: players.reduce((sum, player) => sum + player.framingRuns, 0), standaloneCatcherFramingRuns: rawCatcherFramingRuns, players },
    regressedValue: { fieldingRunValue: regressedFieldingRunValue, embeddedFramingRuns, standaloneCatcherFramingRuns: rawCatcherFramingRuns * catcherReliability },
    appliedValue: { nonFramingRunsPerGame: 0, reason: 'HISTORICAL_VALIDATION_PENDING' },
    source: 'BASEBALL_SAVANT_FRV_CSV',
  };
}

function buildFraming(lineup, framing, observedAt) {
  const catcherId = Number((lineup?.players || []).find(player => player.position === 'C')?.id || 0);
  const row = framing.get(catcherId);
  if (!row) return { status: 'MISSING', observedAt, source: 'BASEBALL_SAVANT_CATCHER_FRAMING_CSV' };
  return {
    status: lineup?.official ? 'CONFIRMED' : 'PROJECTED',
    validationStatus: 'PENDING',
    observedAt,
    catcherId,
    framingRuns: finite(row.rv_tot, 0),
    pitches: Math.max(0, finite(row.pitches, 0)),
    rawValue: { framingRuns: finite(row.rv_tot, 0), pitches: Math.max(0, finite(row.pitches, 0)) },
    regressedValue: { framingRuns: finite(row.rv_tot, 0) * clamp(finite(row.pitches, 0) / (finite(row.pitches, 0) + 1200), 0, 0.90) },
    appliedValue: { framingRunsPerGame: 0, reason: 'HISTORICAL_VALIDATION_PENDING' },
    source: 'BASEBALL_SAVANT_CATCHER_FRAMING_CSV',
  };
}

function buildPitchMatchup(lineup, opposingStarter, batterPitches, pitcherPitches, observedAt) {
  const starterId = Number(opposingStarter?.id || 0);
  const mix = pitcherPitches.get(starterId);
  if (!mix?.size) return { status: 'MISSING', observedAt, source: 'BASEBALL_SAVANT_PITCH_ARSENAL_CSV' };
  const slotWeights = [1.05, 1.03, 1.08, 1.10, 1.07, 1, 0.96, 0.93, 0.90];
  let weightedRv = 0;
  let weight = 0;
  let samplePitches = 0;
  let covered = 0;
  const batterAudit = [];
  (lineup?.players || []).slice(0, 9).forEach((player, index) => {
    const batter = batterPitches.get(Number(player.id));
    if (!batter?.size) return;
    let batterRv = 0;
    let batterMixWeight = 0;
    let batterSample = 0;
    let batterBaselineRv = 0;
    let batterBaselineWeight = 0;
    for (const batterRow of batter.values()) {
      const pitches = Math.max(0, finite(batterRow.pitches, 0));
      if (!pitches) continue;
      batterBaselineRv += finite(batterRow.run_value_per_100, 0) * pitches;
      batterBaselineWeight += pitches;
    }
    const overallBatterRunValuePer100 = batterBaselineWeight > 0 ? batterBaselineRv / batterBaselineWeight : 0;
    for (const [pitchType, pitcherRow] of mix) {
      const batterRow = batter.get(pitchType);
      if (!batterRow) continue;
      const usage = clamp(finite(pitcherRow.pitch_usage, 0) / 100, 0, 1);
      // Only the pitch-mix interaction belongs here. Overall batter quality is
      // already represented by season offense and the projected lineup.
      batterRv += (finite(batterRow.run_value_per_100, 0) - overallBatterRunValuePer100) * usage;
      batterMixWeight += usage;
      batterSample += Math.min(finite(batterRow.pitches, 0), finite(pitcherRow.pitches, 0)) * usage;
    }
    if (batterMixWeight < 0.45) return;
    const slotWeight = slotWeights[index] || 1;
    weightedRv += batterRv / batterMixWeight * slotWeight;
    weight += slotWeight;
    samplePitches += batterSample;
    covered += 1;
    batterAudit.push({
      batterId: Number(player.id),
      battingOrder: index + 1,
      coveredUsage: batterMixWeight,
      rawRunValuePer100: batterRv / batterMixWeight,
      overallBatterRunValuePer100,
      effectiveSamplePitches: batterSample,
    });
  });
  if (covered < 6 || weight <= 0) return { status: 'MISSING', observedAt, source: 'BASEBALL_SAVANT_PITCH_ARSENAL_CSV' };
  const rawRunValuePer100 = weightedRv / weight;
  const sampleReliability = clamp(samplePitches / (samplePitches + 1800), 0, 0.88);
  const coverage = covered / 9;
  const regressedRunValuePer100 = rawRunValuePer100 * sampleReliability * coverage;
  return {
    status: covered >= 8 && lineup?.official ? 'CONFIRMED' : 'PROJECTED',
    validationStatus: 'PENDING',
    observedAt,
    centeredRunValuePer100: regressedRunValuePer100,
    expectedPitches: clamp(finite(opposingStarter?.expectedInnings, 5.2) * 15.2, 35, 115),
    samplePitches,
    lineupCoverage: coverage,
    starterId,
    rawValue: { centeredRunValuePer100: rawRunValuePer100, batterAudit },
    regressedValue: { centeredRunValuePer100: regressedRunValuePer100, sampleReliability, coverage },
    appliedValue: { runDelta: 0, reason: 'HISTORICAL_VALIDATION_PENDING' },
    recentMixStatus: 'MISSING_NEUTRAL',
    source: 'BASEBALL_SAVANT_PITCH_ARSENAL_CSV',
  };
}

export async function buildSavantAdvancedSnapshotV2(context, options = {}) {
  const season = Number(String(context?.game?.gameDate || '').slice(0, 4)) || new Date().getUTCFullYear();
  const urls = {
    fielding: `${SAVANT}/fielding-run-value?type=fielder&seasonStart=${season}&seasonEnd=${season}&minInnings=1&csv=true`,
    framing: `${SAVANT}/catcher-framing?year=${season}&min=1&type=catcher&csv=true`,
    batterPitch: `${SAVANT}/pitch-arsenal-stats?type=batter&year=${season}&min=1&minPitches=1&csv=true`,
    pitcherPitch: `${SAVANT}/pitch-arsenal-stats?type=pitcher&year=${season}&min=1&minPitches=1&csv=true`,
  };
  const [fieldingResponse, framingResponse, batterResponse, pitcherResponse] = await Promise.all(Object.values(urls).map(url => fetchCsv(url, options)));
  const observedAt = [fieldingResponse, framingResponse, batterResponse, pitcherResponse].map(row => row.observedAt).sort().at(-1);
  const fielders = byPlayer(fieldingResponse.rows, 'id');
  const framing = byPlayer(framingResponse.rows, 'id');
  const batterPitches = pitchByPlayer(batterResponse.rows);
  const pitcherPitches = pitchByPlayer(pitcherResponse.rows);
  const away = {
    fielding: buildFielding(context?.away?.lineup, fielders, framing, observedAt),
    catcherFraming: buildFraming(context?.away?.lineup, framing, observedAt),
    pitchTypeMatchup: buildPitchMatchup(context?.away?.lineup, context?.home?.starter, batterPitches, pitcherPitches, observedAt),
  };
  const home = {
    fielding: buildFielding(context?.home?.lineup, fielders, framing, observedAt),
    catcherFraming: buildFraming(context?.home?.lineup, framing, observedAt),
    pitchTypeMatchup: buildPitchMatchup(context?.home?.lineup, context?.away?.starter, batterPitches, pitcherPitches, observedAt),
  };
  return {
    version: MLB_SAVANT_ADVANCED_V2_VERSION,
    modelContractVersion: MLB_ADVANCED_FEATURES_V2_VERSION,
    observedAt,
    away,
    home,
    sources: urls,
    sourceStatus: {
      fielding: fieldingResponse.ok ? 'CONFIRMED' : 'MISSING',
      catcherFraming: framingResponse.ok ? 'CONFIRMED' : 'MISSING',
      pitchTypeMatchup: batterResponse.ok && pitcherResponse.ok ? 'CONFIRMED' : 'MISSING',
    },
    errors: [fieldingResponse, framingResponse, batterResponse, pitcherResponse].filter(row => !row.ok).map(row => row.error),
    historicalArchive: false,
  };
}
