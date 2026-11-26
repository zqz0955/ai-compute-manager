# 開發及回歸

用核對過的 Node v24.22.3。測試資料使用該 checkout 的 tools/fixtures/work。位於專案 candidates 下的候選也可使用專案的相同工作區。Windows 隔離安裝測試須將 ACM_TEST_ROOT 與 ACM_INSTALL_WORKSPACE_FIXTURE 設為同一個合格的絕對路徑。禁止在磁碟根、正式工作庫或資料備份內建立測試資料。

~~~text
npm test
node tools/check-dependencies.mjs
node tools/release.mjs scan
node tools/release.mjs build <absolute-artifact-path>
node tools/release.mjs verify <absolute-artifact-path>
~~~

個別回歸用 node --test test/<suite>.test.mjs。瀏覽器驗收需要相容的 Chrome/Playwright，並設定 ACM_DASHBOARD_BROWSER=1。若該項 skip，本機 HTTP 服務整合仍會執行。日常迭代避免重跑已封存的實機資格。

標記合成資料、實機證據、宣告與 UNKNOWN。新增資料庫欄位需要說明舊證據的相容性及復原。發布時從乾淨 checkout 建置兩次，獨立核對 SHA 與封包內容。

保留錯誤碼與受影響範圍。報告遮蔽憑證、模型輸入輸出及私人配置。正式版本、GitHub、設備權限與現場服務另有授權。
