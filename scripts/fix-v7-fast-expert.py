from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected one match, found {count}')
    return text.replace(old, new, 1)


def replace_between(text, start, end, replacement, label):
    left = text.find(start)
    if left < 0:
        raise SystemExit(f'{label}: start marker missing')
    right = text.find(end, left)
    if right < 0:
        raise SystemExit(f'{label}: end marker missing')
    return text[:left] + replacement.rstrip() + '\n\n' + text[right:]


path = Path('lib/expert.js')
text = path.read_text()
text = text.replace("export const EXPERT_VERSION = 'GPT-MLB-RESEARCH-LAYER-2026-08-v2.1';", "export const EXPERT_VERSION = 'GPT-MLB-RESEARCH-LAYER-2026-08-v2.2';")

compact_stat = '''function compactStatBlock(block) {
  const source = block && typeof block === 'object' ? block : {};
  return {
    available: Boolean(source.available),
    gamesPlayed: source.gamesPlayed,
    gamesStarted: source.gamesStarted,
    inningsPitched: source.inningsPitched,
    runsPerGame: source.runsPerGame,
    ops: source.ops,
    iso: source.iso,
    kRate: source.kRate,
    bbRate: source.bbRate,
    era: source.era,
    fip: source.fip,
    whip: source.whip,
    kMinusBB: source.kMinusBB,
    hrPer9: source.hrPer9,
  };
}

function compactTeam(team) {
  return {
    seasonHitting: compactStatBlock(team?.seasonHitting),
    recentHitting: compactStatBlock(team?.recentHitting),
    vsLeft: compactStatBlock(team?.vsLeft),
    vsRight: compactStatBlock(team?.vsRight),
    starter: team?.starter ? {
      name: team.starter.name,
      throws: team.starter.throws,
      confirmed: team.starter.confirmed,
      expectedInnings: team.starter.expectedInnings,
      season: compactStatBlock(team.starter.season),
      recent: compactStatBlock(team.starter.recent),
      pitchQuality: team.starter.pitchQuality ? {
        available: team.starter.pitchQuality.available,
        runFactor: team.starter.pitchQuality.runFactor,
      } : null,
    } : null,
    lineup: team?.lineup ? {
      official: team.lineup.official,
      projected: team.lineup.projected,
      offensiveIndex: team.lineup.offensiveIndex,
      catcher: team.lineup.catcher,
      sampleGames: team.lineup.sampleGames,
      players: (team.lineup.players || []).slice(0, 9).map(player => ({
        name: player.name,
        position: player.position,
        battingOrder: player.battingOrder,
        ops: player.ops,
      })),
    } : null,
    bullpen: team?.bullpen ? {
      usageAvailable: team.bullpen.usageAvailable,
      fatigueIndex: team.bullpen.fatigueIndex,
      highLeverageAvailability: team.bullpen.highLeverageAvailability,
      qualityFactor: team.bullpen.qualityFactor,
      relievers: (team.bullpen.relievers || []).slice(0, 7).map(row => ({
        name: row.name,
        weightedPitches: row.weightedPitches,
        appearances: row.appearances,
        lastDayPitches: row.lastDayPitches,
        saves: row.saves,
        holds: row.holds,
      })),
      daily: (team.bullpen.daily || []).slice(0, 4).map(row => ({
        date: row.date,
        pitches: row.pitches,
        appearances: row.appearances,
      })),
    } : null,
    injuries: (team?.injuries || []).slice(0, 8).map(row => ({ player: row.player, status: row.status })),
    injuryImpact: team?.injuryImpact,
    defense: team?.defense,
    baserunning: team?.baserunning,
    rest: team?.rest,
  };
}'''
text = replace_between(text, 'function compactTeam(', 'function compactPayload(', compact_stat, 'compact team payload')
text = replace_once(text, '    featureProvenance: context?.featureProvenance,', '    featureProvenance: (context?.featureProvenance || []).slice(0, 14),', 'feature provenance limit')
text = replace_once(
    text,
    '6. 回傳單一合法 JSON，不要 Markdown、不要解釋。',
    '6. 所有 reason 最多 40 個中文字；audit 每類最多 5 項；crossChecks 最多 4 項。回傳單一合法 JSON，不要 Markdown、不要解釋。',
    'concise expert prompt',
)
text = replace_once(text, '      max_tokens: 2200,', '      max_tokens: 1400,', 'expert output budget')
text = replace_once(
    text,
    "    if (String(model).startsWith('openai/')) body.reasoning_effort = 'low';",
    "    if (String(model).startsWith('openai/')) body.reasoning_effort = 'minimal';",
    'minimal reasoning effort',
)
text = replace_once(
    text,
    "  const models = unique([\n    process.env.AI_ANALYSIS_MODEL,\n    'openai/gpt-5-mini',\n    process.env.AI_MODEL,\n    'google/gemini-2.5-flash',\n  ]);",
    "  const models = unique([\n    'openai/gpt-5-nano',\n    process.env.AI_ANALYSIS_MODEL,\n    process.env.AI_MODEL,\n    'google/gemini-2.5-flash',\n  ]);",
    'fast model order',
)
text = text.replace("export async function buildExpertAssessment({ context, markets, mode = 'auto', timeoutMs = 24000 }) {", "export async function buildExpertAssessment({ context, markets, mode = 'auto', timeoutMs = 22000 }) {")
old_loop = '''  for (let index = 0; index < models.length; index += 1) {
    const model = models[index];
    const remaining = deadline - Date.now();
    if (remaining < 2200) break;
    const hasFallback = index < models.length - 1;
    const reserveForFallback = hasFallback ? Math.min(9000, Math.max(4500, remaining * 0.42)) : 0;
    const availableForAttempt = Math.max(2200, remaining - reserveForFallback);
    const attemptBudget = Math.max(2200, Math.min(index === 0 ? 13000 : remaining, availableForAttempt));
    try {
      const parsed = await gatewayAssessment(key, model, prompt, attemptBudget);
      const result = sanitizeExpertAssessment(parsed, context, model);
      cache.set(keyValue, { value: result, expires: Date.now() + 300000 });
      return result;
    } catch (error) {
      failures.push(`${model}：${String(error?.message || error)}`);
    }
  }'''
