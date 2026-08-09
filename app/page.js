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
import { blankDirection, buildAutoAnalysisPlan, flattenMarkets, withFallbackWater } from '../lib/batch.js';
import { translateTeamText } from '../lib/i18n.js';

const VERSION = '8.0.0';
const STORAGE = 'mlb-positive-ev-v7';
const LEGACY_KEYS = ['mlb-positive-ev-v6-1', 'mlb-positive-ev-v6', 'mlb-positive-ev-v5', 'mlb-positive-ev-v4', 'mlb-positive-ev-v3'];
const DEFAULT_SETTINGS = {
  unitValue: 10000,
  rebateRate: 0.015,
  candidateThreshold: 7.2,
  strongestThreshold: 8.5,
  simulationsPerScenario: 1800,
  expertMode: 'auto',
  fallbackWater: {
    全場讓分: 0.95,
    全場大小: 0.94,
    上半讓分: 0.94,
    上半大小: 0.93,
  },
};
const EMPTY = { locks: [], analysisHistory: {}, bets: [], settings: DEFAULT_SETTINGS, lastBatchId: null };
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

function canvasDataURL(canvas, quality = 0.92) {
  return canvas.toDataURL('image/jpeg', quality);
}

function renderImageCrop(image, sx, sy, sw, sh, { minimumWidth = 1500, maximumDimension = 2400 } = {}) {
  const sourceMaximum = Math.max(sw, sh);
  const desiredScale = Math.max(1, minimumWidth / Math.max(1, sw));
  const scale = Math.max(0.35, Math.min(2, maximumDimension / Math.max(1, sourceMaximum), desiredScale));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(sw * scale));
  canvas.height = Math.max(1, Math.round(sh * scale));
  const context = canvas.getContext('2d', { alpha: false });
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  let data = canvasDataURL(canvas, 0.9);
  if (data.length > 3_000_000) data = canvas.toDataURL('image/jpeg', 0.76);
  return data;
}

