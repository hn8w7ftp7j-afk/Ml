import { scoreDistribution } from '../../lib/soccer/score-model.js';
import { soccerDate } from '../../lib/soccer/contracts.js';
import { SOCCER_FORWARD_VERSION, SOCCER_FORWARD_POLICY, soccerForwardHash, soccerForwardAnalysisRevision, soccerForwardModelDescriptor } from '../../lib/soccer/forward-validation.js';
export const iso = value => new Date(value).toISOString(), active = Date.parse('2026-10-19T10:00:00Z'), run = active + 1000, observed = run + 1000, captured = observed + 1000, start = active + 3600000, after = start + 7200000;
export const sha = value => soccerForwardHash(value), hash = sha('synthetic-training'), protocol = { version: SOCCER_FORWARD_VERSION, activatedAt: iso(active), policy: SOCCER_FORWARD_POLICY };
export function fixtureCapture({ league = 'epl', period = 'REGULATION_FT', variant = 'BASELINE', id = '100', sequence = 1, modelSeed = 'synthetic-training' } = {}) {
  const prediction = { ...scoreDistribution(1.7, 1.1, -.05), modelVersion: 'SOCCER-POISSON-DC-RESEARCH-v1', trainingHash: sha(modelSeed), trainedThrough: '2025-12-30T00:00:00.000Z' };
  const halfTime = { ...scoreDistribution(.72, .49, -.015), period: 'REGULATION_HT', distributionFamily: 'POISSON_DIXON_COLES_THINNED', modelVersion: 'SOCCER-HT-RESEARCH-fixture', trainingHash: sha(`HT:${modelSeed}`), trainedThrough: '2025-12-30T00:00:00.000Z' };
  const source = kind => ({ provider: 'ESPN', url: `https://site.api.espn.com/apis/site/v2/sports/soccer/${league === 'epl' ? 'eng.1' : 'uefa.champions'}/${kind}${kind === 'summary' ? `?event=${id}` : '?dates=20261019'}`, fetchedAt: iso(observed), contentHash: sha(`${kind}:${league}:${id}`) });
  const game = { id: `soccer:${league}:${id}`, league, sourceId: id, startTime: iso(start), date: soccerDate(start), status: 'scheduled', source: source('scoreboard'),
    home: { id: `soccer:${league}:team:1`, sourceId: '1' }, away: { id: `soccer:${league}:team:2`, sourceId: '2' } };
  const snapshot = { version: 'SOCCER-RESEARCH-SYNTHETIC-FIXTURE', league, gameId: game.id, date: game.date, runStartedAt: iso(run), observedAt: iso(observed), analysisCutoff: iso(observed),
    status: 'RESEARCH_ONLY', analysisStatus: 'COMPLETED', qaFlag: 'WARN', formalScoringEnabled: false, executable: false,
    prediction, halfTimePrediction: halfTime,
    evidence: { phase: 'PREMATCH_OBSERVATION', game, source: source('summary'), teams: {} },
    inputVersions: { modelTrainingHash: sha(modelSeed), researchArtifactHash: sha('research'), halfTimeArtifactHash: sha('half-time'), evidenceHash: source('summary').contentHash, evidenceFetchedAt: iso(observed) } };
  const modelHash = sha(soccerForwardModelDescriptor(snapshot, period, variant));
  return { captureId: sha([league,id,period,variant,sequence,modelSeed]), captureSequence: String(sequence), league, gameId: game.id, date: game.date, period, variant,
    modelHash, capturedAt: iso(captured), revision: soccerForwardAnalysisRevision(snapshot), snapshot };
}
export const changed = (original, mutate) => { const row = structuredClone(original); mutate(row); row.revision = soccerForwardAnalysisRevision(row.snapshot); row.modelHash = sha(soccerForwardModelDescriptor(row.snapshot,row.period,row.variant)); return row; };
export function resultFor(capture) {
  const { snapshot: { evidence: { game, source } } } = capture;
  return { ok: true, verified: true, status: 'NORMAL_FINAL_CROSSCHECKED', league: capture.league, gameId: capture.gameId, date: capture.date, startTime: game.startTime,
    teamIds: { home: game.home.id, away: game.away.id }, fullTime: { home: 2, away: 1, period: 'REGULATION_FT' },
    halfTime: { home: 1, away: 0, period: 'REGULATION_HT', verified: true }, observedAt: iso(after), resultHash: sha('result'),
    sources: [source, game.source].map(row => ({ ...row, fetchedAt: iso(after) })), evidenceScope: SOCCER_FORWARD_POLICY.resultEvidence };
}
