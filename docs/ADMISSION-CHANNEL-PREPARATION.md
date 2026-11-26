# 並行接續通道準備

本文件整理不依賴 NX 真實生成的 H2、H3、GPU 下一階段。它是本輪設計交付，沒有修改正式服務、ACL、SSH、帳號或核心，也沒有啟動跨主機或 GPU 派送。既有程式重用，具體實作與實機資格仍分開。

## H2：跨 SID 正式唯讀遙測

本輪前已驗的真實資料來源是管理端在同一程序內核對 V0.6，再透過 V1 簽章遙測介面接入。下一步只需將信任邊界搬到既有角色，沿用 [H2 信任鏈](H2-LIVE-TELEMETRY.md)：

1. 管理觀測端保留原 V0.6 程序世代、588 檔與原生 TCP owner 核對，只呼叫固定安全 GET；不接入有副作用的歷史路由。
2. 觀測端透過具名且 ACL 固定的 Windows named pipe 交付已投影框架，不能讓 API Runner 讀正式程式、SQLite、備份或 SSH 私鑰。API 執行端沿用專用標準 SID，不以 Administrator 代替。
3. 可信管理端在啟動前固定兩個入口、依賴閉包及 runtime。管道握手以原生 server/client PID、SID、建立時間、管道 ACL 與新 challenge 綁定，不只比對管道名稱。固定數量／大小／期限，拒絕任意 URL／path／命令。
4. 框架包含來源世代、節點、原採樣時間及完整簽章；API 每次仍驗原時間與持久序號。源程序退出／重啟、pipe 斷線或觀測逾時立即停止發佈有效資料。重連先重新取得完整世代資格，不把舊數值重新封裝成新鮮。
5. 在隔離工作區以兩個實際標準 SID 核對未授權 pipe client、來源換檔、相同內容替換、錯 PID／建立時間、超長框架與失聯；再按另次許可接入正式唯讀來源。沿用歷史 P2／V0.7 證據，但不重建已清理測試帳號或假設它們直接涵蓋 V1 整合。

需要的額外批准僅限新的受保護 V1 通道與其精確帳號／ACL／入口；不可為簡化管道而放寬正式 V0.6 資料權限。公開 API 繼續只綁 loopback，沒有模型派送權。

## H3：跨主機可信入口與權威回收

沿用 [跨主機契約](CROSS-HOST-ADMISSION.md) 及既有 Controller／durable store／upstream 簽章格式。新增模式必須由 ADMISSION、Worker identity、終態、resource proof 與 RESTORED 全鏈明確綁定，不可把 legacy 收據灌入舊 R1 精確驗證器。

最小可落地的傳輸是固定 Worker 協定 frame 的雙向管道，Windows API 仍只監聽本機；受信管理 SSH 只進入受保護的白名單入口。入口只接受固定 readiness、accept-once、query、controlled-cancel、normal-stop 操作與固定模式，禁止任意 shell、path、URL、模型、配額。現有四個唯讀 SSH 命令的金鑰不具此能力，不能重用或擴權。

| 角色 | 可以簽什麼 | 不可以做什麼 |
|---|---|---|
| 發行權威 | 短效 ADMISSION、固定節點／模型／模式／release／窗口／transport | 不替 Worker 製造執行收據 |
| Worker | ACCEPTED/RUNNING/TERMINAL、對應序號與單次 attempt | 不簽自身 host-restored 解除許可 |
| 主機觀測權威 | 單元／程序收割、完整 cgroup 監測與主機回復的 RESTORED | 不以簽章本身替代實際回收觀測 |
| Windows Controller | 本地持久意圖、工作與資源鎖、最後 API 提交 | 不因斷線、查無工作或重新啟動重送未知 attempt |

傳輸層禁止 execute 自動重試；query 可重複但不會啟動工作。任何 frame 須保留原簽章位元組、domain、nonce、序號、大小限制與時間條件。Windows 已提交但 NX 尚未接收時，查無紀錄仍為 UNKNOWN；只有先前已設計的可信未接收證據契約才可能關閉該 attempt。

合法解除順序不變：單次可信終態與新鮮資源證據 → Worker／runner／engine 全收割 → 單元／cgroup 清空 → 主機恢復 → 上游持久鎖原子 RELEASED → Controller 核對分離權威 → 產品工作／鎖原子完成 → 正式 HTTP/SSE 終態。非正式 SSE 片段保留 provisional，不提早送成功用量。

H3 需先有一個合格 CPU 模式的 NX 原生實證，再固定跨主機入口與短效資格；JSON、SSE 各使用新的獨立窗口、資料庫與 attempt。H1 的一次性資格及 legacy 的單次回條都不能直接變成持續生產權限。

## GPU：記帳及限制方案

沿用 [GPU-ADMISSION.md](GPU-ADMISSION.md)，本輪不新增 GPU 執行入口。Legacy CPU 模式不能延伸至 GPU，因為 CPU cgroup 記帳沒有證明涵蓋全部 Tegra 驅動／統一記憶體配置。

優先完成的離線工程切點為：

- 建立能力記錄，將 CPU bounded、CPU exact、GPU accounting 分為不同資格；GPU 未驗時不可藉 CPU 簽章、ONLINE 或 models:run Token 選入。
- 以固定驅動／backend 配置設計程序與裝置持有清單，區分模型 runner、桌面共享裝置與相機；不得把負載 0%、空駐留或某個 PID 退出當成完整資源回收。
- 對程序 private memory、file cache、DMA／統一記憶體與裝置配置建立覆蓋表；無法觀測或限制的類型明確標缺口。不得將 CPU memory.max 或 sampledPeak 宣稱為 GPU 硬限額。
- 以合成資源證據驗證錯模式、缺欄位、舊 epoch、未知裝置 holder、回收不足及過期 resource proof 皆拒絕；這只能取得合約反例資格。
- 直到 GPU runtime／完整資產 SHA、實際 offload、可驗證硬限制、共享桌面隔離及可信回收具備證據後，才提出一份專項實機窗口。不能為取得隔離而停止桌面或正式 Ollama。

目前 H2 跨 SID 部署、H3 遠端入口及 GPU 原生記帳均未因本設計文件完成而通過。全域 CLEANUP、正式推論、V1 部署、LAN／公網與 GitHub 公開發布維持原守門。
