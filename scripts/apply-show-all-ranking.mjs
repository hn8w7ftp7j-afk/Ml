import fs from 'node:fs';
const path='app/page.js';
let s=fs.readFileSync(path,'utf8');
const old=`  const shadowRanking = useMemo(() => board.flatMap(item => (item.customData?.analysis?.results || [])
    .filter(row => item.actualSource?.provider === 'TAI888_READER_AUTO'
      && row.sourceType === 'ACTUAL_TW_CREDIT'
      && row.provider === 'TAI888_READER_AUTO'
      && row.evCalibration?.actualReaderEligible === true
      && readerStatus?.fresh === true
      && readerStatus?.boardDate === date
      && Boolean(item.readerPayloadHash)
      && item.readerPayloadHash === readerStatus?.payloadHash
      && actualLineFreshNow(row, clockNow)
      && gameIsPrestartNow(item.game, clockNow)
      && row.evCalibration?.qualified === true
      && row.shadowDiagnosticScore != null
      && Number.isFinite(Number(row.shadowDiagnosticScore))
      && row.scoreAudit?.ok === true
      && row.pairAudit?.passed !== false
      && row.scoreStatus === 'SHADOW_DIAGNOSTIC_UNCALIBRATED'
      && row.evCalibration?.scenarioStable === true
      && Number(row.weightedEV) > 0
      && Number(row.robustEV) > 0
      && Number(row.shadowDiagnosticScore) >= 7.2)
    .map(row => ({ item, row, gamePk: item.game.gamePk, matchup: matchup(item.game), market: row.market, pick: row.pick,
      water: row.water, score: Number(row.shadowDiagnosticScore), weightedEV: row.weightedEV, robustEV: row.robustEV })))
    .sort((left, right) => right.score - left.score || Number(right.robustEV || 0) - Number(left.robustEV || 0)), [board, clockNow, date, readerStatus?.fresh, readerStatus?.boardDate, readerStatus?.payloadHash]);`;
const neu=`  const shadowRanking = useMemo(() => board.flatMap(item => (item.customData?.analysis?.results || [])
    .filter(row => item.actualSource?.provider === 'TAI888_READER_AUTO'
      && row.sourceType === 'ACTUAL_TW_CREDIT'
      && row.provider === 'TAI888_READER_AUTO'
      && row.evCalibration?.actualReaderEligible === true
      && Boolean(item.readerPayloadHash)
      && actualLineFreshNow(row, clockNow)
      && gameIsPrestartNow(item.game, clockNow))
    .map(row => {
      const score = row.shadowDiagnosticScore != null && Number.isFinite(Number(row.shadowDiagnosticScore))
        ? Number(row.shadowDiagnosticScore)
        : row.formulaDiagnosticScore != null && Number.isFinite(Number(row.formulaDiagnosticScore))
          ? Number(row.formulaDiagnosticScore)
          : null;
      const qaPassed = row.scoreAudit?.ok === true && row.pairAudit?.passed !== false;
      const qualified = row.evCalibration?.qualified === true;
      const rankingEligible = qualified && qaPassed && row.scoreStatus === 'SHADOW_DIAGNOSTIC_UNCALIBRATED'
        && row.evCalibration?.scenarioStable === true && Number(row.weightedEV) > 0 && Number(row.robustEV) > 0 && score != null && score >= 7.2;
      return { item, row, gamePk: item.game.gamePk, matchup: matchup(item.game), market: row.market, pick: row.pick,
        water: row.water, score, weightedEV: row.weightedEV, robustEV: row.robustEV, qaPassed, qualified, rankingEligible };
    }))
    .sort((left, right) => Number(right.score ?? -Infinity) - Number(left.score ?? -Infinity)
      || Number(right.robustEV ?? -Infinity) - Number(left.robustEV ?? -Infinity)), [board, clockNow]);`;
