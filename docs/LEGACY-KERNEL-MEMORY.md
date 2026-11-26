# Legacy Linux 核心的有界 CPU 記憶體契約

`LEGACY_KERNEL_BOUNDED_CPU_V1` 是獨立候選模式。原 R1 精確峰值模式保留其原數值、欄位、驗證器及一次性資格。沒有因找不到 `memory.peak` 而自動切換模式；新模式需要另外固定發布清單、簽章資格與操作窗口。本輪只有隔離工程與離線客體驗收許可，沒有 NX 推論或系統變更許可。

## 固定候選與契約比較

| 項目 | 原 R1 精確峰值模式 | LEGACY_KERNEL_BOUNDED_CPU_V1 |
|---|---|---|
| 記憶體上限 | memory.max 2 GiB；精確峰值不超過 1.75 GiB | memory.max 1,610,612,736 bytes（1.5 GiB） |
| 預警／節流 | 原契約原樣保留 | memory.high 1,476,395,008 bytes（1.375 GiB）；high 事件亦為拒絕條件 |
| 峰值 | 必須有同群組核心 memory.peak | peakBytes 必須為 null，峰值資格為 UNKNOWN |
| 採樣最大值 | 與核心峰值分開 | sampledPeakBytes 只表示實際讀取樣本的最大值，是全程峰值的下界 |
| 成功依據 | 精確峰值、原事件／回收及主機復原條件 | 固定 whole-workload cgroup 限制、連續監測證據、零禁止事件增量，以及可信終態／完整回收／主機復原 |
| 失敗後 | HOLD，不重送 | HOLD，不因 current 回落、重啟或事件歸零而重新取得資格 |

其餘固定條件為指定 `qwen2.5:0.5b-instruct-q4_K_M`、Ollama 0.40.16、CPU-only、`cpu.max=100000 100000`、`pids.max=64`、`memory.swap.max=0`、context 512、最多 16 tokens、90 秒、單一生成、零重試。主機 MemAvailable 至少 6 GiB。1.5 GiB 是本模式的核心限制設定，不是本工具量得的精確最大用量；high 與 max 相差 128 MiB，也不是已證明可涵蓋所有核心超額配置的保證。

## Linux 5.15 的直接證據與限制

以下是上游 v5.15 原始碼研究，不是 Tegra 實機等價證明。來源固定於 tag `v5.15`，2026-11-25 取得原始位元組並以 SHA-256 記錄，原始碼行號及必要片段另留私有研究回條。

