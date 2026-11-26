# 資格矩陣（2026-11-26）

本輪接續 `NX_LEGACY_BOUNDED_CPU_ACCEPT_LIMITED`。上一輪已完成的裝置、隔離真實引擎、兩位標準 Windows 使用者證據與當次 CPU 實機回條各自保留。整體為 `ACM_V1_0_RC2_SOFTWARE_READY_HARDWARE_PENDING`。

| 階段 | 裁決 | 證據及下一道門檻 |
|---|---|---|
| H0 設備前檢 | PASS_LIMITED_READONLY_BASELINE | 歷史安全唯讀＋當輪 NX L4T、CUDA 套件及裝置中繼資料 |
| H1 原 R1 精確峰值 CPU | HOLD_KERNEL_MEMORY_PEAK_ABSENT | 保留原精確峰值及一次性資格 |
| H1 Legacy bounded CPU | NX_LEGACY_BOUNDED_CPU_ACCEPT_LIMITED | 2026-11-26 單次 4.969 秒，雙層提交及基線回復，原始 14 份稽核已重新核對。樣本最大值 708,984,832 bytes、精確峰值 `null` |
| H2 真實唯讀監控 | PASS_LIMITED_LIVE_OPERATOR_PROJECTION | 同一受信操作程序整合，獨立 API 帳號及 pipe 的正式部署待驗 |
| H3 跨主機 API／Worker | HOLD_CROSS_HOST_NATIVE_AND_ROLE_QUALIFICATION | 隔離 JSON／SSE、雙簽章、失聯持鎖、獨立 Worker UID 與回復權威候選。Windows／NX 真實生成硬拒絕 |
| H3 零生成 SSH | H3_NATIVE_ZERO_GENERATION_ACCEPT_LIMITED | 原生角色採證與當次清理通過；雙簽章挑戰未執行，真實 JSON／SSE 維持 HOLD |
| H4 GPU | HOLD_GPU_HARD_LIMIT_UNPROVEN | 八份固定證據通過唯讀前檢。JetPack 6.2／L4T 36.4.3／CUDA Toolkit 12.6.11 已觀測。隔離後端、精確分配歸屬、GPU 硬限額與可信回收待驗 |
| H5 多節點調度 | HOLD_MULTI_WORKER_AND_SEPARATE_DEVICE_ADMISSION_REQUIRED | 多獨立簽章 Worker、別名去重、雙實體持鎖、重啟守門及回條已通過隔離驗證。實機多 Worker 與兩設備獨立准入待驗 |
| H6 正式部署與回滾 | HOLD_CUTOVER_APPROVAL | 新根冷備遷移、回滾及唯讀人工啟動入口已通過離線演練。切換、實際回滾、退役需分別核准 |
| H7 GitHub 候選 | BLOCKED_PENDING_REVIEW_AND_CI | 權利人已批准公開預覽與 Apache-2.0；最終來源仍須獨立審查、權利核對、安全檢查及 GitHub Actions |

H2 使用既有受保護 V0.7 觀測工具讀 V0.6 固定 loopback GET，再接 V1 的簽章介面。它在同一可信管理程序內執行，**不代表 V1 獨立標準帳號／命名管道部署通過**。正式來源失聯採身分失效注入與停止新樣本轉送測試，沒有拔除設備網路或重新啟動既有服務。測試服務已停止，四個 Token 撤銷。

前次 H2 核心受影響回歸 22 項通過（工具 9、唯讀原因 5、遙測 7、服務 1），另有 3 項瀏覽器收尾故障注入通過。兩項 Chrome 產品案例中，首次 1 PASS／1 FAIL；失敗案在 click 後立即讀取非同步 hashchange 結果，修正測試等候條件後單案重播 PASS，原斷言與產品導覽不變。最終兩項 Chrome 各有通過回條，首次失敗原樣保留。H2 的 51 筆是實際流程檢核紀錄，不等同 51 個獨立測試案例；歷史和新測試不可直接相加成無重複總數。

## 直接沿用的已通過證據

| 項目 | 證據分類 | 本輪處理 |
|---|---|---|
| NX 假引擎 11/11 | PASS_REAL_HARDWARE_FAKE_ENGINE | 不重跑；不是真實模型證據 |
| R1 冷／暖容量 | PASS_ISOLATED_REAL_ENGINE | 只核對固定摘要與驗證器，無再次生成 |
| RC2-R3 JSON 與 SSE | PASS_ISOLATED_REAL_ENGINE | 離線 ARM64，各一個不同 attempt，保留提交及資源回收證據 |
| Windows Owner 10/10、Peer 5/5 | PASS_NATIVE | 獨立非提升 SID、完整祖先與跨帳號拒絕；已清理測試帳號，不重建 |
| ARM64 Agent、Windows／Linux 安裝及還原 | PASS_ISOLATED_NATIVE | 原範圍沿用，不擴張成任意硬體合格 |

## 安全狀態

全域 CLEANUP=HOLD。正式推論、GPU、持續派送、LAN／公網、正式部署及公開發布仍各自 BLOCKED。歷史 INTERRUPTED／EVIDENCE_UNAVAILABLE 工作保留，原因 UNKNOWN，不重送。軟體能提供唯讀與模擬試用，不應把未取得資格的真實節點標成可運算。

[CPU-first 發布提案](CPU-FIRST-RELEASE.md)將 GPU 資格獨立審查，維持預設停用。

下一步見 [HARDWARE-RUNBOOK.md](HARDWARE-RUNBOOK.md)，各項仍依設備管理方具名批准。
