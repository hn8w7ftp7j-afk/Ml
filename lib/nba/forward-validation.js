import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import { parseCreditLine, fractionFor } from './analysis-core/credit-total.js';
import { nbaMarketScore } from './market-score.js';
import { SCORE_FORMULA_VERSION, SCORE_POLICY_VERSION } from '../deterministic-score.js';
import { ESPN_NBA_TEAMS, validDate, taipeiDate } from './identity.js';
import { NBA_OFFICIAL_VERSION } from './official.js';

export const NBA_FORWARD_VERSION = 'nba-forward-original-credit-v1';
export const NBA_FORWARD_SELECTION_VERSION = 'nba-forward-frozen-selection-v1';
export const NBA_FORWARD_MARKETS = Object.freeze(['fullTotal', 'fullRunline', 'firstHalfTotal', 'firstHalfRunline']);
export const NBA_FORWARD_RULE = Object.freeze({ minimumScore: 7.2, positiveW: true, positiveR: true, rebateRate: 0.015 });
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const sidesFor = key => key.endsWith('Total') ? ['over', 'under'] : ['away', 'home'];
const quoteFields = key => key.endsWith('Total') ? ['line', 'overWater', 'underWater'] : ['line', 'lineSide', 'awayWater', 'homeWater'];
const equalQuote = (a, b, key) => !!a && !!b && quoteFields(key).every(field => a[field] === b[field]);
const validProbability = side => !!side && Number.isFinite(side.expectedNet)
  && ['winProbability', 'lossProbability', 'pushProbability'].every(key => Number.isFinite(side[key]) && side[key] >= 0 && side[key] <= 1)
  && Math.abs(side.winProbability + side.lossProbability + side.pushProbability - 1) < 1e-8;

// PostgreSQL NOW() retains microseconds. Date/Date.parse retains only millis;
// use the server-provided exact UTC text for canonical ordering and SQL guards.
const captureTime = row => row?.capturedAtExact ?? row?.captured_at_exact ?? row?.capturedAt ?? row?.captured_at;
function timestampMicros(value) {
  const ms = Date.parse(value), match = String(value).match(/\.(\d+)(?:Z|[+-]\d{2}(?::?\d{2})?)$/i);
  if (!Number.isFinite(ms)) return null;
  const extra = match ? match[1].padEnd(6, '0').slice(3, 6) : '000';
  return BigInt(ms) * 1000n + BigInt(extra);
}

// Called only while the server's analysis is captured before tipoff. Evaluation
// never reruns a subsequently changed score formula against old predictions.
export function freezeNbaForwardSelection(analysis) {
  const markets = {};
  for (const key of NBA_FORWARD_MARKETS) {
    const market = analysis?.marketAnalyses?.[key];
    if (market?.status !== 'ready') continue;
    markets[key] = Object.fromEntries(sidesFor(key).map(side => {
      const value = market.sides?.[side], score = nbaMarketScore(value);
      return [side, { W: Number.isFinite(value?.expectedNet) ? value.expectedNet : null,
        R: Number.isFinite(value?.robustExpectedNet) ? value.robustExpectedNet : null,
        S: Number.isFinite(score?.score) ? score.score : null,
        selected: Number.isFinite(score?.score) && score.score >= 7.2 && value.expectedNet > 0 && value.robustExpectedNet > 0,
        reason: score ? 'frozen_shadow_score' : 'missing_valid_stress_score' }];
    }));
  }
  return { version: NBA_FORWARD_SELECTION_VERSION, rule: { ...NBA_FORWARD_RULE },
    formulaVersion: SCORE_FORMULA_VERSION, policyVersion: SCORE_POLICY_VERSION, markets,
    executable: false, formalEligible: false };
}

export function nbaCaptureRevision(payload) {
  const { generatedAt, persistence, ...stable } = payload || {};
  return hash(stable);
}

