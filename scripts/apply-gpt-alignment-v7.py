from pathlib import Path
import re


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one match, found {count}')
    return text.replace(old, new, 1)


def replace_between(text, start, end, replacement, label):
    start_index = text.find(start)
    if start_index < 0:
        raise SystemExit(f'{label}: start marker missing')
    end_index = text.find(end, start_index)
    if end_index < 0:
        raise SystemExit(f'{label}: end marker missing')
    return text[:start_index] + replacement.rstrip() + '\n\n' + text[end_index:]


# ---------------------------------------------------------------------------
# lib/analysis.js
# ---------------------------------------------------------------------------
path = Path('lib/analysis.js')
text = path.read_text()
text = text.replace("export const MODEL_VERSION = 'GPT市場校準聯合情境模型-2026-08-v6.1';", "export const MODEL_VERSION = 'GPT研究整合聯合情境模型-2026-08-v7';")
text = text.replace("export const RULES_VERSION = 'MLB-TW-EXECUTION-2026-08-v6.1';", "export const RULES_VERSION = 'MLB-TW-EXECUTION-2026-08-v7';")

expert_helpers = r'''function expertResidual(expert, key) {
  const row = expert?.adjustments?.[key];
  return row && typeof row === 'object' ? row : {};
}

function combinedUncertainty(base, extra) {
  return Math.sqrt(Math.max(0, safe(base, 0)) ** 2 + clamp(safe(extra, 0), 0, 0.07) ** 2);
}

function scenarioLevelRows(source) {
  const value = source && typeof source === 'object' ? source : {};
  const rows = [
    { z: -1, weight: clamp(safe(value.low, 0.20), 0.05, 0.70) },
    { z: 0, weight: clamp(safe(value.central, 0.60), 0.10, 0.90) },
    { z: 1, weight: clamp(safe(value.high, 0.20), 0.05, 0.70) },
  ];
  const total = rows.reduce((sum, row) => sum + row.weight, 0);
  return rows.map(row => ({ ...row, weight: total > 0 ? row.weight / total : 1 / 3 }));
}'''
text = replace_once(text, 'function offenseProfile(team, opposingStarter) {', expert_helpers + '\n\nfunction offenseProfile(team, opposingStarter, adjustment = {}) {', 'insert expert helpers')

text = replace_once(text, '  const factor = geometricBlend([\n    [ratio(runs, 4.35, 0.76, 1.27), 0.32],', '  let factor = geometricBlend([\n    [ratio(runs, 4.35, 0.76, 1.27), 0.32],', 'offense mutable factor')
text = replace_once(text, "  ]) * (1 - injuryPenalty);\n\n  const lineupStatus", "  ]) * (1 - injuryPenalty);\n  factor *= clamp(safe(adjustment.multiplier, 1), 0.95, 1.05);\n\n  const lineupStatus", 'offense expert multiplier')
text = replace_once(text, '    uncertainty: Math.sqrt(lineupUncertainty ** 2 + splitUncertainty ** 2 + recentUncertainty ** 2),', '    uncertainty: combinedUncertainty(Math.sqrt(lineupUncertainty ** 2 + splitUncertainty ** 2 + recentUncertainty ** 2), adjustment.uncertaintyAdd),', 'offense uncertainty')
text = replace_once(text, '    inputs: { runs, ops, iso, kRate, bbRate, splitOps: split?.available ? split.ops : null, lineupIndex, runningIndex, injuryPenalty },', '    inputs: { runs, ops, iso, kRate, bbRate, splitOps: split?.available ? split.ops : null, lineupIndex, runningIndex, injuryPenalty, expertResidual: clamp(safe(adjustment.multiplier, 1), 0.95, 1.05), expertReason: adjustment.reason || \'\' },', 'offense inputs')

starter_function = r'''function starterProfile(starter, adjustment = {}) {
  const expertMultiplier = clamp(safe(adjustment.multiplier ?? adjustment.runMultiplier, 1), 0.94, 1.06);
  const inningsDelta = clamp(safe(adjustment.inningsDelta, 0), -0.65, 0.65);
  if (!starter?.available) {
    return {
      factor: expertMultiplier,
      expectedInnings: clamp(4.8 + inningsDelta, 3.2, 7.2),
      uncertainty: combinedUncertainty(0.17, adjustment.uncertaintyAdd),
      status: '未知',
      inputs: { expertResidual: expertMultiplier, expertInningsDelta: inningsDelta, expertReason: adjustment.reason || '' },
    };
  }
  const season = starter.season || {};
  const recent = starter.recent || {};
  const recentWeight = sampleWeight(recent.inningsPitched, 55, 0.06, 0.28);
  const era = blend(season.era, recent.era, recentWeight, 4.2);
  const fip = blend(season.fip, recent.fip, recentWeight * 0.8, era);
  const whip = blend(season.whip, recent.whip, recentWeight, 1.3);
  const kMinusBB = blend(season.kMinusBB, recent.kMinusBB, recentWeight * 0.8, 0.14);
  const hrPer9 = blend(season.hrPer9, recent.hrPer9, recentWeight * 0.7, 1.15);
  const pitchQuality = clamp(safe(starter?.pitchQuality?.runFactor, 1), 0.88, 1.12);

  let factor = geometricBlend([
    [ratio(era, 4.2, 0.70, 1.42), 0.29],
    [ratio(fip, 4.2, 0.72, 1.38), 0.25],
    [ratio(whip, 1.3, 0.76, 1.32), 0.19],
    [Math.exp(-(kMinusBB - 0.14) * 1.9), 0.16],
    [ratio(hrPer9, 1.15, 0.72, 1.42), 0.07],
    [pitchQuality, 0.04],
  ]);
  factor *= expertMultiplier;

  const gamesStarted = Math.max(1, safe(season.gamesStarted, safe(recent.gamesStarted, 1)));
  const seasonLength = safe(season.inningsPitched, 0) / gamesStarted;
  const recentStarts = Math.max(1, safe(recent.gamesStarted, 0));
  const recentLength = recentStarts > 0 ? safe(recent.inningsPitched, 0) / recentStarts : seasonLength;
  const expectedInnings = clamp(safe(starter.expectedInnings, blend(seasonLength, recentLength, 0.35, 5.2)) + inningsDelta, 3.2, 7.2);
  const sample = safe(season.inningsPitched, 0);
  const sampleUncertainty = sample >= 100 ? 0.045 : sample >= 50 ? 0.065 : sample >= 20 ? 0.09 : 0.13;
  const arsenalUncertainty = starter?.pitchQuality?.available ? 0.025 : 0.055;
  const confirmationUncertainty = starter?.confirmed === false ? 0.055 : 0.015;

  return {
    factor: clamp(factor, 0.68, 1.44),
    expectedInnings,
    uncertainty: combinedUncertainty(Math.sqrt(sampleUncertainty ** 2 + arsenalUncertainty ** 2 + confirmationUncertainty ** 2), adjustment.uncertaintyAdd),
    status: starter?.confirmed === false ? '預估' : '已確認',
    inputs: { era, fip, whip, kMinusBB, hrPer9, pitchQuality, expectedInnings, expertResidual: expertMultiplier, expertInningsDelta: inningsDelta, expertReason: adjustment.reason || '' },
  };
}'''
text = replace_between(text, 'function starterProfile(', 'function bullpenProfile(', starter_function, 'replace starter profile')

