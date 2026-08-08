from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one match, found {count}')
    return text.replace(old, new, 1)


path = Path('lib/vision.js')
text = path.read_text().replace("export const VISION_VERSION = 'MLB-VISION-2026-08-v7.0.4';", "export const VISION_VERSION = 'MLB-VISION-2026-08-v7.0.5';")
path.write_text(text)

path = Path('app/api/vision/route.js')
text = path.read_text()
helper_marker = "const unique = values => [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))];"
helper = helper_marker + r'''

function normalizeImageDataURL(value) {
  const source = String(value || '').trim();
  const comma = source.indexOf(',');
  if (comma < 0) return source;
  const header = source.slice(0, comma + 1);
  const payload = source.slice(comma + 1).replace(/\s+/g, '');
  return `${header}${payload}`;
}'''
text = replace_once(text, helper_marker, helper, 'insert data URL normalizer')
text = text.replace("checkRateLimit(request, { id: 'vision-v7-0-4'", "checkRateLimit(request, { id: 'vision-v7-0-5'")
text = replace_once(
    text,
    "    const images = Array.isArray(body.images) ? body.images.slice(0, 2) : [];",
    "    const images = (Array.isArray(body.images) ? body.images.slice(0, 2) : []).map(normalizeImageDataURL);",
    'normalize uploaded images',
)
path.write_text(text)

path = Path('app/page.js')
path.write_text(path.read_text().replace("const VERSION = '7.0.4';", "const VERSION = '7.0.5';"))

path = Path('app/api/health/route.js')
path.write_text(path.read_text().replace("version: '7.0.4'", "version: '7.0.5'"))

path = Path('package.json')
path.write_text(path.read_text().replace('"version": "7.0.4"', '"version": "7.0.5"'))
Path('DEPLOYMENT_VERSION').write_text('7.0.5-vision-base64-normalization\n')

path = Path('scripts/test.mjs')
path.write_text(path.read_text().replace('/v7\\.0\\.4$/', '/v7\\.0\\.5$/'))

path = Path('scripts/smoke.mjs')
text = path.read_text()
text = text.replace("const VERSION = '7.0.4';", "const VERSION = '7.0.5';")
text = text.replace("const VISION_VERSION = 'MLB-VISION-2026-08-v7.0.4';", "const VISION_VERSION = 'MLB-VISION-2026-08-v7.0.5';")
text = text.replace('/第\\s*7\\.0\\.4\\s*版/', '/第\\s*7\\.0\\.5\\s*版/')
text = replace_once(
    text,
    "const visionFixture = readFileSync(new URL('./fixtures/vision-table.b64', import.meta.url), 'utf8').trim();",
    "const visionFixture = readFileSync(new URL('./fixtures/vision-table.b64', import.meta.url), 'utf8').replace(/\\s+/g, '');",
    'normalize production fixture',
)
path.write_text(text)

path = Path('README.md')
text = path.read_text()
text = text.replace('第 7.0.4 版', '第 7.0.5 版', 1)
text += '''

### 7.0.5 Base64 圖片資料正規化

正式圖片 smoke 找到最後一個具體原因：測試圖片的 Base64 文字含換行，AI Gateway 會以 400 拒絕。後端現在會保留合法 data URL 標頭，並只移除 Base64 payload 內的空白與換行後再驗證及送出。這也提高從不同手機、剪貼簿或中介程式送入圖片時的相容性；Production smoke 同步先驗證並正規化測試圖片。
'''
path.write_text(text)

print('vision v7.0.5 patch applied')
