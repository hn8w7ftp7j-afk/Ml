'use client';

import { useRef, useState } from 'react';
import { buildGameAnalysisCopy, writeAnalysisClipboard } from '../lib/game-analysis-copy.js';

export default function GameAnalysisCopy({ cardRef, receipt, matchup, available }) {
  const busy = useRef(false);
  const [state, setState] = useState('idle');
  const [manualText, setManualText] = useState('');
  const [error, setError] = useState('');
  const [showText, setShowText] = useState(false);
  async function copy() {
    if (busy.current || !available) return;
    busy.current = true;
    setState('copying');
    setError('');
    setManualText('');
    let text = '';
    try {
      // Capture this card synchronously before a background render can change it.
      text = buildGameAnalysisCopy(cardRef.current, receipt);
      setManualText(text);
      await writeAnalysisClipboard(text);
      setState('copied');
    } catch {
      setManualText(text);
      setShowText(true);
      setError(text ? '瀏覽器未允許自動複製，請在下方文字框全選並複製。' : '此場分析尚未準備好，請稍後再試。');
      setState('failed');
    } finally { busy.current = false; }
  }
  return <div className="analysisCopy" data-analysis-copy-controls="true">
    <button type="button" className="mini analysisCopyButton" onClick={copy} disabled={!available || state === 'copying'} aria-label={`複製完整分析：${matchup}`} title={available ? '包含所有收合中的分析明細，不會重新分析' : '此場產生分析後即可複製'}>{state === 'copying' ? '正在複製…' : '複製完整分析'}</button>
    <span role="status" className="analysisCopyStatus">{state === 'copied' ? '已複製完整分析' : error}</span>
    {manualText && <button type="button" className="mini" onClick={() => setShowText(value => !value)}>{showText ? '收合匯出文字' : '檢視本次複製文字'}</button>}
    {manualText && showText && <label className="analysisCopyFallback">整場分析文字（本次按下複製時凍結；可全選複製）<textarea aria-label={`完整分析文字：${matchup}`} readOnly value={manualText} onFocus={event => { event.currentTarget.select(); event.currentTarget.setSelectionRange(0, manualText.length); }}/></label>}
  </div>;
}