| 來源 | SHA-256 | 用途 |
|---|---|---|
| [cgroup-v2.rst](https://raw.githubusercontent.com/torvalds/linux/v5.15/Documentation/admin-guide/cgroup-v2.rst) | 5d38d9c3418e7f3db9199669a616a68f9028701a9fae6bca5974ef647249fa23 | current、high、max、事件、swap 及記憶體歸屬語意 |
| [mm/memcontrol.c](https://raw.githubusercontent.com/torvalds/linux/v5.15/mm/memcontrol.c) | 66fd03b48d055a1b245a32b348fb9372001a1434f5549a5dec4bd5444f387b91 | charge 失敗後的強制記帳路徑與 high reclaim |
| [include/linux/memcontrol.h](https://raw.githubusercontent.com/torvalds/linux/v5.15/include/linux/memcontrol.h) | 182271fa50fcef9ba5ddf5f4661fd90be397f0ca7f584a114817f52138221453 | local 與階層事件累計方式 |

`memory.high` 透過節流與 reclaim 施壓，並非不可跨越的硬界線。`memory.max` 是 cgroup 最終限制，但上游文件本身保留暫時超額的情況。v5.15 `try_charge_memcg()` 的原子配置、退出／OOM victim、`PF_MEMALLOC`、fatal signal、OOM 無法前進及 `__GFP_NOFAIL` 路徑可進入強制 charge；其中部分發生在 `MEMCG_MAX` 累計之前。這直接限制了可作出的結論：**零 high/max/oom/oom_kill 增量加上離散 current 樣本，不能證明所有瞬間都未超過 max，也不能換算精確峰值。**[配置路徑](https://github.com/torvalds/linux/blob/v5.15/mm/memcontrol.c#L2524-L2665)

`memory.events` 通常包含子群組，但 cgroup2 的 `memory_localevents` 掛載選項會改變此行為；`memory.events.local` 只代表當層。監測必須逐一核對允許的群組及可用 local 計數，不只讀取一個假定為完整彙總的檔案。事件檔的值是累計計數，不是連續電流式量測；通知會合併，仍須讀完整計數、比較基準與單調性。[事件累計原始碼](https://github.com/torvalds/linux/blob/v5.15/include/linux/memcontrol.h#L1067-L1091)

記憶體在建立配置時歸屬特定 cgroup，遷移 PID 不會遷移已記帳頁面。因此引擎開始前先分群，並觀測整個受限 service（含 controller、guard、engine、runner），不可只把單一 runner 的 RSS 相加。由外層預熱的檔案快取、核心未涵蓋的配置、驅動統一記憶體及執行緒在兩次採樣間的短暫生命週期仍是盲點。此模式只准 CPU-only，不授予 GPU 記帳資格。[記憶體歸屬](https://github.com/torvalds/linux/blob/v5.15/Documentation/admin-guide/cgroup-v2.rst#L1531-L1555)

## 可信觀測與拒絕條件

1. 受信管理父程序固定 slice/service invocation、cgroup2 mount、父slice及允許子群組的 dev/inode。每次完整觀測重新核對物件身分、quota 文字值及 group 集合，拒絕未核准的新子群組。不能接受 API 傳入任意 cgroup 路徑。
2. 觀測整個 workload；群組中每個 PID 都保存啟動 tick、UID/GID 與實際 cgroup 歸屬。先綁定子程序再放行引擎，之後的 runner 子程序必須留在相同受控樹。相機、GPU、主機 Ollama socket、正式模型庫及繼承 FD 的原隔離條件不變。
3. 工作開始前建立 current／events／可用 local／swap／pids 的基準。採樣目標間距為 100 ms、允許最大完整採樣間距為 1000 ms；使用單調時鐘，保留原始間距、最大間距及樣本數。這是中斷偵測門檻，不是即時停止保證。完整樣本讀取失敗、超時、時間倒退、計數倒退或缺失一律使監測 latch 為失敗。
4. 在每個完整樣本核對 max/high/swap/pids/cpu 實際設定，current 與 sampledPeak 分開累計。`high`、`max`、`oom`、`oom_kill`、PIDs 限額命中或 swap 使用出現禁止變化，以及身分或限制漂移，一律停止本次工作並保留 HOLD。事件曾發生後，即使之後 current 下降，也不能以正常結束補正。
5. 受限 service 內的 controller 觀測四層；slice外可信父程序另連續監看slice並核對 controller／Worker 的存活與退出、單元完整收割及主機拓撲。controller 自身 OOM、失聯或程序異常不能產生有效成功證據。正常停止只處理本次綁定的程序；未知程序不強制終止。
6. 正常過程須持續監測到卸載、runner／engine 收割及空群組確認。外層父程序核對單元釋放、主機恢復及證據連續性後，才發行 host-restored 許可；R1 持久鎖先原子 RELEASED，再由產品控制器核對後完成產品鎖與 API 成功提交。

監測失效時安全停止是一個 fail-closed 結果：正常停止請求若無法完成，就保留 HOLD 與管理者介入條件。不能宣稱已經卸載或只因等待期限結束就解除鎖。

## 證據與模式綁定

發布清單、資格簽章、upstream identity／epoch、終態、資源觀測及 host-restored 許可均須綁定 `LEGACY_KERNEL_BOUNDED_CPU_V1`。舊 R1 收據不能在此模式解除鎖，新模式的 null peak 也不能被舊精確峰值驗證器接受。實作的精確欄位以 `src/worker/r1/legacy-memory.mjs` 與其測試為準，不另外維護一份放寬的 JSON 驗證器。

最少保存：模式、固定限制、原始 cgroup 物件識別摘要、完整程序歸屬檢查、起訖時間、樣本數、最大採樣間距、各事件基準與增量、local 可用狀態、swap 與 PIDs、監測終態、`peakBytes:null`、`sampledPeakBytes`、證據摘要，以及既有 job／attempt／實體／模型／release／engine generation／nonce 綁定。這些觀測是新風險契約的證據，不是對未知精確峰值的填值。

## 核心相容性矩陣

| 環境 | 核心能力與證據 | 本輪資格 |
|---|---|---|
| 上游 Linux v5.15 原始碼 | current/max/high/events/local/swap 語意及 force charge 路徑已查核 | PASS_STATIC_SOURCE；不是執行驗收 |
| 既有離線 ARM64 QEMU 客體 | 核心、systemd、實際 limits／事件與程序觀測由本輪回條固定 | 依本輪原生回條裁決；不得改標為 Tegra 5.15 |
| 缺 peak 的契約反例 | 以明確模式及 null peak 驗證缺 peak 語意、故障與反重放 | 依本輪定向測試裁決；不是核心配置路徑實測 |
| Orin NX 5.15.148-tegra | 2026-11-26 完成單次 bounded CPU，精確 `peakBytes=null` | NX_LEGACY_BOUNDED_CPU_ACCEPT_LIMITED，其他實機窗口各自准入 |
| 原 R1 精確模式 | 精確 peak 與原上限保持 | 原資格獨立保留，不自動改為 legacy |
| GPU／Tegra 統一記憶體 | 尚未證明完整 charge 覆蓋 | BLOCKED_GPU |

如果原生隔離客體有 `memory.peak`，可以明確讓 legacy 模式不消費該值來測試新契約，但必須寫成「在該核心驗證 bounded mode」，不能稱為 Linux 5.15 缺 peak 的原生執行。主機核心頁面配置與 Tegra 驅動差異保留 UNVERIFIED。

## 剩餘風險及准入結論

即使隔離正常推論與所有故障案例通過，此模式仍有核心強制 charge、離散觀測間隙、監測調度延遲、記憶體 charge 歸屬與 Tegra 差異的剩餘風險。管理方須針對這些具體差異批准一次性 NX 風險契約，不能把原 R1「精確最大 1.75 GiB」條件默默換成新模式成功。

`LEGACY_KERNEL_BOUNDED_CPU_READY_FOR_ADMISSION` 只能在實作、隔離真實模型回條、故障拒絕及獨立審查均具備足夠證據後提出。它是供批准的候選狀態；NX 實機、全域 CLEANUP、持續推論、正式部署與公開發布各自保留守門。

新版明確證據欄位及controller退出後的外層末段核對見 [LEGACY-EVIDENCE-FORMAT.md](LEGACY-EVIDENCE-FORMAT.md)。新mode只有受信啟動端顯式opt-in才接受產品資格；所有末段證據仍需在原生隔離回條支持，不能由原R1模式推定。

### 隔離宿主門檻的範圍

本輪重用的QEMU客體配置3GiB RAM，只驗受限單元1.5GiB max／1.375GiB high的新引擎契約；不能達成或宣稱驗過NX主機MemAvailable≥6GiB。該6GiB條件仍是未來NX新入口在現場必須重新檢查的硬性前檢。離線客體無網路後端，不能把其空工作環境視為NX桌面／相機工作空窗證據。

新版保留域為revision2：獨立transient slice持有唯一硬配額，三個子群組只能使用指定繼承設定。memoryEvidence必含retentionKind與schemaRevision，舊三群組草稿不被接受；正常service退出不再依賴已被原生反證的RemainAfterExit保留假設。外層監測與末段schema見證據格式文件。這是隔離候選內的契約修正，不是NX已批准版本。
