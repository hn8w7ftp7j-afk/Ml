# 四聯盟棒球 PIT 影子分析

網站版本：`11.0.0`
Tai888 Reader：`2.1.19`（本次不需重裝）

這是私人使用的盤口分析與實際下注帳本。所有模型輸出目前都是影子診斷，不是正式推薦；正式推薦、正式下注資格與 Unit 在 locked OOS 與 forward 驗證完成前一律停用。

## 目前發布狀態

| 聯盟 | 官方賽程 | Tai888 Reader | 實際下注帳本 | 影子分析／排名 |
| --- | --- | --- | --- | --- |
| MLB 美棒 | 啟用 | 啟用 | 啟用 | 啟用 |
| NPB 日棒 | 啟用 | 啟用 | 啟用 | 暫停 |
| KBO 韓棒 | 啟用 | 啟用 | 啟用 | 暫停 |
| CPBL 台棒 | 啟用 | 啟用 | 啟用 | 暫停 |

NPB、KBO、CPBL 已建立各自的資料與規則契約，但在聯盟專屬先發能力、打線、純後援牛棚、球場與情境資料鏈完整發布前，API 會以 `LEAGUE_NOT_READY` fail closed。不得回退 `analysis-v10`、不得套用 MLB 參數，也不得用整隊失分冒充先發 ERA／FIP／WHIP或純牛棚品質。

## V11 不可違反的模型鏈

每場只建立一份不可變的聯合比分分布：

```text
聯盟隔離的賽前 PIT 資料
  → 上游客／主得分中心與共用聯合比分分布
  → 同一分布結算四市場、八方向
  → Tai888 盤口與水位只轉換 payoff
  → Weighted EV / Robust EV
  → 數學、資料、情境與排名 Gate
  → 影子 S 分數
```

核心保證：

- 大／小、讓／受讓與全場／前五局從同一場的凍結比分世界結算。
- Tai888 是實際成交價，不得回灌或改變預測得分、勝率與方向。
- 外部市場只可作同合約稽核，不能取代模型 EV 或改寫分布。
- 盤口、水位、來源、Reader hash、聯盟與場次完全隔離。
- 核心資料缺失、過期、未能 PIT 證明或數學 QA 失敗時不建立有效 EV、S 分數或排名。
- 已開賽、Reader 過期、盤日或 payload hash 不一致時，保留完成的賽前分析供稽核，但停止排名與新下注紀錄。

## 上游方向完整性

方向只由棒球資料與已發布特徵決定。市場價格只能作用於結算損益。

MLB 必要核心包含可信場次身分、先發／opener-bulk 情境、打線、球隊攻擊、純後援牛棚、球場與必要環境資訊。零先發紀錄的投手不得自動視為正常 5.2 局先發；投手 split 必須配對本場球隊與賽前截點。

六項 MLB 進階特徵採伺服器端、PIT 截止與獨立放行：OAA／FRV、捕手 framing、球種對戰、傷停 run value、主審 zone、球場方位風向。尚未通過對應 artifact、年度／制度與 OOS Gate 的特徵保持中性；捕手與主審分開計算，已放行進階效果合計限制在每隊預期得分 `±0.30`。

亞洲三聯盟另有獨立規則契約：

- NPB：聯盟／交流戰 DH 狀態、可信先發能力、打線與球場資料必須同時可證明。
- KBO：官方左右投、雙重賽狀態、天氣或巨蛋情境必須進入同一 PIT 快照。
- CPBL：先發、打線、純後援牛棚、球場及洋將同時上場限制必須有明確狀態。

只取得姓名、空打線、中性球場或整隊近期比分代理時，都不能發布亞洲聯盟方向。

## 固定結算與影子評分 Gate

本金 `B = 10,000`、每萬退 `150`，退水率 `r = 0.015`。台灣盤逐腿結算全贏、部分贏、走水、部分輸與全輸，正反方向共用同一洞口規則。

影子排名至少受下列硬規則控制：

- `Weighted EV > 0` 且 `Robust EV > 0` 才可能達 7.2。
- Weighted／Robust 差距超過 5 個百分點：保留原始 W、R 與公式分數供稽核，但不列排名。
- Weighted EV 達 20% 以上：視為異常複核，不覆寫原值，但不列排名。
- 8.5 以上必須有兩個彼此獨立、完全相同合約的驗證來源；不足時最高 8.4。
- QA、情境穩定、雙正 EV、Reader 新鮮度與後端 `rankingQualified` 任一失敗即不列排名。
- 所有畫面文字使用「影子候選／影子排名」，不顯示主推、正式注碼或正式推薦。

