import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readJson, snapshotFile } from '../files.mjs';
import { assertPinned, pinPath } from '../lock.mjs';
import { checkModelManifest } from '../../src/worker/r1/ollama-once.mjs';

const evidenceFiles = {
  nx: ['v1.0-h3-h4-admission-20261126/nx-gpu-saved-readonly-inventory.json', '52c05b72a72b9a87e9e56f2098340e94932051af1e576b81d585de198ed4684c'],
  fingerprint: ['v1.0-h3-h4-admission-20261126/nx-gpu-readonly-fingerprint.json', 'de011ea68663d569a970f68d68da0555d8b862e57856f2d1191da61084f1f702'],
  cpu: ['v1.0-nx-legacy-resume-20261126/NX-LIVE-VERDICT.json', '0dc8520f12abec76fe83e507559508b596c8ad15647a7c71faf9ee3b6ef4c7c3'],
  identity: ['v1.0-nx-legacy-resume-20261126/nx-upstream-identity.json', '7afc1f0e67f1030be8c562c9fe09b73e81a9406dca3271f0abed3ffec9ced24c'],
  oldGpu: ['nx-ollama-2048-20261112-2140/gpu-attribution.json', 'e9e9ef2113770c9fcdaf98b395139f5fa7d8323e1f45daf8553ca8961729e4bb'],
  oldGpuAssets: ['nx-ollama-2048-20261112-2140/retained-final.json', '31a8eb86f97fb6eae467d7502f0812097b85c3bf163be346343324d71be1fa49'],
  oldRelease: ['nx-ollama-2048-20261112-2140/release-metadata.json', '6b54d37f998817113348010bcfb787940a547d133c74de0ed25cf17f8353e39a'],
  model: ['v08-first-real-ollama-r1-20261124/model-manifest.json', 'a8b0c51577010a279d933d14c2a8ab4b268079d44c5c8830c0a93900f1827c67'],
};

const archives = [
  ['ollama-linux-arm64.tar.zst', 'e45b8e6dcb86cb9f3057396351655079c9a4879b4ced2678c9350d375dcbc224'],
  ['ollama-linux-arm64-jetpack6.tar.zst', '6e10ad60bd6f78acc432536c86170b4f3b1ba904c339b9317d9bbc028e0901a4'],
];

const limits = Object.freeze({
  hostMemAvailableMinBytes: 6 * 1024 ** 3,
  cgroupRamMaxBytes: 2 * 1024 ** 3,
  ramHeadroomMinBytes: 256 * 1024 ** 2,
  cpuMax: '100000 100000',
  tasksMax: 64,
  swapMaxBytes: 0,
  context: 512,
  maxTokens: 16,
  generationTimeoutMs: 90_000,
  requests: 1,
  retries: 0,
  windowMaxSeconds: 1800,
  dispatchRemainingMinSeconds: 300,
  gpuHardLimitBytes: null,
});

function requireEvidence(ok, code) {
  if (!ok) throw new Error(code);
}