function validTeam(team) {
  return team?.id === `nba:espn:team:${team.sourceId}` && ESPN_NBA_TEAMS[team.sourceId] === team.abbreviation;
}
function completeMarket(payload, key) {
  const market = payload.marketAnalyses?.[key], quote = payload.quotes?.[key];
  if (market?.status !== 'ready' || !equalQuote(quote, market.quote, key)
    || !parseCreditLine(quote.line, key.endsWith('Total') ? 'total' : 'spread')
    || !key.endsWith('Total') && !['away', 'home'].includes(quote.lineSide)) return false;
  const waters = key.endsWith('Total') ? ['overWater', 'underWater'] : ['awayWater', 'homeWater'];
  return waters.every(field => Number.isFinite(quote[field]) && quote[field] > 0 && quote[field] <= 3)
    && sidesFor(key).every(side => validProbability(market.sides?.[side]));
}
export function validNbaForwardCapture(row) {
  const p = row?.payload, captured = Date.parse(captureTime(row)), start = Date.parse(p?.game?.startTime);
  const capturedMicros = timestampMicros(captureTime(row)), startMicros = timestampMicros(p?.game?.startTime);
  return /^[a-f0-9]{64}$/.test(row?.revision || '')
    && (p?.forwardCaptureHashVersion === 'canonical-json-sha256-v1' ? row.revision === nbaCaptureRevision(p) : p?.forwardCaptureHashVersion == null)
    && p?.forwardCaptureVersion === 'nba-analysis-forward-v1' && p.captureScope === 'SERVER_PREDICTION_AND_ORIGINAL_QUOTES'
    && p.league === 'NBA' && p.status === 'ready' && p.executable === false
    && /^nba:espn:game:[1-9]\d{0,14}$/.test(p.gameId || '') && (!row.game_id || row.game_id === p.gameId)
    && validDate(p.date) && (!row.board_date || row.board_date === p.date)
    && p.game?.id === p.gameId && p.game.taipeiDate === p.date
    && p.game.status === 'scheduled' && p.game.completed === false && p.game.timeConfirmed === true
    && validTeam(p.game.away) && validTeam(p.game.home) && p.game.away.id !== p.game.home.id
    && typeof p.modelVersion === 'string' && p.modelVersion.length > 0
    && typeof p.engineVersion === 'string' && p.engineVersion.length > 0
    && /^[a-f0-9]{64}$/.test(p.quoteHash || '') && Number.isFinite(captured) && Number.isFinite(start)
    && p.date === taipeiDate(start) && capturedMicros != null && startMicros != null && capturedMicros < startMicros
    && Number.isFinite(Date.parse(p.observedAt)) && timestampMicros(p.observedAt) <= capturedMicros;
}

// The one predeclared observation per game/market is the LAST complete server
// capture before tipoff, even when an earlier quote would have paid more.
export function canonicalNbaForwardCaptures(rows, { now = Date.now() } = {}) {
  const chosen = new Map();
  for (const row of rows || []) {
    if (!validNbaForwardCapture(row)) continue;
    const exact = String(captureTime(row)), captured = Date.parse(exact), capturedMicros = timestampMicros(exact);
    if (captured > now) continue;
    for (const marketKey of row.marketKey ? NBA_FORWARD_MARKETS.filter(key => key === row.marketKey) : NBA_FORWARD_MARKETS) {
      if (!completeMarket(row.payload, marketKey)) continue;
      const key = `${row.payload.gameId}|${marketKey}`, previous = chosen.get(key);
      const previousMicros = previous ? timestampMicros(captureTime(previous)) : null;
      if (!previous || capturedMicros > previousMicros
        || capturedMicros === previousMicros && row.revision > previous.revision) {
        chosen.set(key, { ...row, capturedAt: new Date(captured).toISOString(), capturedAtExact: exact, marketKey });
      }
    }
  }
  return [...chosen.values()].sort((a, b) => a.payload.game.startTime.localeCompare(b.payload.game.startTime)
    || a.payload.gameId.localeCompare(b.payload.gameId) || a.marketKey.localeCompare(b.marketKey));
}

