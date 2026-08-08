'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  MARKET_ORDER,
  calculateProfit,
  extractLineToken,
  hasActualWater,
  marketIsOpen,
  outcomeFractionForScore,
  priceCLV,
  resultLabel,
  validateMarketPair,
} from '../lib/markets.js';
import { translateTeamText } from '../lib/i18n.js';

const VERSION = '6.0.0';
const STORAGE = 'mlb-positive-ev-v6';
const LEGACY_KEYS = ['mlb-positive-ev-v5', 'mlb-positive-ev-v4', 'mlb-positive-ev-v3'];
const DEFAULT_SETTINGS = {
  unitValue: 10000,
  rebateRate: 0.015,
  candidateThreshold: 7.2,
  strongestThreshold: 8.5,
  simulationsPerScenario: 1800,
  fallbackWater: {
    全場讓分: 0.95,
    全場大小: 0.94,
    上半讓分: 0.94,
    上半大小: 0.93,
  },
};
const EMPTY = { locks: [], analysisHistory: {}, bets: [], settings: DEFAULT_SETTINGS };
const money = value => new Intl.NumberFormat('zh-TW', { style: 'currency', currency: 'TWD', maximumFractionDigits: 0 }).format(Number(value) || 0);
const pct = value => value == null || !Number.isFinite(Number(value)) ? '—' : `${(Number(value) * 100).toFixed(2)}%`;
const uid = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
const matchup = game => `${translateTeamText(game?.away || '')} 對 ${translateTeamText(game?.home || '')}`;
const dateText = value => value ? new Date(value).toLocaleString('zh-TW') : '—';

async function readDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function compressImage(file) {
  const source = await readDataURL(file);
  return new Promise(resolve => {
    const image = new Image();
    image.onload = () => {
      const maximum = 1500;
      const scale = Math.min(1, maximum / Math.max(image.width, image.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.78));
    };
    image.onerror = () => resolve(source);
    image.src = source;
  });
}

async function requestJSON(url, options = {}, timeout = 180000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal, cache: 'no-store' });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); }
    catch { throw new Error(`伺服器回傳格式錯誤（${response.status}）`); }
    if (!response.ok || data.ok === false) throw new Error(data.error || `請求失敗（${response.status}）`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function download(name, text, type = 'application/json') {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([text], { type }));
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function blankDirection() {
  return { pick: '', water: null, waterEstimated: false, waterMissing: false, confidence: 0 };
}

function blankGame(game) {
  return {
    id: uid(),
    away: game?.away || '',
    home: game?.home || '',
    gamePk: game?.gamePk || null,
    matchedGame: game || null,
    confidence: 0,
    markets: MARKET_ORDER.map(market => ({ market, directions: [blankDirection(), blankDirection()] })),
  };
}

function withFallbackWater(game, settings) {
  return {
    ...game,
    markets: MARKET_ORDER.map(market => {
      const source = game.markets?.find(item => item.market === market) || { market, directions: [] };
      const directions = [0, 1].map(index => ({ ...blankDirection(), ...(source.directions?.[index] || {}) }));
      const opened = marketIsOpen(directions);
      if (!opened) return { market, directions };
      const actualCount = directions.filter(direction => hasActualWater(direction.water) && !direction.waterEstimated).length;
      const bothMissing = directions.every(direction => !hasActualWater(direction.water));
      if (bothMissing) {
        const fallback = Number(settings.fallbackWater?.[market] || 0.95);
        return {
          market,
          directions: directions.map(direction => ({ ...direction, water: fallback, waterEstimated: true, waterMissing: false })),
        };
      }
      if (actualCount === 1) {
        return {
          market,
          directions: directions.map(direction => hasActualWater(direction.water)
            ? { ...direction, water: Number(direction.water), waterEstimated: Boolean(direction.waterEstimated), waterMissing: false }
            : { ...direction, water: null, waterEstimated: false, waterMissing: true }),
        };
      }
      return {
        market,
        directions: directions.map(direction => ({
          ...direction,
          water: hasActualWater(direction.water) ? Number(direction.water) : null,
          waterMissing: !hasActualWater(direction.water),
        })),
      };
    }),
  };
}

function flattenMarkets(game) {
  return MARKET_ORDER.flatMap(market => {
    const row = game.markets?.find(item => item.market === market);
    if (!marketIsOpen(row?.directions || [])) return [];
    return (row?.directions || []).slice(0, 2).filter(direction => String(direction?.pick || '').trim()).map(direction => ({
      market,
      pick: String(direction.pick || ''),
      water: hasActualWater(direction.water) ? Number(direction.water) : null,
      waterEstimated: Boolean(direction.waterEstimated),
      confidence: Number(direction.confidence || 0),
    }));
  });
}

function mergeVision(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = String(row.gamePk || `${row.away}-${row.home}`).toLowerCase();
    if (!map.has(key)) {
      map.set(key, { ...row, id: uid() });
      continue;
    }
    const previous = map.get(key);
    map.set(key, {
      ...previous,
      matchedGame: row.matchedGame || previous.matchedGame,
      gamePk: row.gamePk || previous.gamePk,
      markets: MARKET_ORDER.map(market => {
        const left = previous.markets?.find(item => item.market === market);
        const right = row.markets?.find(item => item.market === market);
        return {
          market,
          directions: [0, 1].map(index => {
            const a = left?.directions?.[index];
            const b = right?.directions?.[index];
            if (!a) return b || blankDirection();
            if (!b) return a;
            return Number(b.confidence || 0) > Number(a.confidence || 0) ? b : a;
          }),
        };
      }),
    });
  }
  return [...map.values()];
}