bullpen_function = r'''function bullpenProfile(team, adjustment = {}) {
  const recent = team?.recentPitching || {};
  const recentWeight = sampleWeight(recent.inningsPitched, 55, 0.08, 0.24);
  const recentEra = blend(4.2, recent.era, recentWeight, 4.2);
  const recentWhip = blend(1.3, recent.whip, recentWeight, 1.3);
  const fatigue = clamp(safe(team?.bullpen?.fatigueIndex, 0.2), 0, 1);
  const leverageAvailability = clamp(safe(team?.bullpen?.highLeverageAvailability, 0.75), 0, 1);
  const suppliedQuality = Number(team?.bullpen?.qualityFactor);
  const qualityFactor = Number.isFinite(suppliedQuality)
    ? clamp(suppliedQuality, 0.76, 1.30)
    : geometricBlend([[ratio(recentEra, 4.2, 0.82, 1.22), 0.58], [ratio(recentWhip, 1.3, 0.86, 1.18), 0.42]]);
  let factor = geometricBlend([
    [qualityFactor, 0.56],
    [ratio(recentEra, 4.2, 0.84, 1.20), 0.12],
    [1 + fatigue * 0.17, 0.21],
    [1 + (1 - leverageAvailability) * 0.13, 0.11],
  ]);
  factor *= clamp(safe(adjustment.multiplier, 1), 0.95, 1.05);
  const usageKnown = Boolean(team?.bullpen?.usageAvailable);
  return {
    factor: clamp(factor, 0.75, 1.36),
    uncertainty: combinedUncertainty(usageKnown ? 0.055 + fatigue * 0.035 : 0.105, adjustment.uncertaintyAdd),
    status: usageKnown ? '已確認' : '預估',
    inputs: { recentEra, recentWhip, qualityFactor, fatigue, leverageAvailability, expertResidual: clamp(safe(adjustment.multiplier, 1), 0.95, 1.05), expertReason: adjustment.reason || '' },
  };
}'''
text = replace_between(text, 'function bullpenProfile(', 'function defenseProfile(', bullpen_function, 'replace bullpen profile')

environment_function = r'''function environmentProfile(context, adjustment = {}) {
  const park = clamp(safe(context?.park?.runFactor, 1), 0.86, 1.20);
  const weather = context?.weather || {};
  const temperature = safe(weather.temperature, 21);
  const roof = context?.park?.roof || 'unknown';
  const closedProbability = clamp(safe(weather.roofClosedProbability, roof === 'dome' ? 1 : roof === 'open' ? 0 : 0.35), 0, 1);
  const openTemperatureFactor = clamp(1 + (temperature - 21) * 0.0024, 0.94, 1.06);
  const temperatureFactor = closedProbability * 1 + (1 - closedProbability) * openTemperatureFactor;
  let factor = clamp(park * temperatureFactor, 0.86, 1.20);
  factor *= clamp(safe(adjustment.multiplier, 1), 0.97, 1.03);
  const windSpeed = safe(weather.windSpeed, 0);
  const precipitation = safe(weather.precipitationProbability, 0);
  const weatherKnown = Boolean(weather.available);
  const roofUncertainty = roof === 'retractable' && !weather.roofConfirmed ? 0.045 : roof === 'unknown' ? 0.04 : 0.015;
  const windUncertainty = Math.min(0.065, windSpeed / 450);
  const rainUncertainty = Math.min(0.04, precipitation / 2500);
  const baseUncertainty = weatherKnown ? Math.sqrt(0.02 ** 2 + roofUncertainty ** 2 + windUncertainty ** 2 + rainUncertainty ** 2) : 0.11;
  return {
    factor: clamp(factor, 0.84, 1.22),
    uncertainty: combinedUncertainty(baseUncertainty, adjustment.uncertaintyAdd),
    status: weatherKnown ? (weather.roofConfirmed || roof === 'open' || roof === 'dome' ? '已確認' : '預估') : '未知',
    inputs: { park, temperature, windSpeed, precipitation, closedProbability, expertResidual: clamp(safe(adjustment.multiplier, 1), 0.97, 1.03), expertReason: adjustment.reason || '' },
  };
}'''
text = replace_between(text, 'function environmentProfile(', 'function gameContextProfile(', environment_function, 'replace environment profile')

text = replace_once(text, 'function gameContextProfile(context) {\n  const awayStarter = starterProfile(context?.away?.starter);', "function gameContextProfile(context) {\n  const expert = context?.expertAssessment?.assessment || {};\n  const awayStarter = starterProfile(context?.away?.starter, expertResidual(expert, 'awayStarter'));", 'game profile expert start')
text = replace_once(text, '  const homeStarter = starterProfile(context?.home?.starter);\n  const awayOffense = offenseProfile(context?.away, context?.home?.starter);\n  const homeOffense = offenseProfile(context?.home, context?.away?.starter);\n  const awayBullpen = bullpenProfile(context?.away);\n  const homeBullpen = bullpenProfile(context?.home);', "  const homeStarter = starterProfile(context?.home?.starter, expertResidual(expert, 'homeStarter'));\n  const awayOffense = offenseProfile(context?.away, context?.home?.starter, expertResidual(expert, 'awayOffense'));\n  const homeOffense = offenseProfile(context?.home, context?.away?.starter, expertResidual(expert, 'homeOffense'));\n  const awayBullpen = bullpenProfile(context?.away, expertResidual(expert, 'awayBullpen'));\n  const homeBullpen = bullpenProfile(context?.home, expertResidual(expert, 'homeBullpen'));", 'game profile expert components')
text = replace_once(text, '  const environment = environmentProfile(context);', "  const environment = environmentProfile(context, expertResidual(expert, 'environment'));", 'game profile environment')
text = replace_once(text, '  const quality = clamp(0.50 + ((confirmed + estimated * 0.65) / statusValues.length) * 0.45, 0.50, 0.96);', "  const sourceQuality = clamp(0.50 + ((confirmed + estimated * 0.65) / statusValues.length) * 0.45, 0.50, 0.96);\n  const expertConfidence = clamp(safe(expert.contextConfidence, sourceQuality), 0.35, 0.95);\n  const quality = clamp(sourceQuality * 0.82 + expertConfidence * 0.18, 0.50, 0.96);", 'quality integration')
text = replace_once(text, '    quality,\n    components:', "    quality,\n    modelErrorFloor: clamp(safe(expert.modelErrorFloor, 0.028), 0.015, 0.060),\n    independentEvidenceStrength: clamp(safe(expert.independentEvidenceStrength, 0.32), 0.15, 0.85),\n    marketReliance: clamp(safe(expert.marketReliance, 0.72), 0.45, 0.86),\n    scenarioProbabilities: expert.scenarioProbabilities || {},\n    expertLayerUsed: Boolean(context?.expertAssessment?.used),\n    expertModel: context?.expertAssessment?.model || null,\n    expertSummary: expert.summary || '',\n    expertAudit: expert.audit || { confirmed: [], estimated: [], unknown: [], blocking: [], unmodeled: [] },\n    components:", 'profile expert fields')

