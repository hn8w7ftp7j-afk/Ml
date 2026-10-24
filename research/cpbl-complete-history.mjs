// Offline retrospective evaluation only. No application imports this module.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { assertSourceBlob } from './cpbl-source-pin.mjs';
import { fileURLToPath } from 'node:url';
import { parseCpblGameDetailPayload, projectCpblRotationStarter as baseline } from '../lib/asian-production-features-v1.js';
import { projectCpblRotationStarter as candidate } from './cpbl-empirical-cadence.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
assertSourceBlob(fs.readFileSync(path.join(here, '../lib/asian-production-features-v1.js')),
  '31963075d783ee1e21363db22b6c1ecf4163c6ac', 'v11.9.43');
assert.ok(process.argv[3], 'Prior audit inventory is required to label newly acquired games correctly');
const data = path.resolve(process.argv[2]);
const priorData = process.argv[3] ? path.resolve(process.argv[3]) : null;
const sha = x => crypto.createHash('sha256').update(x).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const protocolBytes = fs.readFileSync(path.join(here, 'cpbl-complete-history-protocol.json'));
const protocol = JSON.parse(protocolBytes);
const manifest = read(path.join(data, 'history-manifest.json'));
assert.equal(manifest.protocolSha256, sha(protocolBytes));
assert.equal(sha(candidate.toString()), protocol.candidateFunctionSha256, 'Do not tune candidate after inspecting outcomes');
assert.equal(sha(fs.readFileSync(path.join(here, 'cpbl-empirical-cadence.mjs'))), protocol.candidateFileSha256);
const priorIds = new Set(priorData ? read(path.join(priorData, 'inventory-game-map.json')).games.map(x => x.providerGameId) : []);
const games = manifest.rows.filter(row => row.status === 'ELIGIBLE').map(row => {
  const raw = fs.readFileSync(path.join(data, `${row.providerGameId}.json`));
  const receipt = read(path.join(data, `${row.providerGameId}.receipt.json`));
  assert.equal(sha(raw), receipt.sha256);
  const detail = parseCpblGameDetailPayload(JSON.parse(raw));
  assert.equal(detail.providerGameId, row.providerGameId);
  assert.equal(detail.status, 'FINISHED');
  return { game: row.game, detail, rawSha256: receipt.sha256 };
}).sort((a, b) => a.game.gameDate.localeCompare(b.game.gameDate) || a.game.providerGameId.localeCompare(b.game.providerGameId));

