import { validateSoccerPredictionScore } from './prediction-score.js';
import { soccerCandidateReceiptCurrent, soccerQuoteIdentity } from './candidate-qualification.js';
import { soccerReaderIdentityVerified } from './reader-identity-proof.js';
import { buildSoccerScenarioResearch } from './scenario-research.js';

export const SOCCER_PREDICTION_PROJECTION_VERSION = 'SOCCER-CURRENT-PREDICTION-v1';
const finite = value => typeof value === 'number' && Number.isFinite(value);
const instant = value => typeof value === 'string' ? Date.parse(value) : NaN;
const fresh = (value, now) => finite(instant(value)) && instant(value) <= now && now - instant(value) < 180000;
const slots = { HANDICAP_HOME: ['HANDICAP', 'home'], HANDICAP_AWAY: ['HANDICAP', 'away'],
  TOTAL_OVER: ['TOTAL', 'over'], TOTAL_UNDER: ['TOTAL', 'under'] };

function quoteScope(snapshot, direction, quote, now) {
  const slot = slots[direction?.direction], game = snapshot?.evidence?.game;
  return Boolean(slot && ['FT', 'HT'].includes(direction.period) && direction.qaFlag !== 'BLOCKED'
    && quote.period === direction.period && quote.kind === slot[0] && quote.side === slot[1]
    && quote.unit === 'GOALS' && quote.sourceQuoteKey === quote.key
    && quote.provenance?.gameId === game?.id && quote.fresh === true && quote.prestart === true
    && finite(quote.water) && quote.water > 0 && fresh(quote.provenance?.observedAt, now));
}

// This is a separate prediction projection over an immutable server-created
// analysis. It never changes the original formal calculation or authorizes a
// real wager. HTTP callers cannot provide the stored prediction/head receipt.
export function publishSoccerPredictionScores(snapshot, { currentStatus = null, now = Date.now() } = {}) {
  if (snapshot?.predictionContext?.mode !== 'PREDICTION'
    && !(snapshot?.directions || []).some(direction => direction.quotes?.some(quote => quote.predictionScore))) return snapshot;
  const current = soccerCandidateReceiptCurrent(snapshot, currentStatus, now)
    && soccerReaderIdentityVerified(snapshot);
  const cutoff = instant(snapshot.analysisCutoff), checkedAt = finite(now) ? new Date(now).toISOString() : null;
  let research = null;
  try { research = buildSoccerScenarioResearch({ game: snapshot.evidence?.game, now: cutoff }); } catch {}
  let quoteCount = 0, scoredQuoteCount = 0, currentQuoteCount = 0, qualifiedQuoteCount = 0;
  const directions = (snapshot.directions || []).map(direction => {
    const quotes = (direction.quotes || []).map(quote => {
      quoteCount++;
      const prediction = quote.predictionScore;
      let validation = null;
      try {
        validation = validateSoccerPredictionScore(prediction, { quote,
          distribution: quote.period === 'HT' ? snapshot.halfTimePrediction : snapshot.prediction,
          game: snapshot.evidence?.game, evidence: snapshot.evidence, research, now: cutoff });
      } catch { /* A malformed or old prediction cannot become current. */ }
      const valid = validation?.ok === true && prediction?.status === 'PREDICTION_SCORE_AVAILABLE';
      if (valid) scoredQuoteCount++;
      const predictionExpiry = instant(prediction?.provenance?.validUntil ?? prediction?.validUntil);
      const expiry = Math.min(instant(snapshot.validUntil), instant(currentStatus?.validUntil), predictionExpiry,
        instant(snapshot.observedAt) + 180000, instant(quote.provenance?.observedAt) + 180000,
        instant(snapshot.evidence?.game?.startTime));
      const active = valid && current && quoteScope(snapshot, direction, quote, now)
        && fresh(prediction.provenance?.calculatedAt ?? prediction.calculatedAt, now)
        && finite(expiry) && expiry > now;
      if (active) currentQuoteCount++;
      const eligible = active && prediction.eligiblePrediction === true && finite(prediction.score)
        && prediction.score >= 7.2 && finite(prediction.W) && prediction.W > 0
        && finite(prediction.R_model) && prediction.R_model > 0;
      if (eligible) qualifiedQuoteCount++;
      const predictionQualification = {
        version: SOCCER_PREDICTION_PROJECTION_VERSION,
        status: active ? 'CURRENT_PREDICTION' : valid ? 'HISTORICAL_PREDICTION' : 'UNAVAILABLE',
        eligible, sourceQuoteKey: quote.key, quoteIdentity: soccerQuoteIdentity(quote),
        gameId: snapshot.gameId, league: snapshot.league, date: snapshot.date,
        period: direction.period, direction: direction.direction,
        analysisRevision: snapshot.revision ?? null, analysisRunId: snapshot.analysisRunId ?? null,
        qualificationVersion: snapshot.qualificationVersion == null ? null : String(snapshot.qualificationVersion),
        quoteGeneration: snapshot.quoteGeneration == null ? null : String(snapshot.quoteGeneration),
        score: valid ? prediction.score : null, S: valid ? prediction.S : null,
        W: valid ? prediction.W : null, R_model: valid ? prediction.R_model : null,
        distributionHash: prediction?.provenance?.distributionHash ?? null,
        scenarioArtifactHash: prediction?.provenance?.scenarioArtifactHash ?? null,
        checkedAt, validUntil: active ? new Date(expiry).toISOString() : null,
        formalEligible: false, executable: false,
      };
      return { ...quote, predictionQualification };
    });
    return { ...direction, quotes };
  });
  return { ...snapshot, directions, predictionProjectionVersion: SOCCER_PREDICTION_PROJECTION_VERSION,
    predictionScoringSummary: { version: 'SOCCER-PREDICTION-SCORING-SUMMARY-v1', mode: 'PREDICTION',
      quoteCount, scoredQuoteCount, currentQuoteCount, qualifiedQuoteCount,
      formalEligible: false, executable: false } };
}