scenario_function = r'''function scenarioGrid(profile) {
  const awayLevels = scenarioLevelRows(profile.scenarioProbabilities?.away);
  const homeLevels = scenarioLevelRows(profile.scenarioProbabilities?.home);
  const environmentLevels = scenarioLevelRows(profile.scenarioProbabilities?.environment);
  const scenarios = [];
  let index = 0;
  for (const awayShock of awayLevels) {
    for (const homeShock of homeLevels) {
      for (const environmentShock of environmentLevels) {
        const environmentMultiplier = Math.exp(environmentShock.z * profile.sharedEnvironmentUncertainty);
        const awayEarly = profile.first5.away * Math.exp(awayShock.z * profile.earlyUncertainty.away) * environmentMultiplier;
        const homeEarly = profile.first5.home * Math.exp(homeShock.z * profile.earlyUncertainty.home) * environmentMultiplier;
        const awayLateBase = Math.max(0.25, profile.full.away - profile.first5.away);
        const homeLateBase = Math.max(0.25, profile.full.home - profile.first5.home);
        const awayLate = awayLateBase * Math.exp(awayShock.z * profile.lateUncertainty.away) * environmentMultiplier;
        const homeLate = homeLateBase * Math.exp(homeShock.z * profile.lateUncertainty.home) * environmentMultiplier;
        scenarios.push({
          id: `S${String(index + 1).padStart(2, '0')}`,
          weight: awayShock.weight * homeShock.weight * environmentShock.weight,
          shocks: { away: awayShock.z, home: homeShock.z, environment: environmentShock.z },
          means: {
            first5: { away: clamp(awayEarly, 0.55, 5), home: clamp(homeEarly, 0.55, 5) },
            late: { away: clamp(awayLate, 0.20, 4.8), home: clamp(homeLate, 0.20, 4.8) },
          },
        });
        index += 1;
      }
    }
  }
  return scenarios;
}'''
text = replace_between(text, 'function scenarioGrid(', 'function addJointScore(', scenario_function, 'replace scenario grid')

calibration_function = r'''function calibrationParameters({ profile, rawProbability, marketAnchorProbability, exactLineProbability, marketName, paired, waterEstimated }) {
  if (marketAnchorProbability == null || !Number.isFinite(Number(rawProbability))) {
    return {
      weight: 1,
      maximumEdge: 1,
      rawProbabilityGap: 0,
      logitGap: 0,
      divergenceRisk: 0,
      modelErrorFloor: profile.modelErrorFloor,
    };
  }
  const qualityScale = clamp((profile.quality - 0.50) / 0.46, 0, 1);
  const evidence = clamp(profile.independentEvidenceStrength, 0.15, 0.85);
  const rawProbabilityGap = Math.abs(rawProbability - marketAnchorProbability);
  const logitGap = Math.abs(logit(rawProbability) - logit(marketAnchorProbability));
  const disagreementPenalty = 1 / (1 + 0.55 * Math.pow(logitGap, 1.20));
  const holePenalty = 1 - Math.min(0.22, exactLineProbability * (marketName.includes('讓分') ? 0.65 : 0.45));
  let weight = (1 - clamp(profile.marketReliance, 0.45, 0.86));
  weight *= 0.72 + 0.18 * qualityScale + 0.10 * evidence;
  weight *= 0.74 + 0.26 * disagreementPenalty;
  weight *= holePenalty;
  if (!paired) weight *= 0.82;
  if (marketName.includes('上半')) weight *= 0.92;
  if (waterEstimated) weight *= 0.60;
  weight = clamp(weight, 0.12, 0.55);

  let maximumEdge = 0.055 + 0.065 * evidence * qualityScale;
  if (!paired) maximumEdge *= 0.88;
  if (marketName.includes('上半')) maximumEdge *= 0.92;
  if (exactLineProbability > 0.20) maximumEdge *= 0.94;
  maximumEdge = clamp(maximumEdge, 0.050, 0.120);
  const divergenceRisk = rawProbabilityGap * (1 - evidence) * (1 - weight * 0.25);
  return {
    weight,
    maximumEdge,
    rawProbabilityGap,
    logitGap,
    divergenceRisk,
    modelErrorFloor: profile.modelErrorFloor,
  };
}'''
text = replace_between(text, 'function calibrationParameters(', 'function marketCalibratedProbability(', calibration_function, 'replace calibration parameters')

text = replace_once(text, 'function unitSuggestion({ score, robustEV, flipProbability, quality, eligible }) {\n  if (!eligible) return 0;\n  let units = score >= 8.5 ? 1.25 : score >= 8.0 ? 1.0 : score >= 7.5 ? 0.75 : 0.5;\n  if (robustEV < 0.01 || flipProbability > 0.25 || quality < 0.72) units = Math.min(units, 0.5);\n  if (flipProbability < 0.08 && quality > 0.88 && robustEV > 0.055) units += 0.25;\n  return clamp(Math.round(units * 4) / 4, 0.25, 1.5);\n}', "function unitSuggestion({ score, robustEV, flipProbability, quality, eligible, modelErrorFloor = 0.025, independentEvidence = 0.35 }) {\n  if (!eligible) return 0;\n  const edgeAboveError = robustEV - modelErrorFloor;\n  let units = score >= 8.5 ? 1.25 : score >= 8.0 ? 1.0 : score >= 7.5 ? 0.75 : 0.5;\n  if (edgeAboveError < 0.012 || flipProbability > 0.25 || quality < 0.72) units = Math.min(units, 0.5);\n  if (independentEvidence < 0.35) units = Math.min(units, 0.5);\n  if (flipProbability < 0.08 && quality > 0.88 && edgeAboveError > 0.04 && independentEvidence > 0.60) units += 0.25;\n  return clamp(Math.round(units * 4) / 4, 0.25, 1.5);\n}", 'unit suggestion')

text = replace_once(text, 'function buildRisks({ profile, flipProbability, robustEV, marketName, row, rawProbabilityGap = 0, calibrationWeight = 1 }) {', 'function buildRisks({ profile, flipProbability, robustEV, marketName, row, rawProbabilityGap = 0, calibrationWeight = 1, divergenceRisk = 0 }) {', 'risk signature')
text = replace_once(text, "  if (profile.statuses.umpire !== '已確認') risks.push('主審採中性分布');", "  if (profile.statuses.umpire !== '已確認') risks.push('主審採中性分布');\n  if (!profile.expertLayerUsed) risks.push('GPT 研究判讀層未完成，本版使用統計備援');", 'risk expert fallback')
text = replace_once(text, "  if (rawProbabilityGap > 0.08) risks.push(`原始模型與市場差距 ${(rawProbabilityGap * 100).toFixed(1)}%，正式 EV 已按 ${(calibrationWeight * 100).toFixed(0)}% 模型權重收斂`);", "  if (rawProbabilityGap > 0.08) risks.push(`原始模型與市場差距 ${(rawProbabilityGap * 100).toFixed(1)}%，正式 EV 使用 ${(calibrationWeight * 100).toFixed(0)}% 資料模型權重`);\n  if (divergenceRisk > 0.10) risks.push('市場與資料模型分歧仍大，已提高評分所需誤差門檻');", 'risk divergence')
text = replace_once(text, "  if (robustEV <= 0) risks.push('最不利合理情境已翻為非正 EV');", "  if (robustEV <= 0) risks.push('最不利合理情境已翻為非正 EV');\n  else if (robustEV <= profile.modelErrorFloor) risks.push('穩健 EV 尚未明確高於模型誤差門檻');", 'risk error floor')

