# Orin NX 單次 bounded CPU 驗收

這份操作書對應 `LEGACY_KERNEL_BOUNDED_CPU_V1` 的實際 NX 專用入口。部署 TAR 及逐檔清單由審查包另行固定。使用本機驗收回條判定入口資格，並由設備管理方批准當次操作。原 R1 精確峰值模式及其一次性機會獨立保留。

## 固定對象

| 項目 | 核准時固定的內容 |
|---|---|
| 系統 | Orin NX ARM64、L4T 36.4.3、5.15.148-tegra、systemd 249、glibc 2.35。用既有可信 SSH 核對主機金鑰與 machine-id SHA |
| 來源 | 部署 TAR SHA、files.json SHA、nx-entry.py SHA、固定候選 Git；逐檔簽核方式為操作者在可信管理終端傳入核准 SHA |
| 目錄 | staging `/opt/acm-nx-legacy-cpu-stage-v1`、installed `/opt/acm-nx-legacy-cpu-v1`、audit `/opt/acm-nx-legacy-cpu-audit-v1` |
| 身分 | root 管理父程序監測及核發回復許可；65201 簽章 Worker；65202 Ollama／runner。使用固定數字 UID/GID，前檢查 NSS 與執行中程序衝突，沒有建立帳號 |
| unit | `acmlegacycpu.slice` 與 `acm-rc2-engine-readiness.service`。沿用既有證據 schema 內的單元名稱 |
| 資產 | Node ARM64 24.22.3、Ollama 0.40.16 CPU backend、qwen2.5:0.5b-instruct-q4_K_M；模型五個 blobs 共 397,821,319 bytes |
| 配額 | 父 slice CPU 單核心等效、memory.max 1610612736、memory.high 1476395008、Swap 0、Tasks 64；service、controller、engine 使用固定繼承值 |
| 請求 | 非同步 POST 工作一次、GET 相同工作，Context 512、最多 16 tokens、生成 90 秒、零重試 |
| 窗口 | 最長 1800 秒、派送前至少剩餘 300 秒、NX MemAvailable 至少 6 GiB、工作空窗成立 |

記帳範圍是父 slice 及其執行子群組。Python 主機觀測器、外層 HTTP 控制器與非 root 簽章 Worker 位於外層，簽章 Worker 不載入模型並有獨立的 mount、network、IPC。它與主機核發回復許可的程序不同。引擎及 runner 降至 65202 後才執行。root-only 的 release 不交給這兩個 UID。

## 操作前與本機材料

1. 核對審查包的部署 TAR、入口與資產摘要，對照本機固定來源。此來源只接受指定設備與版本。當次 SSH 的主機 key、boot、來源、目錄與 UID/GID 須重新核對。
2. 由管理方確認設備可在本次窗口短暫接受父層 CPU controller 啟用，並接受非 PSI 監測、已審桌面 FD 例外、force-charge 及既有 charge 歸屬盲點。套件本身沒有批准檔。
3. 運用一次原生 sudo 認證。只在可信終端輸入密碼。無須修改 sudoers、系統單元或全域設定，結束以 `sudo -k` 清除該工作階段快取。
4. 在本次允許的 staging 步驟中，先把已核對 TAR 置於 root 控制、不可由其他帳號修改或重新命名的暫放位置。在同一管理工作階段重新核對 SHA，並只在固定 staging 路徑排他建立 root:root 0700 目錄後解開。不可在已存在的 staging 或資料路徑覆寫。TAR 僅含 manifest 及已核對的一般檔案。父目錄 root:root 且不可由其他帳號寫入、不得透過符號連結、額外 ACL 或額外掛載。暫放媒體在管理方核對完原物件後移除。
5. `files.json` 和受保護的 entry 必須符合本機獨立審查的 SHA。確認 Python 由 `/usr/bin/python3 -I -B` 啟動。下列指令只在設備准入及操作窗口獲得集中批准後執行。

只在集中批准的操作中執行接下來的 staging 命令。先核對管理端輸出的 `TAR_SHA`、`MANIFEST_SHA`、`ENTRY_SHA`，並令 `ARCHIVE` 指向已受 root 保護的 TAR。保持工作目錄在固定測試樹之外。逐步核對退出碼及摘要，任一不符就停在 HOLD。

```bash
sudo -v
sudo sha256sum -- "$ARCHIVE"
sudo mkdir -m 0700 -- /opt/acm-nx-legacy-cpu-stage-v1
sudo tar --extract --file "$ARCHIVE" --directory /opt/acm-nx-legacy-cpu-stage-v1 \
  --numeric-owner --same-owner --same-permissions --keep-old-files
sudo sha256sum -- /opt/acm-nx-legacy-cpu-stage-v1/files.json \
  /opt/acm-nx-legacy-cpu-stage-v1/code/tools/nx-legacy/nx-entry.py
```

`snapshot`、`install` 及 `qualify-once` 各有獨立的 13 筆採樣，請預留約三分鐘及雜湊檢查時間。派送前仍須有至少 300 秒。按同一工作階段的有效 sudo 快取進行，窗口及權限到期就停在原守門。

## 取得新鮮桌面投影與綁定政策

從固定 staging 執行以下讀取入口。使用前先核對實際 entry SHA；參數為審查包內的 `MANIFEST_SHA` 與可信 SSH 已確認的 `HOST_FINGERPRINT`。

