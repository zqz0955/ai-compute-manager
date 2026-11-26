# Jetson Orin NX GPU 隔離與回收評估

H3 可以先走 CPU-only 准入。H4 維持 `HOLD_GPU_HARD_LIMIT_UNPROVEN`。Jetson NX 的 CUDA 相容性與歷史 offload 證據支持繼續評估 GPU，但目前缺少同一次 attempt 的分配前硬限額、完整資源歸屬和回收證據。本次評估使用已保存的證據及版本對應的原廠文件。平台與工件盤點沿用 [H4 准入文件](GPU-ADMISSION.md)。

## 個別觀測值的證據範圍

| 來源 | 可以證明 | 仍待取得 |
| --- | --- | --- |
| JetPack 6.2／L4T 36.4.3，CUDA 12.6 | NVIDIA 說明 Tegra iGPU 的 device、pinned host 與 managed/unified buffers 共用 SoC DRAM。各類緩衝的存取、快取與生命週期依類別而異。現有 Ollama GPU 函式庫的磁碟摘要與 ELF 相依性支持相容性盤點 | 當次 boot 與執行世代實際載入的 driver、backend 和 runner；該組合的 allocation／accounting 覆蓋。[NVIDIA CUDA for Tegra 12.6](https://docs.nvidia.com/cuda/archive/12.6.0/cuda-for-tegra-appnote/index.html) |
| Linux 5.15 cgroup v2 | `memory.max` 限制該 cgroup 的已記帳記憶體，核心允許部分情況暫時超限。共享區域可能由其他 cgroup 記帳。`memory.high` 用於節流與 reclaim。裝置 BPF 依裝置類型、major/minor 和存取類型控制裝置檔 | GPU 驅動是否對每種 allocation 在正確的 cgroup 記帳，以及 GPU 專用位元組上限。裝置拒絕需另查繼承或傳入的 FD。NX CPU 許可的 `sampledPeakBytes` 只適用其既有契約，`peakBytes` 維持 `null`。[Linux 5.15 cgroup v2](https://docs.kernel.org/5.15/admin-guide/cgroup-v2.html) |
| `tegrastats`、Ollama 日誌及 `/api/ps` | `GR3D_FREQ` 是取樣期間 GPU 活動比例，`EMC` 和 RAM 是全機觀測。Ollama offload 和 `size_vram` 屬引擎回報 | 把 GPU 實際執行及分配綁定指定 runner 和 attempt。活動歸零、主機 RAM 回升及清單為空各自只作旁證。[Jetson Linux 36.4.3 Tegrastats](https://docs.nvidia.com/jetson/archives/r36.4.3/DeveloperGuide/AT/JetsonLinuxDevelopmentTools/TegrastatsUtility.html) |
| 裝置 FD、DRM `fdinfo`、DMA-BUF 統計 | 已核對的 FD 可以證明程序持有指定裝置或 buffer 的參照。新版上游 DRM 規格具有選用的 `drm-client-id`、共享及 resident 欄位。Linux 5.15 的 DMA-BUF sysfs 介面在啟用相應核心配置時可觀測 buffer inode、exporter 與大小。DMA-BUF 也可由多個 importer 使用 | 先證明當次 Tegra 驅動確實提供相應介面。統計只涵蓋該介面所暴露的物件。複製的 FD 和共享 backing 需要去重，`fdinfo` 的可見範圍也有盲點。僅核對 runner 的 FD 不能核銷所有 driver allocation、附著、mapping 或跨程序引用。[Linux DRM client statistics](https://docs.kernel.org/gpu/drm-usage-stats.html) · [Linux 5.15 DMA-BUF statistics](https://docs.kernel.org/5.15/driver-api/dma-buf.html#dma-buf-statistics) |
| CUDA context、記憶體池與跨程序共享 | 在支援的 CUDA runtime 中，pool 的 `UsedMemCurrent` 與 `ReservedMemCurrent` 分別量測應用使用及 backing 保留。`cudaDeviceReset()` 不會代替對非同步 pool allocation 的明確釋放。Tegra 12.6 不支援舊式記憶體共享 IPC，仍有 EGLStream、NvSci 及 shareable memory handle API | 核對當次後端用到的 pool、VMM、pinned／registered host memory、匯入、匯出及其實際存續。需要同一世代的 context／allocation 完成證據。公開 API 說明不足以認定目標核心與後端具備完整可用計數。[CUDA 12.6 pool API](https://docs.nvidia.com/cuda/archive/12.6.0/cuda-runtime-api/group__CUDART__MEMORY__POOLS.html) · [CUDA 12.6 device management](https://docs.nvidia.com/cuda/archive/12.6.0/cuda-runtime-api/group__CUDART__DEVICE.html) · [CUDA for Tegra 12.6](https://docs.nvidia.com/cuda/archive/12.6.0/cuda-for-tegra-appnote/index.html) |

## 硬限額與部署選項

CUDA 12.6 的 Tegra 文件明列 MPS 不支援。NVIDIA MIG 支援表包含指定的資料中心及工作站 GPU，也明列 Thor iGPU，表上沒有 Orin。新版 Linux 與 NVIDIA 某些發行組合的 `dmem`／MPS 限制依實際驅動及裝置實作，不能作為目前 Jetson Linux 5.15 的資格證據。[CUDA for Tegra 12.6](https://docs.nvidia.com/cuda/archive/12.6.0/cuda-for-tegra-appnote/index.html) · [MIG supported GPUs](https://docs.nvidia.com/datacenter/tesla/mig-user-guide/latest/supported-gpus.html) · [NVIDIA per-GPU limits](https://docs.nvidia.com/dynamo/many-model-serving/per-gpu-compute-and-memory-limits-with-mps)

CUDA 12.6 的 `cudaMemPoolProps.maxSize` 可限制特定 pool。`cudaMemPoolAttrReleaseThreshold` 控制 pool 何時嘗試歸還 backing。這兩個設定各自只作用於設定的 pool。對固定 Ollama 後端而言，能否納管其他 pool、直接分配、host pinning 及匯入仍須逐項驗證。[CUDA 12.6 pool properties](https://docs.nvidia.com/cuda/archive/12.6.0/cuda-runtime-api/structcudaMemPoolProps.html) · [CUDA 12.6 pool API](https://docs.nvidia.com/cuda/archive/12.6.0/cuda-runtime-api/group__CUDART__MEMORY__POOLS.html)

| 選項 | 可取得的隔離與驗收條件 | 取捨 |
| --- | --- | --- |
| 現有 NX，H3 CPU-only | 沿用 `LEGACY_KERNEL_BOUNDED_CPU_V1`，檢查 CPU backend、裝置開啟拒絕及無繼承的 GPU／相機 FD。維持原 CPU 配額與主機復原守門 | 可持續推進 H3。已通過的一次 CPU 真實推論和 H3 跨主機 API／Worker 各有自己的資格。GPU 派送維持停用 |
| 現有 NX，共用 iGPU | 需有獨立於 Ollama 的分配前執行機制，把硬限額綁定同一 attempt 和 GPU 世代。對 device、managed、pinned／registered host、pool、VMM、圖形或 DMA 匯入及其他能接觸相同裝置的入口，逐一證明納管或隔離 | 風險包括共享 DRAM 壓力、旁路、未記帳分配及桌面／相機互擾。`CUDA_VISIBLE_DEVICES`、裝置 ACL、只攔截部分 CUDA API、`memory.max` 或輪詢合用仍缺完整硬限額證明。守門缺口維持 HOLD |
| 獨占測試主機與整顆 iGPU | 另行取得專用設備及空窗，驗證該設備無其他 GPU 租戶且主機監測、停止與回復可用 | 降低服務互擾，仍共享 SoC DRAM，故障可影響整台主機。獨占主機不能直接滿足現有的每次 attempt 硬限額。若要採用整機風險契約，須另行審查，且不得為此停用現有 NX 桌面或服務 |
| 專用離散 GPU 或正式支援的硬體分區 | 在另行合格的主機使用專用卡，或以固定容量的 MIG GPU Instance 分配記憶體與運算資源。證明實際裝置／instance 身分、一次只允許指定 Worker、分區硬限額與超限拒絕。替 CPU 側 host／pinned memory 設獨立的限額和監測 | 有獨立顯示記憶體或正式分區約束，仍需核對 root／設備管理者邊界、driver 版本、健康與回收證據。等同整顆卡的預算需要符合硬體容量及隔離政策。若政策要求小於整卡的硬限額，專卡仍需分區或其他合格的執行機制。[NVIDIA MIG architecture](https://docs.nvidia.com/datacenter/tesla/mig-user-guide/latest/introduction.html) |

近期選擇 CPU-first。若確定需要 GPU，優先評估有明確容量隔離與受支援觀測介面的專用設備。現有 NX 的 GPU 路徑只有在固定 JetPack／driver／backend 明確具備上述完整執行機制及回收權威後，才值得申請實機生成。

## 零生成前檢及一次可審查的回收

1. **線下先固定契約。** 固定 boot／裝置世代格式、runtime／backend／model 摘要、裝置存取清單與硬限額來源，並明確記錄哪些 allocator 路徑要拒絕。寫定超限、監測中斷、FD 漂移與主機復原失敗都維持 HOLD。H4 現有工具只核對保存證據。
2. **取得另行批准後，先測零生成隔離。** 使用獨立 test Worker、runner、UID／GID、cgroup 與私有連線域，核對 FD 開啟、繼承及傳入拒絕。從獨立觀測端拿到實際配置、可歸屬計數、原生超限拒絕及停用後的資源證據。現有桌面、相機和 Ollama 維持運作。任何身分不明或無法解釋的共享資源應停止資格流程。
3. **硬限額合格後另行申請一次 GPU 生成。** 在同一次 attempt 的單調時序內比對固定 runner 身分、GPU 裝置和後端日誌，結合能歸屬該 context 的 kernel 執行證據與非零 offload。模型或 CUDA context 的配置失敗、CPU fallback、監測缺口、超限及失聯均不取得 GPU 通過或自動重試資格。
4. **分開記錄終態和回收。** 核對引擎終態和 runner 身分，停止新接受、卸載模型、收割 Worker／runner，確認私有 socket 與葉 cgroup 已清空。驗證 GPU context、allocation、pool backing 與共享／匯入參照的同世代終值，並確認桌面、相機、既有 Ollama 與主機拓撲符合當次基準。自然閒置和計數減少可當輔助檢查。若終值仍含無法歸屬的資源，保留原 attempt 的持久鎖。
5. **最後才提交。** 在回收與主機復原都確認後，由獨立觀測者對同一 attempt、節點、GPU／partition 識別、世代及新 challenge 出具簽章證據。依序提交 Worker 段與產品持久鎖，再產生終端 API 成功裁決。逾時、斷線或終態不明時保留原證據與鎖，不自動轉派。

目前所有 GPU 派送與解鎖仍由原有守門拒絕。實機測試、另行資產取得及新硬體配置都留待獨立授權。
