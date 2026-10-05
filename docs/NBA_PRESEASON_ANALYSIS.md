# NBA preseason market estimates — v11.9.64

The formal NBA workspace now analyzes available preseason full-game and first-half total and spread contracts. Previously the same-season model had no 2027 preseason calibration observations, so its fallback displayed previous regular-season baseline scores but no market probabilities. The regular-season model remains separate.

ESPN secondary historical schedules for all 30 NBA teams were retrieved for preseason ending years 2024–2026 and previous regular seasons 2023–2025. Event identity, season/type, Taipei date, starting time, home/away, final score and neutral-site flags were cross-checked with every preseason event summary. Quarter scores must sum to final scores; first half uses quarters 1–2. Nineteen unique non-NBA-opponent games were excluded. The artifact embeds a manifest of 378 source URLs with SHA-256 hashes and 198 usable preseason games. Current 2027 preseason inputs use completed 2026 regular-season team results, never current game outcomes.

Four independent fixed ridge regressions (penalty 1000, minimum 30 earlier preseason games) map previous regular-season team strength to full total, full home-minus-away margin, half total and half margin. Each archived error is generated using only games on strictly earlier Taipei dates; same-day results are excluded. The minimum error distribution is 50 observations. All 168 frozen errors are used together, with a fixed 365-day half-life. There is no outcome-based filtering or reversal of over picks to under picks.

Reader quotes are matched to the authoritative scheduled event. Credit-contract rounding, partial wins/losses, favorite identity and each side's own water are evaluated separately. The UI displays unconditional model win probability, push probability and model net per 100 units including 1.5% turnover rebate. A heartbeat with unchanged prices preserves a current result; any change to any analyzed price, line or favorite marks it obsolete. Locked, stale or started events cannot be analyzed.

These are model estimates, **not verified historical betting win rates**. Historical original credit quotes and full contemporaneous input snapshots are unavailable, and injuries, roster changes and rotations are not incorporated. No executable NBA bet or baseball ledger eligibility is introduced. The UI and validation JSON explicitly disclose these limitations. 2025 total MAE improves from baseline 15.74 to 14.81; 2026 total MAE worsens from 16.89 to 17.78. These results do not establish profitability or a >50% realized win rate.

Reproduction:

```sh
node scripts/download-nba-preseason-training.mjs /absolute/source-directory
node scripts/prepare-nba-preseason-training.mjs /absolute/source-directory/training.json
npm run test:nba
npm run build
```

`nba-preseason-model-test.mjs` covers all four markets, exact partial-credit cash settlement, away/home favorite mapping, future/same-day exclusion, training integrity, single-market service execution, merged job results and price freshness. Existing NBA and multi-league tests protect authentication, event matching, workflow progress and baseball isolation.

## Shadow ranking and S display — v11.9.66

The NBA workspace now exposes an independent shadow-ranking tab, with full/half and total/spread filters. It lists every valid analyzed side, including negative net estimates, sorted by S score, then W and R, using the same production deterministic-score mapping as MLB. Win probability, push probability, exact quote/water, favorite/underdog role and sample count come directly from the same analysis payload as the game card; W is NBA model net per 100 units; R is the minimum of W and each prior preseason season stress estimate, requiring at least two seasons with 30 residuals each. S inputs use decimal return units, not probabilities. R is a historical scenario stress metric, not a confidence bound or a verified betting EV. Missing stress evidence leaves S blank until reanalysis. Both game cards and rankings display S to one decimal, with W/R and win/push probabilities in detail. All score outputs remain non-executable and ineligible for formal bets. Completed games join as each job result arrives. Changed prices, stale snapshots, started games, insufficient/reference results and mismatched identities are excluded. Reanalyzing from ranking preserves the selected view. Existing job restoration supplies the same rankings after reload.

## 已完成下注的手動紀錄（v11.9.68）

NBA 單場、全部方向及候選順序可填寫「記錄已下注」。必須明確確認本人已自行完成下注，輸入實際金額、合約盤口、水位及讓分方；不傳送投注交易、不改模型執行資格。

使用同一永久資料庫內的 `nba_manual_bet_records_v1` 保存獨立手動紀錄，NBA「下注紀錄」分頁按盤日查閱。來源固定為本人申報，未驗證、未結算，不加入棒球的 PIT 校準及已驗證績效；沒有沿用棒球前五局結算。相同日期／場次／市場／方向重複送出只回傳原紀錄，不因重分析或變盤改寫金額合約。只有伺服器取得永久資料庫回傳確認後才顯示已記錄；讀寫失敗會停留於待確認狀態，不以本機儲存替代。

### v11.9.69 操作修正

與 MLB 使用相同「紀錄實際下注／記錄中／已下注 ✓／失敗重試」操作：使用者按鍵表示自行完成該合約下注，每筆固定 10,000 元，按一下保存畫面上的盤口、水位與讓分方，不再開填寫表單。各方向可獨立送出，不能在保存確認前標為成功。伺服器亦拒絕非 10,000 元的新紀錄；既有已存合約不改寫。仍只記帳，不送出投注交易。
