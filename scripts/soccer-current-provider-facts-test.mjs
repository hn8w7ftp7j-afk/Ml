import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transform } from 'next/dist/build/swc/index.js';
import { normalizeSoccerSchedule } from '../lib/soccer/data.js';
import { normalizeSoccerPrematch } from '../lib/soccer/prematch.js';
import { soccerFormalEvidenceReadiness } from '../lib/soccer/formal-evidence-readiness.js';
import { soccerScoringReadiness } from '../lib/soccer/scoring-readiness.js';
import { scoreSoccerQuote } from '../lib/soccer/soccer-scoring.js';
import { buildSoccerAnalysis } from '../lib/soccer/analysis.js';
import { soccerSqlFixture } from './helpers/soccer-sql-fixture.mjs';

// Synthetic XI/official shapes exercise engineering boundaries only. They are
// hashed and archived by the actual default store in the isolated SQL fixture;
// no synthetic fixture or acceptance is installed in Production.
const fixture = await soccerSqlFixture();
const before = { DATABASE_URL: process.env.DATABASE_URL, DATABASE_V2_URL: process.env.DATABASE_V2_URL };
process.env.DATABASE_URL = 'postgres://fixture.invalid/current-provider-facts'; delete process.env.DATABASE_V2_URL;
const { archiveSoccerSourceDocument, soccerCurrentSourceAvailability, soccerCurrentProviderFactAcceptance,
  restoreSoccerCurrentSourceAvailability } = await import('../lib/soccer/source-document-store.js');
const { soccerJournalQuery } = await import('../lib/soccer/journal.js');
const iso = time => new Date(time).toISOString();
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fields = ['teams.home.lineup', 'teams.away.lineup', 'referee'];
const observation = (evidence, field) => field.split('.').reduce((value, key) => value?.[key], evidence);
const fact = (evidence, field, now = Date.now(), game = evidence.game) => soccerCurrentProviderFactAcceptance(
  observation(evidence, field)?.source, { evidence, game, now, field });
const audit = (evidence, now = Date.now(), facts = true) => soccerFormalEvidenceReadiness({ evidence, now,
  currentSourceAvailability: soccerCurrentSourceAvailability,
  ...(facts ? { currentProviderFactAcceptance: soccerCurrentProviderFactAcceptance } : {}) });