text = replace_once(text, '        waterEstimated,\n      });\n      if (calibration.rawProbabilityGap > 0.18) score = Math.min(score, 7.4);\n      else if (calibration.rawProbabilityGap > 0.12) score = Math.min(score, 7.9);', "        waterEstimated,\n        modelErrorFloor: profile.modelErrorFloor,\n        independentEvidence: profile.independentEvidenceStrength,\n        divergenceRisk: calibration.divergenceRisk,\n        expertUsed: profile.expertLayerUsed,\n      });\n      if (calibration.divergenceRisk > 0.18) score = Math.min(score, 7.4);\n      else if (calibration.divergenceRisk > 0.12) score = Math.min(score, 7.9);", 'score expert options')
text = replace_once(text, '      let units = unitSuggestion({ score, robustEV: robust.robustEV, flipProbability: evFlipProbability, quality: profile.quality, eligible: betEligible });\n      if (calibration.rawProbabilityGap > 0.12) units = Math.min(units, 0.5);', "      let units = unitSuggestion({ score, robustEV: robust.robustEV, flipProbability: evFlipProbability, quality: profile.quality, eligible: betEligible, modelErrorFloor: profile.modelErrorFloor, independentEvidence: profile.independentEvidenceStrength });\n      if (calibration.divergenceRisk > 0.12) units = Math.min(units, 0.5);", 'unit expert options')
text = replace_once(text, '        rawProbabilityGap: calibration.rawProbabilityGap,\n        calibrationWeight: calibration.weight,', '        rawProbabilityGap: calibration.rawProbabilityGap,\n        calibrationWeight: calibration.weight,\n        divergenceRisk: calibration.divergenceRisk,', 'risk call divergence')
text = replace_once(text, '        marketCalibrationApplied: marketAnchorProbability != null,\n        outcomeProbabilitiesSource:', "        marketCalibrationApplied: marketAnchorProbability != null,\n        marketReliance: profile.marketReliance,\n        modelErrorFloor: profile.modelErrorFloor,\n        independentEvidenceStrength: profile.independentEvidenceStrength,\n        divergenceRisk: calibration.divergenceRisk,\n        expertLayerUsed: profile.expertLayerUsed,\n        expertModel: profile.expertModel,\n        outcomeProbabilitiesSource:", 'result expert metadata')

alignment = r'''    alignmentAudit: {
      instructionVersion: 'MLB 長期正 EV 分析指令｜每日執行最佳化版',
      expertLayer: {
        used: profile.expertLayerUsed,
        model: profile.expertModel,
        summary: profile.expertSummary,
        reason: context?.expertAssessment?.reason || '',
      },
      confirmed: profile.expertAudit.confirmed || [],
      estimated: profile.expertAudit.estimated || [],
      unknown: profile.expertAudit.unknown || [],
      blocking: profile.expertAudit.blocking || [],
      unmodeled: profile.expertAudit.unmodeled || [],
      modules: [
        { name: '實際開盤市場與單邊水位', status: '已實作' },
        { name: '台灣信用盤逐比分結算與每萬退150', status: '已實作' },
        { name: '前五局與全場共用聯合比分世界', status: '已實作' },
        { name: 'GPT 結構化研究判讀層', status: profile.expertLayerUsed ? '已使用' : '統計備援' },
        { name: '正式／預估打線與捕手', status: profile.statuses.awayLineup === '已確認' && profile.statuses.homeLineup === '已確認' ? '已確認' : '情境建模' },
        { name: '外部盤源同步與投注比例', status: '未自動取得' },
        { name: 'Statcast／主審／捕手進階影響', status: '部分或未取得' },
      ],
    },'''
text = replace_once(text, '    featureProvenance: Array.isArray(context?.featureProvenance) ? context.featureProvenance : [],', alignment + '\n    featureProvenance: Array.isArray(context?.featureProvenance) ? context.featureProvenance : [],', 'alignment audit output')
path.write_text(text)

# ---------------------------------------------------------------------------
# lib/markets.js scoring rubric
# ---------------------------------------------------------------------------
path = Path('lib/markets.js')
text = path.read_text()
start = text.index('export function scoreFromCompositeEV(')
end = text.index('// Backward-compatible wrapper', start)
score_function = r'''export function scoreFromCompositeEV(conservativeEV, options = {}) {
  const conservative = Number(conservativeEV) || 0;
  const weightedEV = Number.isFinite(Number(options.weightedEV)) ? Number(options.weightedEV) : conservative;
  const robustEV = Number.isFinite(Number(options.robustEV)) ? Number(options.robustEV) : conservative;
  const flipProbability = clamp(Number(options.flipProbability) || 0, 0, 1);
  const quality = clamp(Number(options.quality ?? options.confidence) || 0.72, 0.35, 1);
  const edgeStrength = clamp(Number(options.edgeStrength) || 0, -1, 1);
  const stability = clamp(Number(options.stability) || (1 - flipProbability), 0, 1);
  const modelErrorFloor = clamp(Number(options.modelErrorFloor) || 0.025, 0.005, 0.08);
  const independentEvidence = clamp(Number(options.independentEvidence) || 0.35, 0.10, 0.90);
  const divergenceRisk = clamp(Number(options.divergenceRisk) || 0, 0, 0.50);
  const integrityWarning = Boolean(options.integrityWarning || options.distributionInvalid);
  const waterEstimated = Boolean(options.waterEstimated);
  const edgeAboveError = conservative - modelErrorFloor;

  let score = 5.10;
  score += 0.82 * smooth(weightedEV, 0.050);
  score += 0.88 * smooth(robustEV, 0.038);
  score += 0.62 * smooth(edgeAboveError, 0.025);
  score += 0.38 * edgeStrength;
  score += 0.42 * ((stability - 0.5) * 2);
  score += 0.28 * ((quality - 0.70) / 0.30);
  score += 0.26 * ((independentEvidence - 0.40) / 0.45);
  score -= 0.40 * flipProbability;
  score -= 0.70 * divergenceRisk;
  score -= Math.max(0, weightedEV - conservative) * 1.2;

  let cap = 9.4;
  if (integrityWarning || waterEstimated) cap = 6.6;
  else if (weightedEV <= 0) cap = 6.6;
  else if (robustEV <= 0) cap = 7.1;
  else if (edgeAboveError <= 0) cap = 7.1;
  else {
    if (robustEV < modelErrorFloor + 0.012 || conservative < modelErrorFloor + 0.004) cap = Math.min(cap, 7.4);
    if (robustEV < modelErrorFloor + 0.027 || conservative < modelErrorFloor + 0.014) cap = Math.min(cap, 7.9);
    if (robustEV < modelErrorFloor + 0.050 || conservative < modelErrorFloor + 0.030) cap = Math.min(cap, 8.4);
    if (flipProbability > 0.35) cap = Math.min(cap, 7.4);
    else if (flipProbability > 0.25) cap = Math.min(cap, 7.9);
    else if (flipProbability > 0.15) cap = Math.min(cap, 8.4);
    if (divergenceRisk > 0.18) cap = Math.min(cap, 7.4);
    else if (divergenceRisk > 0.12) cap = Math.min(cap, 7.9);
  }

  if (cap > 8.4 && (independentEvidence < 0.60 || quality < 0.80 || flipProbability > 0.10 || edgeAboveError < 0.04)) cap = 8.4;

  let floor = 3.5;
  if (weightedEV > -0.10 && robustEV > -0.14) floor = 4.1;
  if (weightedEV > -0.06 && robustEV > -0.09) floor = 4.45;
  if (weightedEV > -0.03 && robustEV > -0.05) floor = 4.75;
  if (weightedEV > -0.01 && robustEV > -0.025) floor = 5.0;

  return clamp(Math.min(score, cap), floor, 9.4);
}

'''
text = text[:start] + score_function + text[end:]
path.write_text(text)

