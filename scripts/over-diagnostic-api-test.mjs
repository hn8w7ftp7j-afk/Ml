import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { GET } from '../app/api/diagnostics/over/route.js';
import { createSessionToken } from '../lib/security.js';
import { createOverDiagnosticSummary, gameSourceEvidence, OVER_DIAGNOSTIC_FILE, OVER_DIAGNOSTIC_MANIFEST, OVER_DIAGNOSTIC_MAX_RESPONSE_BYTES, readOverDiagnosticAsset, validateOverDiagnosticData } from '../lib/over-diagnostic-data.js';
import { diagnosticView } from '../lib/over-diagnostic-view.js';

const cwd = process.cwd();
const originalPassword = process.env.APP_PASSWORD, originalSecret = process.env.SESSION_SECRET;
const temporary = await mkdtemp(path.join(os.tmpdir(), 'over-diagnostic-api-'));
const sha256 = value => createHash('sha256').update(value).digest('hex');
process.env.APP_PASSWORD = 'local-diagnostic-test';
process.env.SESSION_SECRET = 'local-diagnostic-test-secret-abcdefghijklmnopqrstuvwxyz';
const token = await createSessionToken();
const request = (query = '', auth = true) => new Request(`http://localhost/api/diagnostics/over${query ? `?${query}` : ''}`, { headers: auth ? { cookie: `mlb_session=${token}` } : {} });
const readResponse = async response => {
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return response.json();
};

