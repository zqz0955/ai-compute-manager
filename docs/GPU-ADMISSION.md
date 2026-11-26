# H4 Jetson Orin NX GPU 專項准入

目前裁決 `HOLD_GPU_HARD_LIMIT_UNPROVEN`。固定版本的離線前檢已可執行。GPU 執行、回收權威及可承認的 GPU 位元組硬限額尚未取得資格。本輪完成唯讀資產與平台盤點，未開 GPU 執行窗口。

## 可直接執行的離線前檢

在候選根目錄用 Node 24 執行。第一個參數是專案 `evidence` 目錄的絕對路徑。選用的第二個參數是已取得原廠封包的本機目錄。

```text
node tools/h4/preflight.mjs <evidence-absolute-directory> [existing-assets-absolute-directory]
node --test test/h4-preflight.test.mjs
```

程式以固定 SHA-256 核對八份已保存原始證據。讀取規則沿用候選的檔案身分與重新解析點防護。提供既有封包目錄時，程式另外讀取並核對兩個指定名稱的既有工件，區分缺檔與內容不符。它不下載、不解封、不建立 GPU 工作或核發放行權。完整離線報告的退出碼是 `42`（HOLD）；輸入或摘要不符的退出碼是 `1`。輸出包括 `dispatchAllowed=false`、`releaseAllowed=false` 及 `gpuHardLimitBytes=null`。依賴方不可將報告完整或原廠雜湊核對轉譯為派送、清理或解鎖授權。

## 相容性與固定工件

| 範圍 | 已核對內容 | 仍待取得 |
| --- | --- | --- |
| 裝置唯讀盤點 | NX 為 AArch64、JetPack 6.2+b77、L4T 36.4.3、5.15.148-tegra、CUDA toolkit 12.6.11、cuDNN 9.3.0.75 | 執行前重新固定開機世代、裝置識別、讀取時序與實際被載入的 CUDA driver |
| 現役磁碟工件 | 磁碟 Ollama binary SHA `645f7c676bac5d81332c43e5ef9d3acd792bc4391404582301c3f29eaf06c3ee`。JetPack6 目錄中的 `libggml-cuda.so` 為 AArch64 普通檔，221,040,320 bytes，SHA `07e4d5a134c70b2b367146708bfc71c473498fce11e0937c2092d107ed867729`。ELF 直接依賴包含 `libggml-base.so.0`、`libcudart.so.12`、`libcublas.so.12`、`libcuda.so.1` | 現役 PID 的 executable 與 mappings 未查驗。現役服務的磁碟檔不取得實驗執行授權。獨立區的完整相依閉包、loader 解析及實際映射仍待核對 |
| 歷史 GPU | 11 月 12 日固定 v0.40.13 JetPack6、CUDA driver 12.6、SM 8.7、`qwen3.5:2b-q4_K_M`、context 2,048，runner 25／25 layers offload，同 digest 的駐留回報 1,599,602,686 bytes | 歷史 GPU 回條限該版本與工作。其 `size_vram` 本身沒有證明硬限額或所有記憶體歸屬 |
| H4 模型候選 | 重用 CPU 驗收的 `qwen2.5:0.5b-instruct-q4_K_M`，manifest SHA `a8b0c51577010a279d933d14c2a8ab4b268079d44c5c8830c0a93900f1827c67`，五個 blob 描述共 397,821,319 bytes，無 projector | 這個模型與下列固定 GPU 工件組合尚未載入或生成。CPU 採樣峰值只屬 CPU 執行群組 |

