from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected one match, found {count}')
    return text.replace(old, new, 1)

p=Path('lib/markets.js'); t=p.read_text()
helper=r'''
function numericLineBase(pick) {
  const parsed = typeof pick === 'string' ? parseTaiwanLine(pick) : pick;
  if (!parsed?.valid || !parsed.legs?.length) return null;
  return parsed.legs.reduce((sum, value) => sum + value, 0) / parsed.legs.length;
}

function plausibleMarketLine(market, pick) {
  const parsed = parseTaiwanLine(pick);
  if (!parsed.valid) return false;
  const base = numericLineBase(parsed);
  if (!Number.isFinite(base)) return false;
  // MLB full-game runlines are normally small; values such as 9-10 are almost certainly a total/water column shifted into runline.
  if (market === '全場讓分') return base >= 0 && base <= 4.5;
  if (market === '上半讓分') return base >= 0 && base <= 3.0;
  if (market === '全場大小') return base >= 4.5 && base <= 16.5;
  if (market === '上半大小') return base >= 2.0 && base <= 10.0;
  return true;
}
'''
t=replace_once(t,'export function validateMarketPair(market, directions) {',helper+'\nexport function validateMarketPair(market, directions) {','integrity helper')
t=replace_once(t,"    else if (!parseTaiwanLine(pick).valid) errors.push(`盤口格式無法辨識：${pick}`);", "    else if (!parseTaiwanLine(pick).valid) errors.push(`盤口格式無法辨識：${pick}`);\n    else if (!plausibleMarketLine(market, pick)) errors.push(`盤口數值與市場不合理，疑似辨識錯欄：${pick}`);",'validate plausible')
# vision normalization: reject implausible line before it can create picks
t=t.replace("      if (!line) return { market, directions: [{ pick: '', water: null, confidence: 0 }, { pick: '', water: null, confidence: 0 }] };", "      if (!line || !plausibleMarketLine(market, `大${line}`)) return { market, directions: [{ pick: '', water: null, confidence: 0, integrityError: line ? '盤口數值疑似辨識錯欄' : '' }, { pick: '', water: null, confidence: 0, integrityError: line ? '盤口數值疑似辨識錯欄' : '' }] };",1)
t=replace_once(t,"    if (!line || !favorite || !underdog) return { market, directions: [{ pick: '', water: null, confidence: 0 }, { pick: '', water: null, confidence: 0 }] };", "    if (!line || !favorite || !underdog || !plausibleMarketLine(market, `${favorite}讓${line}`)) return { market, directions: [{ pick: '', water: null, confidence: 0, integrityError: line ? '盤口數值疑似辨識錯欄' : '' }, { pick: '', water: null, confidence: 0, integrityError: line ? '盤口數值疑似辨識錯欄' : '' }] };",'vision runline guard')
p.write_text(t)

# version
for file, old, new in [('app/page.js',"const VERSION = '7.2.0';","const VERSION = '7.2.1';"),('app/api/health/route.js',"version: '7.2.0'","version: '7.2.1'"),('package.json','"version": "7.2.0"','"version": "7.2.1"')]:
 p=Path(file); s=p.read_text(); p.write_text(s.replace(old,new))
Path('DEPLOYMENT_VERSION').write_text('7.2.1-market-integrity-guard\n')

p=Path('scripts/test.mjs'); s=p.read_text(); marker="assert.deepEqual(validateMarketPair('上半大小', nullLikeVision.markets[3].directions), []);"
addition=r'''

assert.ok(validateMarketPair('全場讓分', [
  { pick: '匹茲堡海盜讓9-10', water: 0.95 },
  { pick: '紐約大都會受讓9-10', water: 0.95 },
]).some(error => error.includes('疑似辨識錯欄')));
assert.ok(validateMarketPair('上半讓分', [
  { pick: '匹茲堡海盜讓9-10', water: 0.95 },
  { pick: '紐約大都會受讓9-10', water: 0.95 },
]).some(error => error.includes('疑似辨識錯欄')));
assert.equal(normalizeVisionGame({ away: '紐約大都會', home: '匹茲堡海盜', fullRunline: { favoriteSide:'home', line:'9-10', favoriteWater:0.95, underdogWater:null } }, { gamePk:9, away:'紐約大都會', home:'匹茲堡海盜' }).markets[0].directions[0].pick, '');
'''
if marker not in s: raise SystemExit('test marker missing')
p.write_text(s.replace(marker,marker+addition,1))

p=Path('README.md'); s=p.read_text().replace('# MLB 長期正期望值分析｜第 7.2.0 版','# MLB 長期正期望值分析｜第 7.2.1 版',1); s+='''\n\n### 7.2.1 盤口完整性防線\n\n在圖片辨識與分析之間新增 MLB 市場合理性檢查。全場／上半讓分若讀到明顯像總分欄位的 9-10 等異常線，會直接視為辨識錯欄並阻擋分析；大小盤也有各自合理範圍。缺單邊實際水位不會再用 0 分冒充正式評分。\n'''; p.write_text(s)
print('market integrity v7.2.1 applied')