const exclusions = [], rows = [];
function history(target, teamId, limit) {
  return games.filter(x => x.game.officialDate.slice(0, 4) === target.game.officialDate.slice(0, 4)
    && x.game.officialDate < target.game.officialDate
    && [x.game.awayTeamId, x.game.homeTeamId].includes(teamId))
    .sort((a, b) => b.game.gameDate.localeCompare(a.game.gameDate) || b.game.providerGameId.localeCompare(a.game.providerGameId)).slice(0, limit);
}
for (const target of games) {
  for (const side of ['away', 'home']) {
    const teamId = target.game[`${side}TeamId`];
    const oldHistory = history(target, teamId, 6), nextHistory = history(target, teamId, 24);
    assert(nextHistory.every(x => x.game.officialDate < target.game.officialDate));
    const old = baseline(oldHistory, teamId, target.game.gameDate);
    const next = candidate(nextHistory, teamId, target.game.gameDate, { asOf: target.game.gameDate });
    const baseline24 = baseline(nextHistory, teamId, target.game.gameDate);
    const candidate6 = candidate(oldHistory, teamId, target.game.gameDate, { asOf: target.game.gameDate });
    // Read actual personnel only after both independent predictions are made.
    const actual = read(path.join(data, `${target.game.providerGameId}.personnel.json`))[side]?.starter;
    if (actual?.status !== 'PASS' || !actual.id) {
      exclusions.push({ id: target.game.providerGameId, side, reason: 'ACTUAL_STARTER_UNVERIFIED' });
      continue;
    }
    const result = prediction => ({ covered: !!prediction, top1: prediction?.id || null,
      correct: !!prediction && prediction.id === actual.id,
      recall: !!prediction && prediction.candidates.some(x => x.id === actual.id),
      candidates: prediction?.candidates.map(x => ({ id: x.id, name: x.name, weight: x.weight })) || [] });
    rows.push({ providerGameId: target.game.providerGameId, date: target.game.officialDate, side, teamId,
      actual: { id: actual.id, name: actual.name, method: actual.method },
      priorAuditGame: priorIds.has(target.game.providerGameId),
      oldHistoryGames: oldHistory.length, nextHistoryGames: nextHistory.length,
      old: result(old), next: result(next), baseline24: result(baseline24), candidate6: result(candidate6),
      historyIds: nextHistory.map(x => x.game.providerGameId) });
  }
}
function metric(rs, method) {
  const covered = rs.filter(x => x[method].covered).length;
  const correct = rs.filter(x => x[method].correct).length;
  const recalled = rs.filter(x => x[method].recall).length;
  return { eligible: rs.length, covered, correct, recalled,
    coverage: rs.length ? covered / rs.length : null,
    top1All: rs.length ? correct / rs.length : null,
    top1Covered: covered ? correct / covered : null,
    candidateRecallAll: rs.length ? recalled / rs.length : null };
}
function summarize(rs) {
  const common = rs.filter(x => x.old.covered && x.next.covered);
  return { old: metric(rs, 'old'), next: metric(rs, 'next'),
    diagnostics: { baseline24: metric(rs, 'baseline24'), candidate6: metric(rs, 'candidate6') },
    common: { old: metric(common, 'old'), next: metric(common, 'next'),
      oldOnlyCorrect: common.filter(x => x.old.correct && !x.next.correct).length,
      nextOnlyCorrect: common.filter(x => !x.old.correct && x.next.correct).length },
    complete24HistorySides: rs.filter(x => x.nextHistoryGames === 24).length };
}
const grouped = key => Object.fromEntries([...new Set(rows.map(key))].sort().map(value => [value, summarize(rows.filter(x => key(x) === value))]));
const result = { createdAt: new Date().toISOString(), protocol, protocolSha256: sha(protocolBytes),
  baselineFunctionSha256: sha(baseline.toString()), candidateFunctionSha256: sha(candidate.toString()),
  acquisition: { seasonScheduleGames: manifest.seasonScheduleGames, emptyScheduleMonths: manifest.emptyScheduleMonths,
    scheduleFailures: manifest.scheduleFailures, detailFailures: manifest.rows.filter(x => x.status === 'ERROR'),
    statusCounts: Object.fromEntries([...new Set(manifest.rows.map(x => x.status))].sort().map(status => [status, manifest.rows.filter(x => x.status === status).length])) },
  dataset: { games: games.length, sides: rows.length, firstDate: games[0]?.game.officialDate, lastDate: games.at(-1)?.game.officialDate,
    rawFiles: games.map(x => ({ providerGameId: x.game.providerGameId, sha256: x.rawSha256 })) },
  exclusions, summary: { all: summarize(rows), newlyAcquired: summarize(rows.filter(x => !x.priorAuditGame)),
    priorAudit: summarize(rows.filter(x => x.priorAuditGame)), fullHistory24: summarize(rows.filter(x => x.nextHistoryGames === 24)),
    bySeason: grouped(x => x.date.slice(0, 4)), byMonth: grouped(x => x.date.slice(0, 7)), byTeam: grouped(x => String(x.teamId)) },
  deploymentDecision: 'NOT_AUTOMATICALLY_PROMOTED', rows };
fs.writeFileSync(path.join(data, 'evaluation-results.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ acquisition: result.acquisition, dataset: { ...result.dataset, rawFiles: undefined },
  exclusions, summary: result.summary }, null, 2));
