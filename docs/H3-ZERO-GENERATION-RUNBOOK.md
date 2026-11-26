# H3 零生成跨主機准入

此入口只接受一次簽章探測。它使用獨立 OpenSSH 執行個體、具名 Windows 來源地址、固定 TCP 38322、獨立主機金鑰與專用非 root 探測帳號。零生成套件只含 Node runtime、探測入口和簽章／框架程式。它不附 Ollama、模型、調度器或任何派送操作。

## 受信邊界

- 設備名稱或 IP 僅用來定位。Windows 以獨立 OpenSSH 主機公鑰核對傳輸，再核對回覆的設備摘要、boot ID、操作綁定、獨立探測簽章及當次 nonce。通過表示這個入口可用於本次零生成驗收。
- 探測帳號固定為 *acm-h3-ready*，具備專用 UID／GID、無附加群組、無家目錄、無可登入的密碼雜湊。啟動前拒絕該 UID 有任何既存程序。獨立 sshd 僅接受根保護的單一 Ed25519 公鑰、具名 Controller IPv4 和固定命令。伺服器端封鎖 PTY、任意指令、TCP／Unix socket 轉送、代理、X11 及使用者 RC。探測程序另核對固定啟動路徑及匿名 FIFO。
- 一次性標記由探測帳號排他建立。它保護目前唯一固定服務的重送。這個驗收要求探測 UID 專用，該 UID 若能在 SSH 強制命令以外執行任意本機程式，就能破壞同 UID 的標記與金鑰完整性，應停止並依主機事件流程保全。
- root、Linux 核心、SSH daemon 及用來識別設備的本機系統屬於可信運算基礎。Windows 簽章私鑰、專用 SSH 身分、探測金鑰與後續 Worker／復原簽章均分開。任何零生成回條均不發行生成資格。

## 啟用前逐項批准

1. 固定批准的 Orin NX、boot 與設備摘要，Windows 和 NX 各自的操作者、具名 IPv4、獨立 TCP 38322，以及至多 30 分鐘零生成窗口。對過去 CPU 的正式資料、服務、耗用紀錄及 SSH 入口保留原狀。除非設備管理方另行批准，保持現有防火牆不變。
2. 在實機核對 ARM64、systemd、固定 Node、/usr/sbin/sshd 雜湊、/usr/bin/python3 及 /opt 權限。先確認 OpenSSH 既有 root 保護的 /run/sshd 特權分割目錄已存在，READY 入口不建立或修改此共用目錄。以本次已批准的新專用帳號登錄合法 UID、GID。檢查該帳號沒有其他服務、登入公鑰、使用者 shell 入口或附加群組，主目錄設定為不存在的 /nonexistent。原生拒絕案例與有效 SSH 設置都要留存。
3. 精確核對設備沙盒上的三個目錄 /opt/acm-h3-ready-stage-v1、/opt/acm-h3-ready-v1、/opt/acm-h3-ready-audit-v1 均不存在。只在批准後建立 root:root 0700 的 staging。保留這次 once-marker，即使遠端中途失聯。
4. 固定本輪 READY bundle、安裝器和具名 site JSON 的外部 SHA。root 在 staging 預置 bundle.tar、ready-admin.py、site.json、host_key、probe.pem。bundle 含四個定名承載檔。host_key、probe.pem 使用 0400，其他檔案使用 0400 或 0444。SSH host key 是此次專用 Ed25519 key；probe.pem 是另一把專用 Ed25519 PKCS#8 私鑰。驗證兩把私鑰來源與排他用途，使用既有可信管理通道核對公開摘要。私鑰保留在受保護的操作者環境，證據包僅收錄公開材料與摘要。
5. Windows 私有目錄只放 ready-client.json、controller.pem、known_hosts、ssh-identity。最後一項為獨立 OpenSSH 私鑰。known_hosts 固定單行 acm-h3-target ssh-ed25519 後接本窗口已核對的 host key 公開資料。兩端計畫逐欄相同。以 SHA-256 核對 Windows 的固定 OpenSSH 與 Node 執行檔，啟動時使用固定 Node 24.22.3。

## 計畫格式

