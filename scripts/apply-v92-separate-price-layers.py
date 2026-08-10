from pathlib import Path

path = Path('app/page.js')
text = path.read_text()

def replace_once(old, new, label):
    global text
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 match, found {count}')
    text = text.replace(old, new, 1)

replace_once(
'''  const ranked = useMemo(() => board.flatMap(item => {
    const analysis = item.customData?.analysis || item.referenceData?.analysis;
    return (analysis?.results || []).map(row => ({ ...row, game: item.game }));
  }).filter(row => Number.isFinite(Number(row.score))).sort((a, b) => Number(b.score) - Number(a.score)), [board]);''',
'''  const ranked = useMemo(() => board.flatMap(item => {
    const actual = (item.customData?.analysis?.results || []).filter(row => row.sourceType === 'ACTUAL_TW_CREDIT' && hasActualWater(row.water));
    const actualMarkets = new Set(actual.map(row => row.market));
    const reference = (item.referenceData?.analysis?.results || []).filter(row => !actualMarkets.has(row.market));
    return [...actual, ...reference].map(row => ({ ...row, game: item.game }));
  }).filter(row => Number.isFinite(Number(row.score))).sort((a, b) => Number(b.score) - Number(a.score)), [board]);''',
'ranking price layer separation')

replace_once(
'''      updateBoard(game.gamePk, item => ({ ...item, status: 'done', statusLabel: '參考盤分析完成', referenceData: compactAnalysisData(data), customMarkets: reference.markets, error: '' }));''',
'''      updateBoard(game.gamePk, item => ({ ...item, status: 'done', statusLabel: '參考盤分析完成', referenceData: compactAnalysisData(data), customMarkets: [], customData: null, error: '' }));''',
'analysis completion actual markets reset')

replace_once(
'''          game, mode: 'reference', source: found?.source || null, referenceMarkets: found?.markets || [], customMarkets: found?.markets || [],
          status: found ? 'queued' : 'unopened',''',
'''          game, mode: 'reference', source: found?.source || null, referenceMarkets: found?.markets || [], customMarkets: [],
          status: found ? 'queued' : 'unopened',''',
'board actual layer initialization')

replace_once(
'''      const pair = buildActualPair({ pick, water: Number(draftWater), market: editor.market, game: item.game });
      const markets = [...(item.customMarkets || item.referenceMarkets || []).filter(row => row.market !== editor.market), ...pair];
      const data = await requestJSON('/api/reprice', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': uid() },
        body: JSON.stringify({ snapshot, markets, previousMarkets: item.customMarkets || item.referenceMarkets, settings: { ...settings, rebateRate: 0.015, candidateThreshold: 7.2, strongestThreshold: 8.5, expertMode: 'off' } }),''',
'''      const pair = buildActualPair({ pick, water: Number(draftWater), market: editor.market, game: item.game });
      const previousActualMarkets = item.customMarkets || [];
      const markets = [...previousActualMarkets.filter(row => row.market !== editor.market), ...pair];
      const data = await requestJSON('/api/reprice', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': uid() },
        body: JSON.stringify({ snapshot, markets, previousMarkets: previousActualMarkets, settings: { ...settings, rebateRate: 0.015, candidateThreshold: 7.2, strongestThreshold: 8.5, expertMode: 'off' } }),''',
'actual-only reprice request')

old_reset = '''  async function resetMarket(item, market) {
    const snapshot = snapshots.current.get(item.game.gamePk);
    if (!snapshot) return;
    const referencePair = item.referenceMarkets.filter(row => row.market === market);
    const markets = [...item.customMarkets.filter(row => row.market !== market), ...referencePair];
    try {
      setBusy(true);
      const data = await requestJSON('/api/reprice', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': uid() },
        body: JSON.stringify({ snapshot, markets, previousMarkets: item.customMarkets, settings: { ...settings, rebateRate: 0.015 } }),
      }, 120000);
      snapshots.current.set(item.game.gamePk, data.repriceSnapshot);
      const hasActual = markets.some(row => row.sourceType === 'ACTUAL_TW_CREDIT' && hasActualWater(row.water));
      updateBoard(item.game.gamePk, current => ({ ...current, customMarkets: markets, customData: hasActual ? compactAnalysisData(data) : null }));
    } catch (cause) { setError(String(cause?.message || cause)); }
    finally { setBusy(false); }
  }'''
new_reset = '''  async function resetMarket(item, market) {
    const snapshot = snapshots.current.get(item.game.gamePk);
    if (!snapshot) return;
    const markets = (item.customMarkets || []).filter(row => row.market !== market);
    if (!markets.length) {
      updateBoard(item.game.gamePk, current => ({ ...current, customMarkets: [], customData: null }));
      setNotice(`${market}已恢復顯示運彩／參考盤；凍結比分分布仍保留。`);
      return;
    }
    try {
      setBusy(true);
      const data = await requestJSON('/api/reprice', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': uid() },
        body: JSON.stringify({ snapshot, markets, previousMarkets: item.customMarkets || [], settings: { ...settings, rebateRate: 0.015 } }),
      }, 120000);
      snapshots.current.set(item.game.gamePk, data.repriceSnapshot);
      updateBoard(item.game.gamePk, current => ({ ...current, customMarkets: markets, customData: compactAnalysisData(data) }));
    } catch (cause) { setError(String(cause?.message || cause)); }
    finally { setBusy(false); }
  }'''
replace_once(old_reset, new_reset, 'reset actual market only')

path.write_text(text)
print('v9.2 reference and actual price layers separated')