export function nbaForwardContractHash(capture) {
  const p = capture.payload, key = capture.marketKey;
  return hash({ version: NBA_FORWARD_VERSION, revision: capture.revision, gameId: p.gameId, date: p.date,
    capturedAt: String(captureTime(capture)), startTime: p.game.startTime, awayId: p.game.away.id, homeId: p.game.home.id,
    modelVersion: p.modelVersion, engineVersion: p.engineVersion, marketKey: key,
    quote: p.quotes[key], prediction: p.marketAnalyses[key], selection: p.forwardSelection || null });
}
const pending = reason => ({ status: 'PENDING', reason });
function completePeriods(team) {
  return Number.isSafeInteger(team?.score) && team.score >= 0 && Array.isArray(team.periodScores) && team.periodScores.length >= 4
    && team.periodScores.every((row, i) => row.period === i + 1 && Number.isSafeInteger(row.score) && row.score >= 0)
    && team.periodScores.reduce((sum, row) => sum + row.score, 0) === team.score;
}
function sourceVerified(source, provider, now) {
  try {
    const url = new URL(source.url), at = Date.parse(source.fetchedAt);
    return source.provider === provider && source.status === 'ready' && /^[a-f0-9]{64}$/.test(source.hash || '')
      && url.protocol === 'https:' && url.hostname === (provider === 'NBA' ? 'www.nba.com' : 'site.api.espn.com')
      && !url.username && !url.password && Number.isFinite(at) && at <= now && now - at <= 15 * 60000;
  } catch { return false; }
}
function frozenSide(payload, marketKey, side) {
  const f = payload.forwardSelection, value = f?.markets?.[marketKey]?.[side], archived = payload.marketAnalyses[marketKey].sides[side];
  const valid = payload.forwardCaptureHashVersion === 'canonical-json-sha256-v1'
    && f?.version === NBA_FORWARD_SELECTION_VERSION && Object.keys(NBA_FORWARD_RULE).every(key => f.rule?.[key] === NBA_FORWARD_RULE[key])
    && typeof f.formulaVersion === 'string' && typeof f.policyVersion === 'string'
    && value && value.W === archived.expectedNet && value.R === (Number.isFinite(archived.robustExpectedNet) ? archived.robustExpectedNet : null)
    && (value.S === null || Number.isFinite(value.S) && value.S >= 1 && value.S <= 8.9)
    && value.selected === (Number.isFinite(value.S) && value.S >= 7.2 && value.W > 0 && value.R > 0);
  return valid ? { ...value, formulaVersion: f.formulaVersion, policyVersion: f.policyVersion, frozen: true }
    : { W: archived.expectedNet, R: Number.isFinite(archived.robustExpectedNet) ? archived.robustExpectedNet : null,
      S: null, selected: false, frozen: false, reason: 'missing_frozen_selection', formulaVersion: null, policyVersion: null };
}

