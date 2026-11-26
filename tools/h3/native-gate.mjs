import { requireH3 } from './wire.mjs';

export function requireNativeH3Admission() {
  // 隔離候選已區分 Worker 與 root 回復權威。NX 實際部署、SSH 及時序仍待原生驗收。
  // 目前沒有參數、設定、環境變數或隔離測試回條可以啟用實機生成。
  requireH3(false, 'H3_NATIVE_ROLE_SEPARATION_PENDING');
}
