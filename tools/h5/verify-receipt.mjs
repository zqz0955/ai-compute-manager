import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { IDENTIFIER, SHA256 } from '../config.mjs';
import { readJson } from '../files.mjs';
import { hash } from '../../src/worker/simulation.mjs';

const exact = (value, names) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const valid = (value, syntax) => typeof value === 'string' && syntax.test(value);
const need = (pass, reason) => { if (!pass) throw Error(reason); };
const select = (object, names) => Object.fromEntries(names.map(name => [name, object[name]]));
const fields = ['id', 'attemptId', 'nodeId', 'resource', 'source', 'digest', 'state'];
const nodeAliases = node => [...new Set([node.nodeId, 'node:' + node.nodeId, node.resource, ...node.aliases]
  .map(key => key.toLowerCase()))].sort();
const lockFields = ['jobId', 'attemptId', 'nodeId', 'resource', 'phase', 'aliases'];
const eventFields = ['seq', 'jobId', 'attemptId', 'nodeId', 'event', 'at'];

export function projectH5Snapshot(snapshot) {
  return {
    jobs: snapshot.jobs.map(job => ({ ...select(job, fields), cleanupConfirmed: job.cleanup.confirmed })),
    locks: snapshot.locks.map(lock => select(lock, lockFields)),
    events: snapshot.events.map(event => ({ ...select(event, eventFields),
      intent: event.event === 'INTENT' ? hash(event.detail.binding) : null,
      terminal: event.event === 'RELEASE' ? hash(event.detail.evidence) : null,
    })),
  };
}

function currentJobs(snapshot, nodes, requiredSource) {
  need(exact(snapshot, ['jobs', 'locks', 'events']) && Array.isArray(snapshot.jobs) &&
    snapshot.jobs.length === 2 && Array.isArray(snapshot.locks) && snapshot.locks.length <= 2 &&
    Array.isArray(snapshot.events) && snapshot.events.length > 0 && snapshot.events.length < 200, 'H5_SNAPSHOT_INCOMPLETE');
  const byJob = new Map();
  for (const job of snapshot.jobs) {
    need(exact(job, [...fields, 'cleanupConfirmed']) && valid(job.id, uuid) && valid(job.attemptId, uuid) &&
      !byJob.has(job.id) && job.source === requiredSource &&
      nodes.some(node => job.nodeId === node.nodeId && job.resource === node.resource && job.digest === node.modelSha256) &&
      typeof job.cleanupConfirmed === 'boolean', 'H5_JOB_BINDING_INVALID');
    byJob.set(job.id, job);
  }
  for (const lock of snapshot.locks) {
    const job = byJob.get(lock?.jobId);
    const node = nodes.find(node => node.nodeId === job?.nodeId);
    need(exact(lock, lockFields) && job && node && lock.attemptId === job.attemptId &&
      lock.nodeId === job.nodeId && lock.resource === job.resource && Array.isArray(lock.aliases) &&
      isDeepStrictEqual([...lock.aliases].sort(), nodeAliases(node)), 'H5_LOCK_BINDING_INVALID');
  }
  for (const [index, event] of snapshot.events.entries()) {
    const job = byJob.get(event?.jobId);
    need(exact(event, [...eventFields, 'intent', 'terminal']) && job && Number.isSafeInteger(event.seq) &&
      event.seq === index + 1 && Number.isSafeInteger(event.at) && event.at >= (snapshot.events[index - 1]?.at ?? 0) &&
      ((event.event === 'QUEUED' && event.attemptId === null && event.nodeId === null) ||
        (event.attemptId === job.attemptId && event.nodeId === job.nodeId)) &&
      (event.event === 'INTENT' ? valid(event.intent, SHA256) : event.intent === null) &&
      (event.event === 'RELEASE' ? valid(event.terminal, SHA256) : event.terminal === null), 'H5_EVENT_SEQUENCE_OR_BINDING_INVALID');
  }
  for (const job of snapshot.jobs) {
    const own = snapshot.events.filter(event => event.jobId === job.id);
    const intents = own.filter(event => event.event === 'INTENT');
    const queued = own.filter(event => event.event === 'QUEUED');
    need(intents.length === 1 && queued.length === 1 && queued[0].seq < intents[0].seq, 'H5_DUPLICATE_OR_MISSING_INTENT');
  }
  return byJob;
}

