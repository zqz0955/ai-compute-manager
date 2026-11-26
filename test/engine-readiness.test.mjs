import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { inspectReadiness, metadataGet } from '../tools/engine-qualification/readiness.mjs';

test('ARM64 模擬的 metadata 探測允許超過舊 700 ms 的回應，每個 GET 只送一次', async () => {
  const visited = [];
  const result = await inspectReadiness({
    start: async () => {},
    get: async (path, signal) => {
      visited.push(path);
      if (path === '/api/version') {
        await delay(850, undefined, { signal });
        return { version: '0.40.16' };
      }
      if (path === '/api/tags') return { models: [{ name: 'qwen2.5:0.5b-instruct-q4_K_M',
        digest: 'a8b0c51577010a279d933d14c2a8ab4b268079d44c5c8830c0a93900f1827c67' }] };
      assert.equal(path, '/api/ps');
      return { models: [] };
    },
    stop: async () => ({ code: 0, signal: null }),
    metrics: () => ({ empty: true, peak: 140939264, oom: 0, oomKill: 0, max: 0, pidsMaxHits: 0 }),
    hints: () => [],
    emit: () => {},
  });
  assert.equal(result.verdict, 'PASS_METADATA_ONLY');
  assert.equal(result.generationRequests, 0);
  assert.deepEqual(visited, ['/api/version', '/api/tags', '/api/ps']);
  await assert.rejects(metadataGet('/api/generate', AbortSignal.timeout(100)), { code: 'METADATA_ROUTE' });
});