NX site.json 成員為 **plan、listen、controller、authorizedKey、sshdSha256**。listen 是批准的 NX 本機 IPv4，controller 是 Windows 的來源 IPv4，authorizedKey 是專用 SSH 公鑰的前兩欄，sshdSha256 固定伺服器執行檔。Windows ready-client.json 成員為 **plan、host、ssh、sshSha256、nodeSha256**。host 與 NX listen 一致，ssh 是 Windows 受保護 SSH 執行檔的絕對路徑，其餘為執行檔摘要。

兩端 plan 欄位固定如下。

| 欄位 | 來源 |
|---|---|
| version、scope | 1、ACM_H3_ZERO_GENERATION_V1 |
| operation | 新的一次性 UUID |
| deviceSha256、boot | 去除行末空白後的 /etc/machine-id 之 SHA-256、/proc/sys/kernel/random/boot_id |
| sshHostSha256 | SSH host 公鑰第二欄 Base64 解碼後的完整 blob SHA-256 |
| nodeSha256 | 固定 ARM64 Node v24.22.3 SHA-256 |
| controllerKey、probeKey | 各自固定的 Ed25519 DER SPKI 公鑰，以小寫十六進位編碼表示 |
| notBefore、expiresAt | UTC Unix 毫秒，限制 30 分鐘 |
| uid、gid | 已核對的專用探測帳號實際數字身分 |

## 當次操作

在核准 NX 原生窗口執行固定安裝器。第二行過關後才進入啟動。

~~~text
sudo /usr/bin/python3 -I -B /opt/acm-h3-ready-stage-v1/ready-admin.py install BUNDLE_SHA256 SITE_SHA256
sudo /usr/bin/python3 -I -B /opt/acm-h3-ready-stage-v1/ready-admin.py check
sudo /usr/bin/python3 -I -B /opt/acm-h3-ready-stage-v1/ready-admin.py start SITE_SHA256
~~~

在 Windows 以固定 Node 執行候選的用戶端入口。保留完整 JSON stdout，以及已核對的公開 plan。回條含原簽章挑戰／回覆、送收時間及往返耗時。核對回覆 nonce 與 NX 退出時保存的 once-marker 相符。

~~~text
node tools/h3/ready-client.mjs PRIVATE_ROOT READY_CLIENT_SHA256
~~~

關閉後核對專用服務及身分。停止只接受該暫態單元的固定 ExecStart。精確清理逐檔比對身分、型態、大小、模式與 SHA，未知項目保留。清理會提取 root-only 稽核並移除本次安裝樹。staging 是管理者輸入，依本次具名物件清單另行保留或清理。保存 audit 與已消耗標記。

~~~text
sudo /usr/bin/python3 -I -B /opt/acm-h3-ready-stage-v1/ready-admin.py stop
sudo /usr/bin/python3 -I -B /opt/acm-h3-ready-stage-v1/ready-admin.py cleanup
~~~

出現其他 UID 程序、指紋漂移、未知檔案、證據遺失、SSHD 設置不一致或停止失敗時保留現場。未取得原生資格前維持生成 HOLD。此 READY-only 固定 slot 為一次性，後續若需重做，須保留稽核並核定新的 slot／操作識別。

## 時序門檻

| 期限 | 執行方 | 憑據 |
|---|---|---|
| 5 秒 | Windows 零生成探測及 SSH | 整次傳輸，涵蓋 SSH 建連與回覆。逾時拒絕 |
| 700 ms | NX 本機探測 | 自有效訊框收妥至簽署證據準備完成的單調時鐘上限 |
| 700 ms | Windows 生成候選 | 原有 READY 與結束時清場證據的新鮮度，以及取樣請求的本機單調計時預算，保持原守門 |
| 既有 R1 觀測窗口 | NX 可信父程序 | 本機 R1 觀測、回復及持久提交，保持原守門 |

零生成估計時差區間為「遠端送出 − 本機收到」至「遠端收到 − 本機送出」。它不需要假定雙向延遲相等。跳時、區間矛盾或單調時鐘與牆鐘明顯不符會被拒絕。*compatibleWith700msAtProbe* 只記錄一筆含 SSH 建連的觀測，後續生成仍須重新取得當次證據。在批准環境檢查實際時鐘同步與長尾延遲。若真實端到端無法守住時序，先改取樣位置或使用另審的時序證據協定，原生成門檻維持。