export function verifyH5(value) {
  need(exact(value, ['version', 'kind', 'source', 'nodes', 'controllerBuildSha256', 'restartProofSha256',
    'transportLossProofSha256', 'failedJobId', 'active', 'reopened']) && value.version === 1 &&
    value.kind === 'MULTINODE_TRANSPORT_LOSS' && ['SIMULATION', 'ISOLATED_REAL_ENGINE'].includes(value.source) &&
    ['controllerBuildSha256', 'restartProofSha256', 'transportLossProofSha256'].every(name => valid(value[name], SHA256)) &&
    Array.isArray(value.nodes) && value.nodes.length === 2, 'H5_RECEIPT_INVALID');
  const aliases = new Map(), physical = new Set(), approvals = new Set();
  for (const node of value.nodes) {
    need(exact(node, ['nodeId', 'resource', 'aliases', 'physicalIdSha256', 'admissionSha256', 'modelSha256']) &&
      valid(node.nodeId, IDENTIFIER) && valid(node.resource, IDENTIFIER) && Array.isArray(node.aliases) &&
      node.aliases.length <= 32 && node.aliases.every(alias => valid(alias, IDENTIFIER)) &&
      ['physicalIdSha256', 'admissionSha256', 'modelSha256'].every(name => valid(node[name], SHA256)) &&
      (value.source !== 'ISOLATED_REAL_ENGINE' || node.resource === node.physicalIdSha256), 'H5_NODE_ADMISSION_INVALID');
    need(!physical.has(node.physicalIdSha256) && !approvals.has(node.admissionSha256), 'H5_DUPLICATE_PHYSICAL_DEVICE_OR_ADMISSION');
    physical.add(node.physicalIdSha256);
    approvals.add(node.admissionSha256);
    for (const alias of nodeAliases(node)) {
      need(!aliases.has(alias), 'H5_NODE_ALIAS_COLLISION');
      aliases.set(alias, node.nodeId);
    }
  }

  const active = currentJobs(value.active, value.nodes, value.source);
  const reopened = currentJobs(value.reopened, value.nodes, value.source);
  const failed = reopened.get(value.failedJobId);
  const healthy = [...reopened.values()].find(job => job.id !== value.failedJobId);
  need(failed && healthy && failed.nodeId !== healthy.nodeId && failed.attemptId !== healthy.attemptId &&
    isDeepStrictEqual(value.active.events, value.reopened.events.slice(0, value.active.events.length)) &&
    value.active.events.every(event => ['QUEUED', 'INTENT'].includes(event.event)), 'H5_ACTIVE_HISTORY_CHANGED');

  need(value.active.locks.length === 2 && new Set(value.active.locks.map(lock => lock.jobId)).size === 2 &&
    value.active.locks.every(lock => lock.phase === 'INTENT'), 'H5_PARALLEL_INTENT_NOT_OBSERVED');
  for (const [id, job] of active) {
    const after = reopened.get(id);
    need(after && job.state === 'RUNNING' && job.cleanupConfirmed === false &&
      fields.slice(0, -1).every(key => job[key] === after[key]), 'H5_JOB_REDISPATCH_OR_BINDING_CHANGED');
  }
  const tail = value.reopened.events.slice(value.active.events.length);
  need(tail.length === 2 && tail.some(event => event.jobId === failed.id && ['EVIDENCE_HOLD', 'CRASH_HOLD'].includes(event.event)) &&
    tail.some(event => event.jobId === healthy.id && event.event === 'RELEASE'), 'H5_HOLD_RELEASE_EVIDENCE_MISSING');
  need(value.reopened.locks.length === 1 && value.reopened.locks[0].jobId === failed.id &&
    value.reopened.locks[0].phase === 'HOLD' && failed.state === 'INTERRUPTED' && failed.cleanupConfirmed === false &&
    healthy.state === 'SUCCEEDED' && healthy.cleanupConfirmed === true, 'H5_REOPENED_HOLD_OR_RELEASE_INVALID');

  return { status: 'H5_EVIDENCE_CONSISTENT', source: value.source, physicalDevices: 2, simultaneousIntentCount: 2,
    interruptedLockHeldAfterRestart: true, healthyPeerReleased: true, replayedAttempts: 0, hardwareQualified: false,
    gate: 'INDEPENDENT_RAW_EVIDENCE_AND_HARDWARE_REVIEW_REQUIRED' };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const [receipt, expected, ...extra] = process.argv.slice(2);
    need(receipt && valid(expected, SHA256) && extra.length === 0, 'USAGE_H5_RECEIPT_SHA256_REQUIRED');
    const record = readJson(receipt);
    need(record.sha256 === expected, 'H5_RECEIPT_SHA_MISMATCH');
    console.log(JSON.stringify(verifyH5(record.value)));
  } catch (error) {
    console.error(JSON.stringify({ status: 'HOLD', code: /^[A-Z0-9_]{3,80}$/u.test(error.message)
      ? error.message : 'H5_RECEIPT_REJECTED' }));
    process.exitCode = 1;
  }
}