export function evaluateNbaForwardCapture(capture, result, official, now = Date.now()) {
  if (!validNbaForwardCapture(capture) || !completeMarket(capture.payload, capture.marketKey)) return pending('CAPTURE_UNVERIFIED');
  const p = capture.payload, game = result?.data?.game;
  if (!game || game.league !== 'NBA' || game.id !== p.gameId || game.id !== `nba:espn:game:${game.sourceId}`
    || game.taipeiDate !== p.date || Date.parse(game.startTime) !== Date.parse(p.game.startTime)
    || !['away', 'home'].every(side => validTeam(game[side]) && game[side].id === p.game[side].id)) return pending('GAME_IDENTITY_UNVERIFIED');
  if (game.status !== 'final' || game.completed !== true || !/^final(?:\b|\/)/i.test(game.statusText || '')
    || Date.parse(game.startTime) >= now) return pending('FINAL_RESULT_NOT_CONFIRMED');
  if (!['away', 'home'].every(side => completePeriods(game[side]))
    || game.away.periodScores.length !== game.home.periodScores.length || game.away.score === game.home.score) return pending('PERIOD_SCORES_INCOMPLETE');
  const espnSources = (result.sources || []).filter(source => sourceVerified(source, 'ESPN', now));
  if (!espnSources.length || (result.sources || []).some(s => ['stale', 'unavailable'].includes(s.status))) return pending('RESULT_SOURCE_UNVERIFIED');
  const officialSources = (official?.sources || []).filter(source => sourceVerified(source, 'NBA', now));
  if (official?.version !== NBA_OFFICIAL_VERSION || !['ready', 'partial'].includes(official.status)
    || official.gameId !== game.id || !/^00[1245]\d{7}$/.test(official.officialGameId || '')
    || official.temporalBasis !== 'postgame_crosscheck' || official.teams?.length !== 2
    || !['away', 'home'].every(side => official.teams.some(t => t.providerId === game[side].id))
    || new Set(official.teams.map(t => t.officialId)).size !== 2
    || officialSources.length !== 2 || new Set(officialSources.map(s => s.url)).size !== 2) return pending('OFFICIAL_SCORE_CROSSCHECK_PENDING');
  const key = capture.marketKey, quote = p.quotes[key], half = key.startsWith('firstHalf'), total = key.endsWith('Total');
  const scores = Object.fromEntries(['away', 'home'].map(side => [side, half ? game[side].periodScores.slice(0, 2).reduce((sum, q) => sum + q.score, 0) : game[side].score]));
  const quantity = total ? scores.away + scores.home : quote.lineSide === 'home' ? scores.home - scores.away : scores.away - scores.home;
  const line = parseCreditLine(quote.line, total ? 'total' : 'spread');
  const outcomes = sidesFor(key).map(side => {
    const fraction = fractionFor(quantity, line, total ? side === 'over' : side === quote.lineSide);
    const water = quote[`${side}Water`], exposure = new Decimal(Math.abs(fraction)), rebate = exposure.times('0.015');
    const unitProfit = new Decimal(Math.max(fraction, 0)).times(water).minus(Math.max(-fraction, 0)).plus(rebate).toNumber();
    const prediction = p.marketAnalyses[key].sides[side], selection = frozenSide(p, key, side);
    return { side, fraction, result: fraction === 0 ? 'PUSH' : fraction === 1 ? 'WIN' : fraction === -1 ? 'LOSS' : fraction > 0 ? 'PARTIAL_WIN' : 'PARTIAL_LOSS',
      water, unitProfit, rebate: rebate.toNumber(), unitExposure: exposure.toNumber(),
      predictedWinProbability: prediction.winProbability, predictedLossProbability: prediction.lossProbability,
      predictedPushProbability: prediction.pushProbability, binaryWinOutcome: Number(fraction > 0),
      brier: (prediction.winProbability - Number(fraction > 0)) ** 2, selection };
  });
  return { status: 'EVALUATED', version: NBA_FORWARD_VERSION, revision: capture.revision, contractHash: nbaForwardContractHash(capture),
    observationKey: `${NBA_FORWARD_VERSION}|${p.gameId}|${key}`, gameId: p.gameId, date: p.date,
    marketKey: key, modelVersion: p.modelVersion, engineVersion: p.engineVersion, engineCommit: p.engineCommit || null,
    capturedAt: capture.capturedAt, capturedAtExact: String(captureTime(capture)), startTime: p.game.startTime, originalQuote: structuredClone(quote),
    scores, fullScores: { away: game.away.score, home: game.home.score },
    period: half ? 'FIRST_TWO_PERIODS_EXCLUDING_OVERTIME' : 'FULL_GAME_INCLUDING_OVERTIME',
    officialGameId: official.officialGameId, outcomes, sources: [...espnSources, ...officialSources], evaluatedAt: new Date(now).toISOString(),
    selectionRule: { ...NBA_FORWARD_RULE }, canonicalRule: 'LAST_COMPLETE_SERVER_CAPTURE_PER_GAME_MARKET_BEFORE_TIPOFF',
    unitStake: 1, isActualBet: false, evidenceStatus: 'PREGAME_SERVER_CAPTURE_OFFICIAL_POSTGAME_CROSSCHECK',
    captureBeforeTipoff: true, captureHashReproducible: p.forwardCaptureHashVersion === 'canonical-json-sha256-v1', strictPointInTime: false, strictPregameReplay: false,
    executable: false, formalEligible: false, promotionEligible: false, calibrationEligible: false };
}

