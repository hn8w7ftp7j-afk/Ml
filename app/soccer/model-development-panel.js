'use client';
import { soccerMatchContextObservations } from '../../lib/soccer/match-context-observations.js';
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const number=(value,digits=2)=>finite(value)?value.toFixed(digits):'—';
const percent=value=>finite(value)&&value>=0&&value<=1?`${(value*100).toFixed(1)}%`:'—';
const scoped=(value,game)=>value&&value.gameId===game?.id&&value.league===game?.league&&value.formalEligible===false&&value.modelEffectApplied===false;

export function SoccerModelDevelopmentPanel({minutes,conditions,matchXg,evidence,game}) {
  const m=scoped(minutes,game)&&minutes.version==='SOCCER-PRIOR-PARTICIPATION-MINUTES-RESEARCH-v1'?minutes:null;
  const c=scoped(conditions,game)&&conditions.version==='SOCCER-SCHEDULE-CONGESTION-POISSON-RIDGE-RESEARCH-v1'?conditions:null;
  const x=scoped(matchXg,game)&&matchXg.version==='SOCCER-STATSBOMB-MATCH-XG-RESEARCH-v1'?matchXg:null;
  if(!m&&!c&&!x)return null;
  const holdout=m?.validation?.holdout;
  const context=soccerMatchContextObservations(evidence,game);
  const venue=context.venue;
  const leaguePhase=Boolean(context.uclPhase);
  return <details className="soccerDetails"><summary>人員、逐場 xG 與賽程條件模型</summary>
    <p>以下為另行訓練的研究模型與保存結果。先發資格、傷停完整度及對進球的實際影響仍須驗證。</p>
    {m&&<section aria-label="預計上場分鐘模型"><h4>球員上場機率與預計分鐘</h4>
      {holdout&&<p>2025 年回顧測試 {holdout.model?.games??0} 場；分鐘平均誤差 {number(holdout.model?.minuteMAE)} 分鐘，對照模型 {number(holdout.baseline?.minuteMAE)} 分鐘。出場角色 Log Loss {number(holdout.model?.logLoss,3)}，對照 {number(holdout.baseline?.logLoss,3)}。誤差越低越好。</p>}
      {m.validation?.holdoutCandidateCoverage&&<p>原始可核對比賽 {m.validation.holdoutCandidateCoverage.usableGames} 場；另有 {m.validation.holdoutCandidateCoverage.unseenAppearingPlayers} 次實際出場不在先前候選名單內，未納入上列候選球員誤差。</p>}
      {['home','away'].map(side=>{const team=m.teams?.[side],players=team?.status==='RESEARCH_FORECAST_AVAILABLE'&&Array.isArray(team.players)?team.players:[];return <div key={side}><h5>{side==='home'?'主隊':'客隊'}</h5>
        {players.length?<><p>以近 14 日同賽事已觀察的 {team.coverage?.recentVerifiedMatches??0} 場名單預測 {players.length} 人；名單覆蓋未確認完整。</p>
          <div className="soccerTableWrap"><table className="soccerAuditTable"><thead><tr><th>球員</th><th>先發機率</th><th>出場機率</th><th>預計分鐘</th></tr></thead><tbody>{players.map(player=><tr key={player.id}><td>{player.name}</td><td>{percent(player.startProbability)}</td><td>{percent(player.appearanceProbability)}</td><td>{number(player.expectedMinutes,1)}</td></tr>)}</tbody></table></div></>:<p>缺少符合範圍的近期名單，這一隊尚無分鐘預測。</p>}</div>;})}
      <p className="soccerAvailability">僅涵蓋先前觀察過的球員；轉入、轉出、傷停與出賽資格仍未知。分鐘採正規時鐘，不含補時或加時。回顧測試不代表新的獨立驗收。</p>
    </section>}
    {c&&<section aria-label="賽程條件模型"><h4>賽程密度條件模型</h4>
      {c.validation&&<p>2025 年回顧測試 {c.validation.test?.games??0} 場；比分 Log Loss {number(c.validation.test?.scoreLogLoss,4)}，對照 {number(c.validation.baselineTest?.scoreLogLoss,4)}。誤差越低越好。</p>}
      {c.prediction?<p>研究平均進球：主隊 {number(c.prediction.homeRate)}／客隊 {number(c.prediction.awayRate)}。使用已觀察的同賽事開球間隔、近 14 日場數與中立場標記。</p>:<p>本場尚無符合模型範圍的兩隊近期賽程，未產生條件模型預測。</p>}
      {venue?.name&&<p>{context.poststart?'賽後來源':'來源'}記載場地：{[venue.name,venue.city,venue.country].filter(Boolean).join('・')}</p>}
      {leaguePhase&&<p>{context.poststart?'賽後來源':'來源'}記載賽事階段：歐冠聯賽階段。</p>}
      <p className="soccerAvailability">開球間隔不等於實際休息；跨賽事、旅行、天氣、裁判及歐冠跨聯賽影響尚未完整建模。兩項研究結果均另行保存，正式分數仍依完整驗收判定。</p>
    </section>}
    {x&&<section aria-label="逐場非十二碼 xG 研究"><h4>逐場非十二碼 xG 模型</h4>
      {x.researchAvailable&&x.researchCoverage?<><p>StatsBomb 開放資料：{x.researchCoverage.firstMatchDate} ～ {x.researchCoverage.lastMatchDate}，共 {x.researchCoverage.games} 場。逐射門計算全場／半場 xG，另排除十二碼計算 npxG。</p>
        <p>保留期測試 {x.researchMetrics?.test?.games??0} 場；球隊 npxG 均方誤差 {number(x.researchMetrics?.test?.candidate?.mse,4)}，聯盟均值對照 {number(x.researchMetrics?.test?.leagueMeanBaseline?.mse,4)}。</p>
        <p><img src="/sources/statsbomb-open-data.png" alt="StatsBomb" width="120"/> <a href="https://github.com/statsbomb/open-data" target="_blank" rel="noreferrer">StatsBomb Open Data 研究來源</a></p>
      </>:<p>本聯盟尚無可用的同源逐場 xG 研究資料。</p>}
      <p className="soccerAvailability">本場仍缺當季、同一供應商的完整逐場 xG。歷史研究不會套成目前球隊實力，也不與其他供應商累計 xG 混用。</p>
    </section>}
  </details>;
}
