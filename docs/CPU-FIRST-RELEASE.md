# V1.0 CPU-first 發布候選

產品範圍以待批准提案保存。正式部署、原正式資料存取及公開發布需權利人和設備管理方具名批准。

| 功能 | 建議版本範圍 | 發布前條件 |
|---|---|---|
| 本機唯讀與既有模擬 | 可保留候選 | 使用固定 ACL、資料根及 Token 契約。回滾演練保留 |
| H3 NX CPU 非串流 | 第一實機工作流 | 先核可獨立零生成窗口，再另行核可單次生成。具名原生回條、獨立權威及復原證據必須齊備 |
| H3 NX CPU SSE | 各自 qualify | 非串流完成後，另用窗口、工作庫與資格。客戶端只把驗證提交後的 DONE 當正式成功 |
| H5 多 Worker CPU | 離線資格候選 | 各機各模型獨立准入。真實並行及失聯回條待驗 |
| H4 GPU | 預設停用、與 CPU-first 分開審查 | 沿用硬限額／歸屬／回收拒絕守門。合格方式未確立以前不派送 |
| 正式切換、公開發佈 | 仍待批准 | 核對指定冷備 lineage、同鎖還原、新根與回滾、一致來源、授權定案 |

NX Legacy bounded CPU 的單次 4.969 秒原始回條可作相同資產、配額與觀測契約的前置證據。該次窗口與資格單獨封存。Windows、Nano A、跨主機、SSE 與多設備並行均各需自身的實機證據。

[H3 零生成](H3-ZERO-GENERATION-RUNBOOK.md) · [H3 生成方案](H3-ADMISSION.md) · [H5 驗收](H5-MULTINODE-QUALIFICATION.md) · [H6 切換與回滾](PRODUCTION-CUTOVER.md) · [Tegra GPU 研究](TEGRA-GPU-ISOLATION.md)

全域 CLEANUP 維持 HOLD。持續派送、GPU 與正式服務變更需獨立裁決。
