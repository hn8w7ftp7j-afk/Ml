import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

// Versioned research artifact identities, not model parameters. Changes require a new reviewed export.
export const OVER_DIAGNOSTIC_SHA256 = 'ae177617461640f2509e2a0d7552301c9035b8d6a7b13473b0c6dbe310b6b405';
export const OVER_DIAGNOSTIC_INPUT_HASH = 'd8ac6cb570d0347e32f0c203d4b1651997d3bb72ee3e5bc23eb3c2c3f7f092a7';
export const OVER_DIAGNOSTIC_FILE = 'over-diagnostic-v1.json.gz';
export const OVER_DIAGNOSTIC_MANIFEST = 'over-diagnostic-v1.manifest.json';
export const OVER_DIAGNOSTIC_MAX_RESPONSE_BYTES = 4_000_000;
const dataSchema = 'MLB-OVER-DIAGNOSTIC-TABLES-v1';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invariant = condition => { if (!condition) throw new Error('DIAGNOSTIC_SCHEMA_OR_INTEGRITY_MISMATCH'); };

export function validateOverDiagnosticData(data) {
  invariant(object(data) && object(data.manifest) && data.manifest.schemaVersion === dataSchema);
  invariant(data.manifest.analysisMode === 'FROZEN_HISTORICAL_DIAGNOSTIC'
    && data.manifest.modelChanged === false && data.manifest.modelOrSelectionChanged === false
    && data.manifest.inputHash === OVER_DIAGNOSTIC_INPUT_HASH);
  invariant(object(data.inventory) && Array.isArray(data.inventory.rows)
    && data.inventory.rows.length === data.inventory.totalGames
    && Array.isArray(data.games) && data.games.length === data.inventory.validOverMarkets);
  invariant(Array.isArray(data.funnel?.stages) && data.funnel.stages.length === 5
    && Array.isArray(data.funnel.transitions) && Array.isArray(data.crossTabs)
    && Array.isArray(data.conditionalComparisons) && Array.isArray(data.componentGroups)
    && Array.isArray(data.limitations));
  invariant(data.funnel.sourceHashes?.['offline-eval-20260911/inputs.jsonl.gz'] === OVER_DIAGNOSTIC_INPUT_HASH);
  invariant(object(data.sourceEvidenceCatalog));
  const ids = new Set();
  for (const game of data.games) {
    invariant(object(game) && Number.isSafeInteger(game.gameId) && game.gameId > 0 && !ids.has(game.gameId));
    ids.add(game.gameId);
    invariant(typeof game.gameDate === 'string' && typeof game.selected === 'boolean'
      && ['W', 'R', 'score', 'mu', 'line', 'baselineRuns'].every(key => Number.isFinite(game[key]))
      && ['actual', 'bias', 'net', 'preNet'].every(key => game[key] === null || Number.isFinite(game[key]))
      && object(game.environment) && object(game.offense) && object(game.pitching)
      && ['away', 'home'].every(side => object(game.offense[side]) && object(game.pitching[side]))
      && Array.isArray(game.segments) && Array.isArray(game.clamps));
    invariant(typeof game.baselineDataVersion === 'string' && /^[a-f0-9]{64}$/.test(game.baselineDataHash));
    gameSourceEvidence(data, game);
  }
  invariant(data.funnel.stages[0].n === data.games.length
    && data.inventory.selectedMarkets === data.games.filter(game => game.selected).length);
  for (const stage of data.funnel.stages) {
    invariant(Array.isArray(stage.gameIds) && stage.n === stage.gameIds.length
      && new Set(stage.gameIds).size === stage.gameIds.length && stage.gameIds.every(id => ids.has(id)));
  }
  return data;
}

export async function readOverDiagnosticAsset({ directory = path.join(process.cwd(), 'data', 'diagnostics') } = {}) {
  const [manifestBytes, gzip] = await Promise.all([
    readFile(path.join(directory, OVER_DIAGNOSTIC_MANIFEST)),
    readFile(path.join(directory, OVER_DIAGNOSTIC_FILE)),
  ]);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  invariant(manifest.schemaVersion === 'MLB-OVER-DIAGNOSTIC-ASSET-v1'
    && manifest.file === OVER_DIAGNOSTIC_FILE && manifest.dataSchemaVersion === dataSchema
    && manifest.sha256 === OVER_DIAGNOSTIC_SHA256 && manifest.inputHash === OVER_DIAGNOSTIC_INPUT_HASH
    && manifest.gzipBytes === gzip.length && gzip.length < OVER_DIAGNOSTIC_MAX_RESPONSE_BYTES
    && manifest.gzipSha256 === sha256(gzip));
  const bytes = gunzipSync(gzip, { maxOutputLength: 64 * 1024 * 1024 });
  invariant(bytes.length === manifest.jsonBytes && sha256(bytes) === OVER_DIAGNOSTIC_SHA256);
  const data = validateOverDiagnosticData(JSON.parse(bytes.toString('utf8')));
  invariant(manifest.gameCount === data.games.length && manifest.inventoryCount === data.inventory.totalGames);
  return { data, gzip, integrity: {
    sha256: manifest.sha256, gzipSha256: manifest.gzipSha256, inputHash: manifest.inputHash,
    jsonBytes: bytes.length, gzipBytes: gzip.length, verified: true,
    verificationScope: 'FROZEN_ARTIFACT_BYTES_AND_EMBEDDED_INPUT_HASH',
    sourceInputsRecheckedByThisRequest: false,
  } };
}

