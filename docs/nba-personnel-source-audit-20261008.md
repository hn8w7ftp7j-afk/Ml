# NBA 本場人員來源核對（2026-10-08，台北時間）

本次新增的是賽前來源觀測與可驗證保存，不是新傷停／先發／分鐘模型。`modelInputEnabled`、`officialLineupConfirmed` 均保持 `false`；既有模型權重不變。

## 已存在且可接續的接口

- `lib/nba/data.js`：ESPN NBA summary、injuries、roster 的嚴格場次／球隊／球員 ID 檢核。summary 的賽前 `starter` 只能標為來源報導。
- `lib/nba/pregame-store.js`：只接受尚未開賽、明確時間與五分鐘內來源的 append-only 賽前快照；不能回填事後時間。
- `lib/nba/official.js`：官方場次及球員 ID 交叉核對，但輸出 `pregameLineupVerified: false`，現有實作未提供可靠的官方賽前先發确认。
- `lib/nba/injury-archive.js`：單場、事後恢復的官方歷史報告，不能代表目前所有場次可取得當日官方狀態。

## 本次實際來源檢查

### 官方傷病索引

https://official.nba.com/nba-injury-report-2025-26-season/

2026-10-07 晚間 UTC 檢查時 HTTP 200；頁面仍使用 2025-26 標題，但提供 2026-10-07 的兩個 PDF 連結。不能只靠球季 URL 或檔名認定本場時效。官方文字說明一般需前一天當地 17:00 前提報，背靠背第二場當日 13:00 前，並會持續更新；這是報告提交規則，不是公開接口完整性的保證。

https://ak-static.cms.nba.com/referee/injury/Injury-Report_2026-10-07_10_45AM.pdf

實際打開並目視核對第一頁：索引／檔名時間是 10:45 AM，PDF 頁首是 10:58 AM；GSW@OKC 兩隊標為尚未提交。必須把索引標籤時間、PDF 印刷時間、伺服器取得時間分開保存；尚未提交必須保持 unknown。

https://ak-static.cms.nba.com/referee/injury/Injury-Report_2026-10-07_09_45AM.pdf

上一版本頁首是 09:50 AM，GSW@OKC 的場次時間與較新版本不同，並出現 `xyz`、`asdfe` 等異常原因字串。沒有核對場次時間及球員本場身分前，不會把這些資料輸入模型，也不宣告官方傷停整合已完成。

### 官方先發頁／JSON

https://www.nba.com/players/todays-lineups

實際 HTTP 200，頁面 `__NEXT_DATA__` 的 `pageProps` 只有 `layout`、`region`，本次沒有得到可驗證的逐場先發資料。公開頁存在不代表已得到每場官方五人及公布時間。

https://cdn.nba.com/static/json/liveData/scoreboard/todaysScoreboard_00.json

https://cdn.nba.com/static/json/staticData/scheduleLeagueV2_1.json

搜尋／讀取接口本次回 HTTP 403；未嘗試繞過保護，也未以此宣告 Production 網路一定不可用。

官方 2019-09-20 公告的先發提交規則為開賽前 30 分鐘，熱身受傷等情況仍可變更。該規則不提供本次實際確認先發的時間戳。

https://www.nba.com/news/board-governors-clarification-traveling-official-release

### ESPN 傷停

https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries?limit=1000

本次 HTTP 200 原始回應有 26 組球隊、101 筆傷停；2026-10-07T23:17:30.473Z 呼叫既有 `loadNbaData({view:'injuries'})`，因球員所屬隊與分組衝突而 `TEAM_IDENTITY_MISMATCH`／QA BLOCK，故傳回零筆可用資料。此全域檢核保持不動。

新增 `target-injuries.js` 將該原始完整回應雜湊保存為來源，僅 normalize 本場兩隊；分組 ID 或球員所屬隊任一涉及本場，即必須通過同樣的隊名／ID／NBA UID 檢核，不能把不一致的球員搬到另一隊。如果衝突在不相关的別隊，可不影響本場；如果涉及本場，仍 BLOCK／unknown。空陣列仍不是全員健康。

## 最小落地方式

`loadNbaPersonnelEvidence(game, { now, loadGame, loadInjuries, saveSnapshot, timeoutMs })` 使用伺服器已核對的目標場次，並行抓該場 summary 與本場兩隊的 injuries，再核對場次 ID、主客隊、開賽時間、球季、來源 URL、SHA-256、取得時間、發布時間與每筆傷停報導時間。預設來源等待上限六秒；注入 `loadGame`／`loadInjuries` 時採既有 `loadNbaData(query, options)` 格式。

來源必須五分鐘內、不可 stale／未來時間。個別傷停舊於 48 小時、未給報導時間、未提交、身份衝突及未知狀態均保留 `unknown`。沒列出本場傷兵也只代表沒有匹配報導，不代表健康。

當 summary 可用但 injuries 不可用，可保存部分賽前觀測及缺失原因。只有伺服器注入的 `saveSnapshot` 回條具可核對 revision 與賽前 capturedAt，才顯示 persisted 成功；寫入失敗不顯示成功。

目前輪替、分鐘限制、已確認本場上場分鐘仍無可靠來源。歷史 box score 分鐘可以另外做已完賽描述研究，但不等於本場已確認，亦未送入這次模型。

## 本次自動測試與網路限制

`node scripts/nba-personnel-evidence-test.mjs` 通過本場身分、日期／時間、六秒來源預算、來源雜湊、未來／過期／未提交傷停、五人非官方先發、缺失分鐘、可驗證保存回條及每次 cache hit 重新驗 target 的測試。既有 `nba-pregame-test.mjs` 及 `nba-data-test.mjs`（38 項）亦通過。

2026-10-07T23:24:46.989Z 實際以六秒預算請求 ESPN 本日 scoreboard，回 `UPSTREAM_TIMEOUT`；此結果被保留為 unavailable、零可用場次，未改寫成正常空賽程，也未進行任何外部寫入。因此單元測試通過不等於目前每場外部來源都可取得。
