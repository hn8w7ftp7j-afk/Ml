import { createHash } from 'node:crypto';
import { APP_VERSION } from '../app-version.js';

export const NBA_PERSONNEL_COMPARISON_VERSION = 'nba-personnel-minutes-input-audit-v1';
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const digest = value => /^[a-f0-9]{64}$/.test(value || '');
const time = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
const stamp = value => Number.isFinite(time(value)) ? value : null;

// This is an input audit, not an adjusted prediction. Estimated future minutes
// require a frozen historical player-minute dataset and a validated projection
// method; they do not require the future realized minutes to be confirmed.
export function buildNbaPersonnelComparison(analysis) {
  const evidence = analysis.personnelEvidence;
  const start = time(analysis.game?.startTime), captured = time(evidence?.capturedAt);
  const generated = time(analysis.generatedAt);
  const teams = [analysis.game?.home?.id, analysis.game?.away?.id];
  const sameGame = evidence?.league === 'NBA' && evidence.gameId === analysis.gameId
    && evidence.startTime === analysis.game?.startTime && ['ready', 'partial'].includes(evidence.status);
  const pregame = sameGame && Number.isFinite(captured) && Number.isFinite(start) && captured < start
    && Number.isFinite(generated) && captured <= generated && generated < start;
  const sourcePins = (Array.isArray(evidence?.sources) ? evidence.sources : []).map(source => ({
    provider: source.provider ?? null, url: source.url ?? null, hash: source.hash ?? null,
    status: source.status ?? null, fetchedAt: source.fetchedAt ?? null, publishedAt: source.publishedAt ?? null,
  })).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);
  const sourcePath = '/apis/site/v2/sports/basketball/nba/';
  const observedSource = source => {
    let url; try { url = new URL(source.url); } catch { return false; }
    const published = source.publishedAt === null ? null : time(source.publishedAt);
    return pregame && source.provider === 'ESPN' && url.origin === 'https://site.api.espn.com' && !url.username && !url.password && !url.hash
      && source.status === 'ready' && digest(source.hash) && Number.isFinite(time(source.fetchedAt))
      && time(source.fetchedAt) <= captured && captured - time(source.fetchedAt) <= 300000
      && (published === null || published <= captured);
  };
  const summaryObserved = sourcePins.some(source => {
    if (!observedSource(source)) return false;
    const url = new URL(source.url);
    return url.pathname === `${sourcePath}summary` && url.searchParams.getAll('event').length === 1
      && url.searchParams.get('event') === analysis.game?.sourceId;
  });
  const injurySourceObserved = sourcePins.some(source => observedSource(source)
    && new URL(source.url).pathname === `${sourcePath}injuries`);
  const sourcesObserved = summaryObserved && injurySourceObserved;
  const lineupPlayers = Array.isArray(evidence?.lineups) ? evidence.lineups.flatMap(row => Array.isArray(row.players) ? row.players : []) : [];
  const lineupsObserved = summaryObserved && teams.every(Boolean) && teams[0] !== teams[1]
    && Array.isArray(evidence.lineups) && evidence.lineups.length === 2
    && new Set(evidence.lineups.map(row => row.teamId)).size === 2
    && new Set(lineupPlayers.map(player => player.playerId)).size === 10
    && evidence.lineups.every(row => teams.includes(row.teamId) && row.status === 'provider_reported'
      && Array.isArray(row.players) && row.players.length === 5
      && row.players.every(player => /^nba:espn:player:[1-9]\d{0,14}$/.test(player.playerId || '') && player.teamId === row.teamId));
  const injuriesObserved = summaryObserved && injurySourceObserved
    && evidence.coverage?.injuries === 'provider_latest_reports_not_official'
    && Array.isArray(evidence.injuries) && evidence.injuries.length > 0
    && evidence.injuries.every(row => row.gameId === analysis.gameId && teams.includes(row.teamId) && row.status === 'provider_reported');
  const receipt = evidence?.persistence;
  const receiptPresent = pregame && receipt?.persisted === true && digest(receipt.revision)
    && Number.isFinite(time(receipt.capturedAt)) && time(receipt.capturedAt) <= captured;
  const quoteObservedAt = stamp(analysis.source?.quoteObservedAt ?? analysis.observedAt);
  const cutoffs = [quoteObservedAt, pregame ? evidence.capturedAt : null].filter(Boolean);
  const reasons = [
    ...(!pregame ? ['PERSONNEL_PREGAME_OBSERVATION_MISSING'] : []),
    ...(!sourcesObserved ? ['PERSONNEL_SOURCE_EVIDENCE_UNVERIFIED'] : []),
    ...(!receiptPresent ? ['PERSONNEL_SNAPSHOT_RECEIPT_MISSING'] : []),
    ...(!injuriesObserved ? ['CURRENT_INJURY_REPORTS_INCOMPLETE'] : []),
    ...(!lineupsObserved ? ['REPORTED_LINEUPS_INCOMPLETE'] : []),
    'PLAYER_MINUTE_TRAINING_ARCHIVE_MISSING',
    'AVAILABILITY_SCENARIO_MODEL_NOT_VALIDATED',
    'MINUTE_PROJECTION_MODEL_NOT_VALIDATED',
    'PLAYER_IMPACT_MODEL_NOT_VALIDATED',
  ];
  return {
    version: NBA_PERSONNEL_COMPARISON_VERSION, purpose: 'INPUT_READINESS_ONLY',
    status: 'NOT_RUN_INPUTS_AND_MODEL_MISSING', gameId: analysis.gameId, date: analysis.date,
    baseline: {
      modelVersion: analysis.modelVersion ?? null, engineVersion: analysis.engineVersion ?? APP_VERSION,
      quoteHash: analysis.quoteHash ?? null,
      outputHash: hash({ modelVersion: analysis.modelVersion, prediction: analysis.prediction,
        marketAnalyses: analysis.marketAnalyses, quotes: analysis.quotes ?? { fullTotal: analysis.quote ?? null } }),
    },
    input: {
      observationCutoffAt: cutoffs.length ? cutoffs.reduce((a, b) => time(a) >= time(b) ? a : b) : null,
      observationHash: evidence == null ? null : hash(evidence),
      snapshotRevision: receiptPresent ? receipt.revision : null,
      snapshotCapturedAt: receiptPresent ? receipt.capturedAt : null, sourcePins,
      injuryReportsObserved: injuriesObserved, reportedLineupsObserved: lineupsObserved,
      sourceEvidenceObserved: sourcesObserved,
    },
    missingInputs: reasons, adjustedModelVersion: null, adjustedPrediction: null,
    pairedMetrics: null, pairedPredictionAvailable: false,
    executable: false, promotionEligible: false,
  };
}

