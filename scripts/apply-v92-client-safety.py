from pathlib import Path

path = Path('app/page.js')
text = path.read_text()

old = '''function loadCompactStore() {
  if (typeof window === 'undefined') return { settings: DEFAULT_SETTINGS, bets: [] };
  const own = safeParse(window.localStorage.getItem(STORAGE) || 'null');
  if (own && typeof own === 'object') {
    return {
      settings: { ...DEFAULT_SETTINGS, ...(own.settings || {}), fallbackWater: { ...DEFAULT_SETTINGS.fallbackWater, ...(own.settings?.fallbackWater || {}) } },
      bets: Array.isArray(own.bets) ? own.bets.slice(0, 500) : [],
    };
  }
  for (const key of LEGACY_KEYS) {
    const legacy = safeParse(window.localStorage.getItem(key) || 'null');
    if (!legacy || typeof legacy !== 'object') continue;
    return {
      settings: { ...DEFAULT_SETTINGS, ...(legacy.settings || {}), fallbackWater: { ...DEFAULT_SETTINGS.fallbackWater, ...(legacy.settings?.fallbackWater || {}) } },
      bets: Array.isArray(legacy.bets) ? legacy.bets.slice(0, 500) : [],
    };
  }
  return { settings: DEFAULT_SETTINGS, bets: [] };
}'''
new = '''function loadCompactStore() {
  if (typeof window === 'undefined') return { settings: DEFAULT_SETTINGS, bets: [] };
  try {
    const own = safeParse(window.localStorage.getItem(STORAGE) || 'null');
    if (own && typeof own === 'object') {
      return {
        settings: { ...DEFAULT_SETTINGS, ...(own.settings || {}), fallbackWater: { ...DEFAULT_SETTINGS.fallbackWater, ...(own.settings?.fallbackWater || {}) } },
        bets: Array.isArray(own.bets) ? own.bets.slice(0, 500) : [],
      };
    }
    for (const key of LEGACY_KEYS) {
      const legacy = safeParse(window.localStorage.getItem(key) || 'null');
      if (!legacy || typeof legacy !== 'object') continue;
      return {
        settings: { ...DEFAULT_SETTINGS, ...(legacy.settings || {}), fallbackWater: { ...DEFAULT_SETTINGS.fallbackWater, ...(legacy.settings?.fallbackWater || {}) } },
        bets: Array.isArray(legacy.bets) ? legacy.bets.slice(0, 500) : [],
      };
    }
  } catch {
    // Safari private mode, quota failures and corrupted legacy storage must never crash the app.
  }
  return { settings: DEFAULT_SETTINGS, bets: [] };
}'''
if text.count(old) != 1:
    raise SystemExit(f'loadCompactStore match count: {text.count(old)}')
text = text.replace(old, new, 1)

old = '''function GameCard({ item, onEdit, onBet, onResetMarket }) {
  const referenceGroups = groupResults(item.referenceData?.analysis?.results || []);
  const actualRows = (item.customData?.analysis?.results || []).filter(row => row.sourceType === 'ACTUAL_TW_CREDIT' && hasActualWater(row.water));'''
new = '''function GameCard({ item, onEdit, onBet, onResetMarket }) {
  const screenshotMode = item.mode === 'actual';
  const referenceGroups = groupResults(item.referenceData?.analysis?.results || []);
  const actualRows = (item.customData?.analysis?.results || []).filter(row => row.sourceType === 'ACTUAL_TW_CREDIT' && hasActualWater(row.water));'''
if text.count(old) != 1:
    raise SystemExit('GameCard header not found')
text = text.replace(old, new, 1)

old = '''    {item.referenceData && <>
      <div className="sectionLabel">運彩／參考盤篩選分數</div>
      {referenceGroups.map(group => <div className="marketBlock" key={group.market}>
        <h3>{group.market}</h3>
        {group.rows.length ? group.rows.map(row => <ResultRow key={rowKey(row)} row={row} referenceMarkets={item.referenceMarkets} onEdit={value => onEdit(item, value)} onBet={onBet}/>) : <div className="unopened">此市場未開盤</div>}
      </div>)}
      {actualRows.length > 0 && <div className="actualBox">'''
new = '''    {item.referenceData && <>
      {!screenshotMode && <><div className="sectionLabel">運彩／參考盤篩選分數</div>
      {referenceGroups.map(group => <div className="marketBlock" key={group.market}>
        <h3>{group.market}</h3>
        {group.rows.length ? group.rows.map(row => <ResultRow key={rowKey(row)} row={row} referenceMarkets={item.referenceMarkets} onEdit={value => onEdit(item, value)} onBet={onBet}/>) : <div className="unopened">此市場未開盤</div>}
      </div>)}</>}
      {actualRows.length > 0 && <div className="actualBox">'''
if text.count(old) != 1:
    raise SystemExit('reference section not found')
text = text.replace(old, new, 1)

old = '''          game, source: found?.source || null, referenceMarkets: found?.markets || [], customMarkets: found?.markets || [],
          status: found ? 'queued' : 'unopened','''
new = '''          game, mode: 'reference', source: found?.source || null, referenceMarkets: found?.markets || [], customMarkets: found?.markets || [],
          status: found ? 'queued' : 'unopened','''
if text.count(old) != 1:
    raise SystemExit('reference item mode insertion failed')
text = text.replace(old, new, 1)

old = '''        game: row.matchedGame, source: { label: '我的信用盤截圖', observedAt: new Date().toISOString() }, referenceMarkets: flattenMarkets(row), customMarkets: flattenMarkets(row),
        status: 'queued','''
new = '''        game: row.matchedGame, mode: 'actual', source: { label: '我的信用盤截圖', observedAt: new Date().toISOString() }, referenceMarkets: [], customMarkets: flattenMarkets(row),
        status: 'queued','''
if text.count(old) != 1:
    raise SystemExit('screenshot item mode insertion failed')
text = text.replace(old, new, 1)

path.write_text(text)
print('v9.2 client safety and screenshot display patch applied')