# ---------------------------------------------------------------------------
# lib/mlb.js: projected lineup and bullpen quality
# ---------------------------------------------------------------------------
path = Path('lib/mlb.js')
text = path.read_text()
lineup_block = r'''function battingStatsForPlayer(player) {
  const batting = player?.seasonStats?.batting || player?.stats?.batting || {};
  const avg = safe(batting.avg, 0.25);
  const obp = safe(batting.obp, 0.32);
  const slg = safe(batting.slg, 0.40);
  return {
    ops: safe(batting.ops, obp + slg) || 0.72,
    avg,
    obp,
    slg,
    plateAppearances: safe(batting.plateAppearances || batting.atBats, 0),
  };
}

function lineupOffensiveIndex(rows) {
  const slotWeights = [1.05, 1.03, 1.08, 1.10, 1.07, 1.00, 0.96, 0.93, 0.90];
  let totalWeight = 0;
  let totalLog = 0;
  rows.slice(0, 9).forEach((player, index) => {
    const stats = battingStatsForPlayer(player);
    const sampleWeight = clamp(stats.plateAppearances / 180, 0.35, 1);
    const weight = slotWeights[index] * sampleWeight;
    totalWeight += weight;
    totalLog += Math.log(clamp(stats.ops / 0.72, 0.72, 1.35)) * weight;
  });
  return totalWeight > 0 ? clamp(Math.exp(totalLog / totalWeight), 0.88, 1.12) : 1;
}

function lineupFromRows(rows, { official = false, projected = false, source = 'MLB live feed', sampleGames = 0 } = {}) {
  const sorted = [...rows].filter(player => player?.battingOrder).sort((left, right) => Number(left.battingOrder) - Number(right.battingOrder)).slice(0, 9);
  const catcher = sorted.find(player => player?.position?.abbreviation === 'C');
  return {
    official,
    projected,
    source,
    sampleGames,
    players: sorted.map(player => {
      const batting = battingStatsForPlayer(player);
      return {
        id: player.person?.id || null,
        name: player.person?.fullName || '',
        position: player.position?.abbreviation || '',
        battingOrder: Number(player.battingOrder),
        ...batting,
      };
    }),
    catcher: catcher?.person?.fullName || '',
    offensiveIndex: lineupOffensiveIndex(sorted),
    missingCoreCount: Math.max(0, 9 - sorted.length),
  };
}

function parseLineup(feed, side) {
  const team = feed?.liveData?.boxscore?.teams?.[side];
  const players = team?.players || {};
  const rows = Object.values(players).filter(player => player?.battingOrder);
  const official = rows.length >= 8;
  return lineupFromRows(rows, { official, projected: false, source: 'MLB current game live feed', sampleGames: official ? 1 : 0 });
}

async function projectedLineup(teamId, gameDate) {
  const games = (await fetchRecentSchedule(teamId, gameDate, 9)).slice(0, 6);
  if (!games.length) return lineupFromRows([], { official: false, projected: true, source: 'neutral fallback', sampleGames: 0 });
  const feeds = await Promise.all(games.map(game => fetchFeed(game.gamePk)));
  const appearances = new Map();
  feeds.forEach((feed, feedIndex) => {
    const awayId = feed?.gameData?.teams?.away?.id;
    const side = Number(awayId) === Number(teamId) ? 'away' : 'home';
    const players = feed?.liveData?.boxscore?.teams?.[side]?.players || {};
    const recencyWeight = [1, 0.86, 0.72, 0.58, 0.45, 0.34][feedIndex] || 0.25;
    for (const player of Object.values(players)) {
      if (!player?.battingOrder) continue;
      const id = player.person?.id;
      if (!id) continue;
      const previous = appearances.get(id) || { player, appearanceWeight: 0, orderWeight: 0, orderTotal: 0, catcherWeight: 0 };
      previous.player = player;
      previous.appearanceWeight += recencyWeight;
      previous.orderWeight += Number(player.battingOrder) * recencyWeight;
      previous.orderTotal += recencyWeight;
      if (player.position?.abbreviation === 'C') previous.catcherWeight += recencyWeight;
      appearances.set(id, previous);
    }
  });
  const selected = [...appearances.values()]
    .sort((left, right) => right.appearanceWeight - left.appearanceWeight)
    .slice(0, 9)
    .map(row => ({
      ...row.player,
      battingOrder: Math.max(100, Math.min(900, Math.round((row.orderWeight / Math.max(row.orderTotal, 1)) / 100) * 100)),
      position: row.catcherWeight > row.appearanceWeight * 0.45 ? { ...(row.player.position || {}), abbreviation: 'C' } : row.player.position,
    }))
    .sort((left, right) => Number(left.battingOrder) - Number(right.battingOrder));
  return lineupFromRows(selected, { official: false, projected: true, source: '近六場打序加權預估', sampleGames: games.length });
}

function injuryImpactForLineup(injuries, lineup) {
  const names = new Set((lineup?.players || []).map(player => String(player.name || '').toLowerCase()));
  let impact = 0;
  for (const injury of Array.isArray(injuries) ? injuries : []) {
    const name = String(injury.player || '').toLowerCase();
    impact += names.has(name) ? 0.014 : 0.0025;
  }
  return clamp(impact, 0, 0.05);
}'''
text = replace_between(text, 'function parseLineup(', 'function parseUmpire(', lineup_block, 'replace lineup parser')

text = replace_once(text, "      innings: safe(pitching.inningsPitched, 0),\n    };", "      innings: safe(pitching.inningsPitched, 0),\n      era: safe(row.seasonStats?.pitching?.era, 4.2),\n      whip: safe(row.seasonStats?.pitching?.whip, 1.3),\n      saves: safe(row.seasonStats?.pitching?.saves, 0),\n      holds: safe(row.seasonStats?.pitching?.holds, 0),\n    };", 'reliever quality fields')
text = text.replace("return { usageAvailable: false, fatigueIndex: 0.2, highLeverageAvailability: 0.75, daily: [] };", "return { usageAvailable: false, fatigueIndex: 0.2, highLeverageAvailability: 0.75, qualityFactor: 1, daily: [] };", 2)
text = replace_once(text, "      const previous = pitcherUse.get(reliever.id) || { name: reliever.name, weightedPitches: 0, appearances: 0, lastDayPitches: 0 };", "      const previous = pitcherUse.get(reliever.id) || { name: reliever.name, weightedPitches: 0, appearances: 0, lastDayPitches: 0, qualityWeighted: 0, qualityWeight: 0, saves: 0, holds: 0 };", 'bullpen usage map')
text = replace_once(text, "      previous.appearances += 1;\n      if (daysAgo <= 1) previous.lastDayPitches += reliever.pitches;", "      previous.appearances += 1;\n      const quality = clamp(0.60 * (safe(reliever.era, 4.2) / 4.2) + 0.40 * (safe(reliever.whip, 1.3) / 1.3), 0.72, 1.38);\n      const qualityWeight = Math.max(8, reliever.pitches) * weight;\n      previous.qualityWeighted += quality * qualityWeight;\n      previous.qualityWeight += qualityWeight;\n      previous.saves = Math.max(previous.saves, safe(reliever.saves, 0));\n      previous.holds = Math.max(previous.holds, safe(reliever.holds, 0));\n      if (daysAgo <= 1) previous.lastDayPitches += reliever.pitches;", 'bullpen quality accumulation')
text = replace_once(text, "  const highLeverageAvailability = clamp(1 - consecutiveHeavy * 0.12 - lastDayHeavy * 0.10, 0.35, 1);\n  return { usageAvailable: true, fatigueIndex, highLeverageAvailability, daily, relievers };", "  const highLeverageAvailability = clamp(1 - consecutiveHeavy * 0.12 - lastDayHeavy * 0.10, 0.35, 1);\n  const qualityRows = relievers.filter(row => row.qualityWeight > 0);\n  const qualityFactor = qualityRows.length\n    ? clamp(qualityRows.reduce((sum, row) => sum + row.qualityWeighted, 0) / qualityRows.reduce((sum, row) => sum + row.qualityWeight, 0), 0.76, 1.30)\n    : 1;\n  return { usageAvailable: true, fatigueIndex, highLeverageAvailability, qualityFactor, daily, relievers };", 'bullpen quality output')