```bash
sudo /usr/bin/python3 -I -B /opt/acm-nx-legacy-cpu-stage-v1/code/tools/nx-legacy/nx-entry.py snapshot "$MANIFEST_SHA" "$HOST_FINGERPRINT"
```

13 筆進度各自輸出。保存唯一的 `ACM_NX_LEGACY_DESKTOP_UNAPPROVED` JSON，保持 approval 為 null。若桌面角色、PID／start tick、24 個 FD、設備身分或同一 session 無法核對，維持 HOLD。同步保存 MemAvailable、固定裝置與服務、根 cgroup 及六個已接受 mount 的狀態。快照的作用是準備資料，完成快照不消耗原 R1 機會，也不等於工作窗口核准。

在管理端本機準備四份 JSON。

- `desktop.json` 是上方輸出的完整未批准投影。
- `device.json` 包含 `hostKeyFingerprint`、`machineSha256`、`boot`，取自同次可信通道。
- `files.json` 是原 TAR 中的固定清單。
- `approval.json` 包含管理方可追溯的 `ref`、`managerConsent`、`workWindowConfirmed`、`purpose`、`notBefore`、`expires`、`acceptForceCharge`、`acceptNonPSI`、`acceptParentCPUDelegation`。時間為整數 Unix 秒；`purpose=LEGACY_KERNEL_BOUNDED_CPU_V1`。管理方實際同意後才填布林值。

使用 `python -I -B tools/nx-legacy/bind-release.py desktop.json approval.json files.json device.json release.json` 產生新的政策及 SHA。由可信管理端核對 SHA，把政策以 root:root 0400 排他寫入固定 staging 的 `release.json`。套件與這份政策分開固定，避免自我雜湊。保存原始批准回條及 exact policy SHA。

## 安裝、單次執行及回復

令 `POLICY_SHA` 為上一步的 SHA，與固定 manifest 同時傳入。已過期、缺現場工作空窗、檔案或設備身分漂移時，停在前檢。

```bash
sudo /usr/bin/python3 -I -B /opt/acm-nx-legacy-cpu-stage-v1/code/tools/nx-legacy/nx-entry.py install "$MANIFEST_SHA" "$POLICY_SHA"
sudo /usr/bin/python3 -I -B /opt/acm-nx-legacy-cpu-v1/code/tools/nx-legacy/nx-entry.py qualify-once "$MANIFEST_SHA" "$POLICY_SHA"
```

安裝與啟動各重新核對前檢。啟動記錄完整安裝身分、主機及服務基準、此次操作識別與持久 once-marker；此 marker 不因失敗或清理重設。固定動態 loopback 工作 HTTP 由管理程序自行發出一次，後續均為同 job GET。

父 slice 建立後只允許同一 operation 的固定 service。完整內外採樣間距及完整單次讀取各不得超過 1000 ms。內層 group 及外層同一 slice 核對 memory.max／high／current、禁止事件、Swap、Tasks、CPU 及物件身分。派送前引擎須經固定私有 pipe 握手，外層核對 invocation、監測、批准窗口，內層重新核對 6 GiB 與至少 300 秒。主機觀測父程序或心跳消失要求停止，最後由 unit 時限兜底。未取得可信終態均保留 HOLD。

`peakBytes=null`。採樣最大值獨立記錄，無法觀測兩樣本間暫態超額。模型卸載、程序退出及 service 消失後，核對原父 slice 仍存在、空樹、無事件，再正常停止 slice 並確認根控制器／兄弟群組／既有服務回復。外層管理父程序核發本次 host-restored 許可，R1 持久提交先於產品成功及 API 終態。六個既有 mount 的接受基準仍只限 18452／0 tasks／0 hits。

如需中止，以同一核對版本及操作身分執行固定停止入口。

```bash
sudo /usr/bin/python3 -I -B /opt/acm-nx-legacy-cpu-v1/code/tools/nx-legacy/nx-entry.py stop "$MANIFEST_SHA" "$POLICY_SHA"
```

停止會持久記錄取消，並核對已認領 unit、slice、管理程序身分與無角色殘留。若啟停失敗、主機回復不符、超限、未知 PID 或證據缺失，保留已消耗 marker、資料庫與檔案。部分安裝、失敗執行或未知物件只保全其 install intent 與現場，後續另外盤點及批准精確回復。避免把另一批候選裝進既有目錄。

只在同次成功與主機復原均有回條後清理。先退出固定測試樹，避免自己的終端工作目錄成為持有者。

```bash
sudo /usr/bin/python3 -I -B /opt/acm-nx-legacy-cpu-v1/code/tools/nx-legacy/nx-entry.py cleanup "$MANIFEST_SHA" "$POLICY_SHA"
sudo -k
```

清理先驗證回執、來源目錄、mount ID、inode、檔案 SHA、模式、硬連結與持有程序，寫入清理意圖，再逐檔及逐層處理並同步父目錄。AUDIT、once-marker、SQLite、見證、原始監測與失敗保留。成功最多提出 `NX_LEGACY_BOUNDED_CPU_ACCEPT_LIMITED`。全域 CLEANUP、正式推論、部署與 GitHub 公開發布各依原守門。
