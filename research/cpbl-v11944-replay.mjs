// Research only. Completed-game path replay, NOT full historical production.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { assertSourceBlob } from './cpbl-source-pin.mjs';
const [dataPath, sourcePath, candidatePath, outputPath] = process.argv.slice(2);
const read = name => JSON.parse(fs.readFileSync(path.join(dataPath, name)));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const source = fs.readFileSync(sourcePath, 'utf8');
const blob = assertSourceBlob(source, '54d4b7d83492cddd6298f0c40ce6c3ef817974a7', 'v11.9.44');
function extract(name) {
  const start = source.search(new RegExp(`^(?:export )?(?:async )?function ${name}\\(`, 'm'));
  assert(start >= 0, `Missing function ${name}`);
  const end = source.slice(start + 1).search(/^(?:export )?(?:async )?function /m);
  return source.slice(start, end < 0 ? undefined : start + 1 + end).replace(/^export /, '');
}
const names = ['detailSide', 'parseCpblGameDetailPayload', 'recentStarterRows', 'selectedRecentGames',
  'selectedCpblRotationGames', 'projectCpblRotationStarter'];
const helpers = source.slice(source.indexOf('const clamp ='), source.indexOf('export function baseballInnings'));
const exports = vm.runInNewContext(`${helpers}\nconst CPBL_ROTATION_MAX_REST_DAYS = 10;\n${names.map(extract).join('\n')}\n({${names.join(',')}});`, {}, { timeout: 1000 });
const candidateSource = fs.readFileSync(candidatePath, 'utf8');
const candidate = vm.runInNewContext(candidateSource.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '')
  + '\nprojectCpblRotationStarter;', { detailSide: exports.detailSide }, { timeout: 1000 });
assert.equal(sha(candidate.toString()), 'e10488982a001674f27407f8be1fd9efe395ccdca3e303d1c85f04754c9ac84a');
const previous = read('evaluation-results.json');
const manifest = read('history-manifest.json');
const games = manifest.rows.filter(x => x.status === 'ELIGIBLE').map(row => {
  const raw = fs.readFileSync(path.join(dataPath, `${row.providerGameId}.json`));
  assert.equal(sha(raw), read(`${row.providerGameId}.receipt.json`).sha256);
  const detail = exports.parseCpblGameDetailPayload(JSON.parse(raw));
  assert.equal(detail.providerGameId, row.providerGameId);
  return { game: { ...row.game, gamePk: row.providerGameId }, detail };
}).sort((a,b) => a.game.gameDate.localeCompare(b.game.gameDate) || a.game.providerGameId.localeCompare(b.game.providerGameId));
const byId = new Map(games.map(x => [x.game.providerGameId, x]));
const oldRows = new Map(previous.rows.map(x => [`${x.providerGameId}:${x.side}`, x]));
const rows = [], requests = [], timings = [];
for (const target of games) {
  const prior = games.filter(x => x.game.officialDate < target.game.officialDate
    && x.game.officialDate.slice(0,4) === target.game.officialDate.slice(0,4));
  const chosen = exports.selectedCpblRotationGames(prior.map(x => x.game), target.game).map(x => byId.get(x.providerGameId));
  const priorSix = exports.selectedRecentGames(prior.map(x => x.game), target.game, 6);
  requests.push({ gameId: target.game.providerGameId, old: priorSix.length, current: chosen.length });
  for (const side of ['away','home']) {
    const teamId = target.game[`${side}TeamId`];
    const history24 = prior.filter(x => [x.game.awayTeamId,x.game.homeTeamId].includes(teamId))
      .sort((a,b) => b.game.gameDate.localeCompare(a.game.gameDate) || b.game.providerGameId.localeCompare(a.game.providerGameId)).slice(0,24);
    assert(chosen.every(x => x.game.officialDate < target.game.officialDate));
    const start = performance.now();
    const current = exports.projectCpblRotationStarter(chosen, teamId, target.game.gameDate);
    const empirical = candidate(history24, teamId, target.game.gameDate);
    timings.push(performance.now() - start);
    const actual = read(`${target.game.providerGameId}.personnel.json`)[side].starter;
    assert.equal(actual.status, 'PASS');
    const score = prediction => ({ covered: !!prediction, correct: prediction?.id === actual.id,
      recall: prediction?.candidates.some(x => x.id === actual.id) || false, top1: prediction?.id || null });
    const original = oldRows.get(`${target.game.providerGameId}:${side}`);
    assert(original && original.actual.id === actual.id);
    const next = score(empirical);
    assert.equal(next.correct, original.next.correct, 'Frozen candidate reproducibility changed');
    assert.equal(next.top1, original.next.top1);
    rows.push({ gameId: target.game.providerGameId, side, teamId, date: target.game.officialDate,
      old: original.old, current: score(current), candidate: next,
      completedSourceIds: chosen.map(x => x.game.providerGameId),
      prospectiveReceiptAvailable: chosen.length > 0 && chosen.every(x =>
        Date.parse(read(`${x.game.providerGameId}.receipt.json`).fetchedAt) < Date.parse(target.game.gameDate)) });
  }
}
const metrics = rs => Object.fromEntries(['old','current','candidate'].map(key => [key, {
  sides: rs.length, covered: rs.filter(x => x[key].covered).length,
  correct: rs.filter(x => x[key].correct).length, recalled: rs.filter(x => x[key].recall).length,
}]));
const changed = rows.filter(x => x.old.top1 !== x.current.top1);
const result = { sourceCommit: '8cff679ec5943efcd9a191eb1c65c7a2bef9476e', sourceBlob: blob,
  sourceVersion: '11.9.44', type: 'COMPLETED_GAME_PATH_RETROSPECTIVE_REPLAY',
  limitations: ['No archived pre-target receipts: reserved-game path and actual full production accuracy cannot be replayed.',
    'Counts measure potential detail requests, not wall-clock network latency or cache hit rate.',
    'Prospective evaluation is not running automatically. No production formula change.'],
  metrics: metrics(rows), byTeam: Object.fromEntries([...new Set(rows.map(x => x.teamId))].map(id => [id, metrics(rows.filter(x => x.teamId === id))])),
  changedPredictions: changed.map(x => ({ gameId:x.gameId, side:x.side, old:x.old.top1, current:x.current.top1 })),
  requests: { games: requests.length, oldTotal: requests.reduce((s,x)=>s+x.old,0), currentTotal: requests.reduce((s,x)=>s+x.current,0),
    maximum: Math.max(...requests.map(x=>x.current)), additionalRequestGames: requests.filter(x=>x.current>x.old).length },
  computeTiming: { totalMs: timings.reduce((a,b)=>a+b,0), maxMs: Math.max(...timings), includesNetwork:false },
  sidesWithPreTargetReceipts: rows.filter(x=>x.prospectiveReceiptAvailable).length,
  rows };
fs.writeFileSync(outputPath, JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({...result,rows:undefined},null,2));
