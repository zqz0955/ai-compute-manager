import { REAL_MODE, LEGACY_MODE } from './r1/ollama-once.mjs';
import { inspectOrRelease } from './r1/restore-once.mjs';
import { requireDispatchWindow, runDurableOnce } from './r1/run-durable-once.mjs';
import { createUpstreamClient, createUpstreamAuditVerifier } from './r1/upstream-terminal.mjs';

export function realInferenceDisabled() {
  return Object.assign(new Error('此模式鎖定真實 CPU 與 GPU 推論。'), { code: 'INFERENCE_DISABLED', status: 403 });
}

// 這個來源介面只使用獨立 R1 隔離啟動器交付的身分、存放空間與已授權交換管道。
export function createIsolatedR1Adapter({ identity, controllerPrivateKey, exchange }) {
  if (![REAL_MODE, LEGACY_MODE].includes(identity?.mode)) throw realInferenceDisabled();
  identity = Object.freeze({ ...identity });
  const upstream = createUpstreamClient({ identity, controllerPrivateKey, exchange });
  return Object.freeze({
    pin: upstream.pin,
    run({ store, approval, signal }) {
      requireDispatchWindow(approval);
      return runDurableOnce({ store, upstream, identity, approval, signal });
    },
  });
}

export { createUpstreamAuditVerifier as verifyR1Evidence, inspectOrRelease as inspectOrReleaseR1 };