export function historicalOffload(receipt, assets) {
  requireEvidence(Array.isArray(receipt?.layers) && Array.isArray(receipt?.cuda) &&
    Array.isArray(receipt?.sampled), 'H4_HISTORICAL_GPU_OBSERVATION');
  const layerLines = receipt.layers.flatMap(line =>
    typeof line === 'string' ? [/(?:^|\s)offloaded (\d+)\/(\d+) layers to GPU$/u.exec(line)].filter(Boolean) : []);
  const cuda = receipt.cuda.filter(line => typeof line === 'string' &&
    /(?:^|\s)library=CUDA(?:\s|$)/u.test(line) && /(?:^|\s)libdirs=ollama,cuda_jetpack6(?:\s|$)/u.test(line));
  const sampled = receipt.sampled;
  requireEvidence(receipt?.verified === true && assets?.verified === true && layerLines?.length === 1 &&
    cuda?.length === 1 && sampled?.length === 1, 'H4_HISTORICAL_GPU_OBSERVATION');
  const layer = Number(layerLines[0][1]), total = Number(layerLines[0][2]);
  const driver = /\bdriver=(\d+\.\d+)(?:\s|$)/u.exec(cuda[0]);
  const capability = /\bcompute=(\d+\.\d+)(?:\s|$)/u.exec(cuda[0]);
  const resident = sampled[0];
  requireEvidence(Number.isSafeInteger(layer) && Number.isSafeInteger(total) && layer > 0 && total >= layer &&
    driver && capability && resident?.name === assets.model && resident.model === assets.model &&
    resident.digest === assets.manifestSHA256 &&
    Number.isSafeInteger(resident.size_vram) && resident.size_vram > 0 &&
    Number.isSafeInteger(resident.context_length) && resident.context_length > 0, 'H4_HISTORICAL_GPU_BINDING');
  return {
    layers: layer, totalLayers: total, driver: driver[1], computeCapability: capability[1],
    residentReportedBytes: resident.size_vram, context: resident.context_length,
    model: assets.model, modelManifestSha256: assets.manifestSHA256, binarySha256: assets.binarySHA256,
  };
}

function localArchives(assetPath) {
  const directory = assetPath === undefined ? null : pinPath(assetPath, 'directory');
  return archives.map(([file, sha256]) => {
    if (!directory) return { file, sha256, status: 'VENDOR_METADATA_PINNED' };
    try {
      const actual = snapshotFile(join(directory.path, file), 2 * 1024 ** 3);
      assertPinned(directory);
      requireEvidence(actual.sha256 === sha256, 'H4_ARCHIVE_DIGEST_MISMATCH');
      return { file, sha256, bytes: actual.bytes, status: 'LOCAL_BYTES_MATCH' };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      assertPinned(directory);
      return { file, sha256, status: 'LOCAL_ASSET_MISSING' };
    }
  });
}

