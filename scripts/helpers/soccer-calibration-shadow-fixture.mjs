import fs from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { soccerCalibrationShadowArtifacts } from '../../lib/soccer/calibration-frozen.js';
import { predictSoccerCalibrationResearch, soccerCalibrationHash } from '../../lib/soccer/calibration-research.js';

// Provider-shaped synthetic FUTURE fixtures. Never persisted in Production or
// mixed with the retained real 35-game development package.
export function soccerCalibrationShadowFixture(count = 3) {
  const source = JSON.parse(gunzipSync(fs.readFileSync('research/soccer/calibration-v1/retained-documents.json.gz'))).epl;
  const summaryTemplate = source.summaries[0], originalId = summaryTemplate.data.header.id;
  const eventTemplate = source.scoreboard.data.events.find(event => event.id === originalId);
  const artifacts = soccerCalibrationShadowArtifacts('epl'), now = Date.parse('2026-11-03T12:01:00.000Z');
  const freezeReceipt = { freezeId: 'a'.repeat(64), frozenAt: '2026-10-31T23:00:00.000Z', candidateHash: artifacts.candidate.contentHash, planHash: artifacts.plan.contentHash };
  const records = Array.from({ length: count }, (_, index) => {
    const id = String(999999900 + index), teams = summaryTemplate.data.header.competitions[0].competitors;
    const home = teams.find(team => team.homeAway === 'home').team.id, away = teams.find(team => team.homeAway === 'away').team.id;
    const game = { id: `soccer:epl:${id}`, sourceId: id, league: 'epl', date: '2026-11-03', startTime: '2026-11-02T19:00:00.000Z', status: 'scheduled', neutralSite: false,
      home: { id: `soccer:epl:team:${home}`, sourceId: home }, away: { id: `soccer:epl:team:${away}`, sourceId: away } };
    const capturedAt = '2026-11-01T12:00:00.000Z', forecast = predictSoccerCalibrationResearch({ ...artifacts, game, now: Date.parse(capturedAt) });
    const prediction = { game, candidateHash: artifacts.candidate.contentHash, capturedAt, fullTime: forecast.fullTime, halfTime: forecast.halfTime };
    return { prediction, captureReceipt: { captureId: soccerCalibrationHash(id), freezeId: freezeReceipt.freezeId, capturedAt, predictionHash: soccerCalibrationHash(prediction) } };
  });
  const refresh = document => { document.source.contentHash = createHash('sha256').update(JSON.stringify(document.data)).digest('hex'); return document; };
  function resultDocuments(record, { homeScore = null, live = false, extraPeriod = false } = {}) {
    const game = record.prediction.game, scoreboard = structuredClone(source.scoreboard), summary = structuredClone(summaryTemplate), event = structuredClone(eventTemplate);
    event.id = game.sourceId; event.uid = `s:600~l:700~e:${game.sourceId}`; event.date = game.startTime;
    event.competitions[0].id = game.sourceId; event.competitions[0].uid = `${event.uid}~c:${game.sourceId}`;
    event.competitions[0].date = game.startTime; event.competitions[0].startDate = game.startTime; event.competitions[0].neutralSite = game.neutralSite;
    summary.data.header.id = game.sourceId; summary.data.header.uid = event.uid;
    summary.data.header.competitions[0].id = game.sourceId; summary.data.header.competitions[0].uid = event.competitions[0].uid;
    summary.data.header.competitions[0].date = game.startTime; summary.data.header.competitions[0].neutralSite = game.neutralSite;
    if (homeScore !== null) {
      event.competitions[0].competitors.find(team => team.homeAway === 'home').score = String(homeScore);
      const h = summary.data.header.competitions[0].competitors.find(team => team.homeAway === 'home'); h.score = String(homeScore);
      h.linescores = [{ period: 1, value: 1 }, { period: 2, value: homeScore - 1 }];
      const a = summary.data.header.competitions[0].competitors.find(team => team.homeAway === 'away'); a.linescores = [{ period: 1, value: 1 }, { period: 2, value: Number(a.score) - 1 }];
    }
    if (live) { const status = { period: 2, type: { name: 'STATUS_IN_PROGRESS', state: 'in', completed: false } };
      event.status = structuredClone(status); event.competitions[0].status = structuredClone(status); summary.data.header.competitions[0].status = structuredClone(status); }
    if (extraPeriod) {
      summary.data.keyEvents.push({ id: 'extra-period-proof', period: { number: 3 } });
      summary.data.header.competitions[0].status = { period: 3, type: { name: 'STATUS_FINAL_AET', state: 'post', completed: true } };
    }
    scoreboard.data.events = [event]; scoreboard.source.url = 'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard?dates=20261102&limit=1000';
    summary.source.url = `https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/summary?event=${game.sourceId}`;
    for (const document of [scoreboard, summary]) { document.source.fetchedAt = new Date(now - 10000).toISOString(); document.source.requestedAt = document.source.fetchedAt; refresh(document); }
    return { scoreboard, summaries: [summary] };
  }
  function context(captureIds = null, limit = 100) {
    return { ...artifacts, freezeReceipt, records: records.filter(record => captureIds === null || captureIds.includes(record.captureReceipt.captureId)).slice(0, limit),
      verifyFreezeReceipt: ({ receipt, candidateHash, planHash }) => soccerCalibrationHash(receipt) === soccerCalibrationHash(freezeReceipt)
        && candidateHash === artifacts.candidate.contentHash && planHash === artifacts.plan.contentHash,
      verifyCaptureReceipt: ({ receipt, predictionHash, capturedAt }) => records.some(record => soccerCalibrationHash(record.captureReceipt) === soccerCalibrationHash(receipt)
        && record.captureReceipt.predictionHash === predictionHash && record.prediction.capturedAt === capturedAt) };
  }
  return { source, artifacts, now, freezeReceipt, records, resultDocuments, context };
}
