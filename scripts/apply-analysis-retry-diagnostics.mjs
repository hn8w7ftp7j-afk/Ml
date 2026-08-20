import fs from 'node:fs';

const path = 'app/page.js';
let source = fs.readFileSync(path, 'utf8');

const oldRequestError = `      const error = new Error(data.error || \`請求失敗（\${response.status}）\`);\n      error.status = response.status;\n      throw error;`;
const newRequestError = `      const error = new Error(data.error || \`請求失敗（\${response.status}）\`);\n      error.status = response.status;\n      error.code = data.code || '';\n      error.blocking = Array.isArray(data.blocking) ? data.blocking : [];\n      error.warnings = Array.isArray(data.warnings) ? data.warnings : [];\n      throw error;`;
if (!source.includes(oldRequestError)) throw new Error('requestJSON error block not found');
source = source.replace(oldRequestError, newRequestError);

const oldAnalyze = `      const baseData = await requestJSON('/api/analyze', {\n        method: 'POST',\n        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': uid() },\n        body: JSON.stringify({\n          league,\n          game,\n          markets: actualMarkets,\n          verificationMarkets: [],\n          settings: { ...settings, rebateRate: 0.015, candidateThreshold: 7.2, strongestThreshold: 8.5, expertMode: 'off' },\n        }),\n      }, 180000);`;
const newAnalyze = `      const analyzeRequest = () => requestJSON('/api/analyze', {\n        method: 'POST',\n        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': uid() },\n        body: JSON.stringify({\n          league,\n          game,\n          markets: actualMarkets,\n          verificationMarkets: [],\n          settings: { ...settings, rebateRate: 0.015, candidateThreshold: 7.2, strongestThreshold: 8.5, expertMode: 'off' },\n        }),\n      }, 180000);\n      let baseData;\n      try {\n        baseData = await analyzeRequest();\n      } catch (firstError) {\n        const retryable = !Number(firstError?.status) || Number(firstError.status) >= 500 || /逾時|timeout|fetch|network/i.test(String(firstError?.message || ''));\n        if (!retryable) throw firstError;\n        await new Promise(resolve => window.setTimeout(resolve, 900));\n        baseData = await analyzeRequest();\n      }`;
if (!source.includes(oldAnalyze)) throw new Error('analyze request block not found');
source = source.replace(oldAnalyze, newAnalyze);

const oldCatch = `      const message = String(cause?.message || cause);\n      const blocked = /資料不足｜不評分|比賽已開打或結束/.test(message);\n      updateBoard(game.gamePk, item => ({\n        ...item,\n        status: blocked ? 'blocked' : 'failed',\n        statusLabel: blocked ? '資料不足｜不評分' : '分析失敗',\n        error: message,\n      }));`;
const newCatch = `      const message = String(cause?.message || cause);\n      const blocked = /資料不足｜不評分|比賽已開打或結束/.test(message) || cause?.code === 'CORE_DATA_MISSING';\n      const blocking = Array.isArray(cause?.blocking) && cause.blocking.length ? \`｜缺少：\${cause.blocking.join('、')}\` : '';\n      const diagnostic = \`\${message}\${blocking}\`;\n      console.error('[CLIENT_ANALYZE_FAILED]', { league, gamePk: game?.gamePk, matchup: matchup(game), status: cause?.status || null, code: cause?.code || null, blocking: cause?.blocking || [], message });\n      updateBoard(game.gamePk, item => ({\n        ...item,\n        status: blocked ? 'blocked' : 'failed',\n        statusLabel: blocked ? '資料不足｜不評分' : '分析失敗',\n        error: diagnostic,\n      }));`;
if (!source.includes(oldCatch)) throw new Error('analyze catch block not found');
source = source.replace(oldCatch, newCatch);

fs.writeFileSync(path, source);
console.log('analysis retry + per-game diagnostics patch applied');
