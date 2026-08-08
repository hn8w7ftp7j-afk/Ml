from pathlib import Path


def one(t,o,n,label):
    c=t.count(o)
    if c!=1: raise SystemExit(f'{label}: {c}')
    return t.replace(o,n,1)

p=Path('lib/analysis.js'); t=p.read_text()
t=t.replace("export const MODEL_VERSION = 'GPT研究整合聯合情境模型-2026-08-v7.0.2';", "export const MODEL_VERSION = 'GPT完整指令聯合情境模型-2026-08-v8.0.0';")
t=t.replace("export const RULES_VERSION = 'MLB-TW-EXECUTION-2026-08-v7.0.2';", "export const RULES_VERSION = 'MLB-TW-EXECUTION-2026-08-v8.0.0';")
# Market is price, not truth. Preserve raw model probability and use price only in settlement/EV.
old='''      const calibration = calibrationParameters({
        profile,
        rawProbability: rawWeightedSummary.modelProbability,
        marketAnchorProbability,
        exactLineProbability: rawWeightedSummary.exactLineProbability,
        marketName,
        paired: anchorInfo.paired,
        waterEstimated,
      });'''
new='''      const calibration = calibrationParameters({
        profile,
        rawProbability: rawWeightedSummary.modelProbability,
        marketAnchorProbability,
        exactLineProbability: rawWeightedSummary.exactLineProbability,
        marketName,
        paired: anchorInfo.paired,
        waterEstimated,
      });
      // v8 GPT parity: market price is used for break-even/EV only. It must not overwrite the baseball model's cover probability.
      calibration.weight = 1;
      calibration.maximumEdge = 1;
      calibration.divergenceRisk = 0;'''
t=one(t,old,new,'calibration bypass')
old='''        const calibratedProbability = marketCalibratedProbability(
          rawSummary.modelProbability,
          marketAnchorProbability,
          calibration.weight,
          calibration.maximumEdge,
        );'''
new='''        const calibratedProbability = rawSummary.modelProbability;'''
t=one(t,old,new,'raw probability')
# edge strength relative to break-even market price, but no shrinkage.
old='''      const edgeStrength = marketAnchorProbability == null
        ? clamp(logit(modelProbability) / 3.5, -1, 1)
        : clamp((logit(modelProbability) - logit(marketAnchorProbability)) / 1.25, -1, 1);'''
new='''      const breakEven = breakEvenProbability(water, rebateRate);
      const edgeStrength = clamp((modelProbability - breakEven) / 0.10, -1, 1);'''
t=one(t,old,new,'edge strength')
# Remove market disagreement score caps and unit suppression; disagreement remains diagnostic only.
t=t.replace("      if (calibration.rawProbabilityGap > 0.18 || calibration.divergenceRisk > 0.18) score = Math.min(score, 7.4);\n      else if (calibration.rawProbabilityGap > 0.12 || calibration.divergenceRisk > 0.12) score = Math.min(score, 7.9);\n",'')
t=t.replace("      if (calibration.rawProbabilityGap > 0.12 || calibration.divergenceRisk > 0.12) units = Math.min(units, 0.5);\n",'')
# metadata truthful
t=t.replace("        marketCalibrationApplied: marketAnchorProbability != null,", "        marketCalibrationApplied: false,")
t=t.replace("        marketCalibrationWeight: calibration.weight,", "        marketCalibrationWeight: 0,")
t=t.replace("        maximumCalibratedProbabilityEdge: calibration.maximumEdge,", "        maximumCalibratedProbabilityEdge: null,")
t=t.replace("        calibratedMarketProbabilityGap: marketAnchorProbability == null ? null : Math.abs(modelProbability - marketAnchorProbability),", "        calibratedMarketProbabilityGap: null,")
t=t.replace("        outcomeProbabilitiesSource: '原始聯合比分分布',", "        outcomeProbabilitiesSource: 'GPT完整資料聯合情境原始比分分布（市場不回灌）',")
# audit explicit
t=t.replace("        { name: '實際開盤市場與單邊水位', status: '已實作' },", "        { name: '實際開盤市場與單邊水位', status: '已實作；僅作價格/EV，不回灌過盤率' },")
p.write_text(t)

# Scoring: keep robust gates but remove divergence penalty; reward actual model edge and positive EV more like final GPT framework.
p=Path('lib/markets.js'); s=p.read_text()
s=s.replace("  score -= 0.70 * divergenceRisk;", "  score -= 0.10 * divergenceRisk;")
s=s.replace("  score += 0.38 * edgeStrength;", "  score += 0.72 * edgeStrength;")
s=s.replace("  score += 0.82 * smooth(weightedEV, 0.050);", "  score += 1.00 * smooth(weightedEV, 0.050);")
s=s.replace("  score += 0.88 * smooth(robustEV, 0.038);", "  score += 1.00 * smooth(robustEV, 0.040);")
s=s.replace("    if (divergenceRisk > 0.18) cap = Math.min(cap, 7.4);\n    else if (divergenceRisk > 0.12) cap = Math.min(cap, 7.9);\n",'')
p.write_text(s)

# site version
for f,o,n in [('app/page.js',"const VERSION = '7.3.0';","const VERSION = '8.0.0';"),('app/api/health/route.js',"version: '7.3.0'","version: '8.0.0'"),('package.json','"version": "7.3.0"','"version": "8.0.0"')]:
 p=Path(f); x=p.read_text(); p.write_text(x.replace(o,n))
Path('DEPLOYMENT_VERSION').write_text('8.0.0-gpt-parity-no-market-shrinkage\n')
p=Path('README.md'); x=p.read_text().replace('# MLB 長期正期望值分析｜第 7.3.0 版','# MLB 長期正期望值分析｜第 8.0.0 版',1); x+='''\n\n### 8.0.0 GPT 最終指令評分核心\n\n移除市場水位對棒球模型過盤率的強制回灌與 5%～12% 偏離上限。過盤率由 MLB 資料、GPT 研究判讀與 27 組聯合比分情境獨立產生；實際信用盤水位只用於 break-even、台灣盤逐比分損益、退水與 EV。保留穩健 EV、保守 EV、翻負機率、模型誤差、資料品質與完整性門檻，不因模型與市場不同就機械壓分。\n'''; p.write_text(x)
print('gpt parity v8 applied')
