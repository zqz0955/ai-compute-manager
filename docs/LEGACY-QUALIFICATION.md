# Legacy Kernel Memory 候選驗收範圍

**2026-11-26 補充**：Orin NX 已取得 `NX_LEGACY_BOUNDED_CPU_ACCEPT_LIMITED`。受限 slice 的樣本最大值為 708,984,832 bytes、精確峰值 `null`。4.969 秒、單請求、零重試、R1 先釋放、產品後提交、主機復原和精確清理均有受核對回條。舊 R1 精確峰值及其他實機模式維持各自的獨立資格。下列內容保留本次操作前的隔離準備範圍及歷史缺口，最新狀態以[資格矩陣](QUALIFICATION-MATRIX.md)為準。

本輪新增獨立 LEGACY_KERNEL_BOUNDED_CPU_V1；沒有修改 NX、核心、JetPack、CUDA、正式服務或原 R1 單次資格。原 R1 的精確峰值門檻仍然要求 memory.peak，不會自動轉入新模式。

## 已取得的隔離證據

| 項目 | 結果 | 可作出的主張 |
|---|---|---|
| 受影響 Node 回歸 | 47/47，0 skip | 新契約、簽章隔離、持久 HOLD、事件/身分/限額拒絕、取樣/讀取期限、單次 API 工作與既有受影響守門通過 |
| ARM64 真實引擎 | Ubuntu 24.04、Linux 6.8.0-147-generic、systemd 255、無網路後端 | 是真實 ARM64 Ollama binary 與指定模型；不是 Tegra 5.15 原生資格 |
| 固定資產 | Ollama 0.40.16、指定模型 manifest、5 blobs 共397821319 bytes；逐檔核對 | 沒有新增模型或改用其他 runtime；公開封包不附權重或大型 runtime |
| 新模式正常請求 | 1 request、82,254 ms、34 input / 3 output tokens | 90秒生成、context512、CPU-only、單核整樹配額下通過；零重試 |
| 記憶體 | 718內層與769外層樣本；sampledPeakBytes=695836672、peakBytes=null | 前者僅為採樣下界，不是精確核心峰值，也不是整台主機的最大用量 |
| 監測期限 | 內層最大間距445.230ms／最慢讀取283.888ms；外層727.920ms／34.400ms | 當次所有完整取樣與讀取均在1000ms門檻內，不能推定其他主機的排程延遲 |
| 記帳域 | 四組物件、全部實際配額、零high/max/oom/oom_kill與PIDs事件、Swap0 | 整個受限slice與指定子群組核對；模型頁面/檔案快取的charge歸屬盲點仍保留 |
| 末段與提交 | 服務消失後保留同一父slice、末段空樹、正常移除slice與拓撲回復 | host-restored後R1先提交RELEASED，再提交產品RELEASE與成功工作；不是靠Worker自述reclaimed |
| 四庫冷副本投影 | integrity全部通過、FK0；產品SUCCEEDED且無鎖；R1保留RELEASED紀錄 | 從已關閉的隔離庫另製核對副本，未開正式庫，也未在原測試庫上執行額外SQLite連線 |
| 故障拒絕 | 原生high/max/OOM計數、gap、quota漂移、monitor stop、受控程序崩潰 | 原生事件與程序收割有回條；持久鎖拒絕與兩次重開由簽章反例測試驗證。不能合稱所有故障都曾作用於同一個真實模型工作 |

新模式使用既有非同步工作API提交一次後讀同一工作，並未重驗OpenAI同步completion或SSE。後兩者只保留原R3在原模式的證據。

## 保留的首次失敗

四次零生成工具/原生前檢HOLD完整保存：壓力工具逾時、RemainAfterExit未保留cgroup、無效CPUQuota解除語法、敗方計時器保活。改以獨立retained slice與原生繼承配額，不延長生成或監測門檻。

第一個真模型attempt因同步HTTP等待包含啟動而先到期，隨後亦觀察到外層取樣gap超限；沒有可信終態。該工作持續HOLD，原overlay、回條與審查不覆寫、不重送。後來成功的是修補後新來源與新的獨立attempt，不能回填原工作成功。本輪共兩個不同的隔離真模型attempt，沒有NX生成。

大型監測JSON被客體日誌按固定長度分段；原始serial保留。收集器只移除固定logger前綴並按順序重組，另記原始片段位置，重算內層樣本/成員鏈與外層完整frame鏈後驗證。解析成功本身不是PASS。

## NX 新入口定向驗收

已交付獨立 `tools/nx-legacy/nx-entry.py`、政策綁定與受保護 staging TAR。Linux 6.8 ARM64 離線客體已驗 106 檔、父層實際 limits、子層繼承、固定 stdin 放行、非 root Worker 三個名稱空間、見證、程序收割及逐檔清理。該次客體零生成，主機回復讀值使用受控測試資料，且沒有執行 NX 專用 CLI 的整段 `qualify-once`。原 01、02 兩個 HOLD 及第三輪原生序列保留。

管理端唯讀查核取得 NX ARM64、Tegra 5.15.148、systemd 249、glibc 2.35、有效的記憶體／Tasks 記帳介面及當下的可用記憶體。原生 CPU 委派、末段記帳與本次工作空窗依實際操作重新驗證。

## 仍未取得的資格

1. Linux5.15只有固定上游原始碼研究；可用客體是6.8。NX/Tegra的核心配置路徑、systemd249、桌面裝置與實際記帳仍須新資格，沒有以舊NX假引擎證據補稱。
2. 新版入口已固定安裝、啟動、停止與清理。實際 NX 整段派送、獨立主機核可與復原回條仍待單次驗收。原 QEMU 工具的環境守門保留。
3. 客體3GiB不驗證NX主機MemAvailable至少6GiB，亦未重驗實際桌面FD與工作空窗；這些保留為實機硬性前檢。
4. native06 的簽章 Worker、API 與回收權威位於管理程序。新版 NX 入口新增獨立的 UID 65201 Worker 與 root 回復觀測器，待 NX 整段驗收。H3 跨主機資格另行核定。
5. memory.max不是對所有瞬間實體用量的絕對上界。強制charge、檔案快取既有charge、觀測間隔、監測排程與Tegra驅動差異必須由管理方明確接受。詳見 [安全契約](LEGACY-KERNEL-MEMORY.md)。

[NX RUNBOOK](LEGACY-NX-RUNBOOK.md)對應已固定的實際入口與單次操作方案。執行需要當次批准、管理員唯讀前檢與新窗口。全域CLEANUP HOLD、正式推論/部署/公開發布BLOCKED；H2跨SID、H3與GPU準備見 [並行方案](ADMISSION-CHANNEL-PREPARATION.md)。
