'use client';
import { soccerIdentityHash } from '../../lib/soccer/identity-hash.js';

const version='SOCCER-WYSCOUT-XY-SHOT-RESEARCH-v1';
const methods=[['constantBaseline','訓練期固定機率'],['locationBaseline','僅射門深度'],['candidate','射門起點 XY'],['calibratedCandidate','XY＋校準期截距']];
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const count=value=>Number.isSafeInteger(value)&&value>=0?String(value):'—';
const metric=(value,digits=4)=>finite(value)&&value>=0?value.toFixed(digits):'—';
const probability=value=>finite(value)&&value>=0&&value<=1?`${(value*100).toFixed(1)}%`:'—';

// This is a display-integrity check for a saved server report, never source
// authentication, model acceptance or a way to authorize a football score.
function aggregateRenderable(report,game) {
  if(!report||report.version!==version||report.type!=='AGGREGATE_SHOT_XG_RESEARCH_REPORT'
    ||report.provider!=='WYSCOUT_OPEN_DATA'||report.league!=='epl'||report.league!==game?.league
    ||report.synthetic!==false||report.sourceAuthenticationVerified!==true
    ||report.coordinateContract!=='WYSCOUT_ATTACK_RIGHT_UNIT_SQUARE-v1'
    ||report.protocol?.version!=='SOCCER-WYSCOUT-XY-SHOT-PROTOCOL-2017-18-v1'
    ||report.protocol.trainingBefore!=='2018-01-01'||report.protocol.calibrationBefore!=='2018-03-01'
    ||report.protocol.testBefore!=='2018-06-01'||report.protocol.embargoHours!==48||report.protocol.strictEmbargo!==true
    ||report.protocol.featureSelection!=='FIXED_BEFORE_CORPUS_METRICS_NO_TEST_TUNING'
    ||['accepted','formalEligible','calibrationEligible','promotionEligible','modelEffectApplied','executable',
      'historicalAvailabilityVerified','independentUntouchedTestVerified','currentSeasonCoverageVerified','uclCoverageVerified',
      'rawRowsIncluded','fittedCoefficientsIncluded'].some(key=>report[key]!==false))return false;
  try {const {contentHash,...body}=report;return typeof contentHash==='string'&&contentHash===soccerIdentityHash(body);}
  catch{return false;}
}

const instant=value=>typeof value==='string'&&/(?:Z|[+-]\d\d:\d\d)$/.test(value)?Date.parse(value):NaN;
export function soccerShotXgViewRenderable(view,game,analysisCutoff) {
  if(!view||view.version!=='SOCCER-SHOT-XG-RESEARCH-VIEW-v1'||!['epl','ucl'].includes(game?.league)
    ||view.league!==game.league||view.gameId!==game.id
    ||!['RESEARCH_AVAILABLE','NO_LEAGUE_COHORT','NOT_AVAILABLE_AT_CUTOFF','ARTIFACT_INVALID'].includes(view.status)
    ||['accepted','formalEligible','calibrationEligible','promotionEligible','modelEffectApplied','executable','currentSeasonModelApplied'].some(key=>view[key]!==false)
    ||['W','R','S'].some(key=>view[key]!==null)||!Number.isFinite(instant(view.analysisCutoff))
    ||!Number.isFinite(instant(analysisCutoff))||instant(view.analysisCutoff)!==instant(analysisCutoff))return false;
  const context=view.gameContext;
  if(!context||context.sourceId!==game.sourceId||context.date!==game.date||context.startTime!==game.startTime
    ||context.homeSourceId!==game.home?.sourceId||context.awaySourceId!==game.away?.sourceId
    ||['sourceId','date','startTime','homeSourceId','awaySourceId'].some(key=>typeof context[key]!=='string'||!context[key]))return false;
  if(view.status!=='RESEARCH_AVAILABLE')return view.report===null;
  const artifact=view.artifact,cutoff=instant(view.analysisCutoff);
  return typeof artifact?.version==='string'&&artifact.version.length>0&&/^[a-f0-9]{64}$/.test(artifact.contentHash||'')
    &&Number.isFinite(instant(artifact.createdAt))&&instant(artifact.createdAt)<=cutoff
    &&aggregateRenderable(view.report,game)&&Number.isFinite(instant(view.report.createdAt))
    &&instant(view.report.createdAt)<=cutoff&&Number.isFinite(instant(view.report.availableAt))&&instant(view.report.availableAt)<=cutoff;
}

