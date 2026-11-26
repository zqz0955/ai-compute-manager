# 公開預覽授權狀態

權利人已選擇 Apache-2.0 授權專案有權授權的原創程式，原文見 [LICENSE](../LICENSE)。既有程式與第三方資產權利仍待最終核對；外部 runtime 與模型各依其條款，未包含於封包。以下為原始審查紀錄。

# 授權建議及外部元件

建議由專案權利人考慮 Apache-2.0。它提供明確的專利授權條款，適合將來會提供 API、Agent 與 SDK 的原創程式。MIT 是條款較簡短的選項。現有原始碼的權利人與貢獻來源需要逐項確認，本候選沒有新增 LICENSE 或替第三方資產授權。[Apache License 2.0 原文](https://www.apache.org/licenses/LICENSE-2.0) [MIT License 原文](https://opensource.org/license/mit)

| 來源 | 用途及處理 |
|---|---|
| ACM 原有 V0.6 CSS、V0.7 管理 API、V0.8 R1 | 既有專案來源延用。續留 SHA 或差異，公開前由權利人核准 |
| Node.js 及其內建 SQLite 等元件 | 由操作者另行安裝，保留原授權及組件條款。[Node.js 原始授權資料](https://github.com/nodejs/node/blob/v24.22.3/LICENSE) |
| Ollama | R1 要求指定版本的獨立 runtime。候選只含 ACM adapter。[Ollama 版本授權](https://github.com/ollama/ollama/blob/v0.40.16/LICENSE) |
| Qwen2.5 0.5B | 模型 manifest、blobs 與權重走獨立取得與准入。核對固定 tag 與對應模型條款。[官方模型](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct) |
| GitHub Actions | 工作流程固定上游 checkout/setup-node 提交，Action 程式未打包 |
| 瀏覽器驗收工具 | 可選的本機 Chrome 與 Playwright。產品不需此依賴，封包不含工具 |

公開前需權利人裁決、配套 NOTICE、個資及來源核對。模型與 runtime 的取得方案獨立於產品源碼授權。

## RC2 建議結論

原創 ACM 源碼建議 Apache-2.0，基於使用者與貢獻者在裝置及 API 整合時可檢視明列的專利條款。若權利人優先考量精簡授權與更容易搬用單一檔案，可選 MIT。最終選擇、權利人及第三方 NOTICE 由本人批准後再登錄。 [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) [MIT](https://opensource.org/license/mit)

[可重現 CycloneDX SBOM](sbom.cdx.json)列出產品與核對過的參考依賴。Node、其內建 SQLite、Ollama 及模型資產由獨立門檻取得。Python OpenAI SDK、httpx、Playwright 與 Chrome 僅供選用驗收及外部客戶端。安裝 TAR 限來源、說明與去識別畫面。 [CycloneDX 1.6](https://cyclonedx.org/docs/1.6/json/)