export function validNbaPersonnelComparison(analysis) {
  if (!analysis?.personnelComparison || analysis.personnelComparison.version !== NBA_PERSONNEL_COMPARISON_VERSION) return false;
  try { return hash(analysis.personnelComparison) === hash(buildNbaPersonnelComparison(analysis)); }
  catch { return false; }
}

// Call with the existing canonical market captures. One game can have several
// markets or input revisions; market counts and distinct-game counts stay apart.
export function summarizeNbaPersonnelComparisons(captures, { truncated = false } = {}) {
  if (truncated) return {
    version: NBA_PERSONNEL_COMPARISON_VERSION, status: 'INCOMPLETE_CAPTURE_INVENTORY',
    distinctGames: null, canonicalMarkets: null, trackedMarkets: null,
    legacyMarkets: null, invalidMarkets: null, pairedMarkets: null,
    injuryObservationMarkets: null, lineupObservationMarkets: null,
    notRunMarkets: null, missingInputs: {}, isAdjustedModelResult: false,
  };
  const unique = new Map();
  for (const capture of captures) unique.set(`${capture.payload.gameId}|${capture.marketKey}`, capture);
  const report = {
    version: NBA_PERSONNEL_COMPARISON_VERSION, status: 'INPUT_READINESS_ONLY',
    distinctGames: new Set([...unique.values()].map(c => c.payload.gameId)).size,
    canonicalMarkets: unique.size, trackedMarkets: 0, legacyMarkets: 0,
    invalidMarkets: 0, pairedMarkets: 0, injuryObservationMarkets: 0,
    lineupObservationMarkets: 0, notRunMarkets: 0, missingInputs: {}, isAdjustedModelResult: false,
  };
  for (const { payload } of unique.values()) {
    if (payload.personnelComparison == null) { report.legacyMarkets++; continue; }
    if (!validNbaPersonnelComparison(payload)) { report.invalidMarkets++; continue; }
    const comparison = payload.personnelComparison;
    report.trackedMarkets++; report.notRunMarkets++;
    if (comparison.input.injuryReportsObserved) report.injuryObservationMarkets++;
    if (comparison.input.reportedLineupsObserved) report.lineupObservationMarkets++;
    for (const reason of comparison.missingInputs) report.missingInputs[reason] = (report.missingInputs[reason] || 0) + 1;
  }
  return report;
}