export function SoccerShotXgResearchPanel({view,game,analysisCutoff}) {
  if(!soccerShotXgViewRenderable(view,game,analysisCutoff))return null;
  if(view.status!=='RESEARCH_AVAILABLE')return <section aria-label="自建射門 xG 研究"><h4>自建射門 xG 研究</h4>
    <p>{view.status==='NO_LEAGUE_COHORT'?'本聯盟尚無符合本方法的同聯盟保留期測試，未套用其他聯盟的研究模型或數值。'
      :view.status==='NOT_AVAILABLE_AT_CUTOFF'?'這份研究在本次分析時間尚不可用，未將後來的研究結果填入舊分析。'
        :'自建射門研究資料尚未通過內容核對，未顯示評估數值。'}</p>
  </section>;
  const report=view.report;
  const coverage=report.coverage||{},collection=report.sourceCollection,protocol=report.protocol||{},test=report.evaluation?.test;
  const modelRows=methods.map(([key,label])=>({key,label,value:test?.[key]}));
  const comparable=modelRows.filter(row=>row.value).every((row,_index,rows)=>row.value.games===rows[0].value.games&&row.value.shots===rows[0].value.shots);
  return <section aria-label="自建射門 xG 研究"><h4>自建射門 xG｜歷史保留期研究</h4>
    <p>Wyscout 2017/18 英超開放資料：{collection?<>來源清單 {count(collection.sourceMatches)} 場，資料核對可用 {count(collection.eligibleMatches)} 場，隔離 {count(collection.quarantinedMatches)} 場。</>:<>可核對來源 {count(coverage.sourceMatches)} 場。</>}</p>
    <p>切分評估納入 {count(coverage.includedMatches)} 場、{count(coverage.includedNonPenaltyShots)} 次非十二碼射門；另有 {count(coverage.penaltyShotsExcluded)} 次十二碼未納入，{count(coverage.excludedMatches)} 場未納入本次切分。</p>
    <p>依整場比賽時間切分：訓練截止 {protocol.trainingBefore||'—'}，校準截止 {protocol.calibrationBefore||'—'}；各截止前保留 {count(protocol.embargoHours)} 小時間隔。測試結果不參與選模型或調參。</p>
    {test?<><h5>保留期測試</h5>
      <p>Log Loss 與 Brier 越低越好；XY 原模型與校準版本分別列出，未以測試結果挑選版本。</p>
      {!test.calibratedCandidate&&<p>校準版本尚無可核對結果，未以原模型或零誤差代替。</p>}
      {!comparable&&<p>各方法的評估樣本不同，尚不能直接比較。</p>}
      <div className="soccerTableWrap"><table className="soccerAuditTable"><thead><tr><th>方法</th><th>比賽</th><th>射門</th><th>Log Loss</th><th>Brier</th><th>預估進球率</th><th>實際進球率</th></tr></thead><tbody>
        {modelRows.map(({key,label,value})=><tr key={key}><td>{label}</td><td>{count(value?.games)}</td><td>{count(value?.shots)}</td><td>{metric(value?.logLoss)}</td><td>{finite(value?.brier)&&value.brier<=1?metric(value.brier):'—'}</td><td>{probability(value?.predictedMean)}</td><td>{probability(value?.observedGoalRate)}</td></tr>)}
      </tbody></table></div>
      <details className="soccerDetails"><summary>XY 模型的分箱校準</summary>
        {modelRows.filter(row=>['candidate','calibratedCandidate'].includes(row.key)).map(({key,label,value})=><div key={key}><h5>{label}</h5>
          {Array.isArray(value?.calibrationBins)&&value.calibrationBins.length?<div className="soccerTableWrap"><table className="soccerAuditTable"><thead><tr><th>機率區間</th><th>射門</th><th>預估進球率</th><th>實際進球率</th></tr></thead><tbody>
            {value.calibrationBins.slice(0,20).map((bin,index)=><tr key={index}><td>{probability(bin?.lower)} ～ {probability(bin?.upper)}</td><td>{count(bin?.count)}</td><td>{probability(bin?.predictedMean)}</td><td>{probability(bin?.observedRate)}</td></tr>)}
          </tbody></table></div>:<p>尚無可核對的分箱結果。</p>}
        </div>)}
      </details>
    </>:<p>保留期測試尚無可核對結果。</p>}
    <p><a href="https://doi.org/10.6084/m9.figshare.c.4415000.v5" target="_blank" rel="noreferrer">Wyscout 開放資料</a>（<a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0</a>）・<a href="https://doi.org/10.1038/s41597-019-0247-7" target="_blank" rel="noreferrer">Pappalardo 等，2019，資料說明</a>。本系統另行擷取射門、切分資料並訓練模型。</p>
    <p className="soccerAvailability">此研究評估單次射門的進球機率；資料於賽後回補，並非當時已凍結的獨立賽前驗收。當季完整 npxG、跨供應商座標轉換與歐冠適用性尚未核對。正式模型接入仍須通過資料、校準與收益誤差驗收。</p>
  </section>;
}