function summarize(rows) {
  const total = rows.length, selected = rows.filter(row => row.selection.selected), games = new Set(rows.map(row => row.gameId));
  const statistics = values => {
    const nonpush = values.filter(v => v.fraction !== 0), wins = nonpush.filter(v => v.fraction > 0);
    const winMass = values.reduce((sum, v) => sum + Math.max(v.fraction, 0), 0), lossMass = values.reduce((sum, v) => sum + Math.max(-v.fraction, 0), 0);
    return { directions: values.length, distinctGames: new Set(values.map(v => v.gameId)).size,
      wins: wins.length, losses: nonpush.length - wins.length, pushes: values.length - nonpush.length,
      partialWins: values.filter(v => v.fraction > 0 && v.fraction < 1).length,
      partialLosses: values.filter(v => v.fraction < 0 && v.fraction > -1).length,
      winRateExcludingPush: nonpush.length ? wins.length / nonpush.length : null,
      winFractionMass: winMass, lossFractionMass: lossMass,
      fractionWeightedWinRate: winMass + lossMass ? winMass / (winMass + lossMass) : null,
      unitProfit: values.reduce((sum, v) => sum + v.unitProfit, 0), roi: values.length ? values.reduce((sum, v) => sum + v.unitProfit, 0) / values.length : null,
      brier: values.length ? values.reduce((sum, v) => sum + v.brier, 0) / values.length : null,
      meanPredictedWinProbability: values.length ? values.reduce((sum, v) => sum + v.predictedWinProbability, 0) / values.length : null,
      observedWinProbabilityIncludingPush: values.length ? wins.length / values.length : null };
  };
  return { ...statistics(rows), selected: statistics(selected), selectionRate: total ? selected.length / total : null,
    missingFrozenSelection: rows.filter(row => !row.selection.frozen).length, distinctGames: games.size };
}
export function buildNbaForwardReport(evaluations, { pending = 0, truncated = false } = {}) {
  const unique = new Map();
  for (const e of evaluations || []) {
    if (e?.status !== 'EVALUATED' || e.version !== NBA_FORWARD_VERSION || !Array.isArray(e.outcomes) || e.outcomes.length !== 2) continue;
    const old = unique.get(e.observationKey);
    if (old && old.contractHash !== e.contractHash) throw new Error('Conflicting forward observations');
    unique.set(e.observationKey, e);
  }
  const rows = [...unique.values()].flatMap(e => e.outcomes.map(o => ({ ...o, gameId: e.gameId,
    marketKey: e.marketKey, modelVersion: e.modelVersion, engineVersion: e.engineVersion })));
  const groups = new Map();
  for (const row of rows) {
    const key = JSON.stringify([row.marketKey, row.side, row.modelVersion, row.engineVersion]);
    groups.set(key, [...(groups.get(key) || []), row]);
  }
  return { version: NBA_FORWARD_VERSION, status: rows.length ? 'observations_available' : 'no_completed_observations',
    evaluations: unique.size, pendingMarkets: pending, truncated, ...summarize(rows),
    groups: [...groups.entries()].map(([key, values]) => { const [marketKey, side, modelVersion, engineVersion] = JSON.parse(key);
      return { marketKey, side, modelVersion, engineVersion, ...summarize(values) }; }),
    calibration: [0, 0.2, 0.4, 0.6, 0.8].map(lower => {
      const upper = lower + 0.2, values = rows.filter(r => r.predictedWinProbability >= lower && (upper > 0.99 ? r.predictedWinProbability <= 1 : r.predictedWinProbability < upper));
      return { lower, upper, ...summarize(values) };
    }),
    definitions: { observation: 'one last-complete pre-tipoff capture per game/market; both sides retained',
      allSidesSummary: 'both opposing sides are retained as a data check; combined direction win rate is not model selection performance; use selected statistics for the frozen policy',
      roi: 'sum of net credit-contract return including 1.5% rebate / number of one-unit research directions; not actual wagering',
      winRate: 'positive credit fraction counts as a direction win; negative as loss; pushes excluded',
      partialCredit: 'partial wins/losses are separately counted; fraction-weighted win rate and actual unit return preserve their credit exposure',
      brier: 'mean (archived P[credit fraction > 0] - actual 0/1 positive fraction event)^2; pushes count as not-win, partial win is win, not fractional Brier',
      inference: 'directions within one game and opposite sides are dependent; distinct game count is reported; no independent-direction confidence claim',
      selection: 'frozen pregame S >= 7.2, W > 0, R > 0; missing frozen S/R is not selected; thresholds never fitted to outcomes' },
    unitStake: 1, isActualBet: false, executable: false, formalEligible: false, promotionEligible: false,
    strictPointInTime: false, calibrationEligible: false };
}
