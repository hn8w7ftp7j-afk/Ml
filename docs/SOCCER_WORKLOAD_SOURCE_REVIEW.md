# 足球跨賽事賽程來源核對

核對時間：2026-10-18 UTC（台北 2026-10-19）。本次核對只證明以下來源與案例可用，沒有證明供應商完整覆蓋全部賽事或個別球員負荷。

## 已實際取得的來源

| 來源 | 本次觀察 |
| --- | --- |
| `https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/teams/359/schedule?season=2026` | Arsenal 7 場已完賽英超。單聯賽來源不足以代表總負荷。 |
| `https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.champions/teams/359/schedule?season=2026` | 同隊 2 場已完賽歐冠。 |
| `https://site.api.espn.com/apis/site/v2/sports/soccer/all/teams/359/schedule?season=2026` | 同隊 15 場，包含英超、歐冠、英格蘭聯賽盃、社區盾及友誼賽。 |
| `https://site.api.espn.com/apis/site/v2/sports/soccer/all/teams/359/schedule?fixture=true` | 38 場已公布安排；目標 10 月 24 日英超之前另有 10 月 21 日歐冠。 |
| `https://site.api.espn.com/apis/site/v2/sports/soccer/all/teams/368/schedule?season=2026` | Everton 已完賽來源；截至本次觀察，近 7／14 日來源已回報完賽數為 1／2。 |

在 `2026-10-18T21:02:09.632Z` 完成的四來源讀取與正規化實驗中，Arsenal 近 7／14 日來源已回報完賽數為 2／3，上一場開球至 10 月 24 日目標開球相隔 142.5 小時，但中間仍有尚未進行的歐冠；因此這個值不能稱為實際休息時長。此實驗使用本機 curl transport adapter，耗時 6,194 ms，不代表已驗證正式環境 fetch 路徑。

## 實作口徑

- `fetchSoccerWorkload(game, { now, fetchImpl, timeoutMs })` 使用既有有界來源讀取器。預設各 endpoint 快取 60 秒、逾時 8 秒；全局最多 4 個讀取並行，整個負荷來源讀取預算 9 秒。
- 每隊請求目前／前一曆年標籤的已完賽來源，以及供應商目前的未來安排。共最多 6 個請求、2 輪；不假定所有歐冠球會均按英超季節換季。兩年請求政策仍不能證明來源覆蓋完整。
- 守衛隊伍、對手、event／competition、賽事來源 ID、明確時區、完成狀態與資料取得截止；重複 event 內容相衝突時拒絕該隊觀察，不隨意合併。
- 未來安排不計入已完成負荷；裁定勝負、延賽、未確認時間及其他無法確認已完成實際比賽的狀態不當成已完成負荷。
- `kickoffGapHoursFromLastCompleted` 是開球間隔。缺乏真實終場時間，`actualRestHours` 保持 `null`。上一場只是「來源已回報之最近完賽」，沒有宣稱為完整賽程中的最後一場。
- 個別來源失敗不抹除其他已驗證觀察；保存 `retrievalFailures` 與 `coverage.missingRequests`。只有 fixtures 可用時，近 7／14 日完賽數為 `null`，不推定為零場。
- 成功來源保存各自 `fetchedAt`、URL 與 `contentHash`。失敗來源沒有內容 hash，不能冒充已取得資料。這次新取得的過往賽果不是當年已保存的賽前證據。
- 個別球員的近期已觀察分鐘由下節所述摘要稽核補入；國家隊負荷、預估分鐘、傷病、旅行距離與完整覆蓋仍未建立。`coverage.complete`、`pointInTimeAvailabilityVerified` 及 `modelEffectApplied` 維持 `false`；不直接調整預期進球數。

## 11.10.8：近期個人負荷觀察

- 從兩隊 `recentCompleted` 各選最近最多 4 場，按每場已核對賽事 slug 與 event ID 讀取 summary；不是將英超 endpoint 套到全部盃賽。每隊最多 2 個請求同時進行，新增階段預設預算 5 秒，個別請求 2.5 秒。即使加入共用讀取，每個等待者仍有自己的截止時間。
- `lib/soccer/player-workload.js` 交叉核對球隊、對手、主客、聯賽、event/competition ID、開球、完賽與內容 hash。重用 `soccerMinutesAudit` 重建正規時鐘參與；加時、無法核對事件與缺少名單不填零、不擅自折算。
- 彙整每位球員近 7／14 日已觀察分鐘、登場及先發次數；補時才登場者可能為 0 時鐘分鐘但仍計一次登場。該窗口完全沒有觀察到球員名單時，各指標為 `null`。
- 分母為本次已知近 14 日完賽候選，保存已核對、未讀取、逾時、格式錯誤與加時缺口；這些不代表來源完整母體。`coverage.complete=false`。
- 每場保存來源 URL、取得時間、內容 hash 與球員觀察。完整分析版本同時保存球隊負荷與個人來源版本；新抓歷史不能當作當年賽前已取得。
- 單場壞資料不得抹除其他可核對場次。個人分鐘不作未來上場預測，也不直接調整研究比分或啟用正式 W/R/S。
- `scripts/soccer-player-workload-test.mjs` 與 `scripts/soccer-workload-ui-test.mjs` 以 repository 已保存的真實 Brentford–Arsenal（704467）摘要檢查兩隊各 990 球員分鐘、零時鐘分鐘補時登場、來源與截止、防混隊、部分缺失、共用讀取截止及真實 JSX；`scripts/soccer-workload-test.mjs` 另執行球隊賽程至個人摘要的完整函式路徑。這些是工程／案例驗證，不能代表預測準度或來源完整覆蓋已驗收。

## 驗證

`node scripts/soccer-workload-test.mjs` 涵蓋實際多賽事來源 schema、近 7／14 日統計、未來安排分離、開球間隔與休息區分、來源截止、身分衝突、無法確認時間、裁定結果、跨年標籤、部分來源失敗、快取、並行與逾時。

測試 fixture 是本次實際回應的結構摘錄，刪除標誌、外連、轉播及無關重複欄位；不聲稱摘錄檔本身等於原始回應內容 hash。正式環境來源取得、快照持久化與網站呈現仍須由端到端驗收另行確認。


### 最新來源額外核對

另實際讀取 ESPN `eng.1/summary?event=401878769`（2026-10-18 Arsenal 對 Nottingham Forest）。對手其中一筆換人文字與名單姓名不同，原本要求兩隊一併通過會使 Arsenal 的可核對分鐘也遺失。本版保留預設兩隊完整稽核，另允許按已核對隊伍獨立稽核，結果明列 `TEAM_ONLY`，不猜別名、不放寬本隊換人角色。此來源 Arsenal 本隊重建為 990 正規時鐘球員分鐘、15 人登場；不能據此宣稱對手或其他賽事已核對。
