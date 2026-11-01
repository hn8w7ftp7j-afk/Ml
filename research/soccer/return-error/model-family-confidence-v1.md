# 個別賽事的模型族條件 EV 界

實作：`lib/soccer/model-family-uncertainty.js`。本協定與原有單場實現收益誤差研究分開，不修改 W、R、S 公式、候選門檻、已保存預測、退水或結算規則。

## 估計對象與限制

本方法針對**當場比分分布所屬的指定模型族**，推導原盤條件期望收益的上下界。它不將每場輸贏與預測收益的差值當成當場模型誤差，也不將 bootstrap 散布當成已驗收的真實不確定性。

先凍結比分模型 q 及校準賽事範圍。令第 i 場的原始主客進球率為 λᵢ、μᵢ，假設校準範圍與目標未來賽事的真實邊際率分別為 aλᵢ、bμᵢ，其中 a、b 是同一聯盟、同一期間內穩定的倍率。賽事之間條件獨立，比分邊際是 Poisson；同場主客比分可由任一合法 Dixon–Coles 相關參數相依。

這些是**適用假設**，不是程式自動證明的事實。尤其，參數信賴域無法涵蓋任意模型錯置、未接入的人員影響、時間漂移或未知的賽事依賴。每個輸出都保留 `coverageAssumptionsVerified:false`、`modelMisspecificationBound:null`、`formalEligible:false`，不寫入正式 registry。

## 真實比賽與時間隔離

每個聯盟／期間／完整模型 hash 分開計算。FT 與 HT 不能混合；HT 模型身分須包含原 FT 模型與半場模型的聯合 hash。每場只計一次主客進球與一次原始 rate exposure；多個盤口、方向、價格、重複收據不能增加樣本數。同一真實賽事如有不同時間、率或賽果，整場隔離。

模型來源、建立／訓練完成時間、協定登錄時間、校準起迄與每筆賽果來源 hash／可用時間都留在輸出或輸入 hash。模型與協定必須先於校準窗口。已看過的結果可以產生明確標示的模型族研究，但單靠呼叫者提供的時間或 hash 不能證明歷史凍結或未碰過的前瞻驗證；`durableFreezeVerified` 永遠保持 false。來源蒐集完整性與排除機制也必須獨立驗收。

## 有限樣本的率域

獨立 Poisson 邊際相加後，主隊總進球 S 服從 Poisson(aE)，E=Σλᵢ；客隊同理。對任一總均值 m 與觀察 s，定義

`d(s,m) = s log(s/m) + m - s`，s=0 時為 m。

Poisson MGF 為 `exp(m(exp(t)-1))`。對上尾用 t>0、下尾用 t<0 套 Markov 不等式，最佳化 t=log(s/m)，分別得到 `exp(-d(s,m))` 的尾界。因此把兩側錯誤各設為 δ/2，可反解 `d(s,m) ≤ log(2/δ)`，以至少 1−δ 的機率包含真實總均值。這是保守的 Chernoff 反解，不是常態近似或未校準的 likelihood 比例。

主客各分配 δ=α/2，再由 Bonferroni 得到同時至少 1−α 的率域，**不要求同場主客進球獨立**。除以 E 即為倍率區間。α 必須由協定明示；沒有預設零誤差，也沒有以測試結果挑選 α。反解採域外端點包住根，零進球的下界保持 0。

## 全連續域與比分尾部

Poisson 單一比分 k 的 PMF 對 rate 的最大值在 `clamp(k,lower,upper)`，最小值在兩端點。因此程式對整個連續 rate 矩形建立各 cell 的機率界，而非用幾個網格點猜極值。

Dixon–Coles 只在 00、01、10、11 四格搬移 `(-c,+c,+c,-c)` 的質量。非負機率要求 `−min(p01,p10) ≤ c ≤ min(p00,p11)`；以每格的 enclosing bounds 包住此區域，可保留**全部合法 rho**，不替未知的 rho 指派機率。這個較寬的包絡包含合法模型族，寬界不能被改寫為零誤差。

