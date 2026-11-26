# 唯讀遙測

## Windows 本機

在 Windows 上用 setup --monitor-local 開啟取樣，也可在停服後設定 monitoring.windowsLocal 為 true。CPU 使用率來自相鄰兩筆系統累積 tick。RAM 是系統總量與空閒量之差。磁碟是候選資料所在磁碟區的容量與使用量。GPU、溫度、交換空間和模型未能從通用來源核對時顯示 UNKNOWN。首筆 CPU 缺少前樣本時也顯示 UNKNOWN。 [Node.js 檔案系統資料契約](https://nodejs.org/docs/latest-v24.x/api/fs.html#fsstatfssyncpath-options)

## Agent 和簽章來源

由已核對的 Agent 安裝取得節點識別和 Ed25519 公鑰。在 Dashboard 初次設定準備 monitoring.sources 的一筆物件，停服後由管理者確認並存入設定。可辨識欄位如下。

~~~text
nodeId, kind, publicKey, tokenId, name (optional)
~~~

kind 是 JETSON_AGENT 或 V06_V07_BRIDGE。獨立簽發 scope 為 telemetry:publish 的本機發送者憑證，將使用者識別與該設備的公鑰配對。即使有此 scope，發送者也只可處理已綁定的節點。

1. 在同一台主控的可信會話執行 node tools/publish-telemetry.mjs challenge <隔離埠> <nodeId>。只向該程序提供本機發送憑證的 ACM_TELEMETRY_TOKEN。
2. 把回傳的 32 位元組 challenge 交給已安裝的 Agent，依 Agent 安裝指南以 sample 取得 JSON。
3. 將簽章 JSON 經標準輸入交給 node tools/publish-telemetry.mjs snapshot <隔離埠> <nodeId>。CLI只連 IPv4 loopback。原始 Agent 只透過 stdin/stdout 回應。
4. 用管理讀取憑證在 Dashboard 查來源、時間及模型。採樣 15 秒後過期，值顯示 UNKNOWN。歷史保留原採樣時間及來源標記。Dashboard 的總覽停留時也會遮蔽逾期數值及模型清單，使用「更新總覽」可重新取樣。

challenge 只使用一次，最長 30 秒。伺服器會核對節點、公鑰、簽章、新鮮度及序號。SQLite 在同一交易提交採樣及序號上限。重啟清除尚未消耗的 challenge，但仍保留序號上限。輪換公鑰須以新的驗收節點身分登錄，既有序號與歷史保持可追溯。連線中止、身分不符、空清單與空值各有獨立表示。監測來源不開啟排程資格。

## V0.6／V0.7 轉接

舊版可信觀測器監測過程及憑證維持原樣。兩個相容入口都應由已核對原服務身分的管理端提供，轉接器只處理該端交付的讀取投影。錄影、歷史資料或自填 source 字樣不足以當成目前觀測證據。

- V0.6 支援既有 V0.7 中介程式輸出的 V06_LOOPBACK_VERIFIED frame。
- V0.7 支援管理端從固定讀取介面擷取的 V07_MANAGEMENT_CAPTURE。內容是 capturedAt 和同一次 health、node、models、resident 的 JSON。需檢查來源本身仍為 V06_LOOPBACK_VERIFIED、管理介面唯讀、推論停用以及節點身分。

RC2 要求獨立觀測者簽章。由原管理端核對已授權 V0.6／V0.7 上游程序、端點和原管道身分。在可信觀測程序接上 src/legacy-capture-auth.mjs 的 createPinnedLegacyObserver。提供原受保護的來源驗證回呼、發行者私鑰及允許的唯讀投影。輸出綁定該輪 challenge 與固定上游節點。查驗前後須為同一個已釘選的來源身分。既有來源的帳號、程序以及 named pipe 資格由當次部署接入驗收。

~~~text
node tools/relay-telemetry.mjs init <new-relay-root> <nodeId> <upstreamNodeId> <observerPublicKey> <sourceIdentitySha256>
node tools/relay-telemetry.mjs sign <relay-root> <challenge>
~~~

用 init 回傳的 relay 公鑰登錄 RC2 節點。sign 只收前述觀測程序已簽章的 envelope，拒絕原始 JSON、自述來源、其他節點、發行者或 challenge。它保留原始採樣時間，捨棄未核可欄位，再以 relay 自己的金鑰將資料交付 RC2。轉接器不讀正式工作庫、管理權杖、SSH 設定或私鑰。

本輪隔離測試覆蓋兩種格式、釘選、觀測者簽章、scope 與資料還原。正式來源接入需於設備可用時完成原生程序及管道驗證。
