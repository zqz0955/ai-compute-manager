import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { historicalOffload, verifyH4Preflight } from '../tools/h4/preflight.mjs';
import { createWorkspaceFixture } from '../tools/fixtures/workspace-fixture.mjs';

const assets = {
  verified: true, model: 'fixture:tag', manifestSHA256: 'a'.repeat(64), binarySHA256: 'b'.repeat(64),
};
const fixtureReceipt = {
  verified: true,
  cuda: ['library=CUDA compute=8.7 libdirs=ollama,cuda_jetpack6 driver=12.6'],
  layers: ['load_tensors: offloaded 2/2 layers to GPU'],
  sampled: [{ name: assets.model, model: assets.model, digest: assets.manifestSHA256, size_vram: 4096, context_length: 512 }],
};

test('H4 reconstructs saved offload only from CUDA backend, layer counts and matching residency', () => {
  assert.deepEqual(historicalOffload(fixtureReceipt, assets), {
    layers: 2, totalLayers: 2, driver: '12.6', computeCapability: '8.7', residentReportedBytes: 4096,
    context: 512, model: assets.model, modelManifestSha256: assets.manifestSHA256, binarySha256: assets.binarySHA256,
  });
});

test('H4 refuses activity readings and unrelated backend records as offload evidence', () => {
  for (const cuda of [['GR3D_FREQ 99%'], ['library=CUDA compute=8.7 libdirs=ollama,cuda_v12 driver=12.6']]) {
    assert.throws(() => historicalOffload({ ...fixtureReceipt, cuda }, assets), /H4_HISTORICAL_GPU_OBSERVATION/u);
  }
  assert.throws(() => historicalOffload({ ...fixtureReceipt, cuda: {} }, assets), /H4_HISTORICAL_GPU_OBSERVATION/u);
});

test('H4 refuses zero or ambiguous offload and mismatched residency', () => {
  for (const layers of [
    ['load_tensors: offloaded 0/2 layers to GPU'],
    ['load_tensors: offloaded 3/2 layers to GPU'],
  ]) {
    assert.throws(() => historicalOffload({ ...fixtureReceipt, layers }, assets), /H4_HISTORICAL_GPU_BINDING/u);
  }
  assert.throws(() => historicalOffload({
    ...fixtureReceipt, layers: [...fixtureReceipt.layers, ...fixtureReceipt.layers],
  }, assets), /H4_HISTORICAL_GPU_OBSERVATION/u);
  for (const change of [{ size_vram: 0 }, { digest: 'c'.repeat(64) }, { model: 'other:tag' }]) {
    assert.throws(() => historicalOffload({
      ...fixtureReceipt, sampled: [{ ...fixtureReceipt.sampled[0], ...change }],
    }, assets), /H4_HISTORICAL_GPU_BINDING/u);
  }
});

test('H4 CLI refuses altered archived input and omits caller data from diagnostics', async t => {
  const folder = 'v1.0-h3-h4-admission-20261126';
  const name = join(folder, 'nx-gpu-saved-readonly-inventory.json');
  const work = await createWorkspaceFixture('jcm-hfour-', [name]);
  t.after(() => work.clean());
  await mkdir(join(work.root, folder));
  await work.recordDirectory(join(work.root, folder));
  await work.createFile(name, '{"dispatchAllowed":true,"releaseAllowed":true}');
  assert.throws(() => verifyH4Preflight(work.root), /H4_EVIDENCE_DIGEST_MISMATCH/u);
  const entry = fileURLToPath(new URL('../tools/h4/preflight.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [entry, work.root], { timeout: 3000, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.deepEqual(JSON.parse(result.stderr), {
    verdict: 'HOLD_H4_INPUT_REFUSED', dispatchAllowed: false, releaseAllowed: false, code: 'H4_EVIDENCE_DIGEST_MISMATCH',
  });
});
