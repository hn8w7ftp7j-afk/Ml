// Reproducible, real-source historical research. Output uses exclusive creation;
// fixtures from unit tests are never used as fallback provider data.
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadNbaData } from '../lib/nba/data.js';
import { analyzeNbaShadow } from '../lib/nba/shadow.js';
const args = Object.fromEntries(process.argv.slice(2).map(arg => arg.replace(/^--/, '').split('=')));
if (!args.output || !args.team || !args.season) throw new Error('Required: --team=5 --season=2026 --output=/absolute/new-report.json [--type=regular]');
const seasonType = args.type || 'regular';
const history = await loadNbaData({ view: 'history', id: args.team, season: Number(args.season), seasonType });
if (history.status !== 'ready' || history.qa.status === 'BLOCK') throw new Error(JSON.stringify(history.qa));
const games = []; const sources = [...history.sources]; const failures = [];
for (const game of history.data.games) {
  const result = await loadNbaData({ view: 'game', id: game.sourceId });
  const actual = result.data.game;
  if (result.status === 'ready' && result.qa.status !== 'BLOCK' && actual && actual.id === game.id && actual.startTime === game.startTime && actual.season.year === game.season.year && actual.seasonType === game.seasonType && actual.home.id === game.home.id && actual.away.id === game.away.id && actual.home.score === game.home.score && actual.away.score === game.away.score) games.push(actual);
  else {
    games.push({ ...game, home: { ...game.home, statistics: [] }, away: { ...game.away, statistics: [] } });
    failures.push({ gameId: game.id, status: result.status, qa: result.status === 'ready' && actual ? { status: 'BLOCK', issues: [{ code: 'HISTORY_SUMMARY_IDENTITY_CONFLICT', message: '賽程與 box score 的比賽、時間、球季或比分不一致。' }] } : result.qa });
  }
  sources.push(...result.sources.map(source => ({ ...source, gameId: game.id })));
  console.log(`${games.length}/${history.data.games.length} ${game.id} ${result.status}`);
}
const research = analyzeNbaShadow(games, { teamId: history.data.team.id, seasonType });
if (failures.some(row => row.qa.status === 'BLOCK')) {
  research.status = 'blocked'; research.qa.status = 'BLOCK'; research.validation = null;
  research.qa.issues.push({ code: 'SOURCE_IDENTITY_BLOCK', severity: 'BLOCK', message: '至少一場來源身分或完整性未通過 QA，不能將其隱藏成普通缺值後宣稱驗證成功。' });
}
const artifact = { kind: 'nba-real-source-shadow-validation', generatedAt: new Date().toISOString(), provider: 'ESPN', team: history.data.team, season: Number(args.season), seasonType, failures, sources, research, games };
const destination = path.resolve(args.output);
await fs.mkdir(path.dirname(destination), { recursive: true });
await fs.writeFile(destination, JSON.stringify(artifact, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ output: destination, status: research.status, counts: research.counts, validation: research.validation, failures: failures.length }));
if (research.qa.status === 'BLOCK' || failures.length) process.exitCode = 1;
