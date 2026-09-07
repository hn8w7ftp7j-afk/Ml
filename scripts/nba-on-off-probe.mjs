// Read-only diagnostic for an explicitly supplied, previously acquired ESPN
// summary. File-read time is not represented as provider publication time.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { normalizeGame, normalizeStatistics } from '../lib/nba/data.js';
import { normalizePlayer } from '../lib/nba/identity.js';
import { deriveNbaOnOff } from '../lib/nba/on-off.js';
const file = process.argv[2];
if (!file) throw new Error('Usage: node scripts/nba-on-off-probe.mjs <previously-acquired-summary.json>');
const raw = fs.readFileSync(file, 'utf8'); const summary = JSON.parse(raw);
const game = normalizeGame(summary.header);
for (const block of summary.boxscore.teams) game[block.team.id === game.home.sourceId ? 'home' : 'away'].statistics = normalizeStatistics(block.statistics);
const players = summary.boxscore.players.flatMap(block => block.statistics.flatMap(group => group.athletes.map(row => ({
  ...normalizePlayer(row.athlete, `nba:espn:team:${block.team.id}`), starter: row.starter, didNotPlay: row.didNotPlay,
  statistics: group.keys.map((name, i) => ({ name, displayValue: row.stats[i] })),
}))));
const result = deriveNbaOnOff(game, players, summary.plays);
console.log(JSON.stringify({ fileHash: createHash('sha256').update(raw).digest('hex'), gameId: game.id, result }, null, 2));
if (result.status !== 'ready') process.exitCode = 1;
