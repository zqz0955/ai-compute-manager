# V1.0 人工部署、資料交換與回滾候選

本文件準備下一次正式批准的操作。這輪未切換正式服務、修改舊資料或退役舊帳號。既有 V0.6/V0.7 以及各次 CPU、GPU、跨主機資格各自保留；部署許可不能替代模型執行資格。

## 已有且可重用的工具

| 操作 | 既有入口及邊界 |
|---|---|
| 統一人工啟動 | Windows 與 Linux 使用 `tools/h6/operator.mjs launch` 核對 Node、來源封包、設定 SHA 與私人安裝根後，在前景啟動唯讀服務。原 `start.cmd`、`start.sh` 沿用於通用啟動 |
| 新安裝與前檢 | `tools/rc.mjs setup`、`doctor`，嚴格祖先、物件身分、私人權限及本機安裝互斥鎖 |
| 冷備份與還原 | `backup`、`restore`，核對 SHA、SQLite 結構、資料及 sidecar。SQLite 驗證只處理獨立工作副本，保留來源主檔與 sidecar |
| V1 版本升級 | `upgrade` 產生新備份和新資料根，兩個目標不得存在或互相包含；不原地覆寫來源 |
| 回滾判讀 | `rollback-check` 核對備份 lineage。`DIVERGED_KEEP_CURRENT` 表示保留兩版資料，不能用舊庫覆蓋新寫入 |
| 舊版歷史 | `tools/import-history.mjs` 只匯入固定 SHA 的欄位投影。舊工作不進入執行佇列 |
| 退役 | `uninstall` 先預覽，`--apply` 退休啟動設定，保留工作庫、稽核及備份。不是遞迴刪除工具 |

來源依據為 [安裝說明](INSTALL.md)、[安裝入口](../tools/rc.mjs)、[SQLite 副本檢查](../tools/storage.mjs)、[安裝物件綁定](../tools/manifest.mjs) 及 [歷史匯入](../tools/import-history.mjs)。Windows 標準帳號與 ARM64 的已通過驗收沿用原回條，不為本文件再次重跑。

## 安裝位置與執行身分

正式位置候選是操作人自己的 `%LOCALAPPDATA%/AIComputeManager`，下分 `releases/<release-id>`、`state/<install-id>`、`backups/<backup-id>`。這些是待批准的路徑角色，不是本輪建立的目錄。若組織需要跨帳號部署，改由管理者另外核准程式根及資料 ACL，不自動修改祖先權限。

所有祖先都需通過 `PRIVATE_ANCESTORS`。不以 `WORKSPACE_FIXTURE`、任意可寫磁碟根、junction 或其他帳號可替換的資料夾當成正式資格。使用既有、明確選定的標準帳號，不沿用已清理的 P2 測試帳號。

使用外部 SHA 核對已選 Node 執行檔與候選封包。可信操作人以該 Node 的絕對路徑啟動 H6。從受保護的全新程式位置執行，避免把待驗的來源腳本當成信任根。H6 再以實際載入的 Node 與本地程式重建封包核對。使用不含 `NODE_OPTIONS`、`NODE_PATH` 的可信前景工作階段。模式、埠及設定完整內容以獨立核對過的設定 SHA 固定，在安裝鎖內確認。

V1 預設使用 `127.0.0.1:8787`。既有 `8875`、`8897` 為產品設定的保留埠，本輪不占用。隔離演練使用 `port: 0`，實際埠由啟動回條取得。正式 API 只綁 IPv4 loopback。

## 正式切換前順序

