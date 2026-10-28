'use client';

const VERSION='SOCCER-OPTA-TEAM-XG-v1';
const ARCHIVE_VERSION='SOCCER-TEAM-XG-SOURCE-ARCHIVE-v1';
// Public display allowlist only. Server fetch/normalization remains the source
// authority; importing that Node module would expose it to the client bundle.
const PROVIDERS={
  epl:{label:'英超',url:'https://theanalyst.com/competition/premier-league/table?view=expected',competitionId:'2kwbbcootiqqgmrzs6o5inle5',code:'EPL',calendarId:'6pdwluctev9iebv00r4qqukno',teamCount:20},
  ucl:{label:'歐冠',url:'https://theanalyst.com/competition/uefa-champions-league/table',competitionId:'4oogyu6o156iphvdvphwpck10',code:'UCL',calendarId:'99jev9kv55deht65t6myggxlg',teamCount:36},
};
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const instant=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T/.test(value)&&/(?:Z|[+-]\d{2}:\d{2})$/.test(value)&&Number.isFinite(Date.parse(value))?Date.parse(value):NaN;
const sameTime=(a,b)=>Number.isFinite(instant(a))&&instant(a)===instant(b);
const clock=value=>Number.isFinite(instant(value))?new Date(value).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false}):'來源未提供';
const metric=value=>Number.isFinite(value)&&value>=0?value.toFixed(2):'未知';
const competition=(value,provider)=>provider&&value?.id===provider.competitionId&&value?.code===provider.code&&value?.tournamentCalendarId===provider.calendarId;
const teamValid=team=>team&&typeof team.sourceId==='string'&&/^\d{1,16}$/.test(team.sourceId)
  &&typeof team.optaId==='string'&&team.optaId.length>0&&typeof team.name==='string'&&team.name.length>0
  &&Number.isSafeInteger(team.played)&&team.played>=0&&team.played<=38
  &&['xg','xga'].every(key=>Number.isFinite(team[key])&&team[key]>=0&&team[key]<=1000)
  &&(team.played===0?team.xg===0&&team.xga===0&&team.xgPerMatch===null&&team.xgaPerMatch===null
    :['xg','xga'].every(key=>Number.isFinite(team[`${key}PerMatch`])&&Math.abs(team[`${key}PerMatch`]-team[key]/team.played)<=1e-9));

