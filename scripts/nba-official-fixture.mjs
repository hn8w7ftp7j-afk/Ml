// Convert already downloaded official pages into minimal factual test evidence.
// This script never downloads or preserves advertising/odds/editorial content.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { parseNbaPage } from '../lib/nba/official.js';
const [schedulePath, gamePath, output] = process.argv.slice(2);
if (!schedulePath || !gamePath || !output) throw new Error('schedule.html game.html new-output.json required');
const read = path => { const html = fs.readFileSync(path, 'utf8'); return { value: parseNbaPage(html), hash: createHash('sha256').update(html).digest('hex'), fetchedAt: fs.statSync(path).mtime.toISOString() }; };
const schedule = read(schedulePath); const box = read(gamePath); const game = box.value.game;
const pick = (obj, keys) => Object.fromEntries(keys.map(key => [key, obj[key]]));
const team = obj => ({ ...pick(obj, ['teamId', 'teamTricode', 'score', 'periods']), players: obj.players.map(p => ({ ...pick(p, ['personId', 'firstName', 'familyName']), statistics: pick(p.statistics || {}, ['points']) })) });
const cards = schedule.value.gameCardFeed.modules.flatMap(m => m.cards || []).filter(c => c.cardData?.gameId === game.gameId).map(c => ({ cardData: { ...pick(c.cardData, ['gameId', 'leagueId', 'gameTimeUtc', 'seasonType', 'shareUrl']), homeTeam: pick(c.cardData.homeTeam, ['teamId', 'teamTricode']), awayTeam: pick(c.cardData.awayTeam, ['teamId', 'teamTricode']) } }));
const result = { kind: 'real_official_normalized_subset', sources: [{ url: `https://www.nba.com/games?date=${schedule.value.selectedDate}`, hash: schedule.hash, fetchedAt: schedule.fetchedAt }, { url: `${cards[0].cardData.shareUrl}/box-score`, hash: box.hash, fetchedAt: box.fetchedAt }], schedule: { selectedDate: schedule.value.selectedDate, gameCardFeed: { modules: [{ cards }] } }, game: { ...pick(game, ['gameId', 'gameTimeUTC', 'homeTeamId', 'awayTeamId', 'gameStatus']), homeTeam: team(game.homeTeam), awayTeam: team(game.awayTeam) } };
fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
