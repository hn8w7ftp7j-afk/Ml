from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected one match, found {count}')
    return text.replace(old, new, 1)

path = Path('lib/markets.js')
text = path.read_text()
helper = r'''
function cleanVisionLine(value) {
  if (value == null) return '';
  const line = String(value).replace(/\s+/g, '').trim().slice(0, 20);
  if (!line || /^(?:null|undefined|none|n\/a|na|nil|未開盤|未開|無|沒有|—|-)$/i.test(line)) return '';
  return /^(?:\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?)(?:平|[+-]\d{1,3})?$/.test(line) ? line : '';
}
'''
text = replace_once(text, "function fallbackForMarket(defaultWater, market, fallback) {", helper + "\nfunction fallbackForMarket(defaultWater, market, fallback) {", 'insert cleanVisionLine')
text = text.replace("const line = String(value?.line || '').slice(0, 20);", "const line = cleanVisionLine(value?.line);")
path.write_text(text)

path = Path('scripts/test.mjs')
text = path.read_text()
marker = "assert.equal(vision.markets[2].directions[0].pick, '');"
addition = r'''

const nullLikeVision = normalizeVisionGame({
  away,
  home,
  first5Total: { line: 'null', overWater: null, underWater: null, confidence: 0 },
  first5Runline: { favoriteSide: 'away', line: 'undefined', favoriteWater: null, underdogWater: null, confidence: 0 },
}, { gamePk: 2, away, home }, { 上半大小: 0.93, 上半讓分: 0.94 });
assert.equal(nullLikeVision.markets[2].directions[0].pick, '');
assert.equal(nullLikeVision.markets[2].directions[0].water, null);
assert.equal(nullLikeVision.markets[3].directions[0].pick, '');
assert.equal(nullLikeVision.markets[3].directions[1].pick, '');
assert.deepEqual(validateMarketPair('上半大小', nullLikeVision.markets[3].directions), []);
'''
text = replace_once(text, marker, marker + addition, 'null-like regression test')
path.write_text(text)

path = Path('app/page.js')
text = path.read_text().replace("const VERSION = '7.0.5';", "const VERSION = '7.0.6';")
path.write_text(text)

path = Path('app/api/health/route.js')
text = path.read_text().replace("version: '7.0.5'", "version: '7.0.6'")
path.write_text(text)

path = Path('package.json')
text = path.read_text().replace('"version": "7.0.5"', '"version": "7.0.6"')
path.write_text(text)
Path('DEPLOYMENT_VERSION').write_text('7.0.6-null-market-normalization\n')

path = Path('README.md')
text = path.read_text().replace('# MLB 長期正期望值分析｜第 7.0.5 版', '# MLB 長期正期望值分析｜第 7.0.6 版', 1)
text += '''

### 7.0.6 未開盤 null 正規化

圖片辨識若把未開盤欄位回傳成 `null`、`undefined`、`N/A`、`none`、`未開盤` 等字串，盤口正規化層會一律視為空白未開盤，不建立「大null／小null」或虛假的暫估水位。只有符合台灣盤數字線格式的 line 才能建立市場方向。
'''
path.write_text(text)

print('null-like market normalization v7.0.6 applied')