text = replace_once(text, '  const [league, awayTeam, homeTeam, awayStarter, homeStarter, feed, weather, awayRest, homeRest, awayBullpen, homeBullpen] = await Promise.all([', '  const [league, awayTeam, homeTeam, awayStarter, homeStarter, feed, weather, awayRest, homeRest, awayBullpen, homeBullpen, awayProjection, homeProjection] = await Promise.all([', 'context projection destructure')
text = replace_once(text, '    bullpenUsage(game.awayTeamId, game.gameDate),\n    bullpenUsage(game.homeTeamId, game.gameDate),\n  ]);', '    bullpenUsage(game.awayTeamId, game.gameDate),\n    bullpenUsage(game.homeTeamId, game.gameDate),\n    projectedLineup(game.awayTeamId, game.gameDate),\n    projectedLineup(game.homeTeamId, game.gameDate),\n  ]);', 'context projection calls')
text = replace_once(text, "  const awayLineup = parseLineup(feed, 'away');\n  const homeLineup = parseLineup(feed, 'home');\n  const away = { ...awayTeam, starter: awayStarter, lineup: awayLineup, rest: awayRest, bullpen: awayBullpen };\n  const home = { ...homeTeam, starter: homeStarter, lineup: homeLineup, rest: homeRest, bullpen: homeBullpen };", "  const awayOfficialLineup = parseLineup(feed, 'away');\n  const homeOfficialLineup = parseLineup(feed, 'home');\n  const awayLineup = awayOfficialLineup.official ? awayOfficialLineup : awayProjection;\n  const homeLineup = homeOfficialLineup.official ? homeOfficialLineup : homeProjection;\n  const away = { ...awayTeam, starter: awayStarter, lineup: awayLineup, rest: awayRest, bullpen: awayBullpen, injuryImpact: injuryImpactForLineup(awayTeam.injuries, awayLineup) };\n  const home = { ...homeTeam, starter: homeStarter, lineup: homeLineup, rest: homeRest, bullpen: homeBullpen, injuryImpact: injuryImpactForLineup(homeTeam.injuries, homeLineup) };", 'context projected lineups')
text = text.replace("feature('正式／預估打線', awayLineup.official && homeLineup.official ? '已確認' : '預估', 'MLB live feed'),", "feature('正式／預估打線', awayLineup.official && homeLineup.official ? '已確認' : '預估', awayLineup.official && homeLineup.official ? 'MLB live feed' : 'MLB recent game feeds weighted projection'),")
path.write_text(text)

# ---------------------------------------------------------------------------
# API route: call GPT research layer but preserve deterministic fallback
# ---------------------------------------------------------------------------
path = Path('app/api/analyze/route.js')
text = path.read_text()
text = replace_once(text, "import { analyzeMarkets } from '../../../lib/analysis.js';", "import { analyzeMarkets } from '../../../lib/analysis.js';\nimport { applyExpertAssessment, buildExpertAssessment } from '../../../lib/expert.js';", 'route expert import')
text = text.replace("checkRateLimit(request, { id: 'analyze-v6'", "checkRateLimit(request, { id: 'analyze-v7'")
text = replace_once(text, "      simulationsPerScenario: Math.max(500, Math.min(4000, Math.round(Number(body.settings?.simulationsPerScenario) || 1800))),\n    };", "      simulationsPerScenario: Math.max(500, Math.min(4000, Math.round(Number(body.settings?.simulationsPerScenario) || 1800))),\n      expertMode: ['auto', 'off', 'required'].includes(body.settings?.expertMode) ? body.settings.expertMode : 'auto',\n    };", 'route expert setting')
text = replace_once(text, "      new Promise((_, reject) => setTimeout(() => reject(new Error('MLB 資料取得逾時，請稍後重試')), 50000)),\n    ]);\n    const analysis = analyzeMarkets({ context, markets: activeMarkets, previousMarkets, settings });", "      new Promise((_, reject) => setTimeout(() => reject(new Error('MLB 資料取得逾時，請稍後重試')), 38000)),\n    ]);\n    const expertAssessment = await buildExpertAssessment({\n      context,\n      markets: activeMarkets,\n      mode: settings.expertMode,\n      timeoutMs: 12000,\n    });\n    const enrichedContext = applyExpertAssessment(context, expertAssessment);\n    const analysis = analyzeMarkets({ context: enrichedContext, markets: activeMarkets, previousMarkets, settings });", 'route expert call')
text = replace_once(text, '      context,\n      analysis,', '      context: enrichedContext,\n      expertAssessment,\n      analysis,', 'route response expert')
path.write_text(text)

# ---------------------------------------------------------------------------
# UI/version
# ---------------------------------------------------------------------------
path = Path('app/page.js')
text = path.read_text()
text = text.replace("const VERSION = '6.1.0';", "const VERSION = '7.0.0';")
text = text.replace("const STORAGE = 'mlb-positive-ev-v6-1';", "const STORAGE = 'mlb-positive-ev-v7';")
text = text.replace("const LEGACY_KEYS = ['mlb-positive-ev-v6',", "const LEGACY_KEYS = ['mlb-positive-ev-v6-1', 'mlb-positive-ev-v6',")
text = replace_once(text, '  simulationsPerScenario: 1800,\n  fallbackWater:', "  simulationsPerScenario: 1800,\n  expertMode: 'auto',\n  fallbackWater:", 'page expert default')
text = text.replace('實際開盤市場 → 聯合情境 → 台灣信用盤結算 → 穩健 EV → 綜合投注品質', '實際開盤 → MLB 資料 → GPT 研究判讀 → 聯合比分分布 → 台灣信用盤 EV')
text = text.replace('正在取得資料並執行聯合情境…', '正在取得資料、執行 GPT 研究判讀與聯合情境…')
text = replace_once(text, '<Context context={data.context} analysis={data.analysis}/>', '<Context context={data.context} analysis={data.analysis}/><AlignmentAudit audit={data.analysis.alignmentAudit}/>', 'render alignment audit')