1. 重新核對當次 H0-H7 裁決與相容性矩陣。選定要正式開放的功能集合，未合格的 CPU/GPU／跨主機功能保持停用。全域 CLEANUP 維持獨立裁決。
2. 凍結候選 Git 提交、成品與逐檔 SHA。完成 Secret Scan、SBOM 及雙語文件核對。取得操作者對精確來源、執行身分、路徑、埠及停止／回滾範圍的批准。
3. 核對舊服務 PID、建立時間、帳號、來源、工作、HOLD、終端標記、資料持有者與目前連接埠。未知寫入者或未結束工作就停在 HOLD。若需要舊庫冷備份，另取得當次正常停服許可；本輪的唯讀啟動許可不等於正式退役許可。
4. 正常停止具名舊服務後，證明 PID、監聽與資料把手已釋放，再用原服務的已核准流程建立當場同代冷備份。保存來源時間、完整 SQLite/WAL/SHM、節點設定、ACL、檔案身分、SHA 及全部歷史摘要。不得直接複製正在使用的 SQLite 主檔。
5. 用 V1 建立全新資料根。V0.6/V0.7 資料不是 V1 的 schema，不能把舊 SQLite 掛到 V1 或交給 V1 `restore`。由可信來源輸出已核准的工作／雙模型欄位投影，固定 SHA 後用 `import-history` 匯入。舊 requests/holds 僅作歷史計數，原復原責任和敏感全文仍留在舊系統，不能透過投影讓未結工作獲得派送資格。
6. 發給各客戶端新的 V1 Token，分開 `manage:read`、`models:run`、`manage:write`、`telemetry:publish`。模型 scope 本身不解除引擎資格。Token 不放入 CMD、Git、報告或公開封包，原文只交付權利人一次。
7. 由選定的標準帳號人工啟動 V1，保存 PID、SID、非提升權杖、唯一監聽者及可信來源回條。用既有遙測簽章／挑戰通道，逐節點核對實體、時間、模型、UNKNOWN 與 STALE。不要讓 API 帳號讀舊 SQLite、SSH 私鑰或正式程式。
8. 驗證 `/acm/v1/health`、節點、歷史、模型與只讀限制，核對 Dashboard。確認原歷史沒有進入派送佇列、新舊版本沒有共用 SQLite/WAL/SHM、未知工作仍 HOLD。未取得持續推論資格時，一般產品保持 `read-only`。
9. 全部通過後記錄正式版本與來源別名，保留舊程式、舊資料、同代冷備份及原手動啟動入口。新服務保留為人工前景工作階段，不建立自動啟動。

## H6 可執行操作入口

以下命令的 `node` 代表已由操作人另行核對的本機執行檔絕對路徑。先在可信環境核對 TAR 的外部 SHA，並以系統解封工具解開至同一個受保護的**新程式根**。將工作目錄切到該固定程式根後核對安全邊界與完整來源清單。所有資料、備份、投影與 TAR 參數使用本機絕對路徑，並角色分離。執行任何 stage、rollback 或 launch 前分別取得當次批准。此入口只建立唯讀安裝。

~~~text
node tools/h6/operator.mjs <node-sha256> <release.tar> <release-sha256> stage-legacy <new-install> [<projection.json> <projection-sha256>]
node tools/h6/operator.mjs <node-sha256> <release.tar> <release-sha256> stage-v1 <old-install> <new-backup> <new-install>
node tools/h6/operator.mjs <node-sha256> <release.tar> <release-sha256> rollback <original-install> <same-lineage-backup> <new-rollback-install>
node tools/h6/operator.mjs <node-sha256> <release.tar> <release-sha256> launch <install> <reviewed-config-sha256>
~~~

- `stage-legacy` 建立空白 V1 安裝，另核對指定舊版去敏歷史投影 SHA 與格式後匯入。實際舊庫與舊服務由原管理責任保留。
- `stage-v1` 後端沿用冷備份與新根還原，檢查資料庫相容及憑證退役結果。開始前應持有已正常停止同代服務的回條。新根繼承原唯讀設定，未自動啟動。
- `rollback` 在原安裝鎖內核對同一 lineage 的冷備份，使用同一份已驗證的資料向新根還原。若目前資料已分岔，回傳 `DIVERGED_KEEP_CURRENT` 及退出碼 2，保留原本及備份供差異核對。套用回滾須再人工選定完整舊版程序和資料根。
- `launch` 讀取操作人已核對的 `configSha256`，在真正的安裝鎖內重新驗證內容。接受明確指定埠及 `PRIVATE_ANCESTORS`，監聽 IPv4 loopback，執行模式為 `read-only`。確認 `ACM_LISTEN` 中的 PID、埠、模式、封包與設定摘要後才開啟前景驗收；Ctrl+C 正常停止。
- 失敗的隔離候選若已建立部分資料，留存該根與回條供後續核對。使用全新根進行任何再次批准的操作。

本輪隔離驗收使用既有工作區邊界進行跨代投影、同代冷備份、遷移、同 lineage 回滾與分岔拒絕。設定 SHA 漂移的反例在安裝鎖內拒絕，合格設定的監聽以隔離動態埠驗證。正式埠、來源部署與原帳號退役保持待批。

