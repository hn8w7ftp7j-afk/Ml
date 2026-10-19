# 足球 11.10.15：前瞻賽程來源綁定

正式站端到端核對發現，`normalizeSoccerPrematch` 會用 summary 建立核對後的 `evidence.game`，因此該物件的 `source` 也是 summary。11.10.14 前瞻驗證錯把它當成 scoreboard，造成已保存的預測全部被 `FORWARD_INPUT_SOURCE_AVAILABILITY_UNVERIFIED` 排除。既有獨立 fixture 沒有反映這個實際資料形狀。

分析服務現在把實際選中場次的原 scoreboard 來源獨立保存為 `evidence.scheduleSource`，並將 provider、URL、contentHash 與 fetchedAt 固定於 `inputVersions.scheduleSourceVersion`。前瞻驗證要求原 scoreboard、summary 與各自版本符合，沒有把 summary 改認成 scoreboard，也沒有放寬來源／時效檢查。先發來源亦與真實 normalizer 的 summary 來源逐欄核對。

新增英超／歐冠保留來源 fixture 的整段回歸：實際 fetcher → normalizer → 分析服務 → PostgreSQL 不可變版本 → 資料庫封存憑據 → 前瞻報表。各聯盟 FT／HT 基準各選入一筆，未公布 XI 的挑戰模型保留排除；另驗證缺來源、summary 冒充 scoreboard、版本雜湊衝突及未來來源不能通過。

11.10.14 已建立的收據不回填或追認缺失的賽程來源。只有新分析的新不可變版本能提供完整來源鏈。模型、退水率、評分門檻及正式資格 gate 均維持原設定；本版修正不代表模型驗收或勝率改善。
