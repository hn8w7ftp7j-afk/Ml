# MLB Positive EV v3

私人使用的 MLB 台灣信用盤分析系統。

## 已完成流程

- 今日 MLB 賽程與 probable pitchers
- iPhone 多圖上傳、逐張壓縮、AI Vision 辨識
- 盤口文字備援與手動建檔
- 四市場八方向驗證與盤口鎖定
- 球季／近況、先發、打線、捕手、傷停、左右投對位、球場、天氣、旅行休息資料層
- 台灣信用盤部分輸贏、每萬退水、EV／穩健 EV／加權 EV／評分
- 下注紀錄、自動終場、ROI、CLV、評分／市場／球隊統計
- JSON 備份、還原、CSV 匯出

## 安全

`AI_GATEWAY_API_KEY` 只放在 Vercel Environment Variables。網站目前未加帳號登入牆；正式私人化應再接驗證。