new_loop = '''  for (let index = 0; index < models.length; index += 1) {
    const model = models[index];
    const remaining = deadline - Date.now();
    if (remaining < 1800) break;
    const hasFallback = index < models.length - 1;
    const reserveForFallback = hasFallback ? Math.min(8500, Math.max(4200, remaining * 0.40)) : 0;
    const availableForAttempt = Math.max(1800, remaining - reserveForFallback);
    const firstAttemptLimit = String(model).includes('gpt-5-nano') ? 10500 : 9000;
    const attemptBudget = Math.max(1800, Math.min(firstAttemptLimit, availableForAttempt));
    try {
      const parsed = await gatewayAssessment(key, model, prompt, attemptBudget);
      const result = sanitizeExpertAssessment(parsed, context, model);
      cache.set(keyValue, { value: result, expires: Date.now() + 300000 });
      return result;
    } catch (error) {
      failures.push(`${model}：${String(error?.message || error)}`);
    }
  }'''
text = replace_once(text, old_loop, new_loop, 'fast fallback loop')
path.write_text(text)

path = Path('app/api/analyze/route.js')
text = path.read_text()
text = text.replace("checkRateLimit(request, { id: 'analyze-v7-0-1'", "checkRateLimit(request, { id: 'analyze-v7-0-2'")
text = text.replace("setTimeout(() => reject(new Error('MLB 資料取得逾時，請稍後重試')), 32000)", "setTimeout(() => reject(new Error('MLB 資料取得逾時，請稍後重試')), 30000)")
text = text.replace('timeoutMs: 24000,', 'timeoutMs: 22000,')
path.write_text(text)

path = Path('lib/analysis.js')
text = path.read_text()
text = text.replace("export const MODEL_VERSION = 'GPT研究整合聯合情境模型-2026-08-v7.0.1';", "export const MODEL_VERSION = 'GPT研究整合聯合情境模型-2026-08-v7.0.2';")
text = text.replace("export const RULES_VERSION = 'MLB-TW-EXECUTION-2026-08-v7.0.1';", "export const RULES_VERSION = 'MLB-TW-EXECUTION-2026-08-v7.0.2';")
path.write_text(text)

path = Path('app/page.js')
text = path.read_text().replace("const VERSION = '7.0.1';", "const VERSION = '7.0.2';")
path.write_text(text)

path = Path('app/api/health/route.js')
text = path.read_text().replace("version: '7.0.1'", "version: '7.0.2'")
path.write_text(text)

path = Path('package.json')
text = path.read_text().replace('"version": "7.0.1"', '"version": "7.0.2"')
path.write_text(text)
Path('DEPLOYMENT_VERSION').write_text('7.0.2-fast-gpt-research\n')

path = Path('scripts/smoke.mjs')
text = path.read_text()
text = text.replace("const VERSION = '7.0.1';", "const VERSION = '7.0.2';")
text = text.replace("const MODEL_VERSION = 'GPT研究整合聯合情境模型-2026-08-v7.0.1';", "const MODEL_VERSION = 'GPT研究整合聯合情境模型-2026-08-v7.0.2';")
text = text.replace("const RULES_VERSION = 'MLB-TW-EXECUTION-2026-08-v7.0.1';", "const RULES_VERSION = 'MLB-TW-EXECUTION-2026-08-v7.0.2';")
text = text.replace("const EXPERT_VERSION = 'GPT-MLB-RESEARCH-LAYER-2026-08-v2.1';", "const EXPERT_VERSION = 'GPT-MLB-RESEARCH-LAYER-2026-08-v2.2';")
text = text.replace('/第\\s*7\\.0\\.1\\s*版/', '/第\\s*7\\.0\\.2\\s*版/')
path.write_text(text)

path = Path('README.md')
text = path.read_text()
text = text.replace('第 7.0.1 版', '第 7.0.2 版', 1)
text = text.replace('GPT研究整合聯合情境模型-2026-08-v7.0.1', 'GPT研究整合聯合情境模型-2026-08-v7.0.2')
text += '''

### 7.0.2 快速 GPT 研究層

正式研究層改以 OpenAI GPT-5 nano 優先執行結構化殘差判讀，並縮小輸入欄位與輸出長度、使用 minimal reasoning effort。它仍不能直接給方向、EV 或評分，只能回傳資料交互作用、未知項目、情境權重與模型誤差；Production required smoke 會確認正式站實際完成遠端研究判讀。
'''
path.write_text(text)

print('v7.0.2 fast expert repair applied')
