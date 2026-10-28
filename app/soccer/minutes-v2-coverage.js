'use client';
import minutesV2Coverage from '../../research/soccer/personnel-minutes-v2-coverage.json';

const VERSION='SOCCER-PERSONNEL-MINUTES-V2-COVERAGE-v1';
const EXTRACTOR='SOCCER-REGULATION-MINUTES-SOURCE-ID-STATE-v2';
const count=value=>Number.isSafeInteger(value)&&value>=0;
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const leagueNames={epl:'英超',ucl:'歐冠'};
const reasonNames={
  SUBSTITUTION_STATE_CONFLICT:'換人紀錄與當時場上狀態衝突',
  SUBSTITUTION_ROLE_UNVERIFIED:'換人角色仍無法確認',
  SUBSTITUTION_TEXT_STATE_CONFLICT:'換人文字與球員狀態矛盾',
  DISMISSAL_IDENTITY_CONFLICT:'紅牌球員身分或重複紀錄衝突',
  REGULATION_END_MISSING:'缺少可核對的正規時間終場事件',
};
function verifiedCoverage(summary,league){
  if(!Object.hasOwn(leagueNames,league)||summary?.version!==VERSION||summary.extractorVersion!==EXTRACTOR
    ||summary.currentModelUnchanged!==true||summary.networkRequests!==0
    ||summary.modelEffectApplied!==false||summary.pointInTimeAvailabilityVerified!==false
    ||summary.physicalElapsedMinutesVerified!==false
    ||summary.formalEligible!==false||summary.executable!==false||!hash(summary.summaryHash))return null;
  const sources=summary.sourceArtifactHashes,row=summary.leagues?.[league];
  if(!sources||typeof sources!=='object'||Array.isArray(sources)||!Object.keys(sources).length
    ||Object.values(sources).some(value=>!hash(value))||!row
    ||!['population','v1Reconstructed','v2Reconstructed','recovered','regressed','unverified','stateResolvedSubstitutions'].every(key=>count(row[key]))
    ||row.population===0||row.v1Reconstructed>row.population||row.v2Reconstructed>row.population
    ||row.regressed!==0||row.v2Reconstructed-row.v1Reconstructed!==row.recovered
    ||row.numericChangesOnOriginalUsableGames!==0
    ||row.v2Reconstructed+row.unverified!==row.population
    ||!row.v2Reasons||typeof row.v2Reasons!=='object'||Array.isArray(row.v2Reasons)
    ||Object.values(row.v2Reasons).some(value=>!count(value))
    ||Object.values(row.v2Reasons).reduce((total,value)=>total+value,0)!==row.unverified)return null;
  return row;
}

// This is the current retained-data research inventory, separate from the
// immutable analysis snapshot and its model inputs. It never changes a score.
export function SoccerMinutesV2Coverage({league,summary=minutesV2Coverage}){
  const row=verifiedCoverage(summary,league);
  return <section className="soccerMinutesV2Coverage" aria-label="歷史分鐘重建覆蓋">
    <h4>歷史上場分鐘補齊</h4>
    {row?<><p>{leagueNames[league]}保留資料：原可重建 {row.v1Reconstructed}／{row.population} 場；本次可重建 {row.v2Reconstructed}／{row.population} 場，補回 {row.recovered} 場。</p>
      <p>仍有 {row.unverified} 場未通過核對{row.unverified?'：':'。'}</p>
      {row.unverified>0&&<ul>{Object.entries(row.v2Reasons).filter(([,value])=>value>0).map(([reason,value])=><li key={reason}>{reasonNames[reason]||'其他來源檢核未通過'}：{value} 場</li>)}</ul>}
      <p className="soccerAvailability">這是目前保留歷史資料的賽後重播，按球員身分與當時場上狀態核對正規時鐘分鐘，不含實際補時。不是賽前預計分鐘，也不證明當時已取得資料。</p>
      <p className="soccerAvailability">新增分鐘觀察尚未納入現行模型；原比分分布與正式 S 評分狀態維持不變。</p></>
      :<p className="soccerAvailability">此聯盟尚無可核對的分鐘重建統計。</p>}
  </section>;
}
