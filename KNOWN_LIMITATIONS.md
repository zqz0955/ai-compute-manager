# RC2 驗收邊界（2026-11-26）

2026-11-26 的 NX Legacy bounded CPU 單次實機回條為 `NX_LEGACY_BOUNDED_CPU_ACCEPT_LIMITED`，一次生成、零重試、4.969 秒。受限 slice 的採樣最大值為 708,984,832 bytes，精確峰值保持 `null`。原 R1 精確峰值資格仍獨立。最新狀態見[資格矩陣](docs/QUALIFICATION-MATRIX.md)。

- Windows P2 已在同一台 Windows 主機以兩個不同的非提升標準帳號驗證，Owner 10/10、Peer 5/5。涵蓋嚴格祖先防護、安裝、監控、更新、還原、回滾及跨帳號隔離。測試帳號與設定檔已清理；其他主機配置仍需驗收。本次重新封裝的安裝 TAR 已同步這項資格，不再沿用舊版 P2 HOLD 文件。
- Windows 本機 CPU、RAM、磁碟為可選實際採樣。Windows GPU、溫度、交換空間及模型缺少可信來源時顯示 UNKNOWN。
- V0.6／V0.7 的簽章投影與資料接收已做隔離驗收。本輪另核對正式唯讀來源的 Windows 程序、固定 588 檔與 loopback 入口，再用 V1 簽章介面接收真實 A／NX 資料。此資格工具的觀測器與 V1 控制器在同一可信操作程序內；它不等於 V1 獨立標準帳號、命名管道及正式部署已通過。正式歷史工作庫、憑證及 SSH 資料不是 V1 的直接讀取來源。
- Orin NX 現行 5.15.148-tegra 核心的三個有效 memory cgroup 缺少 `memory.peak`，而 `memory.current`、`memory.max`、`memory.events` 可讀。原精確模式 H1 停在該能力檢查，沒有消耗 R1 單次請求。Legacy bounded CPU 另有已審契約與一次性實機回條。
- 真實設備遙測的 ONLINE 與有效零值不是執行資格。現有觀測節點保留 UNVERIFIED，不會自動成為可派送節點。真實資源預留、佇列、優先級與多節點推論尚待個別資格及整合驗收。
- 原 RC2 的 INTERRUPTED／EVIDENCE_UNAVAILABLE 工作保留 HOLD，原因與請求是否抵達引擎仍為 UNKNOWN。RC2-R3 的新離線 ARM64 工作分別取得零生成、非串流與 SSE 回條，只核准這兩次單次測試。
- R1 真實引擎容量與早期 NX 假引擎證據依各自原版本與環境適用。它們不提供 RC2 持續派送權限。
- RC2-R3 實測收到兩個有 provisional 標記的真實 SSE 片段。正式用量、完成事件在 R1 與產品兩次持久提交後一併驗收。實機 SSE 與持續派送另行准入。
- GitHub Actions 隔離工作流與可重現封包可供審查。公開託管執行、授權與發布由權利人批准。無 npm 依賴也須單獨核對 Node、外部工具及資產。
- H3 有專用非 root Worker 和 root 回復權威隔離候選，以及獨立零生成 SSH 入口。Windows／NX 的原生設備、SSH、角色與時序資格保持獨立。RESTORED 核對引擎回收，外層簽署角色的收割由受信監督器在回覆前完成及保全。真實生成仍由入口硬拒絕。
- [CPU-first 發布提案](docs/CPU-FIRST-RELEASE.md)仍待批准。[Tegra GPU 研究](docs/TEGRA-GPU-ISOLATION.md)與 CPU 准入各自審查。
- H4 已核對 NX 磁碟上的 GPU backend 摘要與 ELF 直接相依。資產閉包、實際載入／offload、統一記憶體分配歸屬、可強制硬限額及可信回收未合格。離線前檢固定拒絕派送及解鎖。
- H5 產品 Controller 已支援多個各自簽章合格的隔離 CPU Worker。Windows H3 啟動器現行採單 Worker，兩設備資格與生產多 Worker 啟動入口仍待驗。H6 遷移、回滾與手動啟動均在隔離根演練，正式切換待批准。
- 現有手動啟動腳本使用 PATH 尋找 Node；正式切換前須核對固定執行檔，不得把它視為已具 V0.6 受保護啟動器的內嵌 SHA 保證。部署／遷移／回滾方案見 [PRODUCTION-CUTOVER.md](docs/PRODUCTION-CUTOVER.md)，跨主機與 GPU 需求分別見 [CROSS-HOST-ADMISSION.md](docs/CROSS-HOST-ADMISSION.md) 與 [GPU-ADMISSION.md](docs/GPU-ADMISSION.md)。
- 全域 CLEANUP 為 HOLD。正式 CPU/GPU、LAN、公網、正式部署及自動啟動各有門檻。整體仍為 `ACM_V1_0_RC2_SOFTWARE_READY_HARDWARE_PENDING`，不是 `ACM_V1_0_RELEASE_READY`。
