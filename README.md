# MLB Positive EV v3.1

私人使用的 MLB 台灣信用盤分析系統。

## 核心流程

- MLB 官方賽程與 probable pitchers
- iPhone 多圖上傳、壓縮、AI Vision 辨識與手動校正
- 實際開盤市場才鎖定與分析；未開盤市場可留白
- 全場讓分／全場大小／上半讓分／上半大小，各市場獨立
- 台灣信用盤部分輸贏、每萬退水、EV／穩健 EV／加權 EV／評分
- 下注紀錄、終場結算、ROI、CLV、JSON 備份與 CSV 匯出

## 安全設定

Vercel Environment Variables：

- `AI_GATEWAY_API_KEY`：必要
- `AI_MODEL`：選填，預設 `google/gemini-2.5-flash`
- `APP_PASSWORD`：設定後啟用私人登入牆
- `SESSION_SECRET`：建議設定至少 32 個隨機字元，用於 30 天登入 Cookie 簽章

網站不會把金鑰送到瀏覽器。API 有同源檢查、輸入大小限制、格式驗證與基礎頻率限制。正式環境仍建議把 GitHub Repository 改為 Private，並在 Vercel Firewall 對 `/api/vision`、`/api/analyze` 再加平台級 Rate Limit。

## 測試

`npm test` 會執行盤口解析、部分結算、退水、EV、支配性、未開盤市場、認證、同源、大小限制與頻率限制測試。每次推送 main 後，GitHub Actions 會等待 Vercel Production 更新並測試首頁、Security Headers、賽程、AI 文字解析、完整 8 方向、只有 1 個市場的 2 方向分析，以及賽果 API。
