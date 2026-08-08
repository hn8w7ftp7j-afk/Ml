from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected one match, found {count}')
    return text.replace(old, new, 1)


# Canonicalize every incoming screenshot before it reaches AI Gateway.
path = Path('app/api/vision/route.js')
text = path.read_text()
text = replace_once(
    text,
    "const DATA_URL = /^data:image\\/(?:jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=]+$/;",
    "const IMAGE_DATA_URL = /^data:image\\/(jpeg|jpg|png|webp);base64,([\\s\\S]+)$/i;",
    'image data URL regex',
)
helper = r'''
function canonicalImageDataURL(value) {
  if (typeof value !== 'string') return '';
  const match = value.match(IMAGE_DATA_URL);
  if (!match) return '';

  let encoded = String(match[2] || '').replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!encoded || encoded.length < 32 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return '';
  const remainder = encoded.length % 4;
  if (remainder === 1) return '';
  if (remainder) encoded += '='.repeat(4 - remainder);

  let bytes;
  try { bytes = Buffer.from(encoded, 'base64'); }
  catch { return ''; }
  if (!bytes.length || bytes.length > 2_400_000) return '';

  let mime = '';
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) mime = 'png';
  else if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) mime = 'jpeg';
  else if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') mime = 'webp';
  if (!mime) return '';

  return `data:image/${mime};base64,${bytes.toString('base64')}`;
}
'''
text = replace_once(
    text,
    "const unique = values => [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))];\n",
    "const unique = values => [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))];\n" + helper,
    'canonical image helper',
)
text = replace_once(
    text,
    "    const body = await readJsonBody(request, 4_500_000);\n    const images = Array.isArray(body.images) ? body.images.slice(0, 2) : [];\n    const text = cleanText(body.text, 40000);",
    "    const body = await readJsonBody(request, 4_500_000);\n    const rawImages = Array.isArray(body.images) ? body.images.slice(0, 2) : [];\n    const images = rawImages.map(canonicalImageDataURL);\n    const text = cleanText(body.text, 40000);",
    'normalize incoming images',
)
text = replace_once(
    text,
    "    if (!images.length && !text) return NextResponse.json({ ok: false, error: '沒有收到圖片或盤口文字' }, { status: 400 });\n    if (images.some(value => typeof value !== 'string' || value.length > 3_200_000 || !DATA_URL.test(value))) {\n      return NextResponse.json({ ok: false, error: '圖片格式或大小不符合要求，請重新選擇或裁切圖片' }, { status: 413 });\n    }",
    "    if (!rawImages.length && !text) return NextResponse.json({ ok: false, error: '沒有收到圖片或盤口文字' }, { status: 400 });\n    if (rawImages.length !== images.filter(Boolean).length || images.some(value => value.length > 3_200_000)) {\n      return NextResponse.json({ ok: false, error: '圖片格式或大小不符合要求，請重新選擇或裁切圖片' }, { status: 413 });\n    }",
    'canonical image validation',
)
text = text.replace("checkRateLimit(request, { id: 'vision-v7-0-4'", "checkRateLimit(request, { id: 'vision-v7-0-5'")
path.write_text(text)

# The fixture may be line-wrapped in git; always send one canonical base64 string.
path = Path('scripts/smoke.mjs')
text = path.read_text()
text = text.replace("const VERSION = '7.0.4';", "const VERSION = '7.0.5';")
text = text.replace("const VISION_VERSION = 'MLB-VISION-2026-08-v7.0.4';", "const VISION_VERSION = 'MLB-VISION-2026-08-v7.0.5';")
text = text.replace('/第\\s*7\\.0\\.4\\s*版/', '/第\\s*7\\.0\\.5\\s*版/')
text = replace_once(
    text,
    "const visionFixture = readFileSync(new URL('./fixtures/vision-table.b64', import.meta.url), 'utf8').trim();",
    "const visionFixture = readFileSync(new URL('./fixtures/vision-table.b64', import.meta.url), 'utf8').replace(/\\s+/g, '');\nassert.match(visionFixture, /^[A-Za-z0-9+/]+={0,2}$/);",
    'canonical smoke fixture',
)
path.write_text(text)

path = Path('lib/vision.js')
text = path.read_text().replace("export const VISION_VERSION = 'MLB-VISION-2026-08-v7.0.4';", "export const VISION_VERSION = 'MLB-VISION-2026-08-v7.0.5';")
path.write_text(text)

path = Path('app/page.js')
text = path.read_text().replace("const VERSION = '7.0.4';", "const VERSION = '7.0.5';")
path.write_text(text)

path = Path('app/api/health/route.js')
text = path.read_text().replace("version: '7.0.4'", "version: '7.0.5'")
path.write_text(text)

path = Path('package.json')
text = path.read_text().replace('"version": "7.0.4"', '"version": "7.0.5"')
path.write_text(text)

Path('DEPLOYMENT_VERSION').write_text('7.0.5-canonical-image-data-url\n')

path = Path('README.md')
text = path.read_text()
text = text.replace('# MLB 長期正期望值分析｜第 7.0.4 版', '# MLB 長期正期望值分析｜第 7.0.5 版', 1)
text += '''

### 7.0.5 圖片資料正規化

所有上傳截圖在送入辨識模型前，會移除 base64 換行與空白、補齊 padding、重新編碼並依實際 PNG／JPEG／WebP 檔頭校正 MIME。正式圖片 smoke fixture 也使用同一個無空白 base64 規則，避免有效圖片因傳輸格式被模型誤判為損壞。
'''
path.write_text(text)

print('vision v7.0.5 patch applied')
