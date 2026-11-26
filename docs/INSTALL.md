# 安裝、維護與回復

## 安裝前

- 下載或重用核對過的 Node v24.22.3。RC 接受同一個主版本的後續修補版，驗收版本與 SHA 另列在審查紀錄。Node 需提供內建 SQLite。
- 核對審查方獨立提供的封包 SHA。Windows 可使用 Get-FileHash，Linux 可使用 sha256sum。使用本機受保護的程式目錄，解開到新位置，再用該固定來源執行安裝。
- 使用已存在且無其他一般帳號可替換的本機父目錄。Windows 安裝器只在新目錄套用本帳號、SYSTEM 與本機 Administrators 的存取控制。Linux 以一般帳號開啟，使用私有目錄及檔案權限。
- 資料安裝位置與程式目錄分離。埠預設 8787，configuration port 設為 0 時由作業系統分配隔離埠，實際值出現在 ACM_LISTEN。只接受 IPv4 loopback。既有 8875 與 8897 為保留埠。占用 8787 時停止並檢查持有人。
- 本機操作人應使用一般使用者帳號啟動，並自行選擇帳號、驗證 PATH 與父層權限。目前既有 Windows 專用帳號不在這套通用安裝器的管理範圍。

## 手動維護

下列指令使用安裝的絕對路徑。先停止此次啟動的前景程序，確認控制視窗已結束。

~~~text
node tools/rc.mjs token issue <install> <id> <scope[,scope...]> [ttl-hours]
node tools/rc.mjs token rotate <install> <id> [ttl-hours]
node tools/rc.mjs token revoke <install> <id>
node tools/rc.mjs node list <install>
node tools/rc.mjs node enroll <install> <descriptor.json>
node tools/rc.mjs asset import <install> <file> <sha256>
node tools/rc.mjs migration-check <install>
node tools/rc.mjs upgrade <install> <new-backup-dir> <new-install-dir>
node tools/rc.mjs backup <install> <new-backup-dir>
node tools/rc.mjs restore <backup-dir> <new-install-dir>
node tools/rc.mjs rollback-check <install> <backup-dir>
node tools/rc.mjs uninstall <install>
node tools/rc.mjs uninstall <install> --apply
~~~

Windows 可用 setup --monitor-local 啟用本機採樣。Windows 使用 start.cmd，Linux 使用 sh start.sh，皆傳入安裝目錄內 config.json 的絕對路徑。憑證建立與輪替結果只在前景命令列顯示一次。憑證原文不存進設定。撤銷後不得重用識別碼。輪替保留同一個客戶端的 scope 及工作擁有者身分。憑證撤銷或輪替完成後再人工啟動。

節點註冊可傳入經核對的本機描述檔。descriptor.example.json 提供宣告格式。宣告的設備資源須取得實機資格。派送權限由另外的准入流程核對。asset import 只把使用者已取得及核對的本機資產放入雜湊存放區。取得模型／runtime 前由操作人核對來源與授權，RC 沒有自動下載或匯入後猜測執行的行為。

uninstall 預覽與 --apply 僅針對已核對的安裝入口與憑證。資料、SQLite、稽核及原始備份保存在受保護的安裝位置。遇到不明鎖或不明檔案時，先保存現況。不得用刪資料或重設 HOLD 的方式讓新版啟動。

## 備份、升級與回滾

1. 正常停止目前候選，取得 cold backup。備份核對主庫、存在的 sidecar、設定、資產及 SHA。
2. 準備新程式目錄及新資料目錄。核對新封包後，使用 restore 建立互不共用的資料副本。備份不重啟程式。
3. 在新副本執行 migration-check，再以獨立埠驗收版本、歷史、模型拒絕和 HOLD。未知 schema 版本維持 HOLD。既有保留紀錄、持久化鎖與稽核以原樣移交。
4. 還原副本會退休備份內的 Token 身分，避免以舊備份恢復已撤銷的憑證。為副本發新的客戶端識別碼及憑證。
5. 失敗時停止已核實的候選，保存新資料另供核對。先執行 rollback-check，再由操作者選擇完整的同代舊程式與舊資料。使用不同安裝根，不跨代覆寫 SQLite、WAL 或 SHM。

歷史交換使用明確取得的 V0.6 或 V0.7 唯讀投影。用 node tools/import-history.mjs <install> <snapshot.json> <sha256> 在停止時匯入。檔案格式見 [歷史快照範例](examples/legacy-history.example.json)。舊工作與雙模型紀錄只供查閱。來源請求與 HOLD 數量只作歷史註記。私人原始資料庫、原提示詞、回答及復原責任由原系統保留。

## Linux Agent 准入

使用發行包內的 node agent/cli.mjs install 為一般 Linux ARM64 帳號安裝唯讀 Agent，依[安裝與退役指南](AGENT-INSTALL.md)取得公開金鑰並完成遙測登錄。node tools/rc.mjs agent-plan 提供另外的執行設備評估。執行域、帳號、簽章身分、模型與 CPU/GPU 資源資格須另外核對。維運及真實工作 scope 必須分開。若之後採用管理 helper，只能接受固定動詞和物件身分，且由管理者安裝及持有。通用安裝不寫入 sudoers、SSH 權限或服務管理設定。

## 意外退出後的本機鎖復原

先用 node tools/rc.mjs lock-status <install> 核對鎖狀態及 SHA。原程序狀態不明、仍存活或有另一個復原程序時，保留 HOLD。PID 已明確不存在後才可用 node tools/rc.mjs recover-lock <install> <expected-lock-sha256> <new-backup-dir>。入口須先封存舊鎖和完整資料並驗證副本，再移除已核對的安裝鎖。已派送且未確認的資源封鎖仍由控制器保留。

首次成功開啟兩個資料庫後，程式在安裝根寫入 storage-seal.json。備份及還原一併保留。已建立回條的安裝若缺少一個或兩個 SQLite 主庫會保留 HOLD。

## RC1 升級至 RC2

使用 RC2 程式執行 upgrade，建立新冷備份和新資料根，原安裝保持可回復。新副本保留既有工作和監控歷史，遙測序號表以相容方式補入。電腦重啟後如有不明鎖，先保存同代資料和回條。

預設保護包含整條祖先路徑。Windows 核對未受信任的刪除、替換與權限修改，Linux 核對 owner、可寫權限與實際路徑。固定受管工作區若不符合多人部署資格，只能依開發者指南明確開啟隔離測試模式。doctor 所示 WORKSPACE_FIXTURE 為試驗範圍。可用安裝仍需 PRIVATE_ANCESTORS 及實際操作身分資格。