至少涵蓋 0、1 的完整矩形包含四格全部修正，所以該矩形 CDF 的 DC 修正和為零。矩形外質量上界取 rate 上端點的 Poisson CDF；未知尾部乘以既有結算引擎的最差／最好可能收益。既有 `evaluateSoccerQuote` 提供每個比分的信用盤／亞洲盤算術，足球退水仍依傳入的原始契約。標準 settled-principal 的 outcome mask 只有在完全等價時才能轉給該引擎，其餘 mask 明確拒絕。

最後在所有 cell 機率界與 `Σp=1` 下，用線性規劃的對偶界積分 payoff。對任意 t，`EV=t+Σ(vᵢ−t)pᵢ`；每個係數依正負選擇機率的保守端點。此不等式對所有機率配置都成立，沒有以取樣的參數極值代替全域證明。沒有尾部歸一化或中點填值。

所有 ln、exp、乘除與加減使用既有 decimal.js 80 位、向負／正無窮有向捨入。`Decimal(number)` 的最短十進位並非原數字的精確 IEEE binary64 值，所以 rate、exposure、倍率、水位、退水、結算 fractions 與參考 W 的輸入端點，會**先向外擴一個 binary64 可表示值**再進 Decimal，兼容封存 JSON 十進位值與原有 JS binary64 值；概率／fraction 的已知合法下界再限制為 0。Poisson PMF 與 CDF 尾部使用一致的輸入包絡。輸出 binary64 也向外擴一個可表示值。

既有引擎仍決定每格 win／loss fractions 與派彩規則；新模組依這些 fractions 對 gross、退水本金及 net 逐步作有向 Decimal 重算，並與原引擎 float 結果取包絡。尾部 payoff corners 也同樣處理。多步消去誤差不保證只有最終結果的一 ULP，因此不能僅替 `netPerUnit` 擴一 ULP。數值精度／矩形大小只控制界的寬度，不作為經濟模型誤差。

## 與正式 R 的介面

`evaluateSoccerModelFamilyUncertainty` 核對完整 confidence-set hash、聯盟、期間、模型與目標賽前時間，再傳播當場原始 rates。若提供既有情境流程算出的 W，可輸出

`familyOnlyErrorBound = max(0, W−lowerEV, upperEV−W)`。

只有在上述模型族及資料條件成立時，這個界才包住當場族內條件 EV 與 W 的差。它保留獨立欄位；`empiricalErrorMargin`、`formalModelError`、W／R／S 仍為 null。未來若經獨立驗收認定其適用，才能把已驗收數值及 validation artifact／實際真實場次／來源收據接入原 scorer 的 `uncertainty.modelError`；目前不自動進行此映射。原有 `R=min(W,Q10,W−modelError)` 不變。

## 核對依據

- Peter W. Glynn (1987), *Upper Bounds on Poisson Tail Probabilities*, Operations Research Letters 6, 9–14；作者原文與 Poisson 尾部誤差背景：[PDF](https://web.stanford.edu/~glynn/papers/1987/G87b.pdf)。上列 MGF 反解的完整推導在本協定中明示。
- Dixon & Coles (1997), *Modelling Association Football Scores and Inefficiencies in the Football Betting Market*, JRSS C 46, 265–280：[DOI](https://doi.org/10.1111/1467-9876.00065)。此引用說明模型族，並不宣稱本專案已驗收其適用性。
- decimal.js 官方 API 的 `naturalLogarithm`、`naturalExponential`、precision 與 directed rounding：[官方文件](https://mikemcl.github.io/decimal.js/)。兩個自然函數在此精度下依文件正確捨入。

測試指令：`node scripts/soccer-model-family-uncertainty-test.mjs`。測試含 Poisson 反解機率涵蓋、連續區間內部極值反例、正負合法 rho 的實際 payoff、未知尾部、真場次去重／衝突、FT／HT／聯盟隔離、變造 hash 與禁止正式 promotion。合成工程測試不能替代正式站資料適用驗收。