try {
  // The file archive is immutable input. Every field exposed by the summary must retain its original type/value.
  const asset = await readOverDiagnosticAsset();
  const summary = createOverDiagnosticSummary(asset.data);
  const view = diagnosticView(summary);
  assert.equal(summary.games.length, 539);
  assert.equal(view.calculationChain.length, 1078);
  assert.equal(view.pitchingAllocation.length, 1078);
  assert.equal(summary.sourceEvidenceCatalog, undefined);
  assert.equal(summary.transport.summaryIsFullTrace, false);
  assert.deepEqual(summary.funnel, asset.data.funnel);
  assert.deepEqual(summary.inventory, asset.data.inventory);
  assert.deepEqual(summary.conditionalComparisons, asset.data.conditionalComparisons);
  assert.deepEqual(summary.componentGroups, asset.data.componentGroups);
  function subsetEqual(compact, full, context = '') {
    for (const [key, value] of Object.entries(compact)) {
      if (key === 'detailsAvailable') continue;
      if (value && typeof value === 'object' && !Array.isArray(value)) subsetEqual(value, full[key], `${context}.${key}`);
      else assert.deepEqual(value, full[key], `${context}.${key} must preserve saved value, including null`);
    }
  }
  for (const [index, game] of summary.games.entries()) {
    subsetEqual(game, asset.data.games[index], String(game.gameId));
    assert.equal(game.pitching.away.terminatedExpectedOuts, null);
    assert.equal(game.pitching.home.terminatedExpectedOuts, null);
    assert.equal(game.segments, undefined);
    assert.equal(game.modelFeatureUsage, undefined);
  }
  const incomplete = structuredClone(asset.data);
  incomplete.games[0].gameId = incomplete.games[1].gameId;
  assert.throws(() => validateOverDiagnosticData(incomplete));
  incomplete.games[0].gameId = asset.data.games[0].gameId;
  incomplete.manifest.inputHash = '0'.repeat(64);
  assert.throws(() => validateOverDiagnosticData(incomplete));
  const wrongSchema = { ...asset.data, manifest: { ...asset.data.manifest, schemaVersion: 'unknown' } };
  assert.throws(() => validateOverDiagnosticData(wrongSchema));

  const unauthorized = await GET(request('', false));
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.get('cache-control'), 'no-store');
  for (const query of ['gameId=', 'gameId=NBA:824252', 'gameId=../data', 'gameId=0', 'gameId=824252&gameId=824493', 'download=0', 'gameId=824252&download=1', 'league=NBA']) {
    const response = await GET(request(query));
    assert.equal(response.status, 400, query);
    assert.equal((await readResponse(response)).code, 'DIAGNOSTIC_QUERY_INVALID');
  }
  const defaultResponse = await GET(request());
  assert.equal(defaultResponse.status, 200);
  const summaryBytes = Buffer.from(await defaultResponse.arrayBuffer());
  assert(summaryBytes.length < OVER_DIAGNOSTIC_MAX_RESPONSE_BYTES);
  assert.deepEqual(JSON.parse(summaryBytes).data, summary);
  for (const game of [asset.data.games[0], asset.data.games.at(-1)]) {
    const response = await GET(request(`gameId=${game.gameId}`));
    assert.equal(response.status, 200);
    const body = await readResponse(response);
    assert.deepEqual(body.data.game, game);
    assert.equal(body.data.games, undefined);
    assert.deepEqual(body.data.sourceEvidenceCatalog, gameSourceEvidence(asset.data, game));
    assert(Object.keys(body.data.sourceEvidenceCatalog).length < Object.keys(asset.data.sourceEvidenceCatalog).length);
    assert.equal(body.integrity.verified, true);
    assert.equal(body.integrity.sourceInputsRecheckedByThisRequest, false);
    assert(Buffer.byteLength(JSON.stringify(body)) < OVER_DIAGNOSTIC_MAX_RESPONSE_BYTES);
  }
  const missingGame = await GET(request('gameId=999999999999'));
  assert.equal(missingGame.status, 404);
  assert.equal((await readResponse(missingGame)).code, 'DIAGNOSTIC_GAME_NOT_FOUND');

  // Changing cwd exercises route failure responses against isolated copies, never the tracked data files.
  const testDirectory = path.join(temporary, 'data', 'diagnostics');
  await mkdir(testDirectory, { recursive: true });
  process.chdir(temporary);
  const missing = await GET(request());
  assert.equal(missing.status, 503);
  assert.equal((await readResponse(missing)).code, 'DIAGNOSTIC_DATA_NOT_AVAILABLE');
  const manifest = JSON.parse(await readFile(path.join(cwd, 'data', 'diagnostics', OVER_DIAGNOSTIC_MANIFEST), 'utf8'));
  await writeFile(path.join(testDirectory, OVER_DIAGNOSTIC_MANIFEST), JSON.stringify(manifest));
  const corrupted = Buffer.from(asset.gzip);
  corrupted[Math.floor(corrupted.length / 2)] ^= 1;
  await writeFile(path.join(testDirectory, OVER_DIAGNOSTIC_FILE), corrupted);
  const corrupt = await GET(request());
  assert.equal(corrupt.status, 503);
  assert.equal((await readResponse(corrupt)).code, 'DIAGNOSTIC_DATA_INVALID');
  // Rewriting both file and sidecar still cannot bypass the independently pinned frozen JSON digest.
  const alteredData = JSON.parse(gunzipSync(asset.gzip));
  alteredData.games[0].W += 0.1;
  const alteredJson = Buffer.from(JSON.stringify(alteredData));
  const alteredGzip = gzipSync(alteredJson);
  await writeFile(path.join(testDirectory, OVER_DIAGNOSTIC_FILE), alteredGzip);
  await writeFile(path.join(testDirectory, OVER_DIAGNOSTIC_MANIFEST), JSON.stringify({ ...manifest, gzipBytes: alteredGzip.length, gzipSha256: sha256(alteredGzip), jsonBytes: alteredJson.length, sha256: sha256(alteredJson) }));
  const tampered = await GET(request());
  assert.equal(tampered.status, 503);
  const failure = await readResponse(tampered);
  assert.equal(failure.code, 'DIAGNOSTIC_DATA_INVALID');
  assert.doesNotMatch(JSON.stringify(failure), /local-diagnostic-test|stack|workspace|SESSION_SECRET/);
  process.chdir(cwd);

  const exportResponse = await GET(request('download=1'));
  assert.equal(exportResponse.status, 200);
  assert.equal(exportResponse.headers.get('content-type'), 'application/gzip');
  assert.equal(exportResponse.headers.get('cache-control'), 'no-store');
  assert.equal(exportResponse.headers.get('content-encoding'), null);
  const downloaded = Buffer.from(await exportResponse.arrayBuffer());
  assert(downloaded.length < OVER_DIAGNOSTIC_MAX_RESPONSE_BYTES);
  assert.deepEqual(downloaded, asset.gzip);
  assert.equal(sha256(gunzipSync(downloaded)), asset.integrity.sha256);
  assert.deepEqual(JSON.parse(gunzipSync(downloaded)), asset.data);
  console.log(JSON.stringify({ status: 'PASS', checks: ['auth', 'query-isolation', 'compact-summary-value-and-null-preservation', '539-games-and-1078-team-rows', 'per-game-exact-trace-and-receipts', 'missing-file', 'corrupt-file', 'pinned-hash-tamper', 'schema-and-input-identity', 'gzip-download-byte-equality'], summaryBytes: summaryBytes.length, gzipBytes: downloaded.length }));
} finally {
  process.chdir(cwd);
  await rm(temporary, { recursive: true, force: true });
  if (originalPassword === undefined) delete process.env.APP_PASSWORD; else process.env.APP_PASSWORD = originalPassword;
  if (originalSecret === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = originalSecret;
}
