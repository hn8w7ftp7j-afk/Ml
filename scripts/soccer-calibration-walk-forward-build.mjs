import fs from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { buildSoccerCalibrationWalkForward, SOCCER_CALIBRATION_WALK_FORWARD_VERSION } from '../lib/soccer/calibration-walk-forward.js';
import { soccerCalibrationHash } from '../lib/soccer/calibration-research.js';

const bytesHash = bytes => createHash('sha256').update(bytes).digest('hex');
const compactPeriods = periods => Object.fromEntries(Object.entries(periods).map(([period, value]) => [period,
  { ...value, paired: Object.fromEntries(Object.entries(value.paired).filter(([key]) => key !== 'gameIds')) }]));
export function compactSoccerCalibrationWalkForwardReport(report) {
  const body = { ...Object.fromEntries(Object.entries(report).filter(([key]) => !['contentHash', 'leagues'].includes(key))),
    type: 'COMPACT_REPRODUCIBLE_CALIBRATION_WALK_FORWARD_DIAGNOSTICS', fullReportContentHash: report.contentHash,
    fullReportJSONSha256: bytesHash(`${JSON.stringify(report, null, 2)}\n`),
    traceReproduction: 'Run soccer-calibration-walk-forward-build with this generatedAt and the unchanged retained source archives; --output retains the complete per-game trace.',
    leagues: Object.fromEntries(Object.entries(report.leagues).map(([league, value]) => [league,
      { ...Object.fromEntries(Object.entries(value).filter(([key]) => !['contentHash', 'folds'].includes(key))),
        fullLeagueReportHash: value.contentHash, folds: value.folds.map(fold => ({
          ...Object.fromEntries(Object.entries(fold).filter(([key]) => !['training', 'calibration', 'test', 'sourceExcluded'].includes(key))),
          training: { ...Object.fromEntries(Object.entries(fold.training).filter(([key]) => key !== 'gameIds')),
            gameIdsHash: soccerCalibrationHash(fold.training.gameIds) },
          calibration: { ...Object.fromEntries(Object.entries(fold.calibration).filter(([key]) => key !== 'ledger')),
            ledgerHash: soccerCalibrationHash(fold.calibration.ledger) },
          test: { populationGames: fold.test.populationGames, periods: compactPeriods(fold.test.periods),
            ledgerHash: soccerCalibrationHash(fold.test.ledger), pairedGameIdsHashes: Object.fromEntries(Object.entries(fold.test.periods)
              .map(([period, value]) => [period, soccerCalibrationHash(value.paired.gameIds)])) },
          sourceExcluded: Object.fromEntries(Object.entries(fold.sourceExcluded).map(([window, rows]) => [window,
            { records: rows.length, reasons: rows.reduce((value, row) => { value[row.reason] = (value[row.reason] || 0) + 1; return value; }, {}), ledgerHash: soccerCalibrationHash(rows) }])) })) }])) };
  return { ...body, contentHash: soccerCalibrationHash(body) };
}
export async function buildSoccerCalibrationWalkForwardReport(args = process.argv.slice(2)) {
  const options = {};
  for (let at = 0; at < args.length; at++) {
    const flag = args[at];
    if (!['--input-dir', '--output', '--compact-output', '--generated-at', '--verify'].includes(flag) || options[flag] !== undefined
      || !args[at + 1] || args[at + 1].startsWith('--')) throw Error('WALK_FORWARD_ARGUMENT_INVALID');
    options[flag] = args[++at];
  }
  if (options['--verify'] && (options['--output'] || options['--compact-output'])) throw Error('WALK_FORWARD_VERIFY_MUST_NOT_OVERWRITE');
  const previous = options['--verify'] ? JSON.parse(await fs.readFile(options['--verify'], 'utf8')) : null;
  const generatedAt = options['--generated-at'] || previous?.generatedAt || new Date().toISOString();
  const directory = path.resolve(options['--input-dir'] || 'research/soccer');
  const baselineBytes = await fs.readFile(path.join(directory, 'baseline.json'));
  const halfTimeBaselineBytes = await fs.readFile(path.join(directory, 'half-time-baseline.json'));
  const baseline = JSON.parse(baselineBytes), halfTimeBaseline = JSON.parse(halfTimeBaselineBytes), leagues = {}, archiveBytes = {};
  for (const league of ['epl', 'ucl']) {
    const files = [`${league}-history.json.gz`, `half-time-${league}-history.json.gz`];
    const bytes = await Promise.all(files.map(file => fs.readFile(path.join(directory, file))));
    files.forEach((file, index) => { archiveBytes[file] = { sha256: bytesHash(bytes[index]), bytes: bytes[index].length }; });
    leagues[league] = buildSoccerCalibrationWalkForward({ league, generatedAt,
      fullTimeHistory: JSON.parse(gunzipSync(bytes[0])), halfTimeHistory: JSON.parse(gunzipSync(bytes[1])),
      hyperparameters: { fullTime: baseline.leagues[league].selected, halfTime: halfTimeBaseline.leagues[league].selected } });
  }
  const body = { version: SOCCER_CALIBRATION_WALK_FORWARD_VERSION, generatedAt, status: 'RESEARCH_ONLY',
    source: { representation: 'RETAINED_NORMALIZED_HISTORY_ARCHIVES', archiveBytes,
      baselineSha256: bytesHash(baselineBytes), halfTimeBaselineSha256: bytesHash(halfTimeBaselineBytes),
      originalSourceDocumentHashesRecomputed: false, historicalPitVerified: false, providerCompletenessVerified: false },
    leagues, accepted: false, formalEligible: false, executable: false, W: null, R: null, S: null };
  const report = { ...body, contentHash: soccerCalibrationHash(body) };
  const compact = compactSoccerCalibrationWalkForwardReport(report);
  if (previous && soccerCalibrationHash(previous) !== soccerCalibrationHash(previous.type === compact.type ? compact : report)) throw Error('WALK_FORWARD_REPORT_REPRODUCTION_CHANGED');
  if (options['--output']) {
    await fs.mkdir(path.dirname(path.resolve(options['--output'])), { recursive: true });
    await fs.writeFile(options['--output'], `${JSON.stringify(report, null, 2)}\n`);
  }
  if (options['--compact-output']) {
    await fs.mkdir(path.dirname(path.resolve(options['--compact-output'])), { recursive: true });
    await fs.writeFile(options['--compact-output'], `${JSON.stringify(compact, null, 2)}\n`);
  }
  return { status: previous ? 'REPRODUCED_EXACTLY' : 'RESEARCH_ONLY', generatedAt, contentHash: report.contentHash,
    accepted: false, formalEligible: false, W: null, R: null, S: null,
    ...(options['--output'] ? { output: path.resolve(options['--output']) } : {}),
    leagues: Object.fromEntries(Object.entries(leagues).map(([league, value]) => [league, { coverage: value.coverage,
      folds: value.folds.map(fold => ({ id: fold.id, fitStatus: fold.fitStatus, fitFailures: fold.fitFailures,
        trainingGames: fold.training.acceptedFullTimeGames, calibration: { population: fold.calibration.populationGames,
          used: fold.calibration.usedGames, parameters: fold.calibration.parameters },
        test: { population: fold.test.populationGames, periods: compactPeriods(fold.test.periods) },
        sourceExcluded: Object.fromEntries(Object.entries(fold.sourceExcluded).map(([name, rows]) => [name, rows.length])) })) }])) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.stdout.write(`${JSON.stringify(await buildSoccerCalibrationWalkForwardReport())}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
