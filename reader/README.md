# Tai888 Reader v2.0.7 LOCKED MARKET FIX

## 功能

- 只讀取 Chrome 已正常登入、目前頁面已顯示的 Tai888 MLB 盤口表格。
- 逐場解析全場讓分、全場大小、上半讓分、上半大小與雙方水位。
- 每次只採用單一分頁、單一 frame 的完整權威盤面；不跨 frame 合併。
- 聯盟場數與逐場 4 市場／8 方向不完整時整批停止上傳。
- Tai888 頁面超過 3 分鐘沒有活動時停止刷新，避免舊盤被當成新盤。
- Tai888 頁面內容變動時自動同步，並每 60 秒送一次心跳。
- 不讀取密碼、Cookie、Session、帳戶額度，不操作下注，不繞過 Cloudflare。
- URL 中繼資料只保留 Tai888 `origin + pathname` 與固定 `#/BS` 盤面標記；query、其他 hash、`document.title` 與原始 frame URL 不保存也不上傳。

## 更新安裝

1. 解壓縮 ZIP。
2. Chrome 開啟 `chrome://extensions`。
3. 移除所有舊版。
4. 開啟「開發人員模式」。
5. 按「載入未封裝項目」，選擇解壓後的 `Tai888-Reader` 資料夾。
6. 點 Reader 圖示，第一次輸入一次配對密碼。
7. 保持 Tai888 MLB 盤口頁開著，之後自動同步。
8. 在擴充功能頁確認顯示 `2.0.7 LOCKED MARKET FIX`。