function latestVersion(history, lockId) {
  return Array.isArray(history?.[lockId]) ? history[lockId][0] : null;
}

function migrateSaved() {
  try {
    const current = JSON.parse(localStorage.getItem(STORAGE) || 'null');
    if (current) {
      return {
        ...EMPTY,
        ...current,
        locks: Array.isArray(current.locks) ? current.locks : [],
        analysisHistory: current.analysisHistory || {},
        bets: Array.isArray(current.bets) ? current.bets : [],
        settings: {
          ...DEFAULT_SETTINGS,
          ...current.settings,
          fallbackWater: { ...DEFAULT_SETTINGS.fallbackWater, ...(current.settings?.fallbackWater || {}) },
        },
      };
    }
    for (const key of LEGACY_KEYS) {
      const legacy = JSON.parse(localStorage.getItem(key) || 'null');
      if (!legacy) continue;
      return {
        ...EMPTY,
        bets: Array.isArray(legacy.bets) ? legacy.bets : [],
        settings: {
          ...DEFAULT_SETTINGS,
          ...legacy.settings,
          fallbackWater: { ...DEFAULT_SETTINGS.fallbackWater },
        },
      };
    }
  } catch {}
  return EMPTY;
}

export default function Home() {
  const [tab, setTab] = useState('today');
  const [date, setDate] = useState(() => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date()));
  const [games, setGames] = useState([]);
  const [loadingGames, setLoadingGames] = useState(false);
  const [health, setHealth] = useState(null);
  const [store, setStore] = useState(EMPTY);
  const [ready, setReady] = useState(false);
  const [images, setImages] = useState([]);
  const [visionStatus, setVisionStatus] = useState('');
  const [visionBusy, setVisionBusy] = useState(false);
  const [manualText, setManualText] = useState('');
  const [manualGamePk, setManualGamePk] = useState('');
  const [parsed, setParsed] = useState([]);
  const [selected, setSelected] = useState(0);
  const [busyLocks, setBusyLocks] = useState({});

  useEffect(() => {
    setStore(migrateSaved());
    setReady(true);
    loadGames(date);
    requestJSON('/api/health').then(setHealth).catch(() => setHealth({ ok: false }));
  }, []);

  useEffect(() => {
    if (ready) localStorage.setItem(STORAGE, JSON.stringify(store));
  }, [store, ready]);

  async function loadGames(targetDate = date) {
    setLoadingGames(true);
    try {
      const data = await requestJSON(`/api/mlb?date=${targetDate}`);
      setGames(data.games || []);
    } catch (error) {
      alert(`賽程載入失敗：${error.message}`);
    } finally {
      setLoadingGames(false);
    }
  }

  async function chooseImages(files) {
    const list = [...(files || [])].slice(0, 8);
    setVisionStatus('正在壓縮圖片…');
    const rows = [];
    for (let index = 0; index < list.length; index += 1) {
      const file = list[index];
      rows.push({ id: uid(), name: file.name, preview: URL.createObjectURL(file), data: await compressImage(file), size: file.size });
      setVisionStatus(`正在處理第 ${index + 1} 張，共 ${list.length} 張`);
    }
    setImages(rows);
    setVisionStatus(`已準備 ${rows.length} 張圖片`);
  }

  async function recognize() {
    if (!images.length || visionBusy) return;
    setVisionBusy(true);
    const all = [];
    try {
      for (let index = 0; index < images.length; index += 1) {
        setVisionStatus(`人工智慧辨識中：第 ${index + 1} 張，共 ${images.length} 張`);
        const data = await requestJSON('/api/vision', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ images: [images[index].data], schedule: games, defaultWater: store.settings.fallbackWater }),
        });
        all.push(...(data.games || []));
      }
      const merged = mergeVision(all);
      if (!merged.length) throw new Error('沒有辨識到任何場次');
      setParsed(merged);
      setSelected(0);
      setVisionStatus(`辨識完成：共 ${merged.length} 場`);
      setTab('confirm');
    } catch (error) {
      setVisionStatus(`辨識失敗：${error.message}`);
    } finally {
      setVisionBusy(false);
    }
  }

  async function parseText() {
    if (!manualText.trim() || visionBusy) return;
    setVisionBusy(true);
    setVisionStatus('正在解析盤口文字…');
    try {
      const data = await requestJSON('/api/vision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: manualText, schedule: games, defaultWater: store.settings.fallbackWater }),
      });
      const rows = mergeVision(data.games || []);
      if (!rows.length) throw new Error('沒有解析到場次');
      setParsed(rows);
      setSelected(0);
      setVisionStatus(`解析完成：共 ${rows.length} 場`);
      setTab('confirm');
    } catch (error) {
      setVisionStatus(`解析失敗：${error.message}`);
    } finally {
      setVisionBusy(false);
    }
  }

  function addManual() {
    const game = games.find(item => String(item.gamePk) === String(manualGamePk));
    if (!game) return alert('請先選擇一場 MLB 賽事');
    setParsed(previous => [...previous, blankGame(game)]);
    setSelected(parsed.length);
    setTab('confirm');
  }

  const current = parsed[selected];
  function updateCurrent(updater) {
    setParsed(previous => previous.map((game, index) => index === selected ? updater(game) : game));
  }

  function setMatch(gamePk) {
    const game = games.find(item => String(item.gamePk) === String(gamePk)) || null;
    updateCurrent(row => ({ ...row, gamePk: game?.gamePk || null, matchedGame: game, away: game?.away || row.away, home: game?.home || row.home }));
  }

  function editDirection(market, index, key, value) {
    updateCurrent(game => ({
      ...game,
      markets: game.markets.map(row => row.market !== market ? row : {
        ...row,
        directions: [0, 1].map(directionIndex => {
          const direction = { ...blankDirection(), ...(row.directions?.[directionIndex] || {}) };
          if (directionIndex !== index) return direction;
          if (key === 'water') {
            return { ...direction, water: value === '' ? null : Number(value), waterEstimated: false, waterMissing: value === '' };
          }
          if (key === 'waterEstimated') return { ...direction, waterEstimated: Boolean(value), waterMissing: false };
          if (key === 'pick') return { ...direction, pick: value, confidence: String(value).trim() ? 1 : 0 };
          return { ...direction, [key]: value };
        }),
      }),
    }));
  }

  const preparedCurrent = useMemo(() => current ? withFallbackWater(current, store.settings) : null, [current, store.settings]);
  const currentErrors = useMemo(() => {
    if (!preparedCurrent) return [];
    const errors = [];
    if (!preparedCurrent.matchedGame) errors.push('尚未配對 MLB 官方賽事');
    for (const market of MARKET_ORDER) {
      const row = preparedCurrent.markets?.find(item => item.market === market);
      errors.push(...validateMarketPair(market, row?.directions || []).map(error => `${market}：${error}`));
    }
    return [...new Set(errors)];
  }, [preparedCurrent]);
  const currentOpenMarkets = useMemo(() => preparedCurrent ? MARKET_ORDER.filter(market => marketIsOpen(preparedCurrent.markets?.find(item => item.market === market)?.directions || [])) : [], [preparedCurrent]);
  const currentDirections = useMemo(() => preparedCurrent ? flattenMarkets(preparedCurrent) : [], [preparedCurrent]);

  function lockCurrent() {
    if (!preparedCurrent) return;
    if (currentErrors.length) return alert(currentErrors.join('\n'));
    const markets = flattenMarkets(preparedCurrent);
    if (!markets.length) return alert('這場目前沒有任何已開盤市場，不需要鎖定');
    const lock = {
      id: uid(),
      sourceId: preparedCurrent.id,
      lockedAt: new Date().toISOString(),
      game: preparedCurrent.matchedGame,
      markets,
      version: VERSION,
      status: 'locked',
    };
    setStore(value => ({ ...value, locks: [lock, ...value.locks].slice(0, 300) }));
    alert(`盤口快照已建立：${new Set(markets.map(item => item.market)).size} 個市場、${markets.length} 個方向`);
  }

  async function analyze(lock) {
    if (busyLocks[lock.id]) return;
    setBusyLocks(value => ({ ...value, [lock.id]: true }));
    try {
      const previous = [...store.locks]
        .filter(item => item.id !== lock.id && String(item.game?.gamePk) === String(lock.game?.gamePk) && new Date(item.lockedAt) < new Date(lock.lockedAt))
        .sort((left, right) => new Date(right.lockedAt) - new Date(left.lockedAt))[0];
      const data = await requestJSON('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          game: lock.game,
          markets: lock.markets,
          previousMarkets: previous?.markets || [],
          settings: store.settings,
        }),
      }, 180000);
      const version = { id: uid(), createdAt: new Date().toISOString(), ...data };
      setStore(value => ({
        ...value,
        analysisHistory: {
          ...value.analysisHistory,
          [lock.id]: [version, ...(value.analysisHistory[lock.id] || [])].slice(0, 30),
        },
      }));
      setTab('analysis');
    } catch (error) {
      alert(`分析失敗：${error.message}`);
    } finally {
      setBusyLocks(value => ({ ...value, [lock.id]: false }));
    }
  }

  function removeLock(id) {
    if (!confirm('刪除這個盤口快照與其分析版本？下注紀錄不受影響。')) return;
    setStore(value => {
      const history = { ...value.analysisHistory };
      delete history[id];
      return { ...value, locks: value.locks.filter(lock => lock.id !== id), analysisHistory: history };
    });
  }

  function addBet(game, result, analysis) {
    if (!result.betEligible) return;
    const unit = result.portfolioUnit || result.unitSuggestion || 0.5;
    const stake = unit * store.settings.unitValue;
    const bet = {
      id: uid(),
      createdAt: new Date().toISOString(),
      analysisSnapshotId: analysis.snapshotId,
      modelVersion: analysis.modelVersion,
      rulesVersion: analysis.rulesVersion,
      gamePk: game.gamePk,
      away: game.away,
      home: game.home,
      game: matchup(game),
      market: result.market,
      pick: result.pick,
      water: result.water,
      score: result.score,
      weightedEV: result.weightedEV,
      robustEV: result.robustEV,
      conservativeEV: result.conservativeEV,
      evFlipProbability: result.evFlipProbability,
      portfolioRole: result.portfolioRole,
      unit,
      stake,
      result: '未結算',
      fraction: null,
      profit: 0,
      rebate: 0,
      awayRuns: '',
      homeRuns: '',
      awayFirst5: '',
      homeFirst5: '',
      closeWater: '',
      closePick: '',
      clv: null,
    };
    setStore(value => ({ ...value, bets: [bet, ...value.bets] }));
  }

  function updateBet(id, patch) {
    setStore(value => ({ ...value, bets: value.bets.map(bet => bet.id === id ? { ...bet, ...patch } : bet) }));
  }

  function settleBet(bet, awayRuns = bet.market.includes('上半') ? bet.awayFirst5 : bet.awayRuns, homeRuns = bet.market.includes('上半') ? bet.homeFirst5 : bet.homeRuns) {
    const fraction = outcomeFractionForScore(bet.pick, Number(awayRuns), Number(homeRuns), bet.away, bet.home);
    if (fraction == null) return alert('盤口或球隊名稱無法結算');
    const stake = Number(bet.unit || 1) * store.settings.unitValue;
    const calculation = calculateProfit({ stake, water: bet.water, fraction, rebateRate: store.settings.rebateRate });
    const sameLine = !bet.closePick || extractLineToken(bet.closePick) === extractLineToken(bet.pick);
    const clv = bet.closeWater && sameLine ? priceCLV(bet.water, bet.closeWater) : null;
    const scorePatch = bet.market.includes('上半')
      ? { awayFirst5: Number(awayRuns), homeFirst5: Number(homeRuns) }
      : { awayRuns: Number(awayRuns), homeRuns: Number(homeRuns) };
    updateBet(bet.id, { ...scorePatch, stake, fraction, result: resultLabel(fraction), profit: calculation.profit, rebate: calculation.rebate, clv });
  }

  async function autoSettle(bet) {
    try {
      const data = await requestJSON(`/api/result?gamePk=${bet.gamePk}`);
      if (!data.final) return alert(`比賽尚未結束：${data.status}`);
      settleBet(bet, bet.market.includes('上半') ? data.awayFirst5 : data.awayRuns, bet.market.includes('上半') ? data.homeFirst5 : data.homeRuns);
    } catch (error) {
      alert(error.message);
    }
  }

  function removeBet(id) {
    if (confirm('確定刪除這筆下注紀錄？')) setStore(value => ({ ...value, bets: value.bets.filter(bet => bet.id !== id) }));
  }

  const gameSummary = useMemo(() => games.map(game => {
    const snapshots = store.locks.filter(item => String(item.game?.gamePk) === String(game.gamePk));
    const analyses = snapshots.map(lock => latestVersion(store.analysisHistory, lock.id)).filter(version => version?.ok);
    const scores = analyses.flatMap(version => version.analysis?.results || []).map(result => result.score).filter(Number.isFinite);
    return { ...game, snapshotCount: snapshots.length, analyzed: analyses.length > 0, highest: scores.length ? Math.max(...scores) : null };
  }), [games, store]);

  const allLatestResults = useMemo(() => store.locks.flatMap(lock => latestVersion(store.analysisHistory, lock.id)?.analysis?.results || []), [store]);
  const performance = useMemo(() => {
    const settled = store.bets.filter(bet => bet.fraction != null);
    const profit = settled.reduce((sum, bet) => sum + Number(bet.profit || 0), 0);
    const risk = settled.reduce((sum, bet) => sum + Number(bet.stake || 0), 0);
    const rebate = settled.reduce((sum, bet) => sum + Number(bet.rebate || 0), 0);
    const closing = settled.filter(bet => bet.clv != null);
    return {
      settled,
      profit,
      risk,
      rebate,
      roi: risk ? profit / risk : 0,
      avgClv: closing.length ? closing.reduce((sum, bet) => sum + Number(bet.clv), 0) / closing.length : null,
      positiveClv: closing.length ? closing.filter(bet => Number(bet.clv) > 0).length / closing.length : null,
      w: settled.filter(bet => Number(bet.fraction) > 0).length,
      l: settled.filter(bet => Number(bet.fraction) < 0).length,
      p: settled.filter(bet => Number(bet.fraction) === 0).length,
    };
  }, [store.bets]);

  function exportJSON() {
    download(`mlb-positive-ev-v6-${Date.now()}.json`, JSON.stringify(store, null, 2));
  }

  function exportCSV() {
    const head = ['時間', '分析快照', '模型版本', '比賽', '市場', '投注方向', '水位', '評分', '加權EV', '穩健EV', '保守EV', '翻負機率', 'Unit', '結果', '盈虧', '退水', '純水位CLV'];
    const rows = store.bets.map(bet => [
      bet.createdAt, bet.analysisSnapshotId, bet.modelVersion, translateTeamText(bet.game), bet.market, translateTeamText(bet.pick), bet.water, bet.score,
      bet.weightedEV, bet.robustEV, bet.conservativeEV, bet.evFlipProbability, bet.unit, bet.result, bet.profit, bet.rebate, bet.clv,
    ]);
    download(`mlb-bets-v6-${Date.now()}.csv`, [head, ...rows].map(row => row.map(value => `"${String(value ?? '').replaceAll('"', '""')}"`).join(',')).join('\n'), 'text/csv');
  }

  async function importJSON(file) {
    try {
      const data = JSON.parse(await file.text());
      setStore({
        ...EMPTY,
        ...data,
        locks: Array.isArray(data.locks) ? data.locks : [],
        analysisHistory: data.analysisHistory || {},
        bets: Array.isArray(data.bets) ? data.bets : [],
        settings: {
          ...DEFAULT_SETTINGS,
          ...data.settings,
          fallbackWater: { ...DEFAULT_SETTINGS.fallbackWater, ...(data.settings?.fallbackWater || {}) },
        },
      });
      alert('第 6 版備份已還原');
    } catch {
      alert('備份檔格式錯誤');
    }
  }

  const sampleMessage = performance.settled.length < 30
    ? '少於 30 筆：只記錄，不判定模型有效。'
    : performance.settled.length < 50
      ? '30～49 筆：只能做初步診斷。'
      : performance.settled.length < 100
        ? '50～99 筆：仍屬初步樣本。'
        : performance.settled.length < 200
          ? '100～199 筆：進入滾動監控。'
          : '200 筆以上：才適合正式檢查評分校準、CLV 與 ROI。';

  const scoreGroups = [
    ['8.5 分以上', bet => bet.score >= 8.5],
    ['8.0～8.4 分', bet => bet.score >= 8 && bet.score < 8.5],
    ['7.5～7.9 分', bet => bet.score >= 7.5 && bet.score < 8],
    ['7.2～7.4 分', bet => bet.score >= 7.2 && bet.score < 7.5],
    ['低於 7.2 分', bet => bet.score < 7.2],
  ];

  return <main className="shell">
    <header className="header">
      <div>
        <div className="eyebrow">私人分析系統</div>
        <h1>⚾ MLB 長期正期望值分析</h1>
        <p>實際開盤市場 → 聯合情境 → 台灣信用盤結算 → 穩健 EV → 綜合投注品質</p>
      </div>
      <div className="headerRight">
        <span className={`health ${health?.ok && health?.aiGatewayConfigured ? 'ok' : 'warn'}`}>
          {health?.ok ? (health.aiGatewayConfigured ? '人工智慧正常' : '人工智慧未設定') : '系統檢查中'}
        </span>
        <span className="badge">第 {VERSION} 版</span>
      </div>
    </header>

    <nav className="tabs">
      {[
        ['today', '今日賽事'], ['upload', '📷 上傳'], ['confirm', '盤口確認'], ['analysis', '分析結果'],
        ['bets', '下注紀錄'], ['perf', '績效'], ['settings', '設定'],
      ].map(([key, name]) => <button key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{name}</button>)}
    </nav>

    {tab === 'today' && <section>
      <div className="metrics">
        <Metric t="今日賽事" v={games.length}/>
        <Metric t="盤口快照" v={store.locks.length}/>
        <Metric t="正式候選" v={allLatestResults.filter(result => result.betEligible).length}/>
        <Metric t="最高評分" v={allLatestResults.filter(result => Number.isFinite(result.score)).length ? Math.max(...allLatestResults.filter(result => Number.isFinite(result.score)).map(result => result.score)).toFixed(1) : '—'}/>
      </div>
      <div className="card toolbar">
        <input type="date" value={date} onChange={event => setDate(event.target.value)}/>
        <button className="primary" onClick={() => loadGames(date)}>{loadingGames ? '載入中…' : '重新載入'}</button>
      </div>
      <div className="card">
        <h2>今日 MLB 賽事儀表板</h2>
        {!gameSummary.length ? <Empty text="今天沒有賽事或尚未載入"/> : gameSummary.map(game => <div className="gameRow" key={game.gamePk}>
          <div>
            <b>{matchup(game)}{game.doubleHeader !== 'N' ? `｜雙重賽第 ${game.gameNumber} 場` : ''}</b>
            <small>{dateText(game.gameDate)}｜{game.venue}</small>
            <small>先發投手（官方原文）：{game.awayProbable || '未公布'} 對 {game.homeProbable || '未公布'}</small>
          </div>
          <div className="gameStatus"><span className="pill">{game.status}</span><span>{game.snapshotCount} 個快照</span><strong>{game.highest?.toFixed(1) || '—'}</strong></div>
        </div>)}
      </div>
    </section>}

    {tab === 'upload' && <section>
      <div className="card">
        <h2>一、上傳信用盤截圖</h2>
        <label className="drop">點這裡從手機相簿選擇<input type="file" accept="image/*" multiple onChange={event => chooseImages(event.target.files)}/><span>最多 8 張；只擷取實際開出的市場</span></label>
        <div className="previews">{images.map(image => <div className="preview" key={image.id}><img src={image.preview} alt="盤口截圖"/><button onClick={() => setImages(value => value.filter(item => item.id !== image.id))}>移除</button><small>{image.name}</small></div>)}</div>
        <div className="status">{visionStatus || '尚未選擇圖片'}</div>
        <button className="primary full" disabled={visionBusy || !images.length} onClick={recognize}>{visionBusy ? '人工智慧辨識中，請勿重複點擊' : '開始辨識盤口'}</button>
      </div>
      <div className="card">
        <h2>二、盤口文字備援</h2>
        <textarea rows="7" value={manualText} onChange={event => setManualText(event.target.value)} placeholder="可直接貼上整段盤口文字"/>
        <button className="secondary full" disabled={visionBusy} onClick={parseText}>解析盤口文字</button>
      </div>
      <div className="card">
        <h2>三、手動建立空白賽事</h2>
        <div className="toolbar"><select value={manualGamePk} onChange={event => setManualGamePk(event.target.value)}><option value="">選擇今日賽事</option>{games.map(game => <option key={game.gamePk} value={game.gamePk}>{matchup(game)}</option>)}</select><button className="secondary" onClick={addManual}>建立</button></div>
      </div>
    </section>}

    {tab === 'confirm' && <section>
      <div className="card">
        <h2>盤口確認與不可覆寫快照</h2>
        {!parsed.length ? <Empty text="尚無辨識結果，請先到上傳頁"/> : <>
          <div className="chips">{parsed.map((game, index) => <button key={game.id} className={index === selected ? 'chip activeChip' : 'chip'} onClick={() => setSelected(index)}>{matchup(game)}</button>)}</div>
          <label>配對 MLB 官方賽事<select value={current?.matchedGame?.gamePk || ''} onChange={event => setMatch(event.target.value)}><option value="">請選擇</option>{games.map(game => <option key={game.gamePk} value={game.gamePk}>{matchup(game)}</option>)}</select></label>
          {MARKET_ORDER.map(market => {
            const row = current?.markets?.find(item => item.market === market) || { directions: [] };
            const directions = [0, 1].map(index => ({ ...blankDirection(), ...(row.directions?.[index] || {}) }));
            const opened = marketIsOpen(directions);
            return <div className="market" key={market}>
              <h3>{market} {!opened && <span className="pill">未開盤</span>}</h3>
              <div className="two">{directions.map((direction, index) => <div className="direction" key={index}>
                <label>方向＋盤口<input value={direction.pick || ''} onChange={event => editDirection(market, index, 'pick', event.target.value)}/></label>
                <label>水位<input type="number" step=".001" value={direction.water ?? ''} placeholder="可留空" onChange={event => editDirection(market, index, 'water', event.target.value)}/></label>
                <small>辨識信心 {Math.round(Number(direction.confidence || 0) * 100)}%｜{direction.waterEstimated ? '暫估水位' : direction.waterMissing ? '水位未提供' : hasActualWater(direction.water) ? '實際水位' : '未開盤'}</small>
              </div>)}</div>
            </div>;
          })}
          {currentErrors.length ? <div className="errors">{currentErrors.map(error => <div key={error}>• {error}</div>)}</div> : currentOpenMarkets.length ? <div className="success">✓ 已開 {currentOpenMarkets.length} 個市場、{currentDirections.length} 個方向。兩邊皆缺水位時自動套用市場暫估水位；單邊缺水位時只評實際水位方向。</div> : <div className="warnings">目前沒有已開盤市場</div>}
          <button className="primary full" onClick={lockCurrent}>🔒 建立不可覆寫盤口快照</button>
        </>}
      </div>
      <div className="card">
        <h2>盤口快照</h2>
        {!store.locks.length ? <Empty text="尚無盤口快照"/> : store.locks.map(lock => <div className="locked" key={lock.id}>
          <div><b>{matchup(lock.game)}</b><small>{dateText(lock.lockedAt)}｜{new Set(lock.markets.map(item => item.market)).size} 個市場｜分析版本 {(store.analysisHistory[lock.id] || []).length}</small></div>
          <div className="toolbar"><button className="primary" disabled={busyLocks[lock.id]} onClick={() => analyze(lock)}>{busyLocks[lock.id] ? '完整分析中…' : '建立新分析版本'}</button><button className="dangerSmall" onClick={() => removeLock(lock.id)}>刪除</button></div>
        </div>)}
      </div>
    </section>}

    {tab === 'analysis' && <section>
      {!store.locks.length ? <div className="card"><Empty text="尚無盤口快照"/></div> : store.locks.map(lock => {
        const versions = store.analysisHistory[lock.id] || [];
        const data = versions[0];
        return <div className="card analysisCard" key={lock.id}>
          <div className="analysisHead"><div><h2>{matchup(lock.game)}</h2><small>盤口快照 {dateText(lock.lockedAt)}｜分析版本 {versions.length}</small></div><button className="secondary" disabled={busyLocks[lock.id]} onClick={() => analyze(lock)}>{busyLocks[lock.id] ? '完整分析中…' : '以最新資料重算新版本'}</button></div>
          {!data?.ok ? <Empty text={busyLocks[lock.id] ? '正在取得資料並執行聯合情境…' : '此快照尚未分析'}/> : <>
            <Context context={data.context} analysis={data.analysis}/>
            {data.analysis.portfolio?.length > 0 && <div className="market"><h3>同場主選／次選與總曝險</h3><div className="portfolio">{data.analysis.portfolio.map((row, index) => <div className="portfolioRow" key={`${row.market}-${row.pick}`}><b>{index + 1}</b><span>{row.role}｜{row.market}｜{translateTeamText(row.pick)}</span><strong>{row.score.toFixed(1)}</strong><span>{row.recommendedUnit} Unit{index > 0 ? `｜與主選相關 ${pct(row.correlationToPrimary)}` : ''}</span></div>)}</div></div>}
            {MARKET_ORDER.map(market => {
              const rows = data.analysis.results.filter(result => result.market === market).sort((left, right) => (right.score ?? -1) - (left.score ?? -1));
              return <div className="market results" key={market}><h3>{market}</h3>{!rows.length ? <Empty text="未開盤"/> : rows.map((result, index) => <ResultCard key={`${result.pick}-${index}`} result={result} analysis={data.analysis} game={lock.game} settings={store.settings} onBet={() => addBet(lock.game, result, data.analysis)}/>)}</div>;
            })}
          </>}
        </div>;
      })}
    </section>}

    {tab === 'bets' && <section><div className="card"><h2>下注紀錄</h2>{!store.bets.length ? <Empty text="尚無下注紀錄"/> : <div className="betList">{store.bets.map(bet => <div className="betCard" key={bet.id}>
      <div className="betTop"><div><b>{translateTeamText(bet.game)}</b><small>{bet.market}｜{translateTeamText(bet.pick)}｜{Number(bet.water).toFixed(3)}｜評分 {Number(bet.score).toFixed(1)}｜{bet.portfolioRole || '單筆'}</small><small>加權 {pct(bet.weightedEV)}｜穩健 {pct(bet.robustEV)}｜保守 {pct(bet.conservativeEV)}｜翻負 {pct(bet.evFlipProbability)}</small><small>下注 {dateText(bet.createdAt)}｜模型快照 {bet.analysisSnapshotId || '—'}</small></div><button className="dangerSmall" onClick={() => removeBet(bet.id)}>刪除</button></div>
      <div className="betGrid"><label>Unit<input type="number" step=".25" value={bet.unit} onChange={event => updateBet(bet.id, { unit: Number(event.target.value), stake: Number(event.target.value) * store.settings.unitValue })}/></label>{bet.market.includes('上半') ? <><label>客隊前五局<input type="number" value={bet.awayFirst5} onChange={event => updateBet(bet.id, { awayFirst5: event.target.value })}/></label><label>主隊前五局<input type="number" value={bet.homeFirst5} onChange={event => updateBet(bet.id, { homeFirst5: event.target.value })}/></label></> : <><label>客隊得分<input type="number" value={bet.awayRuns} onChange={event => updateBet(bet.id, { awayRuns: event.target.value })}/></label><label>主隊得分<input type="number" value={bet.homeRuns} onChange={event => updateBet(bet.id, { homeRuns: event.target.value })}/></label></>}<label>收盤水位<input type="number" step=".001" value={bet.closeWater} onChange={event => updateBet(bet.id, { closeWater: event.target.value })}/></label><label>收盤盤口<input value={bet.closePick} onChange={event => updateBet(bet.id, { closePick: event.target.value })}/></label></div>
      <div className="toolbar"><button className="secondary" onClick={() => settleBet(bet)}>依比分結算</button><button className="secondary" onClick={() => autoSettle(bet)}>自動抓取終場</button><span className={`settle ${Number(bet.profit) >= 0 ? 'positive' : 'negative'}`}>{bet.result}｜{money(bet.profit)}｜退水 {money(bet.rebate)}{bet.clv != null ? `｜純水位 CLV ${pct(bet.clv)}` : ''}</span></div>
    </div>)}</div>}</div></section>}

    {tab === 'perf' && <section>
      <div className="metrics"><Metric t="總下注" v={store.bets.length}/><Metric t="已結算" v={performance.settled.length}/><Metric t="勝／敗／走" v={`${performance.w}/${performance.l}/${performance.p}`}/><Metric t="ROI" v={pct(performance.roi)}/><Metric t="總盈虧" v={money(performance.profit)}/><Metric t="總退水" v={money(performance.rebate)}/><Metric t="平均純水位 CLV" v={pct(performance.avgClv)}/><Metric t="正 CLV 比例" v={pct(performance.positiveClv)}/></div>
      <div className="card"><h2>樣本狀態</h2><div className="note">{sampleMessage}</div></div>
      <div className="card"><h2>評分區間</h2><GroupTable groups={scoreGroups.map(([name, filter]) => [name, store.bets.filter(filter)])}/></div>
      <div className="card"><h2>市場統計</h2><GroupTable groups={MARKET_ORDER.map(market => [market, store.bets.filter(bet => bet.market === market)])}/></div>
      <div className="card"><h2>球隊統計</h2><GroupTable groups={[...new Set(store.bets.flatMap(bet => [bet.away, bet.home]).filter(Boolean))].map(team => [translateTeamText(team), store.bets.filter(bet => bet.away === team || bet.home === team)])}/></div>
    </section>}

    {tab === 'settings' && <section>
      <div className="card"><h2>系統設定</h2><div className="settingsGrid">
        <Setting label="1 Unit 金額" value={store.settings.unitValue} step="1000" onChange={value => setStore(row => ({ ...row, settings: { ...row.settings, unitValue: Number(value) } }))}/>
        <Setting label="每萬退水比例" value={store.settings.rebateRate} step=".001" onChange={value => setStore(row => ({ ...row, settings: { ...row.settings, rebateRate: Number(value) } }))}/>
        <Setting label="下注候選門檻" value={store.settings.candidateThreshold} step=".1" onChange={value => setStore(row => ({ ...row, settings: { ...row.settings, candidateThreshold: Number(value) } }))}/>
        <Setting label="最強主推門檻" value={store.settings.strongestThreshold} step=".1" onChange={value => setStore(row => ({ ...row, settings: { ...row.settings, strongestThreshold: Number(value) } }))}/>
        <Setting label="每情境模擬次數" value={store.settings.simulationsPerScenario} step="100" onChange={value => setStore(row => ({ ...row, settings: { ...row.settings, simulationsPerScenario: Number(value) } }))}/>
        {MARKET_ORDER.map(market => <Setting key={market} label={`${market} 暫估水位`} value={store.settings.fallbackWater[market]} step=".001" onChange={value => setStore(row => ({ ...row, settings: { ...row.settings, fallbackWater: { ...row.settings.fallbackWater, [market]: Number(value) } } }))}/>) }
      </div><p className="note">未知打線、捕手、主審、牛棚與屋頂不固定扣分；系統會擴大 27 組聯合情境與翻轉風險。暫估水位只供觀察，不會進正式下注池。</p></div>
      <div className="card"><h2>備份與資料</h2><div className="toolbar wrap"><button className="secondary" onClick={exportJSON}>匯出 JSON 備份</button><button className="secondary" onClick={exportCSV}>匯出 CSV 明細</button><label className="fileButton">匯入 JSON 備份<input type="file" accept="application/json" onChange={event => event.target.files?.[0] && importJSON(event.target.files[0])}/></label><button className="danger" onClick={() => { if (confirm('確定清除全部快照、分析與下注資料？')) setStore({ ...EMPTY, settings: store.settings }); }}>清除資料</button></div><p className="note">資料保存在這台裝置的瀏覽器內。盤口快照與分析版本不互相覆寫，請定期匯出備份。</p></div>
    </section>}
  </main>;
}