async function prepareImage(file) {
  const source = await readDataURL(file);
  return new Promise(resolve => {
    const image = new Image();
    image.onload = () => {
      const full = renderImageCrop(image, 0, 0, image.width, image.height, { minimumWidth: 1600, maximumDimension: 2400 });
      const denseBoard = image.width >= 850 && image.height >= 500;
      if (!denseBoard) {
        resolve({ data: full, parts: [full], width: image.width, height: image.height });
        return;
      }

      const ratio = image.height / Math.max(1, image.width);
      const segmentCount = ratio > 1.7 ? 5 : ratio > 1.15 ? 4 : 3;
      const cropHeight = Math.min(image.height, Math.ceil((image.height / segmentCount) * 1.62));
      const travel = Math.max(0, image.height - cropHeight);
      const positions = segmentCount === 1
        ? [0]
        : Array.from({ length: segmentCount }, (_, index) => Math.round(travel * index / (segmentCount - 1)));
      const crops = [...new Set(positions)].map(position => renderImageCrop(
        image,
        0,
        position,
        image.width,
        cropHeight,
        { minimumWidth: 1900, maximumDimension: 2400 },
      ));
      // Full-image pass discovers every matchup; overlapping crops recover small market text.
      const parts = [full, ...crops];
      resolve({ data: full, parts, width: image.width, height: image.height });
    };
    image.onerror = () => resolve({ data: source, parts: [source], width: 0, height: 0 });
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

async function runPool(items, concurrency, worker) {
  const rows = Array.isArray(items) ? items : [];
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, rows.length || 1)) }, async () => {
    while (cursor < rows.length) {
      const index = cursor;
      cursor += 1;
      await worker(rows[index], index);
    }
  });
  await Promise.all(runners);
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
  const [batchReport, setBatchReport] = useState(null);
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

  async function scheduleForRecognition() {
  if (games.length) return games;
  setVisionStatus('正在先載入當日 MLB 官方賽程…');
  const data = await requestJSON(`/api/mlb?date=${date}`);
  const schedule = data.games || [];
  setGames(schedule);
  if (!schedule.length) throw new Error('當日沒有可配對的 MLB 官方賽事');
  return schedule;
}

  async function chooseImages(files) {
    const list = [...(files || [])].slice(0, 8);
    if (!list.length || visionBusy) return;
    setVisionBusy(true);
    setBatchReport(null);
    setVisionStatus('正在保留文字清晰度並分段全部圖片…');
    try {
      const rows = [];
      for (let index = 0; index < list.length; index += 1) {
        const file = list[index];
        const prepared = await prepareImage(file);
        rows.push({
          id: uid(),
          name: file.name,
          preview: URL.createObjectURL(file),
          data: prepared.data,
          parts: prepared.parts,
          width: prepared.width,
          height: prepared.height,
          size: file.size,
        });
        setVisionStatus(`正在處理第 ${index + 1} 張，共 ${list.length} 張；此圖分為 ${prepared.parts.length} 區塊`);
      }
      setImages(rows);
      const regions = rows.reduce((sum, row) => sum + Math.max(1, row.parts?.length || 0), 0);
      setVisionStatus(`已準備 ${rows.length} 張圖片、${regions} 個區塊；現在自動辨識全部盤口`);
      const schedule = await scheduleForRecognition();
      await recognizeAndAnalyze(rows, schedule);
    } catch (error) {
      setVisionStatus(`自動處理失敗：${error.message}`);
    } finally {
      setVisionBusy(false);
    }
  }

  async function recognizeAndAnalyze(sourceImages, schedule) {
    const all = [];
    const failures = [];
    const models = new Set();
    const tasks = sourceImages.flatMap((image, imageIndex) => {
      const parts = Array.isArray(image.parts) && image.parts.length ? image.parts : [image.data];
      return parts.map((data, partIndex) => ({ image, imageIndex, partIndex, partCount: parts.length, data }));
    });

    for (let index = 0; index < tasks.length; index += 1) {
      const task = tasks[index];
      setVisionStatus(`自動辨識全部圖片：圖片 ${task.imageIndex + 1}/${sourceImages.length}，區塊 ${task.partIndex + 1}/${task.partCount}`);
      try {
        const data = await requestJSON('/api/vision', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ images: [task.data], schedule, defaultWater: store.settings.fallbackWater }),
        });
        if (data.model) models.add(data.model);
        all.push(...(data.games || []));
      } catch (error) {
        failures.push(`圖片 ${task.imageIndex + 1} 區塊 ${task.partIndex + 1}：${error.message}`);
      }
    }

    let merged = mergeVision(all);
    if (!merged.length) throw new Error(failures[0] || '沒有辨識到任何場次，請改貼盤口文字或裁切更小範圍');

    // Completeness pass: a board screenshot must not silently finish after returning only part of the visible slate.
    const matchedIds = new Set(merged.map(row => String(row.gamePk || '')).filter(Boolean));
    const scheduledIds = new Set((schedule || []).map(row => String(row.gamePk || '')).filter(Boolean));
    const coverage = scheduledIds.size ? matchedIds.size / scheduledIds.size : 1;
    if (sourceImages.length && merged.length < 7 && coverage < 0.70) {
      setVisionStatus(`目前只辨識 ${merged.length} 場，正在執行整張圖完整性補掃…`);
      for (let imageIndex = 0; imageIndex < sourceImages.length; imageIndex += 1) {
        try {
          const data = await requestJSON('/api/vision', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ images: [sourceImages[imageIndex].data], schedule, defaultWater: store.settings.fallbackWater, completenessPass: true }),
          });
          if (data.model) models.add(data.model);
          all.push(...(data.games || []));
        } catch (error) {
          failures.push(`圖片 ${imageIndex + 1} 完整性補掃：${error.message}`);
        }
      }
      merged = mergeVision(all);
    }
    setParsed(merged);
    setSelected(0);
    const modelText = models.size ? `｜${[...models].join('、')}` : '';
    const partialText = failures.length ? `｜${failures.length} 個區塊需注意` : '';
    const finalMatched = new Set(merged.map(row => String(row.gamePk || '')).filter(Boolean)).size;
    const scheduleCount = (schedule || []).length;
    const completenessText = scheduleCount ? `｜官方賽程覆蓋 ${finalMatched}/${scheduleCount}` : '';
    setVisionStatus(`辨識完成 ${merged.length} 場${completenessText}${modelText}${partialText}；開始自動分析所有有效盤口`);
    await autoAnalyzeAll(merged, failures);
  }

  async function recognize() {
    if (!images.length || visionBusy) return;
    setVisionBusy(true);
    setBatchReport(null);
    try {
      const schedule = await scheduleForRecognition();
      await recognizeAndAnalyze(images, schedule);
    } catch (error) {
      setVisionStatus(`重新處理失敗：${error.message}`);
    } finally {
      setVisionBusy(false);
    }
  }

  async function parseText() {
    if (!manualText.trim() || visionBusy) return;
    setVisionBusy(true);
    setBatchReport(null);
    setVisionStatus('正在解析全部盤口文字…');
    try {
      const schedule = await scheduleForRecognition();
      const data = await requestJSON('/api/vision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: manualText, schedule, defaultWater: store.settings.fallbackWater }),
      });
      const rows = mergeVision(data.games || []);
      if (!rows.length) throw new Error('沒有解析到場次');
      setParsed(rows);
      setSelected(0);
      setVisionStatus(`解析完成 ${rows.length} 場；開始自動分析所有有效盤口`);
      await autoAnalyzeAll(rows, []);
    } catch (error) {
      setVisionStatus(`解析或分析失敗：${error.message}`);
    } finally {
      setVisionBusy(false);
    }
  }

  async function autoAnalyzeAll(rows, recognitionFailures = []) {
    const existingLocks = [...store.locks];
    const plan = buildAutoAnalysisPlan({
      games: rows,
      settings: store.settings,
      version: VERSION,
      batchId: uid(),
      idFactory: uid,
    });
    setParsed(plan.preparedGames);

    if (!plan.locks.length) {
      const report = {
        batchId: plan.batchId,
        recognized: plan.recognizedGameCount,
        analyzed: 0,
        failed: 0,
        skipped: plan.recognizedGameCount,
        directions: 0,
        issues: [...plan.issues, ...recognitionFailures],
      };
      setBatchReport(report);
      setVisionStatus('辨識已完成，但沒有可直接分析的有效盤口；請到盤口確認頁修正');
      setTab('confirm');
      return;
    }

    setStore(value => ({
      ...value,
      lastBatchId: plan.batchId,
      locks: [...plan.locks, ...value.locks].slice(0, 300),
    }));
    setBusyLocks(value => ({ ...value, ...Object.fromEntries(plan.locks.map(lock => [lock.id, true])) }));

    let finished = 0;
    let completed = 0;
    const analysisFailures = [];
    await runPool(plan.locks, 2, async lock => {
      const previous = existingLocks
        .filter(item => String(item.game?.gamePk) === String(lock.game?.gamePk) && new Date(item.lockedAt) < new Date(lock.lockedAt))
        .sort((left, right) => new Date(right.lockedAt) - new Date(left.lockedAt))[0];
      try {
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
        const analysisVersion = { id: uid(), createdAt: new Date().toISOString(), ...data };
        setStore(value => ({
          ...value,
          analysisHistory: {
            ...value.analysisHistory,
            [lock.id]: [analysisVersion, ...(value.analysisHistory[lock.id] || [])].slice(0, 30),
          },
        }));
        completed += 1;
      } catch (error) {
        analysisFailures.push(`${matchup(lock.game)}：${error.message}`);
      } finally {
        finished += 1;
        setBusyLocks(value => ({ ...value, [lock.id]: false }));
        setVisionStatus(`自動分析全部盤口：已完成 ${finished}/${plan.locks.length} 場`);
      }
    });

    const issues = [...plan.issues, ...recognitionFailures, ...analysisFailures];
    const report = {
      batchId: plan.batchId,
      recognized: plan.recognizedGameCount,
      analyzed: completed,
      failed: analysisFailures.length,
      skipped: Math.max(0, plan.recognizedGameCount - plan.locks.length),
      directions: plan.directionCount,
      markets: plan.marketCount,
      issues,
    };
    setBatchReport(report);
    setVisionStatus(`全部完成：辨識 ${report.recognized} 場，自動分析 ${report.analyzed} 場、${report.markets} 個市場、${report.directions} 個方向${issues.length ? `；${issues.length} 項需核對` : ''}`);
    setTab(completed > 0 ? 'analysis' : 'confirm');
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
  const latestBatchLocks = useMemo(() => store.lastBatchId ? store.locks.filter(lock => lock.batchId === store.lastBatchId) : [], [store]);
  const latestBatchRows = useMemo(() => latestBatchLocks.flatMap(lock => {
    const data = latestVersion(store.analysisHistory, lock.id);
    return (data?.analysis?.results || []).map(result => ({ lock, data, result }));
  }).sort((left, right) => (right.result.score ?? -1) - (left.result.score ?? -1)), [latestBatchLocks, store.analysisHistory]);
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
    download(`mlb-positive-ev-v7-${Date.now()}.json`, JSON.stringify(store, null, 2));
  }

  function exportCSV() {
    const head = ['時間', '分析快照', '模型版本', '比賽', '市場', '投注方向', '水位', '評分', '加權EV', '穩健EV', '保守EV', '翻負機率', 'Unit', '結果', '盈虧', '退水', '純水位CLV'];
    const rows = store.bets.map(bet => [
      bet.createdAt, bet.analysisSnapshotId, bet.modelVersion, translateTeamText(bet.game), bet.market, translateTeamText(bet.pick), bet.water, bet.score,
      bet.weightedEV, bet.robustEV, bet.conservativeEV, bet.evFlipProbability, bet.unit, bet.result, bet.profit, bet.rebate, bet.clv,
    ]);
    download(`mlb-bets-v7-${Date.now()}.csv`, [head, ...rows].map(row => row.map(value => `"${String(value ?? '').replaceAll('"', '""')}"`).join(',')).join('\n'), 'text/csv');
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
      alert('第 7 版備份已還原');
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
        <p>上傳全部圖片 → 自動辨識全部盤口 → 自動分析全部場次 → 一次顯示所有評分</p>
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
        <h2>一、上傳後自動分析全部盤口</h2>
        <label className="drop">點這裡一次選擇所有盤口圖片<input type="file" accept="image/*" multiple disabled={visionBusy} onChange={event => { chooseImages(event.target.files); event.target.value = ''; }}/><span>最多 8 張；選完後自動辨識、建立全部快照並分析所有實際開盤市場，不必逐場按分析</span></label>
        <div className="previews">{images.map(image => <div className="preview" key={image.id}><img src={image.preview} alt="盤口截圖"/><button disabled={visionBusy} onClick={() => setImages(value => value.filter(item => item.id !== image.id))}>移除</button><small>{image.name}</small></div>)}</div>
        <div className="status">{visionStatus || '尚未選擇圖片；選圖後會直接跑到全部評分'}</div>
        {batchReport && <div className={batchReport.issues?.length ? 'warnings' : 'success'}>本次辨識 {batchReport.recognized} 場｜成功分析 {batchReport.analyzed} 場｜{batchReport.markets || 0} 個市場｜{batchReport.directions || 0} 個方向{batchReport.issues?.length ? `｜${batchReport.issues.length} 項需核對` : '｜全部完成'}</div>}
        <button className="secondary full" disabled={visionBusy || !images.length} onClick={recognize}>{visionBusy ? '正在自動辨識並分析全部盤口…' : '重新辨識並分析目前全部圖片'}</button>
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
        <h2>盤口確認與不可覆寫快照</h2><p className="note">一般上傳不需要逐場操作；只有未配對或辨識異常的市場才需要在這裡修正。</p>
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
      {latestBatchRows.length > 0 && <div className="batchStrip">
        <div><span>本次分析完成</span><b>{latestBatchLocks.length} 場</b></div>
        <div><span>最高評分</span><b>{Math.max(...latestBatchRows.map(row => Number(row.result.score) || 0)).toFixed(1)}</b></div>
        <div><span>下注候選</span><b>{latestBatchRows.filter(row => Number(row.result.score) >= store.settings.candidateThreshold && row.result.betEligible).length}</b></div>
      </div>}
      {!store.locks.length ? <div className="card"><Empty text="尚無盤口快照"/></div> : store.locks.map(lock => {
        const versions = store.analysisHistory[lock.id] || [];
        const data = versions[0];
        return <div className="card analysisCard" key={lock.id}>
          <div className="analysisHead"><div><h2>{matchup(lock.game)}</h2><small>盤口快照 {dateText(lock.lockedAt)}｜分析版本 {versions.length}</small></div><button className="secondary" disabled={busyLocks[lock.id]} onClick={() => analyze(lock)}>{busyLocks[lock.id] ? '完整分析中…' : '以最新資料重算新版本'}</button></div>
          {!data?.ok ? <Empty text={busyLocks[lock.id] ? '正在取得資料、執行 GPT 研究判讀與聯合情境…' : '此快照尚未分析'}/> : <>
            <div className="starterLine">先發：{data.context?.away?.starter?.name || lock.game?.awayProbable || '未公布'} 對 {data.context?.home?.starter?.name || lock.game?.homeProbable || '未公布'}</div>
            {MARKET_ORDER.map(market => {
              const rows = data.analysis.results.filter(result => result.market === market).sort((left, right) => (right.score ?? -1) - (left.score ?? -1));
              return <div className="classicMarket" key={market}><h3>{market}</h3>{!rows.length ? <div className="unopened">未開盤</div> : rows.map((result, index) => <ClassicResultRow key={`${result.pick}-${index}`} result={result} settings={store.settings} onBet={() => addBet(lock.game, result, data.analysis)}/>)}</div>;
            })}
            <details className="analysisDetails"><summary>查看完整分析細節</summary><Context context={data.context} analysis={data.analysis}/><AlignmentAudit audit={data.analysis.alignmentAudit}/>{data.analysis.portfolio?.length > 0 && <div className="market"><h3>同場主選／次選與總曝險</h3><div className="portfolio">{data.analysis.portfolio.map((row, index) => <div className="portfolioRow" key={`${row.market}-${row.pick}`}><b>{index + 1}</b><span>{row.role}｜{row.market}｜{translateTeamText(row.pick)}</span><strong>{row.score.toFixed(1)}</strong><span>{row.recommendedUnit} Unit{index > 0 ? `｜與主選相關 ${pct(row.correlationToPrimary)}` : ''}</span></div>)}</div></div>}</details>
          </>}
        </div>;
      })}
      {latestBatchRows.some(row => Number(row.result.score) >= store.settings.candidateThreshold && row.result.betEligible) && <div className="card candidateList"><h2>今日下注候選</h2><p className="note">只列本次上傳中達 {store.settings.candidateThreshold.toFixed(1)} 分以上且可進下注池的方向。</p>{latestBatchRows.filter(row => Number(row.result.score) >= store.settings.candidateThreshold && row.result.betEligible).map(({ lock, result }, index) => <div className={`candidateRow ${Number(result.score) >= store.settings.strongestThreshold ? 'strongestRow' : ''}`} key={`${lock.id}-${result.market}-${result.pick}-${index}`}><b>{Number(result.score).toFixed(1)}</b><span>{matchup(lock.game)}｜{result.market}｜{translateTeamText(result.pick)}｜{Number(result.water).toFixed(3)}</span><strong>{Number(result.score) >= store.settings.strongestThreshold ? '最強主推' : '下注候選'}</strong></div>)}</div>}
      {batchReport?.issues?.length > 0 && <details className="card analysisDetails"><summary>本次辨識需核對 {batchReport.issues.length} 項</summary><div className="warnings">{batchReport.issues.slice(0, 12).map(item => <div key={item}>• {item}</div>)}</div></details>}
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
        <label>GPT 研究判讀層<select value={store.settings.expertMode || 'auto'} onChange={event => setStore(row => ({ ...row, settings: { ...row.settings, expertMode: event.target.value } }))}><option value="auto">自動整合；失敗時統計備援</option><option value="off">純統計模式</option><option value="required">GPT 未完成就不評分</option></select></label>
        {MARKET_ORDER.map(market => <Setting key={market} label={`${market} 暫估水位`} value={store.settings.fallbackWater[market]} step=".001" onChange={value => setStore(row => ({ ...row, settings: { ...row.settings, fallbackWater: { ...row.settings.fallbackWater, [market]: Number(value) } } }))}/>) }
      </div><p className="note">未知打線、捕手、主審、牛棚與屋頂不固定扣分；GPT 研究層只提供殘差交互作用與情境權重，不能直接改分。暫估水位只供觀察，不會進正式下注池。</p></div>
      <div className="card"><h2>備份與資料</h2><div className="toolbar wrap"><button className="secondary" onClick={exportJSON}>匯出 JSON 備份</button><button className="secondary" onClick={exportCSV}>匯出 CSV 明細</button><label className="fileButton">匯入 JSON 備份<input type="file" accept="application/json" onChange={event => event.target.files?.[0] && importJSON(event.target.files[0])}/></label><button className="danger" onClick={() => { if (confirm('確定清除全部快照、分析與下注資料？')) setStore({ ...EMPTY, settings: store.settings }); }}>清除資料</button></div><p className="note">資料保存在這台裝置的瀏覽器內。盤口快照與分析版本不互相覆寫，請定期匯出備份。</p></div>
    </section>}
  </main>;
}

