from pathlib import Path

# Unit tests
p = Path('scripts/test.mjs')
s = p.read_text()
s = s.replace('  normalizeVisionGame,', '  mirrorTaiwanLineToken,\n  normalizeVisionGame,')
s = s.replace(
    "assert.deepEqual(validateMarketPair('全場大小', [{ pick: '大8+50', water: 0.94 }, { pick: '小8+50', water: null }]), []);",
    "assert.deepEqual(validateMarketPair('全場大小', [{ pick: '大8+50', water: 0.94 }, { pick: '小8-50', water: null }]), []);\n"
    "assert.ok(validateMarketPair('全場大小', [{ pick: '大8+50', water: 0.94 }, { pick: '小8+50', water: 0.94 }]).some(error => error.includes('尾數必須鏡像')));\n"
    "assert.equal(mirrorTaiwanLineToken('8-80'), '8+80');\n"
    "assert.equal(mirrorTaiwanLineToken('1+40'), '1-40');"
)
s = s.replace(
    "fullRunline: { favoriteSide: 'away', line: '1+50', favoriteWater: null, underdogWater: null, confidence: 1 },",
    "fullRunline: { lineSide: 'away', line: '1+50', awayWater: null, homeWater: null, confidence: 1 },"
)
s = s.replace(
    "assert.equal(vision.markets[1].directions[1].water, null);",
    "assert.equal(vision.markets[1].directions[1].water, null);\n"
    "assert.equal(vision.markets[0].directions[0].pick, `${away}讓1+50`);\n"
    "assert.equal(vision.markets[0].directions[1].pick, `${home}受讓1-50`);\n"
    "assert.equal(vision.markets[1].directions[0].pick, '大8+50');\n"
    "assert.equal(vision.markets[1].directions[1].pick, '小8-50');"
)
s = s.replace(
    "first5Runline: { favoriteSide: 'away', line: 'undefined', favoriteWater: null, underdogWater: null, confidence: 0 },",
    "first5Runline: { lineSide: 'away', line: 'undefined', awayWater: null, homeWater: null, confidence: 0 },"
)
s = s.replace(
    "fullRunline: { favoriteSide:'home', line:'9-10', favoriteWater:0.95, underdogWater:null }",
    "fullRunline: { lineSide:'home', line:'9-10', awayWater:null, homeWater:0.95 }"
)
s = s.replace(
    "assert.equal(compactVision.games[0].fullRunline.favoriteSide, 'away');\nassert.equal(compactVision.games[0].fullRunline.underdogWater, null);",
    "assert.equal(compactVision.games[0].fullRunline.lineSide, 'away');\n"
    "assert.equal(compactVision.games[0].fullRunline.awayWater, 0.95);\n"
    "assert.equal(compactVision.games[0].fullRunline.homeWater, null);"
)
s = s.replace('assert.match(VISION_VERSION, /v7\\.3\\.0$/);', 'assert.match(VISION_VERSION, /v8\\.1\\.0$/);')
s = s.replace(
    "assert.ok(scoreFromCompositeEV(-0.03, { weightedEV: -0.02, robustEV: -0.04, flipProbability: 0.8, quality: 0.9 }) >= 3.5);\n"
    "assert.ok(scoreFromCompositeEV(-0.03, { weightedEV: -0.02, robustEV: -0.04, flipProbability: 0.8, quality: 0.9 }) <= 6.6);\n"
    "assert.ok(scoreFromCompositeEV(0.01, { weightedEV: 0.02, robustEV: -0.001, flipProbability: 0.4, quality: 0.9 }) <= 7.1);\n"
    "assert.ok(scoreFromCompositeEV(0.12, { weightedEV: 0.15, robustEV: 0.10, flipProbability: 0.04, quality: 0.92, waterEstimated: true }) <= 6.6);",
    "assert.equal(scoreFromCompositeEV(0, { weightedEV: 0.01, robustEV: 0.01 }), 5);\n"
    "assert.ok(Math.abs(scoreFromCompositeEV(0.044, { weightedEV: 0.05, robustEV: 0.04 }) - 7.2) < 1e-12);\n"
    "assert.equal(scoreFromCompositeEV(0.05, { weightedEV: 0.06, robustEV: 0.05 }), 7.5);\n"
    "assert.equal(scoreFromCompositeEV(0.06, { weightedEV: 0.07, robustEV: 0.06 }), 8);\n"
    "assert.equal(scoreFromCompositeEV(0.07, { weightedEV: 0.08, robustEV: 0.07 }), 8.5);\n"
    "assert.equal(scoreFromCompositeEV(0.08, { weightedEV: 0.09, robustEV: 0.08 }), 9);\n"
    "assert.equal(scoreFromCompositeEV(0.10, { weightedEV: 0.11, robustEV: 0.10 }), 10);\n"
    "assert.ok(scoreFromCompositeEV(0.01, { weightedEV: 0.02, robustEV: -0.001 }) <= 7.1);\n"
    "assert.ok(scoreFromCompositeEV(0.12, { weightedEV: 0.15, robustEV: 0.10, waterEstimated: true }) <= 6.6);"
)
s = s.replace("{ market: '全場讓分', pick: `${home}受讓1+10`, water: 0.95, confidence: 1 },", "{ market: '全場讓分', pick: `${home}受讓1-10`, water: 0.95, confidence: 1 },")
s = s.replace("{ market: '全場大小', pick: '小8+90', water: 0.94, confidence: 1 },", "{ market: '全場大小', pick: '小8-90', water: 0.94, confidence: 1 },")
s = s.replace("{ market: '上半大小', pick: '小4+50', water: 0.93, confidence: 1 },", "{ market: '上半大小', pick: '小4-50', water: 0.93, confidence: 1 },")
s = s.replace('assert.ok(analysis.results.every(row => Number.isFinite(row.score) && row.score >= 3.5 && row.score <= 9.4));', 'assert.ok(analysis.results.every(row => Number.isFinite(row.score) && row.score >= 0 && row.score <= 10));')
s = s.replace('assert.ok(analysis.results.every(row => row.conservativeEV <= row.robustEV + 1e-10));', "assert.ok(analysis.results.every(row => row.cev === row.conservativeEV));\nassert.ok(analysis.results.every(row => row.scoreFormulaVersion === 'CEV20-5+50x-v1'));")
start = s.index("for (const result of analysis.results.filter(row => row.marketAnchorProbability != null)) {")
end = s.index("\nconst repeat = analyzeMarkets", start)
replacement = '''for (const result of analysis.results.filter(row => row.marketAnchorProbability != null)) {
  assert.equal(result.marketCalibrationApplied, true);
  assert.ok(result.marketCalibrationWeight >= 0.12 && result.marketCalibrationWeight <= 0.55);
  assert.ok(result.maximumCalibratedProbabilityEdge >= 0.05 && result.maximumCalibratedProbabilityEdge <= 0.12);
  assert.ok(result.calibratedMarketProbabilityGap <= result.maximumCalibratedProbabilityEdge + 1e-10);
  const expected = Math.min(result.integrityWarning || result.waterEstimated ? 6.6 : result.weightedEV <= 0 ? 6.6 : result.robustEV <= 0 ? 7.1 : 10, Math.max(0, Math.min(10, 5 + 50 * result.cev)));
  assert.ok(Math.abs(result.score - expected) < 1e-12);
}

const disagreementContext = structuredClone(context);
Object.assign(disagreementContext.home.seasonHitting, { runsPerGame: 6.20, ops: 0.900, iso: 0.245 });
Object.assign(disagreementContext.away.seasonHitting, { runsPerGame: 3.20, ops: 0.620, iso: 0.105 });
const disagreement = analyzeMarkets({ context: disagreementContext, markets: markets.filter(row => row.market === '全場讓分'), settings });
for (const row of disagreement.results) {
  assert.equal(row.marketCalibrationApplied, true);
  assert.ok(row.calibratedMarketProbabilityGap <= row.maximumCalibratedProbabilityEdge + 1e-10);
}
'''
s = s[:start] + replacement + s[end:]
s = s.replace("{ market: '全場大小', pick: '小8+50', water: null, confidence: 1 },", "{ market: '全場大小', pick: '小8-50', water: null, confidence: 1 },")
s = s.replace("missing.results.find(row => row.pick === '小8+50')", "missing.results.find(row => row.pick === '小8-50')")
s = s.replace("{ market: '全場大小', pick: '小8+50', water: 0.94, waterEstimated: true, confidence: 1 },", "{ market: '全場大小', pick: '小8-50', water: 0.94, waterEstimated: true, confidence: 1 },")
p.write_text(s)

