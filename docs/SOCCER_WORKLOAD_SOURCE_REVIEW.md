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
- 球員實際分鐘、國家隊負荷、傷病、旅行距離與完整覆蓋仍未建立。`coverage.complete`、`pointInTimeAvailabilityVerified` 及 `modelEffectApplied` 維持 `false`；不直接調整預期進球數。

## 驗證

`node scripts/soccer-workload-test.mjs` 涵蓋實際多賽事來源 schema、近 7／14 日統計、未來安排分離、開球間隔與休息區分、來源截止、身分衝突、無法確認時間、裁定結果、跨年標籤、部分來源失敗、快取、並行與逾時。

測試 fixture 是本次實際回應的結構摘錄，刪除標誌、外連、轉播及無關重複欄位；不聲稱摘錄檔本身等於原始回應內容 hash。正式環境來源取得、快照持久化與網站呈現仍須由端到端驗收另行確認。
