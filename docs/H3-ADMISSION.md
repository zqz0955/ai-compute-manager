# H3 Windows Controller 與 Orin NX Worker 准入

[零生成 RUNBOOK](H3-ZERO-GENERATION-RUNBOOK.md)已提供獨立入口及受限 SSH 套件。以下為生成候選的兩個獨立窗口。現行固定來源有硬性生成 HOLD，Windows serve、NX install 與 qualify-once 均會拒絕。零生成合格之後，仍須把當次實機證據納入可核對的生成准入版本，再由設備管理方分別批准兩個窗口。

## 權威與執行角色

- Windows Controller 驗證 ADMISSION、Worker 公鑰、短效窗口及設備身分。在派送前記錄 intent、實體別名與資源鎖。每個資格固定唯一模型、實體、工作庫和執行世代。
- NX Worker 通訊簽署角色固定獨立非 root UID／GID 65203。可信父程序核對 NSS、程序碰撞、降權、namespace、能力與實際檔案描述元。Worker 降權後只從唯讀 FD 取得自身金鑰，載入後關閉。IPC 只為當次已驗證的 Controller 請求依序封裝 READY、DELTA、TERMINAL、CLEARED。Worker 不得讀取 restoration 私鑰、受保護稽核或 R1 工作庫。
- root 復原權威核對由原 Legacy 執行域寫入的 intent、終態、R1 持久 RELEASED、觀測者所簽的主機復原回條及當次 challenge。R1 保持原有受限 Worker／engine UID 與 cgroup。Windows 驗證終態與復原兩份簽章，包含 nonce、attemptId、模型、實體設備及已簽署的傳輸綁定。程序失聯、時序超限、簽章或復原證據缺失均保留原鎖。
- RESTORED 證明 R1 Worker／engine 完成回復。H3 通訊簽署角色取得該證明後才簽 CLEARED。監督器等到該角色正常退出並保全回條後，才送出最後一次回覆。外層角色的收割證據由可信監督器保全，RESTORED 本身圈定 R1 回復。原生資格須收集這兩類證據。
- root 監督器、Linux 核心、受控 OpenSSH 與 Windows 信任基礎屬於 TCB。受損 root 可以讀取或置換受保護資源，必須以主機事件處理。各角色的權限分隔針對非 root Worker。

## 生成窗口共同前檢

1. 固定本輪 READY 原生回條、兩端應用與 OpenSSH 快照、獨立復原權威的角色及管理方式。原生反例須涵蓋專用非 root Worker 無法讀取復原私鑰、R1 工作庫及稽核，任意命令與轉送被拒絕。固定各自的 host key、Client 公鑰、應用簽章、公鑰對應、角色 UID/GID、release manifest、boot 與實體摘要。
2. 各窗口重新取得最長 30 分鐘的操作批准、CPU/桌面工作空窗與持鎖核對。派送前至少保留 300 秒。驗證跨主機牆鐘、往返及原本 700 ms 證據守門，使用 [Legacy NX RUNBOOK](LEGACY-NX-RUNBOOK.md) 的具名主機基準及回收契約。原本 Legacy CPU 單次實機回條供前置能力查核，保留已耗用狀態。
3. 固定已合格 Legacy bounded CPU 模型與 Ollama 版本，CPU-only、單核心等效、RAM 1.5 GiB、memory.high 1.375 GiB、Swap 0、Tasks 64、Context 512、最多 16 tokens、90 秒生成期限。單請求、零重試。精確峰值為 null，採樣最大值與終態證據分開核對。
4. 每次使用新的 SQLite 工作庫、單次資格、operation、nonce 與 attemptId。Windows API 僅監聽隔離 IPv4 loopback。具名 Token 只含 models:run，固定測試文字與配額。候選僅接受 /v1/completions，錯 JSON／SSE profile 在入庫前拒絕。

## 獨立實機方案

| 順序 | 具名入口與隔離 | 成功證據 |
|---|---|---|
| A. NX CPU 非串流 | legacy-json 固定 NX 路徑、獨立 loopback HTTP、stream=false、一次資格 | 僅單一派送及 HTTP 終態，驗證 R1 釋放先於產品提交、可信簽章、收割、主機復原及一次性稽核 |
| B. NX CPU SSE | A 撤場核對後另行批准。legacy-sse 固定 NX 路徑、全新資料庫／窗口、stream=true | DELTA 為暫定資料，只有雙權威終態與產品持久提交完成才接受 [DONE]。若串流中斷，查原 job 資料並保留原鎖，零重試 |

JSON 與 SSE 分開使用 /opt/acm-nx-h3-json-stage-v1、/opt/acm-nx-h3-json-v1、/opt/acm-nx-h3-json-audit-v1、/opt/acm-nx-h3-json-control-v1，SSE 路徑使用 sse。使用固定暫態單元及可核對的安裝入口，不使用過去 Legacy CPU 實機路徑作為 H3 改寫或清理目標。

準備期間在受保護的 Windows 工作庫使用 tools/h3/windows.mjs provision。單次資格簽發沿用 tools/h3/issue.mjs 的精確計畫核對。各端固定檔案來源及命令 SHA。正式的 H3 generation site 文件須含分離的 Controller／SSH 憑證、Worker FD 私鑰與復原私鑰配置。零生成 SSH 專用帳號或金鑰不可授權到生成端點。後續生成用專用 SSH 生效設置與零生成相同範圍逐一核對，強制各自的固定 relay 命令，驗證 FIFO／SO_PEERCRED，獨立保全原始回條。

實機允許生成前保留目前固定的 H3_NATIVE_ROLE_SEPARATION_PENDING 准入拒絕。後續受審生成版本應要求現場新鮮證據及具名操作窗口，測試回條或單一設定開關均無生成權。失敗、觀測器漂移、SSH 中斷或證據缺失時只停止已識別的本次程序，保留 SQLite、原鎖、稽核與 once-marker。精確清理先確認單元、程序及檔案身分，控制檔、專用 SSH 授權及私鑰按各窗口清冊保全或退役。