export function verifyH4Preflight(evidencePath, assetsPath) {
  const root = pinPath(evidencePath, 'directory');
  const records = Object.fromEntries(Object.entries(evidenceFiles).map(([name, [file, expected]]) => {
    const result = readJson(join(root.path, file));
    requireEvidence(result.sha256 === expected, 'H4_EVIDENCE_DIGEST_MISMATCH');
    return [name, result.value];
  }));
  assertPinned(root);
  const { nx, fingerprint, cpu, identity, oldGpu, oldGpuAssets, oldRelease, model } = records;
  const view = nx.observation;
  requireEvidence(nx.readOnly === true && nx.sudo === false && nx.remoteExit === 0 &&
    view.scope === 'inventory metadata only' && view.machineSha256 === identity.resource &&
    cpu.verdict === 'NX_LEGACY_BOUNDED_CPU_ACCEPT_LIMITED' && view.arch === 'aarch64' &&
    view.kernel === '5.15.148-tegra' && view.packages['nvidia-jetpack'] === '6.2+b77' &&
    view.packages['nvidia-l4t-core'].startsWith('36.4.3-') &&
    JSON.parse(view.cudaVersionJson)?.cuda?.version === '12.6.11' &&
    view.ollamaLibraryNames['/usr/local/lib/ollama'].includes('cuda_jetpack6'), 'H4_PLATFORM_SNAPSHOT');
  requireEvidence(oldRelease.release === 'v0.40.13' &&
    oldRelease.manifestSHA256 === oldGpuAssets.manifestSHA256 &&
    oldRelease.assets.some(a => a.name === archives[1][0] &&
      a.digest === 'sha256:b9641c00bd111229949f6db18d2d6d345ca39dd132a6d1974f6f38f55e9ccde8'), 'H4_HISTORICAL_RELEASE');
  const probe = fingerprint.observation;
  const [backend] = probe.backendFiles;
  requireEvidence(fingerprint.metadataOnly === true && fingerprint.sudo === false && fingerprint.remoteExit === 0 &&
    probe.machineSha256 === view.machineSha256 && probe.runtime.scope === 'disk-path-only' &&
    probe.backendFiles.length === 1 && backend.entry === 'libggml-cuda.so' && backend.symlink === false &&
    backend.elf.some(line => /^Machine:\s+AArch64$/u.test(line)), 'H4_RUNTIME_FINGERPRINT');
  const directLibraryNames = backend.elf.flatMap(line => {
    const needed = /\(NEEDED\).*\[([A-Za-z0-9_.+-]+)\]\s*$/u.exec(line);
    return needed ? [needed[1]] : [];
  });
  requireEvidence(['libcuda.so.1', 'libcudart.so.12', 'libcublas.so.12', 'libggml-base.so.0']
    .every(name => directLibraryNames.includes(name)), 'H4_RUNTIME_DIRECT_LIBRARIES');
  const textAssets = checkModelManifest(model);
  requireEvidence(identity.model === 'qwen2.5:0.5b-instruct-q4_K_M' &&
    identity.digest === evidenceFiles.model[1] && cpu.model === identity.model &&
    cpu.context === limits.context, 'H4_MODEL_BINDING');
  const candidateArchives = localArchives(assetsPath);
  return {
    verdict: 'HOLD_GPU_HARD_LIMIT_UNPROVEN',
    dispatchAllowed: false,
    releaseAllowed: false,
    savedSourcesVerified: Object.keys(records).length,
    compatibility: {
      status: 'PLATFORM_MATCH_FROM_READONLY_METADATA',
      observedAt: nx.at, jetpack: '6.2+b77', l4t: '36.4.3', arch: view.arch,
      kernel: view.kernel, cuda: '12.6.11', cudnn: view.packages['libcudnn9-cuda-12'], backendDirectorySeen: true,
      observedCharDevices: view.devices.filter(entry => entry.char === true).length,
      deviceAllowlistQualified: false,
    },
    historicalOffload: { observedRelease: oldRelease.release, ...historicalOffload(oldGpu, oldGpuAssets) },
    plannedModel: {
      tag: cpu.model, manifestSha256: identity.digest,
      blobDescriptors: textAssets.length, blobBytes: textAssets.reduce((bytes, row) => bytes + row.size, 0),
      gpuExecutionVerified: false,
    },
    engine: {
      plannedRelease: 'v0.40.16', backend: 'cuda_jetpack6', archives: candidateArchives,
      hostDiskFingerprint: {
        observedAt: fingerprint.at, diskOnly: true, binarySha256: probe.runtime.sha256,
        backendSha256: backend.sha256, backendBytes: backend.bytes, directLibraryNames,
      },
      liveLoadedDependencyClosureVerified: false,
    },
    proposedLimits: limits,
    blockers: [
      ...(candidateArchives.every(archive => archive.status === 'LOCAL_BYTES_MATCH') ? [] : ['GPU_ASSET_CONTENT_UNVERIFIED']),
      'GPU_RUNNER_AND_DEVICE_ISOLATION_UNVERIFIED',
      'GPU_DEPENDENCY_CLOSURE_AND_OFFLOAD_UNVERIFIED',
      'GPU_ATTEMPT_HARD_LIMIT_AND_ACCOUNTING_UNPROVEN',
      'GPU_TEARDOWN_AND_INDEPENDENT_WITNESS_UNVERIFIED',
      'GPU_PRIVILEGED_ENTRY_AND_LIVE_APPROVAL_ABSENT',
    ],
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [evidence, assets, ...extra] = process.argv.slice(2);
    requireEvidence(evidence && !extra.length, 'USAGE');
    console.log(JSON.stringify(verifyH4Preflight(evidence, assets), null, 2));
    // 本入口永遠維持 HOLD，避免將離線報告接成派送前的成功條件。
    process.exitCode = 42;
  } catch (error) {
    const code = /^[A-Z][A-Z0-9_]{2,80}$/u.test(error.message) ? error.message : 'H4_INPUT_REJECTED';
    console.error(JSON.stringify({ verdict: 'HOLD_H4_INPUT_REFUSED', dispatchAllowed: false, releaseAllowed: false, code }));
    process.exitCode = 1;
  }
}