NVIDIA JetPack 6.2 的 L4T 36.4.3、kernel 5.15 與 CUDA 12.6 發行組合和唯讀盤點相符。Ollama v0.40.16 的安裝腳本將 R36 的 JetPack6 封包作為額外工件，與 ARM64 基底封包配對。這份原廠選擇規則支持離線相容性規劃。下階段使用隔離 staging，現役服務與依賴庫維持原狀。[NVIDIA JetPack 6.2](https://developer.nvidia.com/embedded/jetpack-sdk-62) · [Ollama v0.40.16 安裝原始碼](https://raw.githubusercontent.com/ollama/ollama/v0.40.16/scripts/install.sh)

| 固定 v0.40.16 工件 | 原廠 SHA-256 |
| --- | --- |
| `ollama-linux-arm64.tar.zst` | `e45b8e6dcb86cb9f3057396351655079c9a4879b4ced2678c9350d375dcbc224` |
| `ollama-linux-arm64-jetpack6.tar.zst` | `6e10ad60bd6f78acc432536c86170b4f3b1ba904c339b9317d9bbc028e0901a4` |

原廠 ZIP/TAR 公告摘要可供日後核對。本機既有基底封包 1,600,610,073 bytes 已重算 SHA 並相符，JetPack6 overlay 的本機候選尚缺，不需要從正式環境取用現役檔案。歷史 v0.40.13 的 overlay 有自己的獨立摘要 `b9641c00bd111229949f6db18d2d6d345ca39dd132a6d1974f6f38f55e9ccde8`。[Ollama v0.40.16 release assets](https://github.com/ollama/ollama/releases/expanded_assets/v0.40.16) · [Ollama v0.40.13 release assets](https://github.com/ollama/ollama/releases/expanded_assets/v0.40.13)

## GPU 硬限額及隔離的不可替代證據

- Tegra 的 iGPU device、pinned host 與 managed/unified 記憶體共用系統 DRAM。CUDA 12.6 的 Tegra 功能限制也明列 MPS 不支援。Orin 未出現在 NVIDIA MIG 支援表。一般 cgroup `memory.max` 對該 cgroup 的記帳範圍設上限，部分情況可短暫超出。current、peak、gpu use、mem availability 與後端的 `size_vram` 用來交叉觀測。[NVIDIA CUDA 12.6 for Tegra](https://docs.nvidia.com/cuda/archive/12.6.0/cuda-for-tegra-appnote/index.html) · [NVIDIA MIG 支援表](https://docs.nvidia.com/datacenter/tesla/mig-user-guide/latest/supported-gpus.html) · [Linux 5.15 cgroup v2 記帳](https://docs.kernel.org/5.15/admin-guide/cgroup-v2.html)
- 裝置管制需要執行前比對 character device 的 major、minor、inode、mount、mode、作用域與持有程序。可見的 31 個裝置節點只作盤點，須另核對最小的 GPU 允許清單與實際裝置 FD。Worker、engine、runner 用本次專有身分與 cgroup，network namespace 只暴露私有 loopback。維持相機、顯示管理、偵錯、排程控制、正式 Ollama socket 與模型根的裝置／路徑拒絕。桌面所持 GPU FD 於前後比對。未能說明的 FD、共享 handle 或不受控程序須拒絕。
- GPU 上限需對同一次 attempt 和一個不可轉移的程序／群組生效，在分配之前拒絕超限，並證明所有會走的 device allocation、managed、pin/register、mempool、VMM、DMA 或共享記憶體匯入都被納入或明確隔離拒絕。需要上限值、覆蓋清單、可重播的拒絕證據，以及獨立觀測者的前後記帳。不能把 CPU cgroup 配額、GPU 選擇參數或關閉程序時的使用率當成已成立的 GPU 上限。
- `GR3D_FREQ` 表示取樣期間 GPU 活動比例。`EMC` 表示記憶體頻寬活動，RAM 是全機值。零利用率和 RAM 回升只作輔證。H1 在目前核心的非根 cgroup 無 `memory.peak`，CPU bounded 特例沒有授權 GPU 代用採樣。[NVIDIA L4T 36.4.3 Tegrastats](https://docs.nvidia.com/jetson/archives/r36.4.3/DeveloperGuide/AT/JetsonLinuxDevelopmentTools/TegrastatsUtility.html)

## 具名操作順序

1. **線下盤點與封包驗證**。以本章離線前檢固定平台和資產。夠用的原廠 overlay、完整檔案閉包與已審查的載入規則才納入獨立文件，縮小到唯一模型與 backend。基底已存在時只核驗原檔。
2. **零生成原生資格**。需要管理方給新的 NX 明確範圍後，以受保護唯讀入口確認 executable 的真實 inode、mount、digest、pid start tick，保存 runner 此次的允許裝置與實際 FD。驗證 GPU allocation guard、隔離、保護與收尾反例須使用另行審查的固定入口。若硬限額或者歸屬無法確認，停止這一步，維持 HOLD。此文件與目前的 CLI 不發行開工或清場權。
3. **一次生成的候選規格**。待上一步通過另行開窗，最長 30 分鐘，派送前至少剩 300 秒。採 context 512、最多 16 tokens、90 秒、單請求、零重試、2 GiB RAM 候選上限、至少 256 MiB 已計帳 RAM 餘裕、主機 MemAvailable 至少 6 GiB、單核等效、64 tasks、Swap 0。GPU cap 需由新證據固定。禁止靜默換到 CPU 或擴大任何限額。遇到缺欄位、失聯、counter 變動、未知 holder、overlimit、OOM、節流或 prior mount/服務異常，維持 HOLD。
4. **可信終態、回收及提交**。比對唯一 attempt 的模型 digest、runtime／backend 摘要、runner PID/start tick、GPU 所屬裝置與實際載入日誌，確認非零 offload layers 並取得同世代的模型 residency 查核。卸載後核對同引擎世代的空駐留、程序退出回條、裝置 FD 及驅動 allocation/context 歸復，葉群組與 namespace/socket 清空，原服務與六 mount 基線恢復。獨立主機觀測者在上述成立後簽回相同 attempt 與新 challenge；先提交 GPU 段持久鎖，再提交產品段與正式 API 結果。溫度、活動率或未經驗證的 `reclaimed=true` 保持輔證地位。
5. **精確復原**。只正常停止本次具名且 verified identity 的程序。保留 audit、一次性記錄與任何未清理狀態。清理須以實物身分、持有者與完整清單核對，未知內容留存。不可改根 cgroup、停止桌面、相機、正式 Ollama 或重啟來取得成功證據。

現有 Worker 和公開設定維持這個拒絕邊界。CPU 管理者簽章轉成 GPU claim 仍不符合既有入口要求。離線 H4 前檢沒有路徑可呼叫服務、替換設定、執行 CUDA 或釋放鎖。H4 執行入口、GPU 硬限額與回收權威各自維持 HOLD，直到取得獨立實機資格。