## 不可變 PIT 與回放

`database/0005_analysis_pit_snapshots.sql` 建立四聯盟共用、聯盟隔離的 append-only PIT 表。FULL 分析永久保存完整聯合比分分布（JSON 或 gzip），price-only reprice 只引用父分布，不得重新抓核心資料或重建另一個棒球世界。

`database/0006_cloud_bet_position_uniqueness.sql` 先隔離既有重複部位，再以聯盟、官方場次、市場與方向建立唯一鍵；新增下注採原子衝突檢查，避免重送、雙擊或多實例競態產生重複紀錄。

每筆快照包含：

- 聯盟、官方場次身分、開打時間、資料／盤口／分析截點。
- `inputHash`、核心／價格／計算／輔助指紋。
- 完整分布、`distributionId`、`distributionHash`。
- 凍結 context、特徵／情境／校準／規則契約。
- 父快照鏈、版本、legacy quarantine 與 replay identity。

資料庫只接受開賽前寫入；內容不可更新或刪除。PIT 狀態只有資料庫確認後才可顯示為已永久保存；未設定資料庫或寫入失敗必須明示未確認，不能把排程中當成已保存。任何 hash、父鏈、聯盟、場次、核心或完整分布不一致都會停止回放。

舊版無法證明 PIT 的紀錄保留在 quarantine，不納入 calibration、OOS、績效或模型升級證據。

## Reader 與下注紀錄安全

Reader 只接受單一權威 Tai888 分頁及完整官方台北盤日。盤口由伺服器依聯盟、場次、盤日與方向簽章。

按下「紀錄實際下注」時，前端會再次核對：

- 官方預定開打時間尚未到達。
- Reader 狀態仍為 fresh，盤日相同。
- 該場分析保存的 `readerGameMarketHash` 等於目前同場 Reader 內容 hash；其他場 heartbeat 或盤口變化不會讓本場誤失效。
- 該列來自 `TAI888_READER_AUTO`、伺服器仍標記 eligible，且 `lineAsOf` 未超過 5 分鐘。
- 有實際水位且不是估計水位。
- 後端已找到相同分析身分的最新、未隔離 PIT 快照，並在資料庫查核完成後再次確認 Reader 新鮮度與尚未開賽。

恢復的舊畫面、過期盤、重價失敗、不同 Reader revision 或無 PIT 證據均不得新增下注。Reader 內容未變時的 heartbeat 只更新獨立的即時狀態，不改寫已簽章的 `lineAsOf`，也不重建比分分布。下注帳本不可刪除或清空；無法證明來源的舊紀錄會保留為人工複核隔離資料，且不進入下注數、勝率、損益或 ROI。

## 安全環境變數

Production 必要：

- `APP_PASSWORD`：私人登入牆。
- `SESSION_SECRET`：至少 32 個隨機字元，不得與網站或 Tai888 密碼共用。
- `READER_PAIR_SECRET`：Reader 配對密鑰。
- `DATABASE_URL`：下注帳本與永久 PIT 儲存。

建議獨立設定：

- `MARKET_INTEGRITY_SECRET`：盤口與 reprice snapshot HMAC；未設定時才使用 `SESSION_SECRET`。

本版不使用任何代理配額，不需要更新 Reader，也不需要 AI／GPT 服務才能產生分數。

## 本機驗證

```bash
npm install
npm test
npm run build
npm audit --omit=dev --audit-level=high
npm run package:reader
npm run e2e:reader
```

`npm test` 包含比分分布隔離、PIT 永久分布與父鏈、Reader hash／時效、台灣盤結算、MLB opener／split、進階特徵 Gate、亞洲三聯盟 fail-closed 與快取跨開賽安全回歸。

## 部署

正式部署前必須：

1. 全部測試、Production build 與 high-severity audit 通過。
2. 確認 `DATABASE_URL` 可建立或已執行 PIT migration。
3. 確認 Reader 仍為 `2.1.19` 且四聯盟頁籤與 league isolation 測試通過。
4. 合併到 `main`，再部署 Vercel Production。
5. 驗證 `/api/health`、登入、四聯盟狀態、MLB 影子頁、亞洲 setup 頁與未登入 API fail closed。

本系統不保證單場或長期獲利；目前輸出只供模型驗證與實際下注紀錄稽核。
