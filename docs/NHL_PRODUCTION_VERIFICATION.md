# NHL Production 實測紀錄

記錄日期：2026-09-06。本文件依本次主執行者提供的 Production 實際操作與測試結果整理；沒有操作證據的項目保留「待驗證」，不以 Build 成功代替實測。

## 本次實測版本

| 項目 | 已提供的證據 |
| --- | --- |
| 既有 Production 網站 | [mlb-positive-ev.vercel.app](https://mlb-positive-ev.vercel.app) |
| NHL 合併 | PR #166 |
| GitHub main commit | `21b5f962c0530ec53692df7309fbb00f81bc101e` |
| 網站版本 | `v11.9.0` |
| Vercel Production deployment | `dpl_4iCdPmyqDc1jaLdCQCkqwt3y8FKb`，狀態 `READY` |
| GitHub main CI | run `34009313000`，對應上述 `21b5f962…` commit，結果 `success`。 |
| NBA 相容要求 | 保留 NBA PR #165／#167 的既有成果；不得以 NHL 修改覆蓋 NBA 功能。 |

下列 Production 證據屬於這次 `v11.9.0` 初次健檢。主執行者另在處理備用門將標題與等待狀態的琥珀色提示，預計發布 `v11.9.1`；後續版本的 Build、部署、commit 對應與 Production 重測尚待補記，本文不預先宣告通過。

## NHL 資料與實際操作

| 項目 | 實測結果 | 驗證範圍 |
| --- | --- | --- |
| 當日賽程 | 台灣日期 `2026-09-06`，官方正常回覆 `0` 場。 | 確認有效空資料可用；不把空賽程當來源故障。 |
| 歷史賽程 | 台灣日期 `2023-10-11` 顯示完整 `3` 場：NSH／TBL `2023020001`、CHI／PIT `2023020002`、SEA／VGK `2023020003`。 | 美東日期為 `2023-10-10`，日期轉換正確。 |
| 比賽詳情 | `2023020001` 的官方 landing、boxscore、play-by-play 均成功取得。 | 此次為 live 官方讀取，不是以歷史樣本替代成功。 |
| 逐節與終場 | 三節客／主比分為 `0:1`、`1:0`、`2:4`，合計 `3:5`。 | 節次總和與終場一致。 |
| 永久來源快照 | 本次保存回應 `persisted: true`；versions GET 可讀回來源 revision。 | 已確認一次實際寫入與讀回；不等於所有後續更新均已保存。 |
| 休息與賽程密度 | 官方完整 club-season 賽程推算：NSH 休息 `3` 天、TBL 休息 `2` 天；兩隊最近七天皆 `3` 場。 | 密度包含實際季前賽；這是本次取得賽程的回溯計算，不構成歷史賽前時間點證據。 |
| 球隊名單 | NSH `20232024` roster 可讀，顯示真實 Player ID。 | 已確認該球隊與球季操作。 |
| 球員資料 | 連續點選兩次 Juuse Saros `8477424`，均返回正確球員資料；統計列可見至 `20252026`。 | 確認重複點選與球員識別；不將其他球季資料冒充所選歷史球季。 |
| 球隊統計 | 官方 club-stats 真實資料可顯示。 | 球員統計可讀；不代表 xG 或所有球隊進階指標已接通。 |
| 歷史研究 | Production 顯示 `20` 場真實樣本、`14` 個 retrospective folds、`0` 個 strict PIT folds。 | 工程／回溯比分研究可查看；未完成正式預測效力或賽前重播驗證。 |

本次來源版本：

```text
6120d80908eff6c26114553219a5c1c3e7084104d56a65fe5e416f04336be8cd
```

對應官方資料取得時間：`2026-09-06 11:37`，台灣時間。取得時間不替代來源發布時間，也不回填成歷史賽前快照時間。

`2023020001` 的實測情境統計如下，均以客隊／主隊順序記錄：

| 範圍 | 射正 | 進球 |
| --- | --- | --- |
| 5v5 | `18 / 22` | `2 / 1` |
| Power Play | `7 / 10` | `1 / 2` |
| 全場射正 | `31 / 34` | — |

5v5 與 Power Play 是各自的比賽情境，不把其合計冒充所有情境的全場統計。

## 切換、介面與既有聯盟

| 操作 | 已觀察結果 | 狀態 |
| --- | --- | --- |
| NHL 日期控制 | 原生日期輸入以 ArrowUp 改至 `2023-11-11`，切換後新日期沒有沿用舊 board；ArrowDown 返回 `2023-10-11`，原歷史快取仍在。 | 已實測 |
| 自動化輸入差異 | browser fill 未觸發 React 狀態更新；原生鍵盤操作可正常改日。 | 已辨識為操作工具限制，不列為網站已重現錯誤。 |
| NHL → NBA modal → 關閉 | 返回 NHL，原本資料仍保留。 | 已實測 |
| NHL → NPB → NHL | 返回後保留歷史日期與 `3` 場 NHL 資料。 | 已實測 |
| NPB 同步／背景工作 | 按鈕實際啟動 `4` 場背景 job，切至 NHL 後工作持續；返回 NPB 後，四個有盤場次均顯示完整模型結果與 PIT 永久保存確認。 | 已確認工作完成與畫面結果；DOM 可見完整 `8/8` 方向，四場皆 `persisted: true`。 |
| NPB 重新驗證與無盤場次 | 後台重新驗證期間，畫面仍保留目前分數；另兩個 Reader 無盤場次維持 `0/8` 與未呈現盤的訊息。 | 已實測；不以缺盤場次冒充有盤或分析完成。 |
| MLB／NPB／KBO／CPBL 入口 | 四聯盟入口均已確認；Reader 顯示 NPB `4/6`、KBO `5/5`、CPBL `2/3`，各自對應所選聯盟。 | 已確認入口、真實讀取與這些聯盟資料未混用；不延伸宣告未操作的下注或結算流程通過。 |
| 下注紀錄 | 今日 ledger 可讀 `26` 筆，包含原有 `4` 筆已結算紀錄。 | 已確認既有紀錄可讀；未寫入假下注，也未以測試新增實盤下注。 |
| Desktop | 頁面 `clientWidth = scrollWidth = 1348`。 | 已確認此視窗尺寸無橫向溢位。 |
| Mobile | 尚未實際縮小 viewport 或使用實機。 | 待驗證 |
| Console／Runtime | 本次檢查網站本身錯誤數為 `0`。 | 已實測；瀏覽器 extension 錯誤另列，未計為網站錯誤。 |

上述 ledger 檢查不代表本次已在 Production 實際完成下注、取消、再次下注、新賽事自動結算或績效重新計算。這些操作不能因既有紀錄可讀而標示為實測通過。

## 自動測試與發布檢查

| 檢查 | 已提供結果 | 限制 |
| --- | --- | --- |
| 完整 `npm test` | 全部 suites 執行到達，`allSuitesReached: true`。測試輸出 `536` 行，包含 NBA `58` 組檢查與 NHL `7` 個 suites。 | `536` 是輸出行數，不是測試數量。 |
| Production Build | PASS | 對應本次已完成版本；不能替代後續版本重跑。 |
| Dependency audit | `0` vulnerabilities | 僅記錄此次 audit 結果。 |
| Reader package | PASS | 套件成功產生不等於 NHL 實際盤型已驗證。 |
| API 錯誤反例 | 單元與 API integration tests 已驗證；Production 實際導覽 `action=schedule&date=2026-02-30` 回傳 `ok: false`、`NHL_INVALID_DATE` 與「台灣日期格式無效」。 | 已驗證正式環境的無效日期回應；其他錯誤類型依自動測試證據列示。 |
| Reader API | Production GET `/api/nhl/reader` 回傳 `league: NHL`、空 `verifiedMarkets`、`executable: false`，並顯示等待真實盤訊息。 | 介面可讀；沒有宣告實際盤型驗證通過。 |

合併後的測試涵蓋 NBA 與 NHL；本次紀錄不把兩個模組的 Shadow 研究資料混為正式下注績效。

## 尚未具備的資料與未完成實測

NHL Tai888 介面目前為空的已驗證市場 manifest，畫面明確顯示：

> 等待真實 Tai888 NHL 盤驗證

這是待資料驗證狀態，不是市場可執行、盤口解析或 OT／Shootout 結算契約已通過的證據。不得由目前畫面推論 W EV、Robust EV、S 評分、下注順序或實盤結算已在 Production 完成驗證。

以下欄位尚未接通可信的實際 feed，仍為 unknown／缺資料：projected goalie、confirmed goalie、injuries、line combinations、defensive pairings、xG。未知狀態有被明確呈現，但不能把它記成該資料功能已完成驗證。

後續必須補上的具體驗證：

- Mobile viewport／實機的主要操作與版面。
- 若要宣告完整棒球 Regression，補齊尚未實際操作的流程證據，並與自動測試結果分開記錄。
- `v11.9.1` 或任何後續版本的完整測試、Build、部署識別，以及受修改與跨聯盟路徑的 Production 重測。
- 真實 NHL Tai888 市場、賽前門將／傷病／陣容快照、進階資料與足夠歷史資料出現後的正式驗證。

本文件保留初次 Production 證據與未完成項目，不據此宣告所有完成標準已達成。