old_result = "        <small>正式加權 EV {pct(result.weightedEV)}｜穩健 EV {pct(result.robustEV)}｜保守 EV {pct(result.conservativeEV)}｜原始未校準 EV {pct(result.rawEV)}｜EV 翻負 {pct(result.evFlipProbability)}</small>\n        <small>市場校準過盤率 {pct(result.modelProbability)}｜原始模型率 {pct(result.rawModelProbability)}｜市場基準 {pct(result.marketAnchorProbability)}｜模型權重 {pct(result.marketCalibrationWeight)}</small>\n        <small>合理水位 {result.fairWater?.toFixed?.(3) || '—'}｜原始合理水位 {result.rawFairWater?.toFixed?.(3) || '—'}｜卡洞 {pct(result.exactLineProbability)}｜基準來源 {result.marketAnchorSource || '—'}</small>\n        <small>原始比分分布：全贏 {pct(result.fullWinProbability)}｜部分贏 {pct(result.partialWinProbability)}｜走水 {pct(result.pushProbability)}｜最不利集合 {result.worstVariant || '—'}</small>"
new_result = "        <small>正式加權 EV {pct(result.weightedEV)}｜穩健 EV {pct(result.robustEV)}｜保守 EV {pct(result.conservativeEV)}｜統計原始 EV {pct(result.rawEV)}｜情境翻負 {pct(result.evFlipProbability)}</small>\n        <small>正式過盤率 {pct(result.modelProbability)}｜統計原始率 {pct(result.rawModelProbability)}｜市場先驗 {pct(result.marketAnchorProbability)}｜資料模型權重 {pct(result.marketCalibrationWeight)}</small>\n        <small>模型誤差門檻 {pct(result.modelErrorFloor)}｜獨立資料強度 {pct(result.independentEvidenceStrength)}｜分歧風險 {pct(result.divergenceRisk)}｜合理水位 {result.fairWater?.toFixed?.(3) || '—'}</small>\n        <small>原始比分分布：全贏 {pct(result.fullWinProbability)}｜部分贏 {pct(result.partialWinProbability)}｜走水 {pct(result.pushProbability)}｜卡洞 {pct(result.exactLineProbability)}｜最不利集合 {result.worstVariant || '—'}</small>"
text = replace_once(text, old_result, new_result, 'result decision trace display')

setting_marker = '        <Setting label="每情境模擬次數" value={store.settings.simulationsPerScenario} step="100" onChange={value => setStore(row => ({ ...row, settings: { ...row.settings, simulationsPerScenario: Number(value) } }))}/>'
expert_select = setting_marker + "\n        <label>GPT 研究判讀層<select value={store.settings.expertMode || 'auto'} onChange={event => setStore(row => ({ ...row, settings: { ...row.settings, expertMode: event.target.value } }))}><option value=\"auto\">自動整合；失敗時統計備援</option><option value=\"off\">純統計模式</option><option value=\"required\">GPT 未完成就不評分</option></select></label>"
text = replace_once(text, setting_marker, expert_select, 'expert mode setting')
text = text.replace('未知打線、捕手、主審、牛棚與屋頂不固定扣分；系統會擴大 27 組聯合情境與翻轉風險。', '未知打線、捕手、主審、牛棚與屋頂不固定扣分；GPT 研究層只提供殘差交互作用與情境權重，不能直接改分。')
text = text.replace('mlb-positive-ev-v6-1-${Date.now()}.json', 'mlb-positive-ev-v7-${Date.now()}.json')
text = text.replace('mlb-bets-v6-1-${Date.now()}.csv', 'mlb-bets-v7-${Date.now()}.csv')
text = text.replace("alert('第 6.1 版備份已還原');", "alert('第 7 版備份已還原');")

text = replace_once(text, "      <Info t=\"聯合情境\" v={`${analysis.scenarioSummary.count} 組 × ${analysis.scenarioSummary.simulationsPerScenario} 次｜${analysis.scenarioSummary.robustVariantCount} 組穩健壓力`}/>", "      <Info t=\"聯合情境\" v={`${analysis.scenarioSummary.count} 組 × ${analysis.scenarioSummary.simulationsPerScenario} 次｜${analysis.scenarioSummary.robustVariantCount} 組穩健壓力`}/>\n      <Info t=\"GPT 研究判讀\" v={`${analysis.alignmentAudit?.expertLayer?.used ? '已整合' : '統計備援'}｜${analysis.alignmentAudit?.expertLayer?.model || analysis.alignmentAudit?.expertLayer?.reason || '—'}`}/>", 'context expert info')

alignment_component = r'''function AlignmentAudit({ audit }) {
  if (!audit) return null;
  const unknown = [...(audit.unknown || []), ...(audit.unmodeled || [])].slice(0, 8);
  return <div className="alignmentAudit">
    <div className="alignmentHead"><b>GPT 指令對齊與未知資料檢查</b><span className="pill">{audit.expertLayer?.used ? 'GPT 已整合' : '統計備援'}</span></div>
    {audit.expertLayer?.summary && <small>{audit.expertLayer.summary}</small>}
    <div className="auditGrid">
      <div><span>已確認</span><b>{audit.confirmed?.length || 0}</b></div>
      <div><span>預估</span><b>{audit.estimated?.length || 0}</b></div>
      <div><span>未知</span><b>{audit.unknown?.length || 0}</b></div>
      <div><span>尚未建模</span><b>{audit.unmodeled?.length || 0}</b></div>
    </div>
    {unknown.length > 0 && <ul className="riskList">{unknown.map(item => <li key={item}>{item}</li>)}</ul>}
  </div>;
}

'''
text = replace_once(text, 'function Metric({ t, v })', alignment_component + 'function Metric({ t, v })', 'alignment component')
path.write_text(text)

# CSS for alignment card
path = Path('app/globals.css')
text = path.read_text()
text += '\n.alignmentAudit{margin:14px 0;padding:14px;border:1px solid #315779;border-radius:14px;background:#0a1b2d}.alignmentHead{display:flex;justify-content:space-between;gap:10px;align-items:center}.alignmentAudit>small{display:block;color:#9fb5cb;margin-top:7px}.auditGrid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:10px}.auditGrid>div{background:#071522;border-radius:10px;padding:9px}.auditGrid span{display:block;color:#829bb4;font-size:11px}.auditGrid b{display:block;font-size:18px;margin-top:3px}@media(max-width:620px){.auditGrid{grid-template-columns:repeat(2,1fr)}}\n'
path.write_text(text)

# ---------------------------------------------------------------------------
# Health, package, version and README
# ---------------------------------------------------------------------------
path = Path('app/api/health/route.js')
text = path.read_text()
text = replace_once(text, "import { MODEL_VERSION, RULES_VERSION } from '../../../lib/analysis.js';", "import { MODEL_VERSION, RULES_VERSION } from '../../../lib/analysis.js';\nimport { EXPERT_VERSION } from '../../../lib/expert.js';", 'health expert import')
text = text.replace("version: '6.1.0'", "version: '7.0.0'")
text = replace_once(text, '    rulesVersion: RULES_VERSION,', '    rulesVersion: RULES_VERSION,\n    expertVersion: EXPERT_VERSION,', 'health expert version')
path.write_text(text)

path = Path('package.json')
text = path.read_text().replace('"version": "6.1.0"', '"version": "7.0.0"')
path.write_text(text)
Path('DEPLOYMENT_VERSION').write_text('7.0.0-gpt-research-alignment\n')

path = Path('README.md')
text = path.read_text()
text = re.sub(r'# MLB 長期正期望值分析｜第 [^\n]+版', '# MLB 長期正期望值分析｜第 7.0.0 版', text, count=1)
text = text.replace('GPT市場校準聯合情境模型-2026-08-v6.1', 'GPT研究整合聯合情境模型-2026-08-v7')
text += '''\n\n## 7.0 GPT 研究整合與未知資料稽核\n\n第 7 版把原本只存在於 ChatGPT 對話中的研究判讀拆成結構化 GPT 層：它只能辨識交互作用、未知資料、殘差調整、情境權重、市場依賴程度與模型誤差，不能直接輸出方向、EV、評分或注碼。所有數字仍須進入共同比分分布、台灣盤逐比分結算、加權 EV、穩健 EV 與評分硬規則。\n\n同時新增近六場打序加權的預估打線、球員級 OPS 打線指數、近期牛棚逐投手品質與疲勞拆分，並在畫面列出已確認、預估、未知與尚未建模的資料。外部盤源同步、Statcast 即時球質、主審與捕手進階效果、正式屋頂公告及實際莊家作廢條款未取得時會明示，不再假裝網站已理解。\n'''
path.write_text(text)

