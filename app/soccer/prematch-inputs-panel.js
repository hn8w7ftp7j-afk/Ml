'use client';

const number = (value, unit = '') => Number.isFinite(value) ? `${value.toFixed(1)}${unit}` : '尚未提供';
const status = value => value?.status === 'PROVIDER_REPORTED' ? '已取得來源資料'
  : value?.status === 'PROVIDER_REPORTED_PARTIAL' ? '已取得部分來源資料'
  : value?.status === 'NOT_APPLICABLE' ? '本場不適用'
  : value?.status === 'RESEARCH_FORECAST_AVAILABLE' ? '研究預估已接入' : '資料待補';
const time = value => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false }) : '尚未提供';
function Receipt({ value }) {
  const receipt = value?.observationArchive;
  return <p className="soccerSource">取得時間 {time(value?.source?.fetchedAt)}｜{receipt?.persisted === true ? '原始文件已保存並讀回核對' : '原始文件保存尚未確認'}</p>;
}

export function SoccerPrematchInputsPanel({ evidence }) {
  if (!evidence?.prematchInputConnection) return null;
  const weather = evidence.weather, travel = evidence.travel, ucl = evidence.uclContext;
  return <details className="soccerResearchDetails" aria-label="本場新增賽前資料">
    <summary>本場天氣、旅行與預計分鐘</summary>
    <p>以下為本場取得的資料或研究預估。模型效果與正式評分仍須獨立驗證。</p>
    <article><h4>球場天氣｜{status(weather)}</h4>
      {weather?.value ? <p>{weather.value.venue?.name}｜{number(weather.value.temperatureC, '°C')}｜風速 {number(weather.value.windSpeedKmh, ' km/h')}｜前一小時雨量 {number(weather.value.precipitationMm, ' mm')}<br/>預報有效時間 {time(weather.value.validAt)}；來源未提供預報發布時間。</p>
        : <p>本場尚未取得可核對的球場預報。{weather?.reason && <small> {weather.reason}</small>}</p>}
      <Receipt value={weather}/>
      {weather?.value && <p className="soccerSource">天氣 <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Open-Meteo</a>（CC BY 4.0）｜球場座標 <a href="https://www.wikidata.org/" target="_blank" rel="noreferrer">Wikidata</a>（CC0）</p>}
    </article>
    <article><h4>旅行與歐冠賽事情境</h4>
      <p>旅行 {status(travel)}｜歐冠情境 {status(ucl)}</p>
      <p>已觀測賽程間隔與球場距離分開保存；距離為兩球場直線估算，實際行程與休息時間仍待確認。</p>
      {travel?.value && <p>{['home', 'away'].map(side => {
        const value = travel.value.teams?.[side];
        return <span key={side}>{side === 'home' ? '主隊' : '客隊'}：距上場開球 {number(value?.kickoffGapHoursFromLastCompleted, ' 小時')}，兩球場直線距離 {number(value?.venueDistanceKm, ' km')}<br/></span>;
      })}</p>}
      {ucl?.value && <p>階段 {({ LEAGUE_PHASE: '聯賽階段', KNOCKOUT: '淘汰賽', FINAL: '決賽' })[ucl.value.phase] || '尚未確認'}｜跨聯賽強度調整尚未驗證。</p>}
      <Receipt value={travel}/>
    </article>
    {['home', 'away'].map(side => {
      const minutes = evidence.teams?.[side]?.minutes, players = minutes?.players || [];
      return <article key={side}><h4>{side === 'home' ? '主隊' : '客隊'}預計分鐘｜{status(minutes)}</h4>
        <p>已綁定本場名單 {players.length} 人。已公布先發與模型先發機率分開保存；缺少歷史紀錄者不填入假分鐘。</p>
        {players.length > 0 && <div className="soccerTableWrap"><table className="soccerTable"><thead><tr><th>球員</th><th>預計分鐘</th><th>模型先發機率</th></tr></thead><tbody>{players.map(player => <tr key={player.id}><th>{player.name || player.displayName || player.id}</th><td>{number(player.expectedMinutes)}</td><td>{number(Number.isFinite(player.startProbability) ? player.startProbability * 100 : null, '%')}</td></tr>)}</tbody></table></div>}
        <Receipt value={minutes}/>
      </article>;
    })}
  </details>;
}