function fresh(league = 'epl', mutatePayload = () => {}) {
  const payload = JSON.parse(fs.readFileSync(new URL(`./fixtures/soccer/${league}-summary.json`, import.meta.url)));
  const now = Date.now(), kickoff = iso(now + 3600000);
  payload.header.date = kickoff; payload.header.competitions[0].date = kickoff;
  payload.header.competitions[0].status = { type: { state: 'pre', completed: false, name: 'STATUS_SCHEDULED' } };
  payload.rosters.forEach((roster, side) => {
    roster.roster = Array.from({ length: 11 }, (_, index) => ({ starter: true,
      athlete: { id: String(900000 + side * 100 + index), displayName: `SYNTHETIC FIXTURE ${side}-${index}` } }));
  });
  payload.gameInfo.officials = [{ displayName: 'SYNTHETIC FIXTURE OFFICIAL', order: 1 }];
  mutatePayload(payload);
  const source = { provider: 'ESPN',
    url: `https://site.api.espn.com/apis/site/v2/sports/soccer/${league === 'epl' ? 'eng.1' : 'uefa.champions'}/summary?event=${payload.header.id}`,
    requestedAt: iso(now - 1100), fetchedAt: iso(now - 1000), contentHash: hash(payload) };
  const game = normalizeSoccerSchedule({ leagues: [payload.header.league], events: [payload.header] }, league, source).games[0];
  const evidence = normalizeSoccerPrematch(payload, game, source, now);
  assert.equal(evidence.ok, true);
  return evidence;
}
const archived = async league => {
  const evidence = fresh(league); evidence.sourceDocumentArchive = await archiveSoccerSourceDocument(evidence); return evidence;
};
try {
  for (const league of ['epl', 'ucl']) {
    const evidence = fresh(league);
    for (const field of fields) assert.equal(fact(evidence, field), null, 'normalization and provider flags cannot mint an archived fact');
    evidence.sourceDocumentArchive = await archiveSoccerSourceDocument(evidence);
    const now = Date.now(), result = audit(evidence, now), prior = audit(evidence, now, false);
    assert.equal(result.currentProviderFacts.length, 3);
    assert.deepEqual(result.reasons, prior.reasons, 'observed facts never loosen a formal gate or remove a blocker');
    assert.equal(result.status, 'BLOCKED');
    for (const field of fields) {
      const accepted = fact(evidence, field, now);
      assert.equal(accepted.status, 'CURRENT_PROVIDER_FACT_ACCEPTED');
      assert.equal(accepted.scope, 'CURRENT_ANALYSIS_ONLY'); assert.equal(accepted.field, field);
      assert.equal(accepted.gameId, evidence.game.id); assert.equal(accepted.league, league);
      assert.equal(accepted.receiptId, evidence.sourceDocumentArchive.receiptId);
      assert.equal(accepted.independentlyConfirmed, false); assert.equal(accepted.historicalAvailabilityVerified, false);
      assert.equal(accepted.formalEligible, false); assert.equal(accepted.rolesVerified, false);
      assert.equal(result.checks.find(check => check.field === field).status, 'BLOCKED', 'formal VERIFIED is still required');
    }
    assert.equal(evidence.referee.officials[0].role, null, 'order 1 never invents a referee role');
    assert.equal(fact(evidence, 'referee', now).fact, 'PROVIDER_REPORTED_NAMED_OFFICIALS');
    assert.equal(fact(evidence, 'teams.home.lineup', now).count, 11);
    assert.equal(evidence.teams.home.lineup.status, 'PROVIDER_REPORTED_XI');
    assert.equal(evidence.teams.home.lineup.independentlyConfirmed, false);
    const score = scoreSoccerQuote({ evidence, game: evidence.game, now });
    assert.equal(score.formalScoringEnabled, false); assert.equal(score.W, null); assert.equal(score.R, null); assert.equal(score.S, null);

    const built = buildSoccerAnalysis({ evidence, now });
    assert.equal(built.scoreReadiness.evidenceReadiness.currentProviderFacts.length, 3, 'shipped analysis injects only the private server verifier');
    const saved = JSON.parse(JSON.stringify(built));
    assert.deepEqual(soccerScoringReadiness(saved, now).evidenceReadiness.currentProviderFacts, result.currentProviderFacts,
      'saved display preserves the source audit at its original cutoff');
    for (const mutate of [
      value => { value.evidence.teams.home.lineup.starters[0].name += ' CHANGED'; },
      value => { value.evidence.teams.home.lineup.starters[0].starter = false; },
      value => { value.evidence.teams.home.lineup.bench.push({ id: '999999' }); },
      value => { value.evidence.referee.officials[0].name += ' CHANGED'; },
      value => { value.evidence.referee.officials[0].role = 'Referee'; },
    ]) {
      const changed = structuredClone(saved); mutate(changed);
      assert.equal(soccerScoringReadiness(changed, now).evidenceReadiness.currentProviderFacts, undefined,
        'changed names/announced flags/official roles cannot borrow a saved fact audit');
    }
    const clone = structuredClone(evidence);
    for (const field of fields) assert.equal(fact(clone, field), null, 'JSON/clone and a copied receipt carry no private fact authority');
    clone.currentProviderFacts = result.currentProviderFacts; clone.currentProviderFactAccepted = true;
    assert.equal(fact(clone, 'teams.home.lineup'), null, 'caller flags cannot create acceptance');
    assert.equal(await restoreSoccerCurrentSourceAvailability(clone), true);
    for (const field of fields) assert.equal(fact(clone, field)?.status, 'CURRENT_PROVIDER_FACT_ACCEPTED', 'exact default DB readback restores observed facts');
    for (const field of fields) {
      assert.equal(fact(evidence, field, Date.parse(evidence.source.fetchedAt) + 180000), null, 'expired observations cannot appear current');
      assert.equal(fact(evidence, field, Date.parse(evidence.sourceDocumentArchive.recordedAtUpperBound) - 1), null,
        'a later DB receipt cannot backdate accepted facts');
      for (const patch of [{ id: 'soccer:epl:999' }, { league: league === 'epl' ? 'ucl' : 'epl' },
        { startTime: iso(now + 7200000) }, { home: { ...evidence.game.home, id: 'soccer:epl:team:999' } }])
        assert.equal(fact(evidence, field, Date.now(), { ...evidence.game, ...patch }), null, 'game/team/league/kickoff must match the receipt');
    }
    const noTransportAuthority = fresh(league);
    noTransportAuthority.sourceDocumentArchive = await archiveSoccerSourceDocument(noTransportAuthority, { query: (...args) => soccerJournalQuery(...args) });
    assert.equal(fact(noTransportAuthority, 'teams.home.lineup'), null, 'an injected archive transport cannot mint private authority');
  }
  for (const mutate of [
    value => { value.teams.home.lineup.starters[0].name = 'CHANGED'; },
    value => { value.teams.home.lineup.starters[0].starter = false; },
    value => { value.teams.home.lineup.starters[0].id = value.teams.away.lineup.starters[0].id; },
    value => { value.teams.home.lineup.starters[1].id = value.teams.home.lineup.starters[0].id; },
    value => { value.teams.home.lineup.starters.pop(); },
    value => { value.teams.home.lineup.status = 'VERIFIED'; },
    value => { value.teams.home.lineup.source = { ...value.teams.home.lineup.source }; },
    value => { value.teams.home.lineup.source = value.teams.away.lineup.source; },
    value => { value.teams.home.sourceId = '999'; },
  ]) {
    const evidence = await archived('epl'); mutate(evidence);
    assert.equal(fact(evidence, 'teams.home.lineup'), null, 'changed or borrowed observations are not the original archived XI');
  }
  for (const mutate of [
    value => { value.referee.officials[0].name = 'CHANGED'; },
    value => { value.referee.officials[0].role = 'Referee'; },
    value => { value.referee.status = 'VERIFIED'; },
    value => { value.referee.source = value.source; },
  ]) {
    const evidence = await archived('epl'); mutate(evidence);
    assert.equal(fact(evidence, 'referee'), null, 'changed names/roles/status or copied document metadata revoke fact authority');
  }
  const beforeArchive = fresh('epl'); beforeArchive.teams.home.lineup.starters[0].name = 'CHANGED BEFORE ARCHIVE';
  beforeArchive.sourceDocumentArchive = await archiveSoccerSourceDocument(beforeArchive);
  assert.equal(fact(beforeArchive, 'teams.home.lineup'), null, 'pre-archive observation mutation cannot gain its original private source proof');
  for (const mutate of [
    payload => { payload.rosters[0].roster.pop(); },
    payload => { delete payload.rosters[0].roster; },
    payload => { payload.gameInfo.officials = []; },
    payload => { payload.gameInfo.officials = [{ displayName: '' }]; },
  ]) {
    const evidence = fresh('epl', mutate); evidence.sourceDocumentArchive = await archiveSoccerSourceDocument(evidence);
    assert.equal(fact(evidence, evidence.referee.officials?.length ? 'teams.home.lineup' : 'referee'), null,
      'an archived missing/partial observation never becomes an accepted complete fact');
  }
  const evidence = await archived('epl');
  for (const field of [undefined, null, {}, 1, 'document', 'weather', 'teams.home.injuries', 'teams.home.lineup.900000'])
    assert.equal(soccerCurrentProviderFactAcceptance(evidence.source, { evidence, game: evidence.game, field }), null,
      'unsupported/malformed fields and broader coverage claims never become accepted facts');
  const source = fs.readFileSync('app/soccer/market-panel.js', 'utf8').replace(/^import .*?;\n/gm, '').replace(/export function/g, 'function');
  const { code } = await transform(source, { filename: 'soccer-market-ui.jsx', jsc: { parser: { syntax: 'ecmascript', jsx: true }, transform: { react: { runtime: 'classic' } } } });
  const context = vm.createContext({ React, Date, soccerScoringReadiness, SoccerRecordButton: () => null }); vm.runInContext(code, context);
  const built = buildSoccerAnalysis({ evidence, now: Date.now() }), saved = JSON.parse(JSON.stringify(built));
  const markup = renderToStaticMarkup(context.SoccerScoringReadiness({ result: saved, game: saved.evidence.game }));
  assert.match(markup, /來源內容已保存並核對/); assert.match(markup, /主隊十一人先發/); assert.match(markup, /客隊十一人先發/);
  assert.match(markup, /具名裁判名單/); assert.match(markup, /裁判職務尚未驗證/); assert.match(markup, /正式模型驗收仍依下列結果判定/);
  assert.doesNotMatch(markup, /正式評分已計算|CURRENT_PROVIDER_FACT_ACCEPTED|SYNTHETIC FIXTURE/);
  const changed = structuredClone(saved); changed.evidence.referee.officials[0].name += ' CHANGED';
  assert.doesNotMatch(renderToStaticMarkup(context.SoccerScoringReadiness({ result: changed, game: changed.evidence.game })), /來源內容已保存並核對/);
  console.log('PASS archived current provider facts: exact source/game/team/time, complete XI/named officials only, clone/mutation/borrowed-scope rejection, saved UI binding; unchanged formal blockers and null S/W/R');
} finally {
  for (const key of Object.keys(before)) { if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key]; }
  await fixture.close();
}