function ClassicResultRow({ result, settings, onBet }) {
  const score = Number.isFinite(Number(result.score)) ? Number(result.score) : null;
  const strongest = score != null && score >= settings.strongestThreshold && result.betEligible;
  const candidate = score != null && score >= settings.candidateThreshold && result.betEligible;
  const icon = strongest ? '🟡' : candidate ? '🟢' : '⚪';
  const unit = result.portfolioUnit || result.unitSuggestion || 0;
  return <div className={`classicResult ${strongest ? 'classicStrongest' : candidate ? 'classicCandidate' : ''}`}>
    <div className="classicPrimary"><span className="classicIcon">{icon}</span><b className="classicScore">{score == null ? '—' : score.toFixed(1)}</b><span className="classicPick">｜{translateTeamText(result.pick)}｜{result.water == null ? '水位未提供' : Number(result.water).toFixed(3)}{result.waterEstimated ? ' 暫估' : ''}</span>{strongest && <span className="classicTag">最強主推</span>}{candidate && !strongest && <span className="classicTag">下注候選</span>}</div>
    {score != null && <div className="classicMeta">穩健 EV {pct(result.robustEV)}｜建議 {unit} Unit</div>}
    {result.betEligible && <button className="classicBet" onClick={onBet}>記錄下注</button>}
  </div>;
}

