# 環境與相容性矩陣

| 路徑 | 要求 | 證據 |
|---|---|---|
| Windows x64 控制器、真實本機量測 | Node 24.22.3、IPv4 loopback、本機 NTFS | 隔離 Windows 安裝、啟停、升級、回復與 CPU／RAM／磁碟採樣通過。Windows 安裝驗收使用提升權限的隔離工作區 |
| Windows 標準帳號及多使用者 | 完整祖先 DACL、不可替換的程式及資料路徑 | PASS_NATIVE。兩個不同、非提升的標準 SID 完成 Owner 10/10、Peer 5/5。涵蓋嚴格祖先、安裝／升級／回滾、junction／替換拒絕及跨帳號讀取、寫入把手與重新命名拒絕。此證據限已測主機 |
| Linux ARM64 控制器 | Node v24.22.3、私有 Unix 權限、一般 UID、WAL | 無網路 Ubuntu 24.04 ARM64 VM 實測安裝、IPv4 loopback、升級及回復 |
| Linux ARM64 唯讀 Agent | Node v24.22.3 或支援的 v22 安全修補版、一般 UID、可信程式祖先 | 隔離 Agent 的採樣、續號、停止及退役可獨立驗收。各 runtime 回條隨獨立審查包提供 |
| V0.6／V0.7 觀測轉接 | 既有唯讀來源與簽章發行者、固定節點及範圍 | 格式、簽章、來源漂移及重播的隔離測試通過。正式程序和通道身分需要原生接入資格 |
| Windows／Orin Nano／Orin NX 合成調度 | 合成 CPU/GPU 能力、資源鎖與持久化工作意圖 | PASS_SIMULATION |
| 已結案 NX ARM64 假引擎 | 原 V0.8 獨立驗收 | 既有 PASS_REAL_HARDWARE，限原假引擎 |
| R1 ARM64 CPU-only Ollama | qwen2.5:0.5b-instruct-q4_K_M、Ollama 0.40.16、2 GiB、單核心 | 既有 PASS_ISOLATED_REAL_ENGINE，限 R1 與 ARM64 QEMU |
| RC2-R3 API 接真實引擎 | 短效隔離資格與已核對世代、簽章終態 | PASS_ISOLATED_REAL_ENGINE。離線 ARM64 完成各一次 JSON 與 SSE，核對 R1／產品提交順序及資源回收。原 RC2 的 INTERRUPTED／EVIDENCE_UNAVAILABLE 仍 HOLD，原因 UNKNOWN，不重送 |
| NX 原 R1 精確峰值 CPU | 固定 R1、現場窗口、精確峰值及主機復原 | HOLD_KERNEL_MEMORY_PEAK_ABSENT，原單次資格保留 |
| NX Legacy bounded CPU | 獨立批准的 1.5 GiB／1.375 GiB high、單核、受限 slice 事件證據 | NX_LEGACY_BOUNDED_CPU_ACCEPT_LIMITED。一次生成 4.969 秒，先上游鎖後產品提交。精確峰值 `null` |
| V1 API 跨主機 JSON／SSE | 獨立操作窗口、傳輸、角色與一次性資格 | CPU 能力前置已取得，跨主機實機權威鏈尚未驗收 |
| 真實 GPU、遠端接入、跨節點單模型 | 各自獨立驗收 | BLOCKED |

R1 冷載入和暖載入的原始峰值分別是 1,194,840,064 和 1,192,833,024 bytes，耗時 75.699 和 73.252 秒。這些數值取自固定容量回條。實際 NX 仍須核對可用記憶體、memory.peak 及受限單元計量。

後續順序見[設備操作驗收計畫](HARDWARE-RUNBOOK.md)。現有合成模型工作只在獨立試用模式執行。全域 CLEANUP、遠端接入、真實推論及正式部署各自保留門檻。

GPU 專項的固定資產、裝置權限、統一記憶體記帳和特權入口仍待資格。詳見 [GPU 准入](GPU-ADMISSION.md)。正式切換、舊服務與帳號退役依 [部署及回滾方案](PRODUCTION-CUTOVER.md)，不能在仍依賴舊觀測通道時提前刪除舊版。
