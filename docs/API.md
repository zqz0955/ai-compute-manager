# 本機 API

`LEGACY_KERNEL_BOUNDED_CPU_V1` 僅供固定隔離准入工具使用，沒有新增公開 API 或一般安裝模式。模型 scope 不授予該資格。模式、終態、記憶體證據、R1 release 和產品提交均須同次綁定；不完整／事件異常時保持持久 HOLD。原 R1 精確模式與只讀拒絕不變。

使用本次啟動畫面 ACM_LISTEN 顯示的 IPv4 loopback 埠。預設位址為 http://127.0.0.1:8787。傳送 Authorization: Bearer 與本機分配給該客戶端的憑證。跟隨轉址、啟用 CORS、把憑證放進網址及傳給其他來源都超出此契約。[OpenAPI](openapi.json)

## 權限與路由

| 方法與路由 | Scope | 行為 |
|---|---|---|
| GET /acm/v1/health | manage:read | 服務狀態與來源 |
| GET /acm/v1/nodes | manage:read | 節點、資源與時間 |
| GET /acm/v1/nodes/{id} | manage:read | 節點細節及資料可用性 |
| GET /acm/v1/nodes/{id}/models | manage:read | 固定節點模型清單 |
| GET /acm/v1/nodes/{id}/resident | manage:read | 新鮮駐留清單 |
| GET /acm/v1/history | manage:read | 合格採樣按 nodeId、from、to、limit 篩選 |
| GET /acm/v1/tasks | manage:read | 本機近期或已匯入的工作摘要 |
| GET /acm/v1/duals | manage:read | 已匯入的雙模型摘要 |
| GET /acm/v1/dashboard | manage:read | 模式、節點、工作、資格、鎖及稽核摘要 |
| GET /acm/v1/dashboard/history?nodeId=… | manage:read | 指定節點近期採樣 |
| GET /v1/models | models:run | 模擬模式下符合排程資格的模型。唯讀模式回傳空清單 |
| POST /v1/chat/completions | models:run | 模擬 Chat JSON 或 SSE |
| POST /v1/completions | models:run | 模擬 Completion JSON 或 SSE |
| POST /acm/v1/jobs | models:run | 建立模擬工作並回傳 202 |
| GET /acm/v1/jobs/{id} | models:run 或 manage:read | 工作擁有者取回輸出。管理讀取只有摘要 |
| POST /acm/v1/jobs/{id}/cancel | models:run | 只有工作擁有者可取消 |

既有八個管理讀取路由保留 requestId、data、error 的回應框架。來源明示 SIMULATION、CONFIGURED_ONLY、WINDOWS_LOCAL、JETSON_AGENT 或 V06_V07_BRIDGE。總覽可另以 OBSERVED 或 MIXED 彙整新鮮觀測。jobs/duals 的 coverage 為 LOCAL_RECENT 或 LOCAL_AND_ARCHIVED。V1 使用自己的資料來源，V0.7 bridge 的 sourceStatus、historySource 及 LATEST_UPSTREAM_PAGE 不適用。legacy 兩個工作清單皆為快照，不提供跨頁 before。

## 推論請求

Chat 接受 model、messages、max_tokens 或 max_completion_tokens、stream、stream_options。messages 為 1–32 筆，角色限 system、user、assistant，最後一筆為 user。各內容必須是非空字串。Completion 使用 prompt。stream_options 只接受 include_usage 布林值，且 stream 必須為 true。未知欄位回 400。

非同步 jobs 接受 model、input、max_tokens 與 priority（−10 到 10，同優先級依入列順序）。Idempotency-Key 的有效範圍是該客戶端，鍵最多 96 個 ASCII 字元。重送同一鍵且內容一致會回同一份工作，變更內容回 409。同步等待超時後，使用 X-ACM-Job-Id 讀取原工作。關閉連線不等於取消。

預覽的 Context 預算按 UTF-8 內容與序列化開銷保守限制，max_tokens 也受模型規格約束。同步回應包含 usage、choices、finish_reason 及 acm_source。SSE 在工作期間即時傳出 acm_provisional 片段。等簽章終態及資源證據提交後才送出 finish_reason、可選正式用量及 [DONE]。中途拒絕或終態不明回 SSE error 並結束。客戶端應把未完成片段當成預覽，依工作識別查詢最終狀態。一般服務仍只有合成可執行。

## 狀態、限制與錯誤

- 服務入口僅接受 IPv4 loopback 與自身 Host／Origin。要求 UTF-8 JSON，HTTP header 上限 8 KiB、body 64 KiB、response 256 KiB、同步等待 90 秒。每分鐘與同時請求上限在本機運作。
- 未登入或過期使用 401。缺 scope、來源不符、推論停用使用 403。工作歸屬不符對一般工作 Token 回 404。超界回 413，頻率或並行限制回 429，工作等待超時回 504。
- API 回傳固定錯誤碼與訊息。普通錯誤格式為 {error:{code,message},requestId}，可用 X-Request-Id 對照。API 審計只保留路由模板、時間、客戶端識別碼與結果。工作鎖及復原詳情由本機維運者核對。
- 空模型清單表示取得有效的零筆結果。節點無法核對時回 503，監控缺值用 null，過期數值不以已知狀態提供。
- 登錄、設定或檔案身分漂移會拒絕回應。設定維護需先正常停止。電源、終端、模型安裝與卸載沒有公開操作路由。

[JavaScript 範例](examples/client.mjs)使用 Node 內建 HTTP。只在可信本機程序環境提供 ACM_API_TOKEN。 [Python 範例](examples/client.py)以不回顯的本機提示取得憑證。兩者目的地均固定於 IPv4 loopback。

Chat 請求與回應參考 [OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)。

## 遙測發送

`GET /acm/v1/dashboard` 的 `placement` 是唯讀准入診斷，不是另一個派送入口。`kind=READ_ONLY_ADMISSION`，唯讀模式下 `status=REJECTED`、`selection=[]`；每節點 `eligible=false`，並列出 `READ_ONLY_MODE`、`OBSERVATION_NOT_EXECUTION_QUALIFICATION`、`TELEMETRY_STALE`、`TELEMETRY_UNKNOWN` 或 `NODE_OFFLINE` 等適用原因。`executionQualification=NOT_EVALUATED` 表示此視圖沒有替該節點發行執行資格。原始 source/status/freshness 同時保留。

`reservationPerformed=false`、`dispatchPerformed=false` 只表示這個診斷沒有執行資源操作，不代替既有工作／鎖查詢。在非唯讀模式，此視圖明確回 `status=NOT_EVALUATED`、`selection=null`、`evaluatedAt=null`，不推測真正 Scheduler 的選擇。實際提交仍由原 Controller、Worker 資格與持久鎖守門。

POST /acm/v1/telemetry/challenge 接受 nodeId，回傳短效 challenge。POST /acm/v1/telemetry/snapshot 接受相同 nodeId 及簽章 snapshot。需要獨立的 telemetry:publish scope、已核對節點公鑰與預期發送者。發送憑證無法查閱 Dashboard 或派送工作。詳見 [遙測指南](TELEMETRY.md)。

[Python 官方 OpenAI SDK 範例](examples/openai-client.py)使用當次隔離服務的 IPv4 loopback，停用環境代理與自動重試。真實 OpenAI SDK 與本機 API 的測試範圍另列於驗收報告。
