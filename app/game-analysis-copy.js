'use client';

import { useRef, useState } from 'react';
import { buildGameAnalysisCopy, writeAnalysisClipboard } from '../lib/game-analysis-copy.js';

export default function GameAnalysisCopy({ cardRef, receipt, matchup, available }) {
  const busy = useRef(false);
  const [state, setState] = useState('idle');
  const [manualText, setManualText] = useState('');
  const [error, setError] = useState('');
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
      await writeAnalysisClipboard(text);
      setState('copied');
    } catch {
      setManualText(text);
      setError(text ? '瀏覽器未允許自動複製，請在下方文字框全選並複製。' : '此場分析尚未準備好，請稍後再試。');
      setState('failed');
    } finally { busy.current = false; }
  }
  return <div className="analysisCopy" data-analysis-copy-controls="true">
    <button type="button" className="mini analysisCopyButton" onClick={copy} disabled={!available || state === 'copying'} aria-label={`複製完整分析：${matchup}`} title={available ? '包含所有收合中的分析明細，不會重新分析' : '此場產生分析後即可複製'}>{state === 'copying' ? '正在複製…' : '複製完整分析'}</button>
    <span role="status" className="analysisCopyStatus">{state === 'copied' ? '已複製完整分析' : error}</span>
    {manualText && <label className="analysisCopyFallback">整場分析文字（點選後全選複製）<textarea aria-label={`完整分析文字：${matchup}`} readOnly value={manualText} onFocus={event => { event.currentTarget.select(); event.currentTarget.setSelectionRange(0, manualText.length); }}/></label>}
  </div>;
}
