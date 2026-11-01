import fs from 'node:fs/promises';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { fetchSoccerJson } from '../lib/soccer/data.js';
import { normalizeSoccerHistory } from '../lib/soccer/history.js';
import { buildSoccerCalibrationRows, fitSoccerCalibrationResearch, buildSoccerCalibrationValidationPlan,
  soccerCalibrationHash, SOCCER_CALIBRATION_METHOD } from '../lib/soccer/calibration-research.js';

const bytesHash = value => createHash('sha256').update(value).digest('hex');
const root = path.resolve('research/soccer');
const loadGzip = async file => JSON.parse(gunzipSync(await fs.readFile(file)));
const store = async (file, value) => fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
export async function buildSoccerCalibrationArtifact(args = process.argv.slice(2), deps = {}) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (['--collect', '--retained-only', '--write-runtime', '--help'].includes(key)) { options[key.slice(2)] = true; continue; }
    if (!['--from', '--through', '--validation-through', '--output-dir'].includes(key) || !args[index + 1] || args[index + 1].startsWith('--')) throw Error('Invalid calibration argument');
    options[key.slice(2)] = args[++index];
  }
  if (options.help) return { help: 'node scripts/soccer-calibration-build.mjs --collect --from YYYY-MM-DD --through YYYY-MM-DD --output-dir research/soccer/calibration-v1 [--validation-through future-ISO]\nOr --retained-only --output-dir existing-package. Development calibration only; immutable source documents and exact base models are retained. No baseline replacement, formal score, acceptance, or untouched-test claim.' };
  if (Boolean(options.collect) === Boolean(options['retained-only']) || !options['output-dir']) throw Error('Choose collect or retained-only and an output directory');
  const directory = path.resolve(options['output-dir']);
  if (options['retained-only']) {
    const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
    const sourceBytes = await fs.readFile(path.join(directory, 'retained-documents.json.gz'));
    const modelsBytes = await fs.readFile(path.join(directory, 'frozen-base-models.json'));
    if (bytesHash(sourceBytes) !== manifest.archives.documentsSha256 || bytesHash(modelsBytes) !== manifest.archives.modelsSha256) throw Error('Calibration archive bytes changed');
    const documents = JSON.parse(gunzipSync(sourceBytes)), models = JSON.parse(modelsBytes), candidates = {};
    for (const league of ['epl', 'ucl']) {
      const dataset = buildSoccerCalibrationRows({ ...documents[league], league, from: manifest.from, through: manifest.through, now: Date.parse(manifest.createdAt) });
      candidates[league] = fitSoccerCalibrationResearch({ dataset, ...models[league], createdAt: manifest.createdAt, validationThrough: manifest.validationThrough });
      const saved = JSON.parse(await fs.readFile(path.join(directory, `${league}-candidate.json`), 'utf8'));
      if (soccerCalibrationHash(saved) !== soccerCalibrationHash(candidates[league]) || candidates[league].contentHash !== manifest.candidateHashes[league]) throw Error('Calibration candidate reproduction changed');
      const plan = JSON.parse(await fs.readFile(path.join(directory, `${league}-validation-plan.json`), 'utf8'));
      if (soccerCalibrationHash(plan) !== soccerCalibrationHash(buildSoccerCalibrationValidationPlan(candidates[league]))
        || plan.contentHash !== manifest.validationPlanHashes[league]) throw Error('Calibration validation plan reproduction changed');
    }
    const runtime = options['write-runtime'] ? await writeSoccerCalibrationShadowRuntime({ directory }) : null;
    return { status: 'REPRODUCED_EXACTLY', accepted: false, candidateHashes: manifest.candidateHashes, ...(runtime ? { runtime } : {}) };
  }
  if (!options.from || !options.through || !/^\d{4}-\d{2}-\d{2}$/.test(options.from) || !/^\d{4}-\d{2}-\d{2}$/.test(options.through)
    || options.through < options.from || options.from.slice(0, 4) !== options.through.slice(0, 4)) throw Error('Collect requires one explicit UTC-year development date window');
  try { await fs.access(path.join(directory, 'manifest.json')); throw Error('Calibration package already exists; reproduce it with retained-only or choose a new directory'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const [baselineBytes, halfTimeBytes] = await Promise.all([fs.readFile(path.join(root, 'baseline.json')), fs.readFile(path.join(root, 'half-time-baseline.json'))]);
  const baseline = JSON.parse(baselineBytes), halfTime = JSON.parse(halfTimeBytes), documents = {}, models = {}, candidates = {};
  const fetchJson = deps.fetchJson || fetchSoccerJson, clock = deps.now || Date.now;
  for (const [league, slug] of [['epl', 'eng.1'], ['ucl', 'uefa.champions']]) {
    // New collection always obtains a new board. Only retained-only may reuse
    // an old package as if it were the exact original collection snapshot.
    const scoreboard = await fetchJson(`https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/scoreboard?dates=${options.from.slice(0, 4)}&limit=1000`, { ttlMs: 0, timeoutMs: 20000 });
    if (!scoreboard.ok) throw Error(`Calibration scoreboard collection failed: ${league}`);
    const normalized = normalizeSoccerHistory(scoreboard.data, league, scoreboard.source, Number(options.from.slice(0, 4)));
    if (!normalized.ok) throw Error('Calibration scoreboard normalization failed');
    const rows = normalized.rows.filter(row => row.startTime.slice(0, 10) >= options.from && row.startTime.slice(0, 10) <= options.through && Date.parse(row.startTime) < clock());
    const summaries = [], collectionFailures = [];
    // Independent per-game public source reads; preserve every failure. The
    // bounded concurrency does not select a more favorable diagnostic sample.
    for (let offset = 0; offset < rows.length; offset += 4) {
      const batch = await Promise.all(rows.slice(offset, offset + 4).map(async row => {
        const file = path.join(root, 'sources', 'calibration', `${league}-${row.eventId}-summary.json.gz`);
        let document;
        try { document = await loadGzip(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (!document?.ok) {
          document = await fetchJson(`https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/summary?event=${row.eventId}`, { ttlMs: 0, timeoutMs: 20000 });
          await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, gzipSync(JSON.stringify(document), { mtime: 0 }));
        }
        return { row, document };
      }));
      for (const { row, document } of batch) if (document.ok) summaries.push(document);
      else collectionFailures.push({ eventId: row.eventId, reason: document.code, source: document.source });
    }
    documents[league] = { scoreboard, summaries, collectionFailures };
    models[league] = { model: baseline.leagues[league].liveModel, halfTimeModel: halfTime.leagues[league].liveModel,
      modelCreatedAt: baseline.createdAt, halfTimeModelCreatedAt: halfTime.createdAt };
  }
  const createdAt = new Date(clock()).toISOString();
  for (const league of ['epl', 'ucl']) {
    const dataset = buildSoccerCalibrationRows({ ...documents[league], league, from: options.from, through: options.through, now: Date.parse(createdAt) });
    candidates[league] = fitSoccerCalibrationResearch({ dataset, ...models[league], createdAt, validationThrough: options['validation-through'] || null });
  }
  await fs.mkdir(directory, { recursive: true });
  const sourceBytes = gzipSync(JSON.stringify(documents), { mtime: 0 });
  const modelsBytes = Buffer.from(`${JSON.stringify(models, null, 2)}\n`);
  await fs.writeFile(path.join(directory, 'retained-documents.json.gz'), sourceBytes);
  await fs.writeFile(path.join(directory, 'frozen-base-models.json'), modelsBytes);
  const plans = {};
  for (const league of ['epl', 'ucl']) {
    await store(path.join(directory, `${league}-candidate.json`), candidates[league]);
    plans[league] = buildSoccerCalibrationValidationPlan(candidates[league]);
    await store(path.join(directory, `${league}-validation-plan.json`), plans[league]);
  }
  const manifest = { version: SOCCER_CALIBRATION_METHOD.version, createdAt, from: options.from, through: options.through,
    validationThrough: options['validation-through'] || null, method: SOCCER_CALIBRATION_METHOD,
    archives: { documents: 'retained-documents.json.gz', documentsSha256: bytesHash(sourceBytes), models: 'frozen-base-models.json',
      modelsSha256: bytesHash(modelsBytes), originalBaselineFileSha256: bytesHash(baselineBytes), originalHalfTimeFileSha256: bytesHash(halfTimeBytes) },
    candidateHashes: Object.fromEntries(Object.entries(candidates).map(([league, candidate]) => [league, candidate.contentHash])),
    validationPlanHashes: Object.fromEntries(Object.entries(plans).map(([league, plan]) => [league, plan.contentHash])),
    restrictions: { accepted: false, baselineChanged: false, historicalPitVerified: false, durableFreezeVerified: false,
      untouchedValidationGames: 0, formalEligible: false, executable: false } };
  await store(path.join(directory, 'manifest.json'), manifest);
  const runtime = options['write-runtime'] ? await writeSoccerCalibrationShadowRuntime({ directory }) : null;
  return { status: 'CALIBRATION_DEVELOPMENT_PACKAGE_PREPARED', createdAt, accepted: false, ...(runtime ? { runtime } : {}),
    leagues: Object.fromEntries(Object.entries(candidates).map(([league, candidate]) => [league, { status: candidate.status, games: candidate.totals.games,
      excluded: candidate.excluded.length, parameters: candidate.parameters, untouchedValidationGames: 0 }])) };
}

/** Generate a server-owned runtime snapshot only after the retained package has
 * reproduced exactly. This is NOT the external durable/DB freeze receipt. */
export async function writeSoccerCalibrationShadowRuntime({ directory = 'research/soccer/calibration-v1',
  outputFile = 'lib/soccer/calibration-frozen.js' } = {}) {
  directory = path.resolve(directory);
  await buildSoccerCalibrationArtifact(['--retained-only', '--output-dir', directory]);
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
  const models = JSON.parse(await fs.readFile(path.join(directory, 'frozen-base-models.json'), 'utf8'));
  const candidates = {}, plans = {};
  for (const league of ['epl', 'ucl']) {
    candidates[league] = JSON.parse(await fs.readFile(path.join(directory, `${league}-candidate.json`), 'utf8'));
    plans[league] = JSON.parse(await fs.readFile(path.join(directory, `${league}-validation-plan.json`), 'utf8'));
  }
  const body = { version: 'SOCCER-CALIBRATION-SHADOW-ARTIFACTS-v1', createdAt: manifest.createdAt, manifest, models, candidates, plans };
  const data = { ...body, contentHash: soccerCalibrationHash(body) };
  const source = `// Generated by soccer-calibration-build --write-runtime after exact retained reproduction.\n// Research snapshot only. Durable pregame freeze/capture receipts remain required.\nimport { soccerCalibrationHash, buildSoccerCalibrationValidationPlan, SOCCER_CALIBRATION_METHOD } from './calibration-research.js';\nconst data = ${JSON.stringify(data)};\nconst validSeal = value => { if (!value) return false; const { contentHash, ...body } = value; return contentHash === soccerCalibrationHash(body); };\nexport function soccerCalibrationShadowArtifacts(league) {\n  if (!['epl','ucl'].includes(league) || !validSeal(data) || data.version !== 'SOCCER-CALIBRATION-SHADOW-ARTIFACTS-v1') throw Error('SOCCER_CALIBRATION_SHADOW_ARTIFACT_INVALID');\n  const candidate = data.candidates[league], plan = data.plans[league], models = data.models[league];\n  if (!validSeal(candidate) || !validSeal(plan) || candidate.status !== 'DEVELOPMENT_FIT_AVAILABLE'\n    || candidate.league !== league || plan.league !== league || candidate.createdAt !== data.createdAt\n    || candidate.contentHash !== data.manifest.candidateHashes[league] || plan.contentHash !== data.manifest.validationPlanHashes[league]\n    || soccerCalibrationHash(candidate.method) !== soccerCalibrationHash(SOCCER_CALIBRATION_METHOD)\n    || soccerCalibrationHash(plan) !== soccerCalibrationHash(buildSoccerCalibrationValidationPlan(candidate))\n    || soccerCalibrationHash(models.model) !== candidate.modelHash || soccerCalibrationHash(models.halfTimeModel) !== candidate.halfTimeModelHash\n    || models.modelCreatedAt !== candidate.modelAvailability.modelCreatedAt || models.halfTimeModelCreatedAt !== candidate.modelAvailability.halfTimeModelCreatedAt\n    || ['accepted','formalEligible','promotionEligible','executable'].some(key => candidate[key] !== false || plan[key] !== false)\n    || ['W','R','S','empiricalErrorMargin'].some(key => candidate[key] !== null || plan[key] !== null)) throw Error('SOCCER_CALIBRATION_SHADOW_ARTIFACT_INVALID');\n  return structuredClone({ candidate, plan, ...models, registryHash: data.contentHash, packageCreatedAt: data.createdAt,\n    sourceArchives: { documentsSha256: data.manifest.archives.documentsSha256, modelsSha256: data.manifest.archives.modelsSha256 } });\n}\n`;
  await fs.mkdir(path.dirname(path.resolve(outputFile)), { recursive: true });
  await fs.writeFile(outputFile, source);
  return { registryHash: data.contentHash, accepted: false, durableFreezeVerified: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { const result = await buildSoccerCalibrationArtifact(); process.stdout.write(`${result.help || JSON.stringify(result)}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