function ResultCard({ result, analysis, settings, onBet }) {
  const score = result.score;
  const invalid = result.integrityWarning || score == null;
  const className = `result ${invalid ? 'invalid' : score >= settings.strongestThreshold ? 'best' : score >= settings.candidateThreshold ? 'candidate' : ''}`;
  return <div className={className}>
    <div className="resultMain">
      <div className="resultLine"><span className="score">{score == null ? '—' : score.toFixed(1)}</span>｜{translateTeamText(result.pick)}｜{result.water == null ? '水位未提供' : Number(result.water).toFixed(3)}{result.waterEstimated ? '（暫估）' : ''}<span className="tag">{result.tag}</span></div>
      {score != null && <>
        <small>正式加權 EV {pct(result.weightedEV)}｜穩健 EV {pct(result.robustEV)}｜保守 EV {pct(result.conservativeEV)}｜統計原始 EV {pct(result.rawEV)}｜情境翻負 {pct(result.evFlipProbability)}</small>
        <small>正式過盤率 {pct(result.modelProbability)}｜統計原始率 {pct(result.rawModelProbability)}｜市場先驗 {pct(result.marketAnchorProbability)}｜資料模型權重 {pct(result.marketCalibrationWeight)}</small>
        <small>模型誤差門檻 {pct(result.modelErrorFloor)}｜獨立資料強度 {pct(result.independentEvidenceStrength)}｜分歧風險 {pct(result.divergenceRisk)}｜合理水位 {result.fairWater?.toFixed?.(3) || '—'}</small>
        <small>原始比分分布：全贏 {pct(result.fullWinProbability)}｜部分贏 {pct(result.partialWinProbability)}｜走水 {pct(result.pushProbability)}｜卡洞 {pct(result.exactLineProbability)}｜最不利集合 {result.worstVariant || '—'}</small>
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
      <Info t="GPT 研究判讀" v={`${analysis.alignmentAudit?.expertLayer?.used ? '已整合' : '統計備援'}｜${analysis.alignmentAudit?.expertLayer?.model || analysis.alignmentAudit?.expertLayer?.reason || '—'}`}/>
    </div>
    {analysis.featureProvenance?.length > 0 && <div className="sourceRows">{analysis.featureProvenance.map(row => <div className="sourceRow" key={row.feature}><b>{row.feature}</b><span>{row.status}</span><span>{row.source}</span></div>)}</div>}
    {analysis.warnings?.length > 0 && <div className="warnings">{analysis.warnings.join('；')}</div>}
  </>;
}

function AlignmentAudit({ audit }) {
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
