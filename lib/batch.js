import { MARKET_ORDER, hasActualWater, marketIsOpen, validateMarketPair } from './markets.js';

export const BATCH_VERSION = 'MLB-AUTO-ANALYZE-ALL-2026-08-v1';

const fallbackId = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;

export function blankDirection() {
  return { pick: '', water: null, waterEstimated: false, waterMissing: false, confidence: 0, sourceType: 'ACTUAL_TW_CREDIT', lineAsOf: '', executable: true, marketVerification: null };
}

export function withFallbackWater(game, settings) {
  return {
    ...game,
    markets: MARKET_ORDER.map(market => {
      const source = game?.markets?.find(item => item.market === market) || { market, directions: [] };
      const directions = [0, 1].map(index => ({ ...blankDirection(), ...(source.directions?.[index] || {}) }));
      const opened = marketIsOpen(directions);
      if (!opened) return { market, directions };
      const actualCount = directions.filter(direction => hasActualWater(direction.water) && !direction.waterEstimated).length;
      const bothMissing = directions.every(direction => !hasActualWater(direction.water));
      if (bothMissing) {
        const fallback = Number(settings?.fallbackWater?.[market] || 0.95);
        return {
          market,
          directions: directions.map(direction => ({ ...direction, water: fallback, waterEstimated: true, waterMissing: false, sourceType: 'ESTIMATED', executable: false })),
        };
      }
      if (actualCount === 1) {
        return {
          market,
          directions: directions.map(direction => hasActualWater(direction.water)
            ? { ...direction, water: Number(direction.water), waterEstimated: Boolean(direction.waterEstimated), waterMissing: false }
            : { ...direction, water: null, waterEstimated: false, waterMissing: true }),
        };
      }
      return {
        market,
        directions: directions.map(direction => ({
          ...direction,
          water: hasActualWater(direction.water) ? Number(direction.water) : null,
          waterMissing: !hasActualWater(direction.water),
        })),
      };
    }),
  };
}

export function flattenMarkets(game) {
  return MARKET_ORDER.flatMap(market => {
    const row = game?.markets?.find(item => item.market === market);
    if (!marketIsOpen(row?.directions || [])) return [];
    return (row?.directions || []).slice(0, 2).filter(direction => String(direction?.pick || '').trim()).map(direction => ({
      market,
      pick: String(direction.pick || ''),
      water: hasActualWater(direction.water) ? Number(direction.water) : null,
      waterEstimated: Boolean(direction.waterEstimated),
      confidence: Number(direction.confidence || 0),
      sourceType: direction.waterEstimated ? 'ESTIMATED' : (direction.sourceType || 'ACTUAL_TW_CREDIT'),
      lineAsOf: direction.lineAsOf || new Date().toISOString(),
      executable: direction.waterEstimated ? false : direction.executable !== false,
      marketVerification: direction.marketVerification || null,
    }));
  });
}

function closedMarket(market) {
  return { market, directions: [blankDirection(), blankDirection()] };
}

export function buildAutoAnalysisPlan({
  games,
  settings,
  version,
  batchId = fallbackId(),
  idFactory = fallbackId,
  now = () => new Date().toISOString(),
} = {}) {
  const locks = [];
  const issues = [];
  const preparedGames = [];

  for (const source of Array.isArray(games) ? games : []) {
    const prepared = withFallbackWater(source, settings || {});
    const label = `${prepared?.away || '客隊'} 對 ${prepared?.home || '主隊'}`;
    if (!prepared?.matchedGame) {
      issues.push(`${label}：尚未配對 MLB 官方賽事，保留在盤口確認頁`);
      preparedGames.push(prepared);
      continue;
    }

    const gameIssues = [];
    const safeMarkets = MARKET_ORDER.map(market => {
      const row = prepared.markets?.find(item => item.market === market) || closedMarket(market);
      if (!marketIsOpen(row.directions || [])) return closedMarket(market);
      const errors = validateMarketPair(market, row.directions || []);
      if (errors.length) {
        gameIssues.push(...errors.map(error => `${market}：${error}`));
        return closedMarket(market);
      }
      return row;
    });
    const safeGame = { ...prepared, markets: safeMarkets };
    const markets = flattenMarkets(safeGame);
    preparedGames.push(safeGame);

    if (!markets.length) {
      issues.push(`${label}：沒有可自動分析的有效開盤市場`);
      if (gameIssues.length) issues.push(...gameIssues.map(error => `${label}｜${error}`));
      continue;
    }

    if (gameIssues.length) issues.push(...gameIssues.map(error => `${label}｜${error}，該市場已略過`));
    locks.push({
      id: idFactory(),
      batchId,
      sourceId: prepared.id || null,
      source: 'auto-upload-all',
      lockedAt: now(),
      game: prepared.matchedGame,
      markets,
      recognitionIssues: gameIssues,
      version,
      status: 'locked',
    });
  }

  return {
    batchId,
    version: BATCH_VERSION,
    locks,
    issues: [...new Set(issues)],
    preparedGames,
    recognizedGameCount: Array.isArray(games) ? games.length : 0,
    directionCount: locks.reduce((sum, lock) => sum + lock.markets.length, 0),
    marketCount: locks.reduce((sum, lock) => sum + new Set(lock.markets.map(row => row.market)).size, 0),
  };
}