function ResultCard({ result, analysis, settings, onBet }) {
  const score = result.score;
  const invalid = result.integrityWarning || score == null;
  const className = `result ${invalid ? 'invalid' : score >= settings.strongestThreshold ? 'best' : score >= settings.candidateThreshold ? 'candidate' : ''}`;
  return <div className={className}>
    <div className="resultMain">
      <div className="resultLine"><span className="score">{score == null ? '—' : score.toFixed(1)}</span>｜{translateTeamText(result.pick)}｜{result.water == null ? '水位未提供' : Number(result.water).toFixed(3)}{result.waterEstimated ? '（暫估）' : ''}<span className="tag">{result.tag}</span></div>
      {score != null && <>
        <small>加權 EV {pct(result.weightedEV)}｜穩健 EV {pct(result.robustEV)}｜保守 EV {pct(result.conservativeEV)}｜EV 翻負 {pct(result.evFlipProbability)}</small>
        <small>模型過盤率 {pct(result.modelProbability)}｜市場去水基準 {pct(result.marketAnchorProbability)}｜合理水位 {result.fairWater?.toFixed?.(3) || '—'}｜卡洞 {pct(result.exactLineProbability)}</small>
        <small>全贏 {pct(result.fullWinProbability)}｜部分贏 {pct(result.partialWinProbability)}｜走水 {pct(result.pushProbability)}｜最不利集合 {result.worstVariant || '—'}</small>
        <small>主要敏感因素：{result.scenarioSensitivity?.primary || '—'}（EV 範圍 {pct(result.scenarioSensitivity?.primaryRange)}）｜建議 {result.portfolioUnit || result.unitSuggestion || 0} Unit</small>
        {result.movement?.available ? <small>盤勢：{result.movement.verdict || result.movement.reason}{result.movement.deltaEV != null ? `｜價值變化 ${pct(result.movement.deltaEV)}` : ''}{result.movement.crossedKeyNumbers?.length ? `｜跨過關鍵數字 ${result.movement.crossedKeyNumbers.join('、')}` : ''}</small> : <small>盤勢：{result.movement?.reason || '無舊盤可比較'}</small>}
        {result.integrityMessage && <div className="errors">{result.integrityMessage}</div>}
        {result.primaryRisks?.length > 0 && <ul className="riskList">{result.primaryRisks.map(risk => <li key={risk}>{risk}</li>)}</ul>}
      </>}
    </div>
    <button disabled={!result.betEligible} onClick={onBet}>{result.betEligible ? '記錄下注' : '不進下注池'}</button>
  </div>;
}