# Production smoke
p = Path('scripts/smoke.mjs')
s = p.read_text()
s = s.replace("const VERSION = '8.0.0';", "const VERSION = '8.1.0';")
s = s.replace("const MODEL_VERSION = 'GPT完整指令聯合情境模型-2026-08-v8.0.0';", "const MODEL_VERSION = 'GPT完整指令聯合情境模型-2026-08-v8.1.0';")
s = s.replace("const RULES_VERSION = 'MLB-TW-EXECUTION-2026-08-v8.0.0';", "const RULES_VERSION = 'MLB-TW-EXECUTION-2026-08-v8.1.0';")
s = s.replace("const VISION_VERSION = 'MLB-VISION-2026-08-v7.3.0';", "const VISION_VERSION = 'MLB-VISION-2026-08-v8.1.0';")
s = s.replace('/第\\s*8\\.0\\.0\\s*版/', '/第\\s*8\\.1\\.0\\s*版/')
s = s.replace("const visionFixture = readFileSync(new URL('./fixtures/vision-table.b64', import.meta.url), 'utf8').replace(/\\s+/g, '');", "const visionFixture = readFileSync(new URL('./fixtures/dense-board-7games.b64', import.meta.url), 'utf8').replace(/\\s+/g, '');")
start = s.index('const visionSchedule = [')
end = s.index('const fullMarkets = [', start)
vision_block = r'''const visionSchedule = [
  [990001,'克里夫蘭守護者','芝加哥白襪','Cleveland Guardians','Chicago White Sox'],
  [990002,'明尼蘇達雙城','密爾瓦基釀酒人','Minnesota Twins','Milwaukee Brewers'],
  [990003,'芝加哥小熊','堪薩斯市皇家','Chicago Cubs','Kansas City Royals'],
  [990004,'科羅拉多落磯','聖路易紅雀','Colorado Rockies','St. Louis Cardinals'],
  [990005,'巴爾的摩金鶯','德州遊騎兵','Baltimore Orioles','Texas Rangers'],
  [990006,'底特律老虎','舊金山巨人','Detroit Tigers','San Francisco Giants'],
  [990007,'洛杉磯道奇','亞利桑那響尾蛇','Los Angeles Dodgers','Arizona Diamondbacks'],
].map(([gamePk,away,home,awayEnglish,homeEnglish]) => ({ gamePk, away, home, awayEnglish, homeEnglish, gameNumber:1, scheduledInnings:9 }));
const visionCapture = await json(`${BASE}/api/vision`, {
  method: 'POST', headers: originHeaders,
  body: JSON.stringify({ images: [`data:image/jpeg;base64,${visionFixture}`], schedule: visionSchedule, boardPass: true, defaultWater: { 全場讓分:0.95, 全場大小:0.94, 上半讓分:0.94, 上半大小:0.93 } }),
}, 180000);
assert.equal(visionCapture.value.visionVersion, VISION_VERSION);
assert.ok(visionCapture.value.model && visionCapture.value.model !== '本地信用盤解析器');
assert.equal(new Set(visionCapture.value.discoveredGamePks.map(String)).size, 7);
assert.equal(visionCapture.value.games.filter(row => row.gamePk).length, 7);
const visionById = new Map(visionCapture.value.games.map(row => [Number(row.gamePk), row]));
const picksFor = id => (visionById.get(id)?.markets || []).flatMap(row => row.directions || []).map(row => row.pick).filter(Boolean);
assert.ok(picksFor(990002).includes('密爾瓦基釀酒人讓2+60'));
assert.ok(picksFor(990002).includes('明尼蘇達雙城受讓2-60'));
assert.ok(picksFor(990003).includes('大10+10'));
assert.ok(picksFor(990003).includes('小10-10'));
assert.ok(picksFor(990007).includes('大4.5'));
const visionPicks = [...visionById.values()].flatMap(row => (row.markets || []).flatMap(market => market.directions || [])).map(row => row.pick).filter(Boolean);
'''
s = s[:start] + vision_block + '\n' + s[end:]
s = s.replace("{ market: '全場讓分', pick: `${game.away}受讓1+50`, water: 0.95, confidence: 1 },", "{ market: '全場讓分', pick: `${game.away}受讓1-50`, water: 0.95, confidence: 1 },")
s = s.replace("{ market: '全場大小', pick: '小8+50', water: 0.94, confidence: 1 },", "{ market: '全場大小', pick: '小8-50', water: 0.94, confidence: 1 },")
s = s.replace("{ market: '上半大小', pick: '小4+50', water: 0.93, confidence: 1 },", "{ market: '上半大小', pick: '小4-50', water: 0.93, confidence: 1 },")
s = s.replace('assert.ok(analysis.results.every(row => row.conservativeEV <= row.robustEV + 1e-10));', 'assert.ok(analysis.results.every(row => row.cev === row.conservativeEV));')
s = s.replace(
    "assert.ok(analysis.results.every(row => row.marketCalibrationWeight >= 0.12 && row.marketCalibrationWeight <= 0.55));",
    "assert.ok(analysis.results.every(row => row.marketCalibrationWeight >= 0.12 && row.marketCalibrationWeight <= 0.55));\n"
    "assert.ok(analysis.results.every(row => Math.abs(row.score - Math.min(row.integrityWarning || row.waterEstimated ? 6.6 : row.weightedEV <= 0 ? 6.6 : row.robustEV <= 0 ? 7.1 : 10, Math.max(0, Math.min(10, 5 + 50 * row.cev)))) < 1e-12));"
)
s = s.replace("{ market: '全場大小', pick: '小8+50', water: null, confidence: 1 },", "{ market: '全場大小', pick: '小8-50', water: null, confidence: 1 },")
s = s.replace("const noScore = missingWater.value.analysis.results.find(row => row.pick === '小8+50');", "const noScore = missingWater.value.analysis.results.find(row => row.pick === '小8-50');")
s = s.replace("{ market: '全場大小', pick: '小8+50', water: 0.94, waterEstimated: true, confidence: 1 },", "{ market: '全場大小', pick: '小8-50', water: 0.94, waterEstimated: true, confidence: 1 },")
p.write_text(s)
