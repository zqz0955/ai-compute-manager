# Legacy 資源證據與可信終態格式

本文件說明固定實作的證據鏈，不授予NX或公開API執行權。新的模式識別為 `LEGACY_KERNEL_BOUNDED_CPU_V1`。原R1的19欄精確證據格式維持原樣。

## 四層綁定

1. 產品ADMISSION明列 `memoryMode`；可信啟動端另傳 `expectedMemoryMode` 才接受該資格。省略opt-in的舊呼叫不能接收legacy欄位。model必CPU、context512、maxTokens16。整份claim的pin包含mode，TERMINAL/CLEARED/RESTORED均綁此pin及同attempt。
2. R1上游的簽章domain為 `ACM_LEGACY_KERNEL_BOUNDED_CPU_V1`，資料庫tag為 `ACM_LEGACY_KERNEL_BOUNDED_CPU_DB_V1`。identity/release/epoch/attempt/model/實體與公鑰均參與身分核對；原精確模式簽章與庫不能重放到這個模式。
3. 引擎終態在原19欄之外增加 `memoryMode` 與 `memoryEvidence`，總21欄。`peakBytes` 必為null，`sampledPeakBytes`是觀測下界。成功仍需HTTP/生成有效、CPU/context實際runner、新鮮空駐留、乾淨收割、空cgroup與零禁止事件。
4. 外層受信父程序核對單元消失及主機拓撲復原後，發行綁定整份R1證據摘要的host-restored許可；先提交R1 RELEASED，再由產品資格鏈提交產品鎖及API成功。Worker自述reclaimed不夠，事件失敗不能用最後空群組補正。

## memoryEvidence（23欄）

| 欄位 | 語意 |
|---|---|
| mode | 固定LEGACY_KERNEL_BOUNDED_CPU_V1 |
| retentionKind / schemaRevision | 固定TRANSIENT_SLICE_HIERARCHICAL_V1／2；拒絕先前三群組草稿 |
| metricSource | 固定CGROUP_V2_CURRENT_AND_EVENTS_NO_PEAK |
| peakBytes | 必為null，不能填樣本最大值 |
| sampledPeakBytes | whole slice的current實際樣本最大值，必為正且不超過high |
| sampleCount | 完整終態至少2筆；開始前允許1筆建立監測 |
| firstSampleMs / lastSampleMs | 單調時鐘的首末觀測時間 |
| maxGapMs / maxReadDurationMs | 完整採樣的最大間距／讀取耗時；各不超過1000ms |
| scopeSha256 / limitsSha256 | 四組物件識別與固定限制的SHA |
| samplesSha256 / membersSha256 | 完整raw樣本鏈與成員鏈的SHA |
| groups | 固定四組path、dev/ino、localAvailable，保持順序 |
| zeroEvents / swapBytes | 成功需true／0，並另保存實值事件資料 |
| healthy / complete | 成功需true／true；監測停止或異常永遠不能恢復健康 |
| eventsBaseline / eventsFinal / eventsDelta | 各四組path/memory{high,max,oom,oom_kill}/local或null/pidsMax；本版本只接受新空群組的全零基準與全零增量 |

實作只對固定空測試群組採全零事件基準；不是允許復用舊非零群組再減掉歷史。可用local消失、計數重置、quota或物件漂移均拒絕。精確schema與型別檢查由 `src/worker/r1/legacy-memory.mjs` 維護。

## 原始觀測與傳輸

每筆raw包含monotonicMs、readDurationMs、四組groups、peakBytes:null及metricSource。每組保存path、dev/ino、actual limits、current、swap、memory.events、local或null、pids.events及PID/startTick/UID/GID/cgroup成員。native reader核對群組集合、成員所屬與身分；契約monitor鎖定scope並拒絕異常及觀測間隙。

原始樣本最多8MiB，只有可信父程序持有。成功時以受限gzip分塊透過既有私有PIPE交付，父程序核對token、invocation、順序、解壓上限並重算樣本鏈後記入私有回條。失敗保留觸發樣本與可取得的現況；缺少診斷不會使HOLD變PASS。這些含PID與設備身分的私有資料不能直接放進公開原始碼。

