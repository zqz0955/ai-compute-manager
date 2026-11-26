# H5 雙設備調度故障驗收

`tools/h5/verify-receipt.mjs` 是可執行的唯讀驗收工具。它核對同一個隔離 Controller 的兩份去敏快照及其收據 SHA，驗證雙實體設備並行預留、失聯後同一 attempt 持久 HOLD、正常設備釋放，以及重啟後沒有再派送原工作。

2026-11-26 的 NX Legacy CPU 單次實機驗收可沿用作為一台設備的一項受控 CPU 證據。Controller 已支援多個彼此獨立的 CPU Worker 資格，具備隔離簽章測試證據。H5 實機仍需兩台設備分別具備當次資格、可信雙主機啟動入口及一次受控並行窗口。

## Controller 准入契約

可信隔離啟動端可在 `engine-qualification` 模式把同一個預建資格 SQLite 物件所簽發的多份 Worker 交給 `openController({qualifiedWorkers, maxConcurrent})`，並設 `maxConcurrent:2` 驗證雙端並行。每份 Worker 仍經既有簽章、CPU 模型、期限與獨立主機回復權威核對。兩份資格不得使用相同 Worker 公鑰、執行世代、資格 ID 或任何碰撞的實體、節點 ID 及別名。單 Worker 啟動入口仍使用 `qualifiedWorker`，正式設定與 HTTP 保持原守門。

工作寫入同一工作庫時就綁定並消耗一份資格，包括排隊後取消的工作。失聯保留該次資源鎖，排程期間資格失效的未送出工作維持原綁定並停止。同一請求重送只讀原工作，任何新工作皆另行使用未消耗的資格。重啟需供應所有已入庫工作的原 Worker 資格供檢查，釋放回條使用原簽章金鑰重驗。HOLD 同樣計入全域併發上限。

## 同一受控情境

1. 先固定兩台設備各自的實體識別指紋、別名、模型摘要、隔離執行域與各自新授權。採用獨立調度測試資料根與環回介面。先核對 H3 資格及雙主機啟動入口，向同一資格工作庫核發兩份獨立 Worker。測試窗口應明確包含雙設備各一次合成工作。
2. 以兩個合成輸入建立不同工作，等待兩個不同實體的 `INTENT` 同時留在原始 Controller 工作庫。保留 Controller snapshot 及兩個工作綁定的各自原始回條。一項工作的持久派送意圖應先於該設備實際接受，兩個節點各須有可信派送及資源帳本。
3. 只在本輪隔離傳輸中受控切斷其中一個 Worker 測試通道。未確認回收的工作應轉為 `INTERRUPTED`，該實體與別名保持 `HOLD`。健康端依其獨立權威完成 `RELEASE`。保留失聯注入之前與之後的原始觀察。
4. 正常停止**本次隔離 Controller**後，以相同工作庫重新開啟，固定來源、工作庫物件及兩次程序世代。記錄重啟後 snapshot。固定收據、原始事件、權威簽章、每台真實回收回條及各自帳本，再使用本工具核對。終態不明的原工作、原資料保存與精確復原均按各自守門處理。
5. H5 負載壓力、取消回收、別名與資源競爭可另外安排無推論反例或單獨批准的實機案例。本工具覆蓋第 2–4 步的雙工作並行、隔離失聯與重啟。只讀遙測、競速模擬及此單一收據保持各自證據範圍。

## 收據輸入

用當次可信 Controller 的 `projectH5Snapshot(controller.snapshot())` 取得 `active` 與 `reopened` 投影。投影保留工作、attempt、設備、鎖、原始事件序號與證據摘要。提示詞、輸出、客戶端識別及私鑰留在原管理範圍。

| 欄位 | 來源 |
|---|---|
| `version`、`kind`、`source` | `1`、`MULTINODE_TRANSPORT_LOSS`、`ISOLATED_REAL_ENGINE`；離線工作使用 `SIMULATION` |
| `nodes` | 恰好兩筆，欄位為 `nodeId`、`resource`、`aliases`、`physicalIdSha256`、`admissionSha256`、`modelSha256`；實機 `resource` 等於設備實體指紋 |
| `controllerBuildSha256`、`restartProofSha256`、`transportLossProofSha256` | 分別固定 Controller 成品、同工作庫重啟與受控失聯的原始回條 |
| `failedJobId` | 受控失聯的原工作識別 |
| `active`、`reopened` | 同時持有兩個 `INTENT` 時與原工作庫重啟後的投影 |

在新的驗收庫只建立這兩份工作並保留開頭至終態的完整事件序列。工具比對快照前綴與鎖綁定，拒絕缺漏、別名碰撞、同實體雙登錄、重送與提前釋放。分別封存原始證據，交由審查方逐份核對雜湊來源、設備、簽章及授權範圍。

~~~text
node tools/h5/verify-receipt.mjs <absolute-receipt.json> <independently-reviewed-receipt-sha256>
~~~

通過輸出為 `H5_EVIDENCE_CONSISTENT`，硬體資格欄仍為 `false`。工具核對投影的一致性，完整的設備資格還需外部原始證據與獨立審核。隔離測試使用兩個獨立簽章的 Legacy CPU 協定替身、各自的回復權威、兩個排他 INTENT、一道傳輸中斷與同一 SQLite 重啟驗證流程。
