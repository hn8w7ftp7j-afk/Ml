import { deterministicScore, SCORE_FORMULA_VERSION } from '../deterministic-score.js';
import { soccerCandidatePayloadValid, soccerCandidateReceiptCurrent, soccerQuoteCandidateCurrent, soccerQuoteIdentity } from './candidate-qualification.js';
import { soccerReaderIdentityVerified } from './reader-identity-proof.js';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const instant = value => typeof value === 'string' ? Date.parse(value) : NaN;
const fresh = (value, now) => Number.isFinite(instant(value)) && instant(value) <= now && now - instant(value) < 180000;
const slots = { HANDICAP_HOME: ['HANDICAP', 'home'], HANDICAP_AWAY: ['HANDICAP', 'away'],
  TOTAL_OVER: ['TOTAL', 'over'], TOTAL_UNDER: ['TOTAL', 'under'] };
const empty = (status = 'UNAVAILABLE', label = '尚未產生評分', tone = 'pending') => ({
  score: null, W: null, R: null, status, label, tone, eligible: false,
});
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const sameGame = (left, right) => Boolean(left && right && left.id === right.id && left.league === right.league
  && left.date === right.date && left.sourceId === right.sourceId && Number.isFinite(instant(left.startTime))
  && instant(left.startTime) === instant(right.startTime) && left.home?.sourceId && left.away?.sourceId
  && left.home.sourceId === right.home?.sourceId && left.away.sourceId === right.away?.sourceId
  && Boolean(left.neutralSite) === Boolean(right.neutralSite));

