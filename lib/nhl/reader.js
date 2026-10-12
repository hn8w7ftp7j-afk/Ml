import { nhlContentHash } from './context.js';
import '../../reader/nhl-teams.js';
import '../../reader/league-registry.js';
import { parseReaderMarketRows, sanitizeTai888PageUrl } from '../../reader/parser.js';

export const NHL_READER_INTERFACE_VERSION = 'NHL-READER-EVIDENCE-v1';
export const NHL_READER_WAITING_MESSAGE = '等待真實 Tai888 NHL 盤驗證';

// Page labels and parsed quotes are evidence, never executable contracts.
// Official game IDs and OT/SO/void semantics require independent verification.
export function validateNhlCapture(input, { now = Date.now(), headerVersion = null } = {}) {
  const errors = [];
  if (!Number.isFinite(now)) errors.push('NHL_READER_CLOCK_INVALID');
  const validText = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[<>\u0000-\u001f]/.test(value);
  if (input?.league !== 'NHL' || input?.provider !== 'TAI888_READER' || input?.interfaceVersion !== NHL_READER_INTERFACE_VERSION) errors.push('NHL_READER_IDENTITY_INVALID');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input?.boardDate || '') || !Number.isFinite(Date.parse(`${input?.boardDate}T00:00:00Z`))
    || new Date(`${input?.boardDate}T00:00:00Z`).toISOString().slice(0, 10) !== input.boardDate) errors.push('NHL_READER_DATE_INVALID');
  let sourceHost = '';
  try {
    const page = new URL(input.pageUrl);
    sourceHost = page.hostname;
    if (page.protocol !== 'https:' || page.username || page.password || (page.port && page.port !== '443')) errors.push('NHL_READER_SOURCE_INVALID');
  } catch { errors.push('NHL_READER_SOURCE_INVALID'); }
  if (!/^(?:[a-z0-9-]+\.)*tai888\.(?:in|com)$/i.test(sourceHost)) errors.push('NHL_READER_SOURCE_INVALID');
  const observed = Date.parse(input?.observedAt);
  if (typeof input?.observedAt !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/.test(input.observedAt)
    || !Number.isFinite(observed) || observed > now + 5_000 || now - observed > 5 * 60_000) errors.push('NHL_READER_STALE');
  if (!validText(input?.readerVersion, 80) || !validText(input?.pageLeagueLabel, 100) || !/NHL|國家冰球|北美冰球/i.test(input.pageLeagueLabel)) errors.push('NHL_READER_LEAGUE_UNCONFIRMED');
  if (headerVersion != null && input?.readerVersion !== headerVersion) errors.push('NHL_READER_VERSION_MISMATCH');
  const rawRows = Array.isArray(input?.rawRows) ? input.rawRows : [];
  if (!Array.isArray(input?.rawRows)) errors.push('NHL_READER_ROWS_MISSING');
  if (rawRows.length > 100) errors.push('NHL_READER_TOO_MANY_ROWS');
  const rows = rawRows.slice(0, 100).map(row => {
    if (!validText(row?.eventLabel, 320) || !validText(row?.marketLabel, 100) || !validText(row?.lineText, 500)
      || !validText(row?.sourceRowId, 100)) errors.push('NHL_READER_ROW_INVALID');
    if (row?.settlementRuleText != null && !validText(row.settlementRuleText, 500)) errors.push('NHL_READER_RULE_TEXT_INVALID');
    return { sourceRowId: row?.sourceRowId, eventLabel: row?.eventLabel, marketLabel: row?.marketLabel,
      lineText: row?.lineText, settlementRuleText: validText(row?.settlementRuleText, 500) ? row.settlementRuleText : null };
  });
  if (new Set(rows.map(row => row.sourceRowId)).size !== rows.length) errors.push('NHL_READER_DUPLICATE_ROW');
  const games = [];
  if (input?.games != null) {
    if (!Array.isArray(input.games) || input.games.length > 40) errors.push('NHL_READER_GAMES_INVALID');
    if (!globalThis.Tai888LeagueRegistry.standardMarker(input.pageLeagueLabel, 'NHL')) errors.push('NHL_READER_SECTION_UNCONFIRMED');
    for (const game of Array.isArray(input.games) ? input.games.slice(0, 40) : []) {
      const away = globalThis.Tai888NhlTeams.resolve(game?.awayRaw);
      const home = globalThis.Tai888NhlTeams.resolve(game?.homeRaw);
      const homeMarker = /[\[［【(（]\s*主\s*[\]］】)）]/u;
      if (game?.league !== 'NHL' || game?.boardDate !== input.boardDate || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(game?.boardTime || '')
        || !away || !home || away.code === home.code || game?.awayAbbrev !== away?.code || game?.homeAbbrev !== home?.code
        || game?.awayTeamId !== away?.teamId || game?.homeTeamId !== home?.teamId
        || homeMarker.test(game?.awayRaw || '') || !homeMarker.test(game?.homeRaw || '')
        || game?.executable !== false) { errors.push('NHL_READER_GAME_IDENTITY_INVALID'); continue; }
      if (!Array.isArray(game.teamEvidence) || game.teamEvidence.length !== 2
        || globalThis.Tai888NhlTeams.resolve(game.teamEvidence[0])?.code !== away.code
        || globalThis.Tai888NhlTeams.resolve(game.teamEvidence[1])?.code !== home.code
        || homeMarker.test(game.teamEvidence[0]) || !homeMarker.test(game.teamEvidence[1])) errors.push('NHL_READER_TEAM_EVIDENCE_INVALID');
      if (game.rawRowText != null && (typeof game.rawRowText !== 'string' || game.rawRowText.length > 2000 || /[<>\u0000-\u001f]/.test(game.rawRowText))) errors.push('NHL_READER_ROW_INVALID');
      const evidence = [];
      for (const market of Array.isArray(game.rawMarketEvidence) ? game.rawMarketEvidence : []) {
        if (!validText(market?.key, 50) || !validText(market?.label, 100) || !Array.isArray(market.rawRows) || market.rawRows.length !== 2
          || market.rawRows.some(value => typeof value !== 'string' || value.length > 240 || /[<>\u0000-\u001f]/.test(value))) {
          errors.push('NHL_READER_MARKET_EVIDENCE_INVALID'); continue;
        }
        evidence.push({ key: market.key, label: market.label, rawRows: [...market.rawRows] });
      }
      if (evidence.length > 10 || new Set(evidence.map(market => market.key)).size !== evidence.length) errors.push('NHL_READER_MARKET_EVIDENCE_INVALID');
      const identity = `NHL:${game.boardDate}:${game.boardTime}:${away.code}:${home.code}`;
      const expectedRows = evidence.filter(value => value.rawRows.some(Boolean)).map(value => ({ sourceRowId: `${identity}:${value.key}`,
        eventLabel: `${game.awayRaw} @ ${game.homeRaw}`, marketLabel: value.label,
        lineText: value.rawRows.filter(Boolean).join(' | '), settlementRuleText: null }));
      const canonicalRows = (Array.isArray(game.rawRows) ? game.rawRows : []).map(row => ({ sourceRowId: row?.sourceRowId,
        eventLabel: row?.eventLabel, marketLabel: row?.marketLabel, lineText: row?.lineText, settlementRuleText: row?.settlementRuleText ?? null }));
      if (JSON.stringify(expectedRows) !== JSON.stringify(canonicalRows)
        || expectedRows.some(row => !rows.some(flat => JSON.stringify(flat) === JSON.stringify(row)))) errors.push('NHL_READER_ROW_EVIDENCE_MISMATCH');
      const parsedMarkets = {};
      for (const [key, property] of [['runline', 'fullRunline'], ['total', 'fullTotal']]) {
        const quote = evidence.find(market => market.key === key);
        parsedMarkets[property] = quote ? parseReaderMarketRows(property, quote.rawRows) : null;
      }
      games.push({ league: 'NHL', boardDate: game.boardDate, boardTime: game.boardTime, startTime: game.boardTime,
        awayAbbrev: away.code, homeAbbrev: home.code, awayTeamId: away.teamId, homeTeamId: home.teamId,
        awayRaw: game.awayRaw, homeRaw: game.homeRaw, teamEvidence: Array.isArray(game.teamEvidence) ? [...game.teamEvidence] : [],
        rawRowText: game.rawRowText || '',
        marketStatus: game.marketStatus === 'locked' ? 'locked' : 'open', rawRows: expectedRows, rawMarketEvidence: evidence,
        parsedMarkets, executable: false, scoreScope: null, includesOvertime: null, shootoutRule: null, voidRuleId: null,
      });
    }
    const allGameRows = games.flatMap(game => game.rawRows);
    if (allGameRows.length !== rows.length || new Set(games.map(game => `${game.boardDate}:${game.boardTime}:${game.awayAbbrev}:${game.homeAbbrev}`)).size !== games.length) errors.push('NHL_READER_GAME_ROW_SET_INVALID');
  }
  if (errors.length) return { ok: false, status: 'BLOCK', errors: [...new Set(errors)] };
  const payload = { league: 'NHL', provider: 'TAI888_READER', interfaceVersion: NHL_READER_INTERFACE_VERSION,
    boardDate: input.boardDate, observedAt: new Date(observed).toISOString(), sourceHost,
    pageUrl: sanitizeTai888PageUrl(input.pageUrl),
    readerVersion: input.readerVersion, pageLeagueLabel: input.pageLeagueLabel, rawRows: rows,
    ...(input?.games != null ? { games } : {}),
    marketVerification: 'WAITING_REAL_TAI888_NHL_EVIDENCE', executable: false };
  return { ok: true, status: 'WAITING_REAL_DATA', message: NHL_READER_WAITING_MESSAGE, payload: { ...payload, sourceHash: nhlContentHash(payload) } };
}
