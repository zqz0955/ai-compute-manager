# Jetson 唯讀 Agent

RC2 的 Agent 是以一般帳號執行的 Linux ARM64 程式。發行包優先使用 Node.js 24.22.3 以上的 24.x，也接受已包含 2026 年 11 月安全修補的 22.23.5 以上的 22.x。舊版 22.16.0 僅保留歷史隔離驗收證據。 [Node.js 安全修補公告](https://nodejs.org/en/blog/vulnerability/november-2026-security-releases/)

先核對發行包和 Node 的 SHA-256，並由設備管理方提供固定唯讀的程式目錄。狀態目錄由執行者管理，所有祖先目錄都須位於可信帳號的控制下。

~~~sh
uname -m
id -u
node --version
agent_state="$HOME/acm-agent-state"
node agent/cli.mjs install "$agent_state" "jetson-local"
node agent/cli.mjs status "$agent_state"
~~~

安裝目錄須為尚未使用的絕對路徑，父層需已存在。安裝會產生專屬 Ed25519 金鑰、初始序號和設備識別。向控制器管理員交付設備識別和安裝回條的公開金鑰，私鑰留在權限 0600 的狀態檔。模式 0700 的根目錄與模式 0600 的狀態檔由同一一般使用者擁有。若目錄、權限、祖先或身分驗證出現差異，先停止操作。

## 採樣、執行及正常停止

~~~sh
node agent/cli.mjs sample "$agent_state" "$acm_controller_challenge"
node agent/cli.mjs start "$agent_state"
~~~

sample 取用控制器分配的單次挑戰，產生一筆簽章回條後退出。start 以前景方式執行，標準輸出第一行是 READY 和設備公鑰。透過標準輸入逐行送入只含 challenge 的 JSON 物件，每個合格物件回覆一筆簽章樣本。challenge 為 32 bytes 的無填補 base64url。回條綁定設備、挑戰、遞增序號及原始採樣時間。控制器須固定公鑰及核對新鮮度、預期挑戰和前次序號，再採用回條。簽章成功僅允許讀取遙測，真實派送資格由另行管理的准入流程決定。

結束輸入或前景 Ctrl+C 會讓程序正常停止並釋放互斥鎖。第二個程序與解除安裝操作在鎖仍存在時會拒絕。LOCK_PRESENT 表示鎖存在，請從原程序與隔離狀態確認持有原因。若意外中止留下鎖，保留原狀態和回條給維運人員，並用已核准的新目錄與新公鑰重新登錄。單憑 PID 或遺失回應無法解除原鎖。

## 資料範圍

- CPU 使用率取自 Linux /proc/stat 的兩次 aggregate counter，RAM 與 swap 使用 /proc/meminfo。磁碟以根檔案系統的容量與區塊計量。溫度取可信核心提供的有效熱區讀數。Linux ARM64 VM 可重播這些真實核心量測。 [Linux /proc](https://docs.kernel.org/filesystems/proc.html) [Linux thermal sysfs](https://docs.kernel.org/driver-api/thermal/sysfs-api.html)
- Jetson 顯示驅動公開的受支援欄位才會提供 GPU 使用率。缺資料、無足夠權限或缺少相容驅動的欄位為 null。
- 需要當地 Ollama 的模型及已載入清單時，在新的 Agent 安裝加上 --ollama。僅連線當地 IPv4 loopback，使用固定的 /api/tags 和 /api/ps GET。回覆為健全且空的清單時保留 []，無法觀測時為 null。 [Ollama 安裝清單](https://docs.ollama.com/api/tags) [Ollama 執行清單](https://docs.ollama.com/api/ps)
- 採樣採用標準輸入輸出，可由另行授權的交換流程承載。Agent 本身持有的工作和模型權限限於唯讀。對外連線及部署資格須分別驗證。

## 解除安裝

~~~sh
node agent/cli.mjs uninstall "$agent_state"
node agent/cli.mjs uninstall "$agent_state" --apply
~~~

第一行先預覽，批准後執行第二行。解除安裝會保留只含公開資訊的撤銷回條，再移除本次安裝的固定狀態檔與私鑰。出現未知物件、替換、鎖或身分變化時會停止。完成後由控制器管理員撤銷公鑰信任，封存對應的稽核回條。產品程式可由設備管理方依發行檔清單收回。

## English quick reference

Provide a trusted, read-only copy of the RC2 source to an unprivileged Linux ARM64 account. Verify the package and Node runtime checksums. Install to a new private absolute state directory using the commands above, then enroll the returned public key on the controller. Keep the process in the foreground. Send newline-delimited challenge objects through standard input or request a single signed sample. Close standard input or press Ctrl+C to stop. Retire the state only after reviewing the uninstall plan and have the controller administrator remove its trust pin. Optional local Ollama enumeration remains read-only. Device dispatch requires separate admission.

解除安裝如果在退役回條已保存、私鑰清理尚未完成時中斷，Agent 會維持停用。遇到此狀態先撤銷主控的該設備發送者憑證和公鑰設定，保留退役回條及目錄身分。由已授權的管理者逐檔核對後處理殘留，不以重新啟用 Agent 進行清理。
