from pathlib import Path


def one(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 match, found {count}')
    return text.replace(old, new, 1)

p = Path('lib/vision.js')
t = p.read_text()
old = '''  if (raw?.gamePk != null) {
    const exact = schedule.find(game => String(game.gamePk) === String(raw.gamePk));
    if (exact) {
      const hasNames = Boolean(raw?.away || raw?.home);
      if (!hasNames || (sideMatches(raw?.away, exact, 'away') && sideMatches(raw?.home, exact, 'home'))) return exact;
    }
  }'''
new = '''  if (raw?.gamePk != null) {
    const exact = schedule.find(game => String(game.gamePk) === String(raw.gamePk));
    // gamePk comes from the supplied official schedule allow-list. Trust the
    // exact identifier and canonicalize abbreviated OCR names to official team
    // names instead of rejecting valid rows such as MIL Brewers.
    if (exact) return exact;
  }'''
t = one(t, old, new, 'canonical gamePk matching')
t = t.replace("export const VISION_VERSION = 'MLB-VISION-2026-08-v8.2.4';", "export const VISION_VERSION = 'MLB-VISION-2026-08-v8.2.5';")
p.write_text(t)

for file, old, new in [
  ('app/page.js', "const VERSION = '8.2.4';", "const VERSION = '8.2.5';"),
  ('app/api/health/route.js', "version: '8.2.4'", "version: '8.2.5'"),
  ('package.json', '"version": "8.2.4"', '"version": "8.2.5"'),
]:
  p = Path(file)
  text = p.read_text()
  if old not in text:
    raise SystemExit(f'{file}: version marker missing')
  p.write_text(text.replace(old, new, 1))

Path('DEPLOYMENT_VERSION').write_text('8.2.5-canonical-gamepk-team-names\n')

p = Path('scripts/test.mjs')
t = p.read_text()
t = one(
  t,
  "import { VISION_VERSION, buildVisionPrompt, cleanVisionJSON, expandVisionPayload } from '../lib/vision.js';",
  "import { VISION_VERSION, buildVisionPrompt, cleanVisionJSON, expandVisionPayload, matchScheduleGame } from '../lib/vision.js';",
  'vision test import',
)
t = t.replace('assert.match(VISION_VERSION, /v8\\.2\\.4$/);', 'assert.match(VISION_VERSION, /v8\\.2\\.5$/);')
marker = "assert.equal(compactVision.games[0].fullRunline.homeWater, null);"
addition = """assert.equal(compactVision.games[0].fullRunline.homeWater, null);
const canonicalSchedule = [{ gamePk: 990002, away: '明尼蘇達雙城', home: '密爾瓦基釀酒人', awayEnglish: 'Minnesota Twins', homeEnglish: 'Milwaukee Brewers' }];
assert.equal(matchScheduleGame({ gamePk: 990002, away: 'MIN Twins', home: 'MIL Brewers' }, canonicalSchedule), canonicalSchedule[0]);"""
t = one(t, marker, addition, 'canonical gamePk regression test')
p.write_text(t)

p = Path('scripts/smoke.mjs')
t = p.read_text()
t = t.replace("const VERSION = '8.2.4';", "const VERSION = '8.2.5';")
t = t.replace("const VISION_VERSION = 'MLB-VISION-2026-08-v8.2.4';", "const VISION_VERSION = 'MLB-VISION-2026-08-v8.2.5';")
t = t.replace('/第\\s*8\\.2\\.4\\s*版/', '/第\\s*8\\.2\\.5\\s*版/')
p.write_text(t)

p = Path('README.md')
t = p.read_text().replace('# MLB 長期正期望值分析｜第 8.2.4 版', '# MLB 長期正期望值分析｜第 8.2.5 版', 1)
t += '''\n\n### 8.2.5 官方 gamePk 名稱正規化\n\n圖片模型回傳的 gamePk 已限定於官方賽程清單；只要 gamePk 精確命中，就直接使用官方中英文球隊名稱，不再因 MIL Brewers、CWS White Sox 等縮寫與完整英文名稱不同而把 matchedGame 判為空。盤口方向、分析 context、畫面中文隊名與下注紀錄因此全部使用同一場官方賽事。\n'''
p.write_text(t)

print('v8.2.5 canonical gamePk patch applied')