function validObservation(value,game){
  const source=value?.source,evidence=value?.sourceEvidence,coverage=value?.coverage,gameDate=typeof game?.date==='string'?game.date:'';
  const provider=Object.hasOwn(PROVIDERS,game?.league||'')?PROVIDERS[game.league]:null;
  const seasonYear=Number(gameDate.slice(0,4)),seasonMonth=Number(gameDate.slice(5,7));
  const seasonStart=seasonMonth>=7?seasonYear:seasonYear-1,season=`${seasonStart}/${seasonStart+1}`;
  const requested=instant(source?.requestedAt),fetched=instant(source?.fetchedAt),available=instant(source?.availableAt),updated=source?.sourceUpdatedAt==null?null:instant(source.sourceUpdatedAt);
  return Boolean(value?.version===VERSION&&value.ok===true&&value.status==='PROVIDER_REPORTED'
    &&provider&&value.league===game.league&&game.id===value.gameId&&new RegExp(`^soccer:${game.league}:\\d{1,16}$`).test(game.id)
    &&typeof game.date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(game.date)&&game.date===value.date
    &&sameTime(game.startTime,value.startTime)&&value.season==='2026/2027'&&value.season===season&&competition(value.competition,provider)
    &&new Date(instant(game.startTime)+8*3600000).toISOString().slice(0,10)===game.date
    &&teamValid(value.teams?.home)&&teamValid(value.teams?.away)
    &&value.teams.home.sourceId===String(game.home?.sourceId)&&value.teams.away.sourceId===String(game.away?.sourceId)
    &&value.teams.home.sourceId!==value.teams.away.sourceId&&value.teams.home.optaId!==value.teams.away.optaId
    &&source?.provider==='OPTA_ANALYST'&&source.url===provider.url&&hash(source.contentHash)
    &&source.scope?.league===game.league&&source.scope.gameId===game.id&&source.scope.field==='season-team-xg'
    &&source.independentlyConfirmed===false&&source.historicalAvailabilityVerified===false
    &&[requested,fetched,available].every(Number.isFinite)&&requested<=fetched&&fetched===available&&available<=Date.now()
    &&(updated===null||Number.isFinite(updated)&&updated<=fetched)
    &&source.sourcePublishedAt===null
    &&evidence?.version===VERSION&&['sourceScopeVerified','contentHashVerified','fetchTimeVerified','observedAvailabilityVerified','competitionVerified','seasonVerified','teamIdentityVerified'].every(key=>evidence[key]===true)
    &&evidence.sourcePublishedAt===null&&evidence.publicationStatus==='MISSING'&&evidence.publishedAvailabilityVerified===false&&evidence.historicalAvailabilityVerified===false&&evidence.independentlyConfirmed===false
    &&(source.sourceUpdatedAt==null?evidence.sourceUpdatedAt==null:sameTime(evidence.sourceUpdatedAt,source.sourceUpdatedAt))
    &&coverage?.type==='SEASON_CUMULATIVE_TEAM_TOTALS'&&coverage.teamCount===provider.teamCount&&coverage.completeSeason===false&&coverage.currentTableOnly===true
    &&['matchLevel','halfTime','nonPenaltyXg','shotQuality','personnel','independentlyVerified'].every(key=>coverage[key]===false)
    &&value.modelEffectApplied===false&&value.pointInTimeAvailabilityVerified===false&&value.formalEligible===false&&value.executable===false);
}

function archiveState(value,game){
  const receipt=value.sourceDocumentArchive,source=value.source,provider=PROVIDERS[game.league];
  if(!receipt)return{status:'MISSING'};
  if(receipt.version===ARCHIVE_VERSION&&receipt.status==='UNAVAILABLE'&&receipt.persisted===false)return{status:'UNAVAILABLE'};
  const recorded=instant(receipt.recordedAt),documentRecorded=instant(receipt.documentRecordedAt),kickoff=instant(game.startTime);
  const before=recorded<kickoff;
  const valid=receipt.version===ARCHIVE_VERSION&&receipt.status==='ARCHIVED'&&receipt.persisted===true&&hash(receipt.receiptId)
    &&receipt.representation==='DECODED_HTML_TEXT_DOCUMENT'&&receipt.serialization==='UTF8_DECODED_HTTP_RESPONSE_TEXT'&&receipt.hashAlgorithm==='SHA256'
    &&receipt.provider==='OPTA_ANALYST'&&receipt.league===value.league&&receipt.gameId===game.id&&receipt.date===value.date&&receipt.season===value.season
    &&competition(receipt.competition,provider)&&receipt.teamIds?.home===value.teams.home.sourceId&&receipt.teamIds?.away===value.teams.away.sourceId
    &&receipt.sourceUrl===provider.url&&receipt.contentHash===source.contentHash&&hash(receipt.contentHash)
    &&Number.isSafeInteger(receipt.documentBytes)&&receipt.documentBytes>0&&receipt.documentBytes<=2097152
    &&sameTime(receipt.fetchedAt,source.fetchedAt)&&sameTime(receipt.availableAt,source.availableAt)&&sameTime(receipt.kickoffAt,game.startTime)
    &&receipt.sourcePublishedAt===source.sourcePublishedAt
    &&(source.sourceUpdatedAt==null?receipt.sourceUpdatedAt===null:sameTime(receipt.sourceUpdatedAt,source.sourceUpdatedAt))
    &&Number.isFinite(recorded)&&Number.isFinite(documentRecorded)&&instant(source.availableAt)<=recorded&&documentRecorded<=recorded&&recorded<=Date.now()
    &&receipt.prematchReceipt===before&&receipt.timingStatus===(before?'PREGAME_DATABASE_RECEIPT':'AFTER_KICKOFF_DATABASE_RECEIPT')
    &&receipt.decodedDocumentHashRecomputed===true&&receipt.rawSourceHashRecomputed===false
    &&receipt.historicalAvailabilityVerified===false&&receipt.independentlyConfirmed===false&&receipt.formalEligible===false;
  return valid?{status:'ARCHIVED',recordedAt:receipt.recordedAt,before}:{status:'MISMATCH'};
}