## 當前執行範圍

隔離ARM64工具的路徑及身分鎖定QEMU測試執行域。該模式的memory.max/high由獨立父slice覆蓋整棵樹，包括service內可信controller、guard、Ollama與runner；固定四層觀測為slice/service/controller/engine，子群組指定繼承max；外層API、R1工作庫／簽章Worker物件及回復權威仍在同一管理Node程序。這輪不是獨立非rootWorker跨主機程序的完整生命週期證明，也不限制管理主機整體記憶體。

NX專用發布入口必須另外固定硬體／系統判定、實際NX路徑、非rootWorker身分、whole-workload邊界及保護清理規則，通過相應隔離驗證後才可執行。[待批准RUNBOOK](LEGACY-NX-RUNBOOK.md)不把目前QEMU-only入口當成該資格。

## Controller 尾段的外層核對（revision 2）

早期草稿假設RemainAfterExit保留service cgroup，但native02原生反證為ENOENT，整輪0生成HOLD；該草稿不再用於准入。新版以獨立transient父slice保留whole-job記帳域，service正常collect後父slice仍須存在，才能由外層讀末段。

父slice是唯一1.5GiB max／1.375GiB high／Swap0／64tasks／單核硬限制域，service、controller、engine子群組明確繼承max。拒絕memory_localevents掛載，確保父memory.events包含子群組事件；PIDs硬限制只設父層，避免晚期子限額事件隨子群組GC消失。local各層仍保留供交叉核對。

可信外層父程序從單元身分成立起，每100ms讀slice current、events/local、limits、swap、pids及物件身分，最大完整觀測間距仍是1000ms。此時序與內層4group觀測重疊並持續至最終tail；不是把inner最後樣本到exit的空窗放寬。外monitor失效、事件、限額／scope漂移皆中止工作並HOLD。

每個外層frame與最終tail另含readDurationMs，從掛載檢查前至所有欄位及物件再核完成後計時；首次讀取同樣須不超過1000ms。outerEvidence.maxReadDurationMs必須由原始frames重算，不能以讀完後的新時間戳掩蓋慢讀。舊草稿沒有這個欄位，不能直接當作修補後的原生驗收證據。

service/controller退出及cgroup收割後，tail必須同slice dev/ino、空procs、populated0、無子群組、零禁止事件及原限制。tail含outerEvidence原始frames與摘要鏈，validator重算所有frame、固定限制與事件、時段重疊及最後覆蓋，不能只信healthy/complete布林。最後才正常stop已固定slice並確認移除及主機拓撲復原。tail SHA參與topologySha256，進入host-restored許可和R1 RELEASED權威綁定。

內層engineEvidence的sampledPeakBytes與外層outerEvidence.sampledPeakBytes分別標明覆蓋時段，最終資源報告可另列兩者最大值作全程採樣下界；兩者都不是核心峰值。父slice保留與末段核對仍須本輪原生回條支持，不能只依systemd屬性宣告通過。

## 驗收工具的工作觀測

Legacy隔離驗收只對既有POST /acm/v1/jobs提交一次，收到202及固定jobId後以GET讀取同一工作，直到可信終態提交或工具觀測期限到達。它不重送生成，也不把202當成運算成功；必須看到SUCCEEDED、cleanup.confirmed及相符的輸出/用量，並另外核對R1與產品提交。這是非同步管理工作API的證據，不宣稱本模式已通過OpenAI同步completion或SSE。

工具在開始後130秒內才可發起新輪詢，已發出的單次GET最多5秒；這是涵蓋原120秒Controller上限及收尾的工具觀測範圍，不是引擎配額。Ollama生成期限仍是90秒，整體執行上限120秒，產品HTTP預設且最大90秒等待完全未改。先前同步驗收在啟動加生成尚未達90秒時先遇HTTP等待期限，其原attempt保持HOLD，不能以新工具重送該attempt或回填成功。