function Context({ context, analysis }) {
  const away = context.away || {};
  const home = context.home || {};
  const umpireName = context.umpire?.name || (typeof context.umpire === 'string' ? context.umpire : '') || '未公布';
  return <>
    <div className="contextGrid">
      <Info t="模型／規則" v={`${analysis.modelVersion}｜${analysis.rulesVersion}`}/>
      <Info t="分析版本" v={`${analysis.analysisStatus}｜${analysis.snapshotId}`}/>
      <Info t="先發" v={`${away.starter?.status || '未知'} ${away.starter?.name || '—'} 對 ${home.starter?.status || '未知'} ${home.starter?.name || '—'}`}/>
      <Info t="預估得分" v={`全場 ${analysis.expectedRuns.full.away.toFixed(2)}－${analysis.expectedRuns.full.home.toFixed(2)}｜前五局 ${analysis.expectedRuns.first5.away.toFixed(2)}－${analysis.expectedRuns.first5.home.toFixed(2)}`}/>
      <Info t="打線／捕手" v={`${away.lineup?.official ? '正式' : '預估'} ${away.lineup?.catcher || '中性'}｜${home.lineup?.official ? '正式' : '預估'} ${home.lineup?.catcher || '中性'}`}/>
      <Info t="牛棚疲勞" v={`客隊 ${Math.round((away.bullpen?.fatigueIndex || 0) * 100)}%｜主隊 ${Math.round((home.bullpen?.fatigueIndex || 0) * 100)}%`}/>
      <Info t="球場／天氣" v={`${context.park?.name || '—'}（${context.park?.roofZh || '屋頂未知'}）｜${context.weather?.available ? `${context.weather.temperature}°C、風 ${context.weather.windSpeed} km/h、雨 ${context.weather.precipitationProbability}%` : '預估情境'}`}/>
      <Info t="旅行／休息" v={`客隊休 ${away.rest?.days ?? '—'} 天／${away.rest?.travelKm || 0} km｜主隊休 ${home.rest?.days ?? '—'} 天／${home.rest?.travelKm || 0} km`}/>
      <Info t="主審／資料品質" v={`${umpireName}｜${pct(analysis.dataQuality)}`}/>
      <Info t="聯合情境" v={`${analysis.scenarioSummary.count} 組 × ${analysis.scenarioSummary.simulationsPerScenario} 次｜${analysis.scenarioSummary.robustVariantCount} 組穩健壓力`}/>
    </div>
    {analysis.featureProvenance?.length > 0 && <div className="sourceRows">{analysis.featureProvenance.map(row => <div className="sourceRow" key={row.feature}><b>{row.feature}</b><span>{row.status}</span><span>{row.source}</span></div>)}</div>}
    {analysis.warnings?.length > 0 && <div className="warnings">{analysis.warnings.join('；')}</div>}
  </>;
}

function Metric({ t, v }) { return <div className="metric"><span>{t}</span><b>{v}</b></div>; }
function Empty({ text }) { return <div className="empty">{text}</div>; }
function Setting({ label, value, onChange, step }) { return <label>{label}<input type="number" value={value} step={step} onChange={event => onChange(event.target.value)}/></label>; }
function Info({ t, v }) { return <div className="info"><span>{t}</span><b>{v}</b></div>; }
function GroupTable({ groups }) {
  return <div className="groupTable">{groups.filter(([, rows]) => rows.length).map(([name, rows]) => {
    const settled = rows.filter(bet => bet.fraction != null);
    const profit = settled.reduce((sum, bet) => sum + Number(bet.profit || 0), 0);
    const risk = settled.reduce((sum, bet) => sum + Number(bet.stake || 0), 0);
    return <div key={name}><b>{name}</b><span>{rows.length} 筆</span><span>{settled.length} 已結算</span><span>ROI {pct(risk ? profit / risk : 0)}</span><span>{money(profit)}</span></div>;
  })}</div>;
}
