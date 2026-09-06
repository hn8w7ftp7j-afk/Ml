# NHL Production 實測紀錄

記錄日期：2026-09-06。本文件依本次主執行者提供的 Production 實際操作與測試結果整理；沒有操作證據的項目保留「待驗證」，不以 Build 成功代替實測。

## 初次 Production 實測版本

| 項目 | 已提供的證據 |
| --- | --- |
| 既有 Production 網站 | [mlb-positive-ev.vercel.app](https://mlb-positive-ev.vercel.app) |
| NHL 合併 | PR #166 |
| GitHub main commit | `21b5f962c0530ec53692df7309fbb00f81bc101e` |
| 網站版本 | `v11.9.0` |
| Vercel Production deployment | `dpl_4iCdPmyqDc1jaLdCQCkqwt3y8FKb`，狀態 `READY` |
| GitHub main CI | run `34009313000`，對應上述 `21b5f962…` commit，結果 `success`。 |
| NBA 相容要求 | 保留 NBA PR #165／#167 的既有成果；不得以 NHL 修改覆蓋 NBA 功能。 |

下列初次 Production 證據屬於 `v11.9.0`；後續部署的實際檢查分開記錄，不以舊版證據推定新版通過。

## v11.9.1 第二次 Production 健檢

- PR #168 合併 commit：`12d6ca5c766ca316d5ad0ca585df9efec4a6aef5`。
- 同一 Production 網址，deployment `dpl_EbxXRm26r82FPatE9Hiy6EHAwxyY` 為 READY，部署 commit 與當時 main 一致；正式畫面顯示 `v11.9.1`。
- main CI `34010129951` SUCCESS，包含完整 `npm test`、Production Build、audit 及 Reader package。
- 備用門將 `00:00` 保持原始值，標題改為「官方門將名單與出場時間」；待 Tai888 驗證提示已實際確認為琥珀色。
- 真實官方 Shootout 比賽 `2023020030`：Regulation `1:1`、官方終場 `2:1`、`outcomeType: SO`；真實 OT 比賽 `2023020069`：Regulation `2:2`、官方終場 `2:3`、`outcomeType: OT`。兩次皆為 `OFFICIAL_LIVE_FETCH`，來源快照 `persisted: true`。
- NHL → NBA modal → 關閉，原 NHL 門將資料保持；「回到今天」與載入按鈕實測完成，`2026-09-06` 官方正常回覆零場。無效日期 API 仍回傳 `NHL_INVALID_DATE`。
- Desktop 再次確認 `clientWidth = scrollWidth = 1348`，網站本身 Console／Runtime error 未觀察到新增錯誤。
- MLB 實際同步後顯示 15 場；KBO 實際同步後 5 場皆顯示 8 個方向與 PIT 保存確認；NPB 新盤更新後，尚未開賽的 4 場皆顯示 8 個方向與 PIT 保存確認。這些不代表新增實盤下注或取消流程已執行。

第二次健檢也發現不能列為 PASS 的恢復問題：CPBL 啟動兩場背景工作並顯示三張賽事卡後，跨 NHL 完整頁面返回，仍可能回到空白盤口畫面。既有程式會在完成後刪除工作編號，快取寫入失敗時又可能只留下部分舊結果或淘汰其他聯盟快取，缺少已完成結果的伺服器恢復路徑。後續修正及其正式驗證必須另有證據，不能把本段問題記成已通過。

## v11.9.3 結果恢復修正

本次先整合最新 main `df2e6b46`／PR #169 的 NHL 來源快取隔離與 Roster 身分 QA，完整保留其程式與測試。

本次修正保留小型已完成工作紀錄，依聯盟、台灣日期、Game ID 與分析版本檢查快取；缺失時重新讀取原有伺服器結果，不以重新計算取代原始分析。快取額滿時不再刪除其他聯盟快取。完全相同的 reference/custom payload 只保存一次，恢復時完整還原，W／R／S、QA 與分布欄位沒有刪改。

單聯盟進行中的工作另保存輕量賽事卡，重新進站時可呈現背景載入狀態。Production 驗證必須再次完成「同步 → NHL → 原聯盟 → 頁面重開」，並檢查同場新舊版本、快取不足與跨聯盟反例。本版本的實際部署 commit、CI 與部署後操作結果記錄於對應發布 PR；此文件中的歷次記錄仍保留其原始驗證範圍。

整合後完整 `npm test` 已通過並確認所有 suites 執行到結束，含實際頁面函式的 14 組恢復反例及 17 組收據／身分／版本反例；獨立 reviewer 亦重跑這兩組測試確認。v11.9.0／v11.9.1 已刪除工作編號的舊結果不能由新收據機制事後憑空找回，驗證須使用新版開始並保存的新工作。

## v11.9.3 部署後實證與 v11.9.4 日期修正

- PR #170 main `26bc301563b323dc1b1cfc40bce8c5f3f0cf4aa6`，main CI `34012055796` SUCCESS；同一 Production deployment `dpl_68WUapPfGFgZfT9oXjwzdsYYfAye` READY，alias 與 commit 核對一致。
- CPBL 同步啟動三場背景工作，分析中以完整頁面導航前往 NHL，返回 CPBL 三場均呈現完成結果與 PIT 已保存。再次 CPBL → NHL → NBA modal → 關閉 → CPBL，三場的可見原始分數與 EV 文本逐項相同，Loading 正常結束。本次未操作實盤下注。
- NHL 正式頁重新取得官方歷史賽程三場、NSH roster 18 人、歷史研究 20 場／14 個 retrospective folds／strict PIT 0。官方 Shootout game `2023020030` 再讀取確認 Regulation 1:1、終場 2:1、SO。
- KBO 恢復後曾收到官方 game identity QA 的 409。舊 schedule 重新驗證是可能路徑，但沒有原始 request 證據可確定是哪個欄位變動；取得最新官方 schedule 後 preflight 正常。沒有放寬身分 QA，也不把 409 寫成成功。
- 四聯盟一鍵實測發現另一個既有問題：從 CPBL／KBO 進站時，MLB 日期使用台灣今日 9/6，未採最新 Reader 盤日 9/7，導致 MLB 被列為無賽事。v11.9.4 將 MLB 納入相同的逐聯盟 Reader 盤日核對，僅接受新鮮、有效、向前的日期，並保留使用者手選日期。
- 日期修正已以實際 resolver 與 one-click handler 的 VM 測試確認 hidden MLB 9/7 與其他聯盟 9/6 的隔離，含 stale、403／503、舊日期、無效日期及手選日期反例，共 6 組；獨立 reviewer 重跑通過。v11.9.4 的完整測試、部署與部署後證據記錄於對應發布 PR，不以本段 v11.9.3 實證替代。

## v11.9.4 與官方身分衝突修復

PR #171 已合併：`fb668211cb813e3b02690456c44b3c5b958613a5`。同一 Production deployment `dpl_DxkNzCCGrjRxKTyng22vf7BmJtvd` READY，alias 與 main commit 一致；main CI `34012999808` SUCCESS。PR CI `34012842596` SUCCESS，包含完整測試、Production Build、audit 與 Reader package；本機亦完整重跑通過。此版修正四聯盟 Reader 盤日，沒有使用舊 main 覆蓋 NBA／NHL 的已合併修改。

v11.9.4 正式一鍵實測：從 CPBL 進站，MLB 正確使用 `2026-09-07` 並提交 10 場；NPB／KBO／CPBL 各使用 `2026-09-06`，分別提交 3／4／3 場。場數依實際尚未開賽清單，不將已開賽場次算成失敗。完成後實際顯示四聯盟 4/4；切回 MLB 日期為 9/7，15 張卡中 10 場有真實盤的場次各顯示 4 個分數並有 PIT 保存確認，其餘 5 場鎖盤沒有假分數。

同次實測收到「此裝置無法保存工作編號」提示：四聯盟 preparedBoard 仍帶入可重建的龐大 verification payload，與單聯盟輕量重連紀錄不一致。v11.9.5 另修復此儲存路徑；保存失敗不冒充成功。

KBO 的另一個實際問題已由真實 parser 重現：同一官方資料列附帶 `gameId=20260906NCWO0` 時產生 `gamePk=1099424697962592`，移除該連結時 fallback 產生 `188899822811850`。兩者主客 Team IDs、UTC 開賽時間及場次相同；Production 恢復兩張卡後，舊 ID 又被當作目前官方 schedule 提交而遭 409。不能把此現象說成兩場不同比賽，也不能偷偷改寫原下注身份。

v11.9.5 以官方完整賽程作唯讀身分核對：只有完整且唯一的同聯盟／同日／同主客 Team IDs／同開賽時間／同場次證據，才將舊識別卡隔離保存。舊 PK、PIT、分析與帳本不改寫；Reader 重驗使用重新取得的官方賽前清單。衝突舊卡保留於明確標示的歷史區，不混進目前賽事。隔離 helper 9 組、真實頁面／API runtime 7 組、工作紀錄儲存 8 組反例通過。儲存測試以明確標記的 provider-shaped 壓力 fixture 執行真實 prepareAllLeagueBatch／oneClick handler；不把 fixture 大小當成 Production localStorage 量測值。模型結果與 receipt fingerprints 保留，寫入成功須讀回核對；完全不能寫入時僅當頁可重連，仍回報未持久保存。此版完整測試及 Production 實證於發布 PR 分別記錄。

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

人員與進階 feed 尚未接通仍屬未完成工程，不能僅寫成等待新球季就會自動就緒；足量歷史樣本及正式 calibration 也尚未完成。

後續必須補上的具體驗證：

- Mobile viewport／實機的主要操作與版面。
- 若要宣告完整棒球 Regression，補齊尚未實際操作的流程證據，並與自動測試結果分開記錄。
- v11.9.3 已完成 CPBL 跨頁恢復實測；後續版本仍須以對應部署的實證核對日期與官方識別衝突修復。
- 真實 NHL Tai888 市場、賽前門將／傷病／陣容快照、進階資料與足夠歷史資料出現後的正式驗證。

本文件保留初次 Production 證據與未完成項目，不據此宣告所有完成標準已達成。
