# 產品與驗收契約

同一 IPv4 loopback 人工程序提供 Dashboard、管理 API 與 OpenAI 相容端點。控制器以 SQLite 保持工作、派送意圖、實體鎖及決策。預設 read-only，配置中的節點能力宣告只用於顯示。只有顯式 simulation 執行本機合成工作。實體 CPU、GPU、遠端代理、全域 CLEANUP 與正式部署各有獨立的資格。

## 控制器

以同一份本機安裝資料啟動一個 controller。工作以 client id 與 request id 去重。選擇節點前驗證模型、資源、健康及實體身分，先持久化意圖及鎖再派送。取消、逾時、失聯及程序中斷時保留不明資源。重啟後保留原工作與證據。使用另一節點只能承接新工作。R1 源碼與環境限定的受控 real attempt 保留原資格及驗收證據。

## HTTP

- `manage:read` 可查封裝、監控、工作摘要、診斷及 HOLD。V0.7 的八個 GET 保持既有回應格式。
- `models:run` 可列可用模型、提交工作、讀自己的工作與明確取消。Token 只在請求標頭，輸出只向具有該 scope 的工作擁有者提供。
- `manage:write` 保留供管理工作流程辨識。安裝、Token 及節點設定由本機停止後的維護入口執行。
- 支援 `GET /v1/models`、`POST /v1/chat/completions`、`POST /v1/completions` 及 SSE。工作使用固定的輸入欄位及資源上限。終態證據成立後才送出結果。
- Dashboard 使用 `GET /acm/v1/dashboard`、`GET /acm/v1/dashboard/history` 與 `/acm/v1/jobs`。獨立驗收涵蓋 scope、瀏覽器 origin、大小、速率、逾時、工作隔離及擴權拒絕。

## 維護

配置、Token registry 及資料目錄獨立於產品檔。每次人工啟動核對路徑、權限及檔案身分。SQLite 維護與執行程序共用排他安裝鎖。只備份已核對用途的資料，原地覆寫或略過不明鎖均須守門。
