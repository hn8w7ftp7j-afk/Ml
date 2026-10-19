// Synthetic publication projection for client/ranking tests only. This does not
// register any model or settlement contract in the shipped server scorer.
import { createHash } from 'node:crypto';
import { projectSoccerCandidates } from '../../lib/soccer/candidate-qualification.js';
const hash = x => createHash('sha256').update(String(x)).digest('hex');
export function candidateFixture(input, now = Date.now()) {
  const s = structuredClone(input), game = s.evidence?.game;
  if (!game) throw Error('synthetic fixture requires original game');
  game.sourceId ??= game.id.split(':').at(-1);
  game.home ??= {}; game.away ??= {};
  game.home.sourceId ??= '359'; game.away.sourceId ??= '364';
  Object.assign(s, { executable: false, selectionResult: 'RESEARCH_SHADOW', qaFlag: 'WARN',
    revision: hash(game.id), analysisRunId: 'synthetic-run-123', qualificationVersion: '1', quoteGeneration: '1',
    validUntil: new Date(now + 180000).toISOString() });
  const receipt = { revision: s.revision, analysisRunId: s.analysisRunId, qualificationVersion: '1', quoteGeneration: '1',
    checkedAt: new Date(now).toISOString(), validUntil: s.validUntil, publishedCurrent: true, reason: 'ACTIVE',
    analysisStatus: 'COMPLETED', selectionResult: 'RESEARCH_SHADOW', executable: false };
  const calculations = new Map();
  for (const d of s.directions) {
    d.executable = false;
    for (const q of d.quotes) {
      q.key = hash(q.key); q.sourceQuoteKey = q.key;
      q.side ??= ({ TOTAL_OVER: 'over', TOTAL_UNDER: 'under', HANDICAP_HOME: 'home', HANDICAP_AWAY: 'away' })[d.direction];
      q.scoring = { formalScoringEnabled: true, calculationEligible: d.eligible === true && s.formalScoringEnabled === true && s.qualification?.eligible === true,
        executable: false, status: 'FORMAL_CALCULATED_AWAITING_PUBLICATION', unit: 'NET_PROFIT_PER_1_STAKE',
        score: d.score, S: d.score, W: d.W, R: d.R, sourceQuoteKey: q.key, gameId: s.gameId, league: s.league, period: q.period,
        provenance: { quoteHash: q.key, distributionHash: hash('synthetic-grid'), calculatedAt: new Date(now).toISOString() },
        conditionalPayoff: { ok: true, quote: { period: q.period, kind: q.kind, direction: q.side.toUpperCase(),
          sourceLine: q.line, lineSide: q.lineSide ?? null, water: q.water } } };
      calculations.set(q.key, q.scoring);
    }
  }
  return projectSoccerCandidates(s, { currentStatus: receipt, validatedCalculations: calculations, now });
}