// Model-only forecasts are a separate display/selection path. They never mint
// formal model acceptance, a total-error bound, or executable betting authority.
export function soccerPredictionScorePresentation({ result, direction, quote, displayGame,
  now = Date.now(), periodConfirmed = true } = {}) {
  if (result?.qaFlag === 'BLOCKED' || direction?.qaFlag === 'BLOCKED')
    return empty('BLOCKED', '資料未通過・不評分', 'blocked');
  const game = result?.evidence?.game, slot = slots[direction?.direction], c = quote?.predictionScore, p = c?.quote;
  if (displayGame !== undefined && !sameGame(displayGame, game))
    return empty('CONTEXT_CHANGED', '賽事資料已更新・待重新評分');
  if (!finite(now) || !periodConfirmed || !slot || !['FT', 'HT'].includes(direction?.period)
    || quote?.period !== direction.period || quote.kind !== slot[0] || quote.side !== slot[1] || quote.unit !== 'GOALS'
    || !game || game.id !== result?.gameId || game.league !== result?.league || game.date !== result?.date
    || !['epl', 'ucl'].includes(result.league) || result.executable !== false || !sha(quote.key)
    || quote.sourceQuoteKey !== quote.key || quote.provenance?.gameId !== game.id || !finite(quote.water) || quote.water <= 0
    || c?.version !== 'SOCCER-MODEL-PREDICTION-SCORE-v1' || c.mode !== 'PREDICTION' || c.status !== 'PREDICTION_SCORE_AVAILABLE'
    || c.accepted !== false || c.formalEligible !== false || c.formalScoringEnabled !== false
    || c.executable !== false || c.totalModelError !== null || c.modelErrorMargin !== null || c.modelValidation !== 'UNVERIFIED'
    || c.RInterpretation !== 'MODEL_PARAMETER_Q10_STRESS_NOT_TOTAL_ERROR_ADJUSTED_R'
    || c.gameId !== game.id || c.league !== result.league || c.period !== quote.period || c.sourceQuoteKey !== quote.key
    || c.provenance?.quoteHash !== quote.key || !['distributionHash','scenarioArtifactHash','protocolHash'].every(key => sha(c.provenance?.[key]))
    || c.scoreFormulaVersion !== SCORE_FORMULA_VERSION || !finite(c.score) || c.S !== c.score
    || !finite(c.W) || !finite(c.R_model) || c.R !== c.R_model
    || p?.period !== quote.period || p.kind !== quote.kind || p.direction !== quote.side.toUpperCase()
    || p.sourceLine !== quote.line || (p.lineSide ?? null) !== (quote.lineSide ?? null) || p.water !== quote.water || p.unit !== 'GOALS'
    || !Number.isFinite(instant(game.startTime)) || !Number.isFinite(instant(c.provenance.calculatedAt))
    || instant(c.provenance.calculatedAt) > now || !Number.isFinite(instant(quote.provenance.observedAt))
    || instant(quote.provenance.observedAt) > instant(c.provenance.calculatedAt)
    || instant(c.provenance.calculatedAt) >= instant(game.startTime)) return empty();
  const fixed = deterministicScore({ weightedEV: c.W, robustEV: c.R_model, actualWater: true, qaPassed: true, executable: false });
  const threshold = c.score >= 7.2 && c.W > 0 && c.R_model > 0;
  if (fixed.score !== c.score || c.eligiblePrediction !== threshold) return empty();
  const values = { score: c.score, W: c.W, R: c.R_model, R_model: c.R_model,
    scoreKind: 'PREDICTION', eligible: false, eligiblePrediction: false, formalEligible: false };
  if (!soccerReaderIdentityVerified(result))
    return { ...values, status: 'IDENTITY_UNVERIFIED', label: '預測值・場次身分未驗證，不列排名', tone: 'muted' };
  const qualification = quote.predictionQualification, receipt = result.currentResearch;
  const current = soccerCandidateReceiptCurrent(result, receipt, now)
    && quote.fresh === true && quote.prestart === true && fresh(quote.provenance.observedAt, now)
    && fresh(c.provenance.calculatedAt, now) && instant(c.provenance.validUntil) > now
    && qualification?.version === 'SOCCER-CURRENT-PREDICTION-v1' && qualification.status === 'CURRENT_PREDICTION'
    && qualification.formalEligible === false && qualification.executable === false
    && qualification.sourceQuoteKey === quote.key && canonical(qualification.quoteIdentity) === canonical(soccerQuoteIdentity(quote))
    && qualification.analysisRevision === result.revision && qualification.analysisRunId === result.analysisRunId
    && String(qualification.qualificationVersion) === String(result.qualificationVersion)
    && String(qualification.quoteGeneration) === String(result.quoteGeneration)
    && qualification.gameId === game.id && qualification.league === result.league && qualification.date === result.date
    && qualification.period === direction.period && qualification.direction === direction.direction
    && qualification.score === c.score && qualification.S === c.score && qualification.W === c.W && qualification.R_model === c.R_model
    && qualification.distributionHash === c.provenance.distributionHash
    && qualification.scenarioArtifactHash === c.provenance.scenarioArtifactHash
    && fresh(qualification.checkedAt, now)
    && instant(qualification.validUntil) > now && instant(qualification.validUntil) <= instant(receipt.validUntil)
    && instant(qualification.validUntil) <= instant(c.provenance.validUntil)
    && qualification.eligible === threshold;
  const historical = !fresh(result.observedAt, now) || !fresh(quote.provenance.observedAt, now)
    || !fresh(c.provenance.calculatedAt, now) || !(instant(c.provenance.validUntil) > now)
    || instant(game.startTime) <= now || result.status === 'POSTSTART_AUDIT'
    || result.publishedCurrent === false && result.persisted === true
    || result.validUntil != null && !(instant(result.validUntil) > now)
    || qualification?.status === 'HISTORICAL_PREDICTION';
  if (historical) return { ...values, status: 'HISTORICAL', label: '歷史預測・不列排名', tone: 'muted' };
  if (!current) return { ...values, status: 'UNPUBLISHED', label: '預測已計算・目前狀態待核對', tone: 'pending' };
  if (!threshold) return { ...values, status: 'BELOW_THRESHOLD', label: '預測未達排名門檻', tone: 'neutral' };
  return { ...values, status: 'PREDICTION_QUALIFIED', label: '預測通過排名門檻', tone: 'qualified', eligiblePrediction: true };
}