// Preserve scalar types and nulls. Missing fields stay absent; no defaults impersonate observations.
const pick = (value, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
const offenseKeys = ['finalFactor', 'baseFactor', 'lineupFactor', 'platoonFactor', 'seasonSourceStatus', 'recentSourceStatus', 'lineupSourceStatus', 'fallbackApplied', 'neutralizationApplied'];
const pitchingKeys = ['starterName', 'starterSourceStatus', 'starterEstimateStatus', 'starterBranch', 'modelBranch', 'starterFallbackApplied', 'starterExpectedInnings', 'starterExpectedOuts', 'starterFactor', 'bullpenSourceStatus', 'bullpenRawFactor', 'bullpenAppliedFactor', 'scheduledBullpenOuts', 'scheduledOuts', 'terminatedExpectedOuts', 'terminatedOutsStatus', 'starterRunsDiagnostic', 'bullpenRunsDiagnostic'];
const environmentKeys = ['sourceStatus', 'rawValue', 'snapshotValue', 'appliedValue', 'valueNature', 'fallbackApplied', 'imputationReason'];

export function createOverDiagnosticSummary(data) {
  const { sourceEvidenceCatalog, ...summaryData } = data;
  const games = data.games.map(game => ({
    ...Object.fromEntries(Object.entries(game).filter(([, value]) => value === null || typeof value !== 'object')),
    offense: Object.fromEntries(['away', 'home'].map(side => [side, pick(game.offense[side], offenseKeys)])),
    pitching: Object.fromEntries(['away', 'home'].map(side => [side, pick(game.pitching[side], pitchingKeys)])),
    environment: Object.fromEntries(['park', 'weather'].map(key => [key, {
      ...pick(game.environment[key], environmentKeys),
      temporalEvidence: pick(game.environment[key].temporalEvidence || {}, ['asOf', 'publishedAt', 'fetchedBeforeCutoff', 'hasPregamePublicationEvidence', 'snapshotPitVerified']),
    }])),
    detailsAvailable: true,
  }));
  const summary = { ...summaryData, games, transport: {
    schemaVersion: 'MLB-OVER-DIAGNOSTIC-TRANSPORT-v1', view: 'SUMMARY',
    gameCount: games.length, allComputableOverGamesIncluded: games.length === data.inventory.validOverMarkets,
    gameFieldsCompacted: true, summaryIsFullTrace: false,
    detailsEndpoint: '/api/diagnostics/over?gameId={gameId}',
    downloadEndpoint: '/api/diagnostics/over?download=1',
    downloadFormat: 'application/gzip',
    detailScope: 'EXACT_GAME_ROW_FROM_FROZEN_DIAGNOSTIC_ARTIFACT',
    rawSourcePayloadsIncluded: false,
    sourceEvidenceCatalogIncluded: false, sourceEvidenceCount: Object.keys(sourceEvidenceCatalog).length,
  } };
  invariant(Buffer.byteLength(JSON.stringify({ ok: true, data: summary })) < OVER_DIAGNOSTIC_MAX_RESPONSE_BYTES - 2000);
  return summary;
}

export function gameSourceEvidence(data, game) {
  const refs = new Set();
  function collect(value) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const row of value) collect(row); return; }
    if (Array.isArray(value.receiptRefs)) for (const ref of value.receiptRefs) {
      invariant(object(ref) && typeof ref.sha256 === 'string'); refs.add(ref.sha256);
    }
    if (typeof value.rawLeagueSnapshotRef === 'string') refs.add(value.rawLeagueSnapshotRef);
    for (const [key, child] of Object.entries(value)) if (key !== 'receiptRefs') collect(child);
  }
  collect(game);
  return Object.fromEntries([...refs].map(hash => {
    invariant(/^[a-f0-9]{64}$/.test(hash) && Object.hasOwn(data.sourceEvidenceCatalog, hash));
    return [hash, data.sourceEvidenceCatalog[hash]];
  }));
}