# ---------------------------------------------------------------------------
# Unit tests
# ---------------------------------------------------------------------------
path = Path('scripts/test.mjs')
text = path.read_text()
text = replace_once(text, "import { analyzeMarkets, estimateRuns, MODEL_VERSION, RULES_VERSION } from '../lib/analysis.js';", "import { analyzeMarkets, estimateRuns, MODEL_VERSION, RULES_VERSION } from '../lib/analysis.js';\nimport { fallbackExpertAssessment, sanitizeExpertAssessment } from '../lib/expert.js';", 'test expert import')

expert_fixture = r'''const fallbackExpert = fallbackExpertAssessment(context, 'unit-test fallback');
assert.equal(fallbackExpert.used, false);
assert.ok(fallbackExpert.assessment.audit.unmodeled.length > 0);
context.expertAssessment = sanitizeExpertAssessment({
  contextConfidence: 0.82,
  independentEvidenceStrength: 0.62,
  marketReliance: 0.60,
  modelErrorFloor: 0.024,
  adjustments: {
    awayOffense: { multiplier: 1.01, uncertaintyAdd: 0.01, reason: 'platoon interaction', evidenceKeys: ['vsLeft'] },
    homeOffense: { multiplier: 0.995, uncertaintyAdd: 0.015, reason: 'projected lineup', evidenceKeys: ['lineup.projected'] },
    awayStarter: { runMultiplier: 0.99, inningsDelta: 0.1, uncertaintyAdd: 0.01 },
    homeStarter: { runMultiplier: 1.01, inningsDelta: -0.1, uncertaintyAdd: 0.015 },
  },
  scenarioProbabilities: {
    away: { low: 0.18, central: 0.62, high: 0.20 },
    home: { low: 0.23, central: 0.60, high: 0.17 },
    environment: { low: 0.18, central: 0.64, high: 0.18 },
  },
  audit: { unknown: ['official lineup'], unmodeled: ['Statcast live movement'] },
  summary: 'unit test expert layer',
}, context, 'unit-test-model');
assert.equal(context.expertAssessment.used, true);

'''
text = replace_once(text, 'const fullRuns = estimateRuns(context, false);', expert_fixture + 'const fullRuns = estimateRuns(context, false);', 'test expert fixture')
text = text.replace('result.marketCalibrationWeight >= 0.08 && result.marketCalibrationWeight <= 0.35', 'result.marketCalibrationWeight >= 0.12 && result.marketCalibrationWeight <= 0.55')
text = text.replace('result.maximumCalibratedProbabilityEdge >= 0.025 && result.maximumCalibratedProbabilityEdge <= 0.05', 'result.maximumCalibratedProbabilityEdge >= 0.05 && result.maximumCalibratedProbabilityEdge <= 0.12')
text = text.replace('assert.ok(disagreementUnderdog.calibratedMarketProbabilityGap <= 0.05 + 1e-10);', 'assert.ok(disagreementUnderdog.calibratedMarketProbabilityGap <= 0.12 + 1e-10);')
text = text.replace("assert.ok(disagreementUnderdog.weightedEV < 0.12, 'market-calibrated EV must not remain at an implausible 20–30% level');", "assert.ok(disagreementUnderdog.weightedEV < 0.18, 'formal EV must not remain at an unbounded 20–30% level');")
text = text.replace("if (disagreementUnderdog.rawMarketProbabilityGap > 0.18) assert.ok(disagreementUnderdog.score <= 7.4);", "if (disagreementUnderdog.divergenceRisk > 0.18) assert.ok(disagreementUnderdog.score <= 7.4);")
text = replace_once(text, 'assert.equal(analysis.scenarioSummary.jointPortfolioDistribution, true);', "assert.equal(analysis.scenarioSummary.jointPortfolioDistribution, true);\nassert.equal(analysis.alignmentAudit.expertLayer.used, true);\nassert.ok(analysis.alignmentAudit.unmodeled.length > 0);\nassert.ok(analysis.results.every(row => row.modelErrorFloor >= 0.015 && row.modelErrorFloor <= 0.06));\nassert.ok(analysis.results.every(row => row.independentEvidenceStrength >= 0.15 && row.independentEvidenceStrength <= 0.85));", 'test alignment assertions')
path.write_text(text)

# ---------------------------------------------------------------------------
# Production smoke test stays deterministic: expertMode off, but audit required.
# ---------------------------------------------------------------------------
path = Path('scripts/smoke.mjs')
text = path.read_text()
text = text.replace("const VERSION = '6.1.0';", "const VERSION = '7.0.0';")
text = text.replace("const MODEL_VERSION = 'GPT市場校準聯合情境模型-2026-08-v6.1';", "const MODEL_VERSION = 'GPT研究整合聯合情境模型-2026-08-v7';")
text = text.replace("const RULES_VERSION = 'MLB-TW-EXECUTION-2026-08-v6.1';", "const RULES_VERSION = 'MLB-TW-EXECUTION-2026-08-v7';")
text = replace_once(text, "const RULES_VERSION = 'MLB-TW-EXECUTION-2026-08-v7';", "const RULES_VERSION = 'MLB-TW-EXECUTION-2026-08-v7';\nconst EXPERT_VERSION = 'GPT-MLB-RESEARCH-LAYER-2026-08-v1';", 'smoke expert version constant')
text = replace_once(text, '        && value.rulesVersion === RULES_VERSION', '        && value.rulesVersion === RULES_VERSION\n        && value.expertVersion === EXPERT_VERSION', 'smoke health wait expert')
text = replace_once(text, 'assert.equal(health.rulesVersion, RULES_VERSION);', 'assert.equal(health.rulesVersion, RULES_VERSION);\nassert.equal(health.expertVersion, EXPERT_VERSION);', 'smoke health assert expert')
text = text.replace('/第\\s*6\\.1\\.0\\s*版/', '/第\\s*7\\.0\\.0\\s*版/')
text = text.replace("const settings = { rebateRate: 0.015, candidateThreshold: 7.2, strongestThreshold: 8.5, simulationsPerScenario: 500 };", "const settings = { rebateRate: 0.015, candidateThreshold: 7.2, strongestThreshold: 8.5, simulationsPerScenario: 500, expertMode: 'off' };")
text = text.replace('row.marketCalibrationWeight >= 0.08 && row.marketCalibrationWeight <= 0.35', 'row.marketCalibrationWeight >= 0.12 && row.marketCalibrationWeight <= 0.55')
text = replace_once(text, 'assert.ok(analysis.results.every(row => row.calibratedMarketProbabilityGap <= row.maximumCalibratedProbabilityEdge + 1e-10));', "assert.ok(analysis.results.every(row => row.calibratedMarketProbabilityGap <= row.maximumCalibratedProbabilityEdge + 1e-10));\nassert.equal(analysis.alignmentAudit.expertLayer.used, false);\nassert.ok(analysis.alignmentAudit.unmodeled.length > 0);\nassert.ok(analysis.results.every(row => Number.isFinite(row.modelErrorFloor)));", 'smoke audit assertions')
path.write_text(text)

print('GPT alignment v7 patch applied')