if(!s.includes(old)) throw new Error('ranking source anchor not found');
s=s.replace(old,neu);
const oldUi=`    {tab === 'ranking' && <section className="panel"><div className="panelHead"><h2>模型影子排名</h2><span className="state shadow">非正式推薦</span></div>
      <div className="emptySmall">此處列出「Reader實際盤＋W/R皆正＋情境穩定＋7.2以上＋資料QA通過」的方向。外部市場不參與評分或排名；這是尚未完成樣本外驗證的模型診斷，不是下注建議。</div>
      {shadowRanking.length ? shadowRanking.map((entry, index) => {
        const betState = bettingEnabled ? getBetState(entry.item, entry.row) : { exact: null, latest: null, records: [] };
        const recordable = betRecordable(entry.item, entry.row, clockNow, bettingEnabled);
        const buttonText = betState.latest ? '已下注 ✓' : '紀錄實際下注';
        return <div className={\`rankRow \${betState.latest ? 'betRecorded' : ''}\`} key={\`\${entry.gamePk}-\${entry.market}-\${entry.pick}\`}><b>{index + 1}</b><strong>{entry.score.toFixed(1)}</strong><div><span>{entry.score >= 8.5 ? '🔥' : '🟢'} {entry.matchup}｜{entry.market}｜{translateTeamText(entry.pick)}｜{waterText(entry.water)}</span><small>診斷W {pct(entry.weightedEV)}｜保守診斷R {pct(entry.robustEV)}｜資料QA PASS｜外部市場未使用｜非正式推薦</small></div>{(recordable || betState.latest) && <button className={\`mini \${betState.latest ? 'recorded' : 'green'}\`} disabled={Boolean(betState.latest)} onClick={() => recordBet(entry.item, entry.row)}>{buttonText}</button>}</div>;
      }) : <div className="emptySmall">目前沒有同時通過雙EV、5%情境穩定線與影子排名門檻的方向；所有有效盤口仍會在今日盤口顯示W/R與分數。</div>}
    </section>}`;
const newUi=`    {tab === 'ranking' && <section className="panel"><div className="panelHead"><h2>模型影子排名｜全部方向</h2><span className="state shadow">全部顯示｜非正式推薦</span></div>
      <div className="emptySmall">此處顯示今日Reader已開盤且已完成分析的全部方向，不再只顯示7.2以上或可下注方向。仍依S分數由高到低排序；未通過EV校準、QA、情境穩定或雙正EV的方向也保留並清楚標示原因。</div>
      {shadowRanking.length ? shadowRanking.map((entry, index) => {
        const betState = bettingEnabled ? getBetState(entry.item, entry.row) : { exact: null, latest: null, records: [] };
        const recordable = betRecordable(entry.item, entry.row, clockNow, bettingEnabled);
        const buttonText = betState.latest ? '已下注 ✓' : '紀錄實際下注';
        const scoreText = entry.score == null ? '—' : entry.score.toFixed(1);
        const icon = entry.rankingEligible ? (entry.score >= 8.5 ? '🔥' : '🟢') : entry.qualified && entry.qaPassed ? '⚪' : '⚠️';
        const status = entry.rankingEligible ? '排名資格：是' : !entry.qualified ? '排名資格：否｜EV校準未通過' : !entry.qaPassed ? '排名資格：否｜QA未通過' : '排名資格：否｜未達正式排名條件';
        return <div className={\`rankRow \${betState.latest ? 'betRecorded' : ''}\`} key={\`\${entry.gamePk}-\${entry.market}-\${entry.pick}\`}><b>{index + 1}</b><strong>{scoreText}</strong><div><span>{icon} {entry.matchup}｜{entry.market}｜{translateTeamText(entry.pick)}｜{waterText(entry.water)}</span><small>W {pct(entry.weightedEV)}｜R {pct(entry.robustEV)}｜{status}｜非正式推薦</small></div>{(recordable || betState.latest) && <button className={\`mini \${betState.latest ? 'recorded' : 'green'}\`} disabled={Boolean(betState.latest)} onClick={() => recordBet(entry.item, entry.row)}>{buttonText}</button>}</div>;
      }) : <div className="emptySmall">目前沒有已完成分析的Reader實際盤方向。</div>}
    </section>}`;
if(!s.includes(oldUi)) throw new Error('ranking UI anchor not found');
s=s.replace(oldUi,newUi);
fs.writeFileSync(path,s);
console.log('show-all ranking patch applied');