## V1 至 V1 的冷備份及新根演練

下列命令只可在具名 V1 服務正常停止後，用已核對的新版 Node 和程式執行。變數需由操作者填入互不重疊、未使用的絕對目錄；此處不含主機私人路徑。

~~~text
node tools/rc.mjs backup <old-install> <new-cold-backup>
node tools/rc.mjs restore <new-cold-backup> <new-install>
node tools/rc.mjs migration-check <new-install>
node tools/rc.mjs doctor <new-install>
node tools/rc.mjs rollback-check <old-install> <new-cold-backup>
~~~

`upgrade <old-install> <new-cold-backup> <new-install>` 可合併前兩步，其來源仍完整保留。還原後所有備份內 Token 被退休，需發新客戶端識別碼；不從舊備份復活撤銷憑證。備份操作會檢查隔離資料副本的 application_id、完整表欄位、關聯與持久化保護摘要，不能只看 `schema_version`。

本輪若只改資格文件，復用已核對的 Windows Owner/Peer、Linux ARM64 安裝與回滾證據。只有新的安裝或資料轉換行為才需要新的定向演練，不重跑歷史真實引擎或假引擎。

## 失敗回滾

1. 保存 V1 新資料、日誌、Token 變更及錯誤回條，不用舊庫覆寫。正常停止本輪已核對的 V1 前景程序，核對監聽者和資料把手已釋放。
2. 對 V1 同代備份執行 `rollback-check`。若資料已分岔，保留新根與舊根，記錄差異，不做原地還原。只讀試運行也可能增加遙測資料，不能假定完全沒有新寫入。
3. 恢復舊 V1 時選擇完整舊程式配舊資料，或從核對過的冷備份還原到另一新根。恢復 V0.6/V0.7 時只使用其完整舊來源、原資料和原受保護人工入口，不把 V1 庫降版或回灌。
4. 重新確認版本、唯讀模式、節點採樣與原歷史，並再次核對只有預期程序持有各自資料。遇到未知程序、來源、ACL 或資料漂移就 HOLD，不強制結束未知程序。

## 舊服務與帳號退役條件

目前不退休任何舊帳號或入口。只有 V1 的正式替代通道完成實機驗收、管理方批准停止依賴、回滾保存期與歷史資料責任明確後，才另列精確退役清單。

- 舊 Dashboard runner 和 API runner 各自核對 SID、程序、手動入口、SSH/Token/pipe 權限、資料及備份持有關係，不能以顯示名稱直接刪帳號。
- V1 若仍依賴 V0.6/V0.7 可信觀測橋接，這兩個來源服務及必要帳號仍是運作依賴，不具退役資格。
- 已核准的舊 SSH 唯讀身分不能移作推論身分。原始來源與回復證據留存，不透過解除 ACL 或搬移資料簡化遷移。
- 退役時只停止有明確批准且身分吻合的程序，撤銷各自憑證，逐項核對檔案／設定檔與依賴後處理。未知項目保留。

退役批准應包含舊版、實際服務或啟動入口、執行帳號 SID、正式資料根與保留期。先檢查回復依賴、工作及 HOLD、PID 及建立時間、監聽與資料持有者；再依具名批准正常停止。需要撤銷 Token 時使用原管理入口並保留撤銷回條。V1 的 `uninstall` 預覽與 `--apply` 僅退休啟動設定，原 Token 登錄檔與資料仍保留供稽核。帳號和其餘依賴另待逐項批准。

## 發布守門

原創程式的 Apache-2.0 是候選選項，等待權利人確認。不能替第三方 runtime 或模型重新授權。公開封包只包含乾淨原始碼、文件、去識別示意與來源清單；不包括模型權重、runtime archive、私人 IP/SID、機密 Token、完整歷史庫或本機稽核。

`tools/release.mjs` 支援來源掃描、可重現 TAR 與清單核對。`tools/sbom.mjs --check` 及 `tools/check-dependencies.mjs` 核對 SBOM 和零 npm 依賴政策。GitHub CI 使用固定 Action commit，但本地通過不能宣稱已在 GitHub 執行。公開 Repository、Push、Release、正式切換與授權定案均等待各自批准。
