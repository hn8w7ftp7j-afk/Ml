import { scoreSoccerQuote, soccerScoringHash } from './soccer-scoring.js';
import { projectSoccerCandidates } from './candidate-qualification.js';

// Persisted VERIFIED flags are not authority. Re-run against current server-owned
// contract and acceptance registrations; no caller contract can authorize a quote.
export function publishSoccerAnalysisCandidates(snapshot, { currentStatus = null, now = Date.now() } = {}) {
  const validatedCalculations = new Map();
  if (snapshot?.persisted === true && snapshot.publishedCurrent === true && currentStatus?.publishedCurrent === true) {
    for (const direction of snapshot.directions || []) for (const quote of direction.quotes || []) {
      const saved = quote.scoring, inputs = saved?.calculationInputs;
      if (!inputs || saved.formalScoringEnabled !== true || saved.calculationEligible !== true) continue;
      try {
        const checked = scoreSoccerQuote({ quote, distribution: quote.period === 'HT' ? snapshot.halfTimePrediction : snapshot.prediction,
          game: snapshot.evidence?.game, evidence: snapshot.evidence, scenarios: inputs.scenarios,
          uncertainty: inputs.uncertainty, acceptance: inputs.acceptance, now });
        if (checked.calculationEligible === true && checked.formalScoringEnabled === true && checked.sourceQuoteKey === quote.key
          && saved.sourceQuoteKey === quote.key && ['score', 'W', 'R'].every(k => checked[k] === saved[k])
          && ['quoteHash', 'distributionHash', 'uncertaintyHash'].every(k => checked.provenance[k] === saved.provenance?.[k])
          && soccerScoringHash(checked.calculationInputs) === soccerScoringHash(inputs)) validatedCalculations.set(quote.key, checked);
      } catch { /* Revoked or unreadable calculations cannot authorize a quote. */ }
    }
  }
  return projectSoccerCandidates(snapshot, { currentStatus, validatedCalculations, now });
}
