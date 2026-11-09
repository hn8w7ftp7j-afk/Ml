import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { fetchSoccerSchedule } from '../../lib/soccer/data.js';
import { normalizeSoccerPrematch } from '../../lib/soccer/prematch.js';
import { buildSoccerAnalysis } from '../../lib/soccer/analysis.js';
import { soccerCompleteScheduleAuthorityVerified } from '../../lib/soccer/reader-identity-proof.js';
import { parseSoccerCapture } from '../../reader/soccer-parser.js';
import { validateSoccerCapture } from '../../lib/soccer/reader.js';
import { soccerDate } from '../../lib/soccer/contracts.js';

// Invented future game and quote values, through the real provider adapter,
// Reader parser and scoped identity proof. No provider/account is contacted.
export async function soccerPredictionLiveFixture({ league = 'epl', now = Date.now(), totalLine = '0.5', water = .95 } = {}) {
  assert.ok(['epl', 'ucl'].includes(league));
  const at = new Date(now).toISOString(), start = new Date(Math.ceil((now + 86400000) / 60000) * 60000).toISOString(), date = soccerDate(start);
  const payload = JSON.parse(fs.readFileSync(`scripts/fixtures/soccer/${league}-summary.json`));
  payload.header.date = start;
  const competition = payload.header.competitions[0];
  competition.date = start; competition.status = { type: { state: 'pre', completed: false, name: 'STATUS_SCHEDULED' } };
  const raw = { ...payload.header, date: start, status: competition.status }, providerLeague = payload.header.league;
  const board = await fetchSoccerSchedule(league, date, { now: () => now,
    fetchImpl: async () => Response.json({ leagues: [providerLeague], events: [raw] }) });
  assert.equal(board.ok, true);
  const game = board.games[0];
  assert.equal(soccerCompleteScheduleAuthorityVerified(board, game), true);
  const slug = league === 'epl' ? 'eng.1' : 'uefa.champions';
  const source = { provider: 'ESPN', url: `https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/summary?event=${game.sourceId}`,
    fetchedAt: at, contentHash: createHash('sha256').update(JSON.stringify(payload)).digest('hex') };
  const evidence = normalizeSoccerPrematch(payload, game, source, now);
  assert.equal(evidence.ok, true); evidence.scheduleSource = game.source;
  const pageLabel = league === 'epl' ? '英格蘭超級聯賽' : '歐洲冠軍聯賽';
  const local = new Date(Date.parse(start) + 8 * 3600000).toISOString(), time = local.slice(11, 16);
  const day = `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
  const capture = { league: league.toUpperCase(), pageLeagueLabel: pageLabel, sourceHost: 'www.tai888.in',
    pageUrl: 'https://www.tai888.in/newapp/', observedAt: at,
    tables: ['FT', 'HT'].map(period => { const label = period === 'FT' ? '全場' : '上半場'; return {
      sectionTitle: `${pageLabel} ${label}`, headers: ['時間', '隊伍', `${label}讓球`, `${label}大小`, `${label}獨贏`],
      rows: [{ cells: [{ pair: [day, time] }, { pair: [game.away.name, `${game.home.name}[主]`] },
        { pair: [String(water), `0.5 ${water}`] }, { pair: [`大${totalLine} ${water}`, `小 ${water}`] },
        { pair: ['主勝 -', '和 -', '客勝 -'] }] }],
    }; }),
  };
  const parsed = parseSoccerCapture(capture, new Date(now));
  assert.deepEqual(parsed.parseIssues, []);
  const checked = validateSoccerCapture({ ...parsed, readerVersion: '2.1.60', pageActivityAt: at }, { now, headerVersion: '2.1.60' });
  assert.equal(checked.ok, true, JSON.stringify(checked));
  const reader = { ...checked.payload, revision: 'a'.repeat(64), observationId: 'b'.repeat(64), firstFetchedAt: at, receivedAt: at, persistedAt: at };
  const build = () => buildSoccerAnalysis({ evidence, reader, schedule: board, now });
  return { league, now, at, start, date, game, evidence, reader, readerPayload: checked.payload, board, capture, build };
}