function unavailableMessage(value){
  if(value==null)return'尚未取得來源表的球隊 xG／xGA；舊版分析可重新核對。';
  if(/UNSUPPORTED/.test(String(value.code||value.reason||'')))return'本場聯盟、球季或球隊尚無適用的來源表資料。';
  if(value.ok===false&&/TIMEOUT|FETCH|UNAVAILABLE|FAILED/.test(String(value.code||value.reason||'')))return'本次 xG 來源讀取失敗，數值未知。';
  return'來源表的球隊 xG／xGA 與本場賽事、期間或來源時間尚未完整核對，暫不顯示數字。';
}

export function SoccerTeamXgPanel({value,game}){
  if(!validObservation(value,game))return <details className="soccerDetails"><summary>球隊 xG／xGA（來源觀察）</summary><p className="soccerAvailability">{unavailableMessage(value)}</p></details>;
  const archive=archiveState(value,game),provider=PROVIDERS[game.league];
  return <details className="soccerDetails"><summary>球隊 xG／xGA（來源觀察）</summary>
    <p>{value.season} {provider.label}｜來源表的球隊累計。xG 為預期進球，xGA 為預期失球。</p>
    <div className="soccerTableWrap"><table className="soccerAuditTable"><caption>Opta Analyst 來源表的球隊累計</caption><thead><tr><th scope="col">球隊</th><th scope="col">本表已賽場次</th><th scope="col">xG</th><th scope="col">xGA</th><th scope="col">場均 xG</th><th scope="col">場均 xGA</th></tr></thead><tbody>{['home','away'].map(side=>{const team=value.teams[side];return <tr key={side}><th scope="row">{side==='home'?'主隊':'客隊'}｜{game[side]?.name||team.name}</th><td>{team.played}</td><td>{metric(team.xg)}</td><td>{metric(team.xga)}</td><td>{metric(team.xgPerMatch)}</td><td>{metric(team.xgaPerMatch)}</td></tr>;})}</tbody></table></div>
    <p className="soccerAvailability">十二碼是否納入此統計，來源口徑尚未完整核對；這不是 npxG。場均值由本表累計除以本表已賽場次，尚無場數時顯示未知。</p>
    {game.league==='ucl'&&<p className="soccerAvailability">歐冠表列的賽事階段與資格賽覆蓋範圍尚未完整確認，不視為整個賽季所有場次。</p>}
    <p className="soccerAvailability">這是來源表的球隊累計，不是本場全場、上半場或逐次射門品質資料，尚未用於模型擬合或調整本場機率。正式評分尚未驗收。</p>
    <p className="soccerAvailability">來源：<a href={value.source.url} target="_blank" rel="noreferrer">Opta Analyst {provider.label}預期進球積分表</a>｜取得：{clock(value.source.fetchedAt)}｜來源更新：{clock(value.source.sourceUpdatedAt)}</p>
    <p className="soccerAvailability">資料庫封存：{archive.status==='ARCHIVED'?`已核對保存（${archive.before?'開賽前':'開賽後'}），${clock(archive.recordedAt)}`:archive.status==='UNAVAILABLE'?'本次尚未確認保存。':archive.status==='MISMATCH'?'憑據與本次來源或賽事不符，尚未確認保存。':'尚未取得憑據。'} 已保存來源觀察不等於歷史可得性或模型驗收通過。</p>
  </details>;
}