// Presentation only. This does not register a contract/model or authorize a
// candidate. Server calculation/publication checks remain the authority; hashes
// here are checked for scope/consistency, not cryptographically recomputed.
export function soccerQuoteScorePresentation({ result, direction, quote, displayGame, now = Date.now(), periodConfirmed = true } = {}) {
  if (quote?.predictionScore != null && quote?.scoring?.formalScoringEnabled !== true)
    return soccerPredictionScorePresentation({ result, direction, quote, displayGame, now, periodConfirmed });
  if (result?.qaFlag === 'BLOCKED' || direction?.qaFlag === 'BLOCKED')
    return empty('BLOCKED', '資料未通過・不評分', 'blocked');
  if (!periodConfirmed || !['FT', 'HT'].includes(direction?.period) || quote?.period !== direction.period)
    return empty('UNAVAILABLE', '期間待確認・不評分');
  const c = quote?.scoring, p = c?.conditionalPayoff?.quote, game = result?.evidence?.game;
  if (displayGame !== undefined && (!displayGame || !game || displayGame.id !== game.id
      || displayGame.league !== game.league || displayGame.date !== game.date
      || game.sourceId !== displayGame.sourceId || !Number.isFinite(instant(displayGame.startTime))
      || instant(game.startTime) !== instant(displayGame.startTime)
      || !displayGame.home?.sourceId || !displayGame.away?.sourceId
      || game.home?.sourceId !== displayGame.home.sourceId || game.away?.sourceId !== displayGame.away.sourceId
      || Boolean(game.neutralSite) !== Boolean(displayGame.neutralSite)))
    return empty('CONTEXT_CHANGED', '賽事資料已更新・待重新評分');
  const slot = slots[direction.direction];
  if (!finite(now) || !slot || !game || game.id !== result?.gameId || game.league !== result?.league
      || !['epl', 'ucl'].includes(result.league) || result.executable !== false
      || quote?.kind !== slot[0] || quote.side !== slot[1] || quote.unit !== 'GOALS'
      || !sha(quote.key) || quote.sourceQuoteKey !== quote.key || quote.provenance?.gameId !== result.gameId
      || !finite(quote.water) || quote.water <= 0 || quote.prestart !== true
      || c?.formalScoringEnabled !== true || c.executable !== false
      || c.status !== 'FORMAL_CALCULATED_AWAITING_PUBLICATION' || c.unit !== 'NET_PROFIT_PER_1_STAKE'
      || c.scoreFormulaVersion !== SCORE_FORMULA_VERSION || !finite(c.score) || c.S !== c.score
      || !finite(c.W) || !finite(c.R) || c.gameId !== result.gameId || c.league !== result.league
      || c.period !== quote.period || c.sourceQuoteKey !== quote.key || c.provenance?.quoteHash !== quote.key
      || !sha(c.provenance.distributionHash)
      || quote.qualification?.distributionHash != null && quote.qualification.distributionHash !== c.provenance.distributionHash
      || c.conditionalPayoff?.ok !== true || p?.period !== quote.period || p.kind !== quote.kind
      || p.direction !== quote.side.toUpperCase() || p.sourceLine !== quote.line
      || (p.lineSide ?? null) !== (quote.lineSide ?? null) || p.water !== quote.water)
    return empty();
  const calculatedAt = instant(c.provenance.calculatedAt), observedAt = instant(quote.provenance.observedAt);
  if (!Number.isFinite(calculatedAt) || calculatedAt > now || !Number.isFinite(observedAt)
      || observedAt > calculatedAt || !Number.isFinite(instant(game.startTime)) || calculatedAt >= instant(game.startTime))
    return empty();
  const actual = deterministicScore({ weightedEV: c.W, robustEV: c.R, actualWater: true, qaPassed: true, executable: false });
  if (actual.score !== c.score) return empty();
  const values = { score: c.score, W: c.W, R: c.R, eligible: false };
  // Preserve the immutable historical calculation for audit, but never present
  // it as a current score or ranking authority when its quote identity is unproven.
  if (!soccerReaderIdentityVerified(result))
    return { ...values, status: 'IDENTITY_UNVERIFIED', label: '歷史值・場次身分未驗證，不列排名', tone: 'muted' };
  const validity = quote.calculationValidity;
  const historical = validity != null && (validity.status !== 'CURRENT_VERIFIED'
      || !fresh(validity.checkedAt, now) || !(instant(validity.validUntil) > now))
    || !fresh(result.observedAt, now) || !fresh(quote.provenance.observedAt, now)
    || !fresh(c.provenance.calculatedAt, now) || instant(game.startTime) <= now || result.status === 'POSTSTART_AUDIT'
    || result.publishedCurrent === false && result.persisted === true
    || result.validUntil != null && !(instant(result.validUntil) > now)
    || result.currentResearch != null && !soccerCandidateReceiptCurrent(result, result.currentResearch, now);
  if (historical) return { ...values, status: 'HISTORICAL', label: '歷史分數・不列排名', tone: 'muted' };
  if (c.score < 7.2 || c.W <= 0 || c.R <= 0)
    return { ...values, status: 'BELOW_THRESHOLD', label: '未達排名門檻', tone: 'neutral' };
  if (result.formalScoringEnabled === true && result.qualification?.eligible === true
      && soccerCandidatePayloadValid(result, now) && soccerQuoteCandidateCurrent(result, direction, quote, { now }))
    return { ...values, status: 'QUALIFIED', label: '通過排名門檻', tone: 'qualified', eligible: true };
  return { ...values, status: 'UNPUBLISHED', label: '評分已計算・資格待發布', tone: 'pending' };
}
