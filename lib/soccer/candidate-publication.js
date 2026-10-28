import { scoreSoccerQuote, soccerScoringHash } from './soccer-scoring.js';
import { projectSoccerCandidates } from './candidate-qualification.js';
import { revalidateSoccerScoringBundle } from './scoring-bundle.js';

// Persisted VERIFIED flags are not authority. Re-run against current server-owned
// contract and acceptance registrations; no caller contract can authorize a quote.
export function publishSoccerAnalysisCandidates(snapshot, { currentStatus = null, now = Date.now() } = {}) {
  const validatedCalculations = new Map(), calculationValidity = new Map();
  const checkedAt=Number.isFinite(now)&&Math.abs(now)<=8.64e15?new Date(now).toISOString():null;
  for (const direction of snapshot?.directions || []) for (const quote of direction.quotes || []) {
    if (quote.scoring?.formalScoringEnabled === true) calculationValidity.set(quote.key, {
      status: 'HISTORICAL_ONLY', code: 'SOCCER_SCORE_CURRENT_AUTHORITY_UNVERIFIED',
      checkedAt, validUntil: null,
    });
  }
  if (snapshot?.persisted === true && snapshot.publishedCurrent === true && currentStatus?.publishedCurrent === true) {
    for (const direction of snapshot.directions || []) for (const quote of direction.quotes || []) {
      const saved = quote.scoring, inputs = saved?.calculationInputs;
      // Calculation validity is independent of the ranking threshold. Genuine
      // low scores also need current artifact, contract and input revalidation.
      if (!inputs || saved.formalScoringEnabled !== true) continue;
      try {
        const trusted=revalidateSoccerScoringBundle({saved,quote,
          distribution:quote.period==='HT'?snapshot.halfTimePrediction:snapshot.prediction,
          game:snapshot.evidence?.game,evidence:snapshot.evidence,now});
        if(!trusted.ok){
          calculationValidity.set(quote.key,{...calculationValidity.get(quote.key),code:trusted.code});
          continue;
        }
        const checked = scoreSoccerQuote({ quote, distribution: quote.period === 'HT' ? snapshot.halfTimePrediction : snapshot.prediction,
          game: snapshot.evidence?.game, evidence: snapshot.evidence, ...trusted.inputs, now });
        if (checked.formalScoringEnabled === true && checked.calculationEligible === saved.calculationEligible && checked.sourceQuoteKey === quote.key
          && saved.sourceQuoteKey === quote.key && ['score', 'W', 'R'].every(k => checked[k] === saved[k])
          && ['quoteHash', 'distributionHash', 'uncertaintyHash'].every(k => checked.provenance[k] === saved.provenance?.[k])
          && soccerScoringHash(checked.calculationInputs) === soccerScoringHash(inputs)) {
          validatedCalculations.set(quote.key, checked);
          calculationValidity.set(quote.key, { status: 'CURRENT_VERIFIED', code: 'SOCCER_SCORE_CURRENT_AUTHORITY_VERIFIED',
            checkedAt, validUntil: trusted.receipt.expiresAt });
        }
      } catch { /* Revoked or unreadable calculations cannot authorize a quote. */ }
    }
  }
  // This read-time projection never changes the immutable original calculation.
  // Revoked scores remain available as history, rather than looking like a
  // current low score or a current score merely waiting for publication.
  const projected={...snapshot,directions:(snapshot?.directions || []).map(direction=>({...direction,
    quotes:(direction.quotes || []).map(quote=>{
      const validity=calculationValidity.get(quote.key);
      return validity?{...quote,calculationValidity:validity}:quote;
    })}))};
  return projectSoccerCandidates(projected, { currentStatus, validatedCalculations, now });
}
