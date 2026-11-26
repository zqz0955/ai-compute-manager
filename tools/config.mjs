export const TOKEN_SCOPES = Object.freeze(['manage:read', 'models:run', 'manage:write', 'telemetry:publish']);
export const SHA256 = /^[a-f0-9]{64}$/u;
export const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const modelId = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/u;
const statuses = ['ONLINE', 'OFFLINE', 'UNVERIFIED', 'UNKNOWN', 'UNAVAILABLE', 'ERROR', 'DEGRADED', 'LOCKED'];
const nodeFields = ['id', 'name', 'resource', 'aliases', 'platform', 'status', 'metrics',
  'cpuCores', 'gpuBytes', 'ramBytes', 'diskBytes', 'swapBytes', 'gpu', 'models', 'resident'];
const metricFields = ['cpuPercent', 'gpuPercent', 'ramUsedBytes', 'gpuUsedBytes', 'diskUsedBytes',
  'swapUsedBytes', 'temperatureC', 'sampledAt'];
const shape = (object, required, allowed = required) => object !== null && typeof object === 'object' &&
  !Array.isArray(object) && required.every(key => Object.hasOwn(object, key)) &&
  Object.keys(object).every(key => allowed.includes(key));
const integer = (value, low, high = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= low && value <= high;
const matches = (value, pattern) => typeof value === 'string' && pattern.test(value);
const nullable = (value, check) => value === undefined || value === null || check(value);
const byteCount = value => integer(value, 0);
const acceptableLabel = value => typeof value === 'string' && value.trim() === value &&
  value.length > 0 && value.length <= 120 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
const list = (value, limit, check) => Array.isArray(value) && value.length <= limit && value.every(check);

function model(value) {
  return shape(value, ['id', 'digest', 'context', 'maxTokens', 'device'],
    ['id', 'digest', 'context', 'maxTokens', 'device', 'ramBytes', 'diskBytes', 'gpuBytes']) &&
    matches(value.id, modelId) && matches(value.digest, SHA256) &&
    integer(value.context, 1) && integer(value.maxTokens, 1, value.context) &&
    ['cpu', 'gpu'].includes(value.device) && ['ramBytes', 'diskBytes', 'gpuBytes'].every(key => nullable(value[key], byteCount));
}

function metrics(value) {
  return shape(value, [], metricFields) && metricFields.every(key => nullable(value[key], sample => {
    if (key === 'sampledAt' || key.endsWith('Bytes')) return byteCount(sample);
    if (key === 'temperatureC') return Number.isFinite(sample) && sample >= -40 && sample <= 200;
    return Number.isFinite(sample) && sample >= 0 && sample <= 100;
  }));
}

export function validateNode(value) {
  if (!shape(value, ['id', 'name', 'resource', 'aliases', 'platform', 'status'], nodeFields) ||
      !matches(value.id, IDENTIFIER) || !matches(value.resource, IDENTIFIER) ||
      !acceptableLabel(value.name) || !matches(value.platform, IDENTIFIER) || !statuses.includes(value.status) ||
      !list(value.aliases, 32, alias => matches(alias, IDENTIFIER)) ||
      !nullable(value.cpuCores, count => integer(count, 1, 4096)) ||
      !['gpuBytes', 'ramBytes', 'diskBytes', 'swapBytes'].every(key => nullable(value[key], byteCount)) ||
      !nullable(value.metrics, metrics) ||
      !nullable(value.gpu, gpu => shape(gpu, ['state'], ['state', 'backend', 'sharedMemory']) &&
        ['SUPPORTED', 'UNSUPPORTED', 'UNKNOWN'].includes(gpu.state) &&
        nullable(gpu.backend, backend => matches(backend, IDENTIFIER)) &&
        nullable(gpu.sharedMemory, shared => typeof shared === 'boolean')) ||
      !nullable(value.models, values => list(values, 128, model)) ||
      !nullable(value.resident, values => list(values, 128, id => matches(id, modelId)))) {
    throw new Error('INVALID_NODE_CAPABILITIES');
  }
  if (new Set(value.aliases.map(alias => alias.toLowerCase())).size !== value.aliases.length ||
      (value.models && new Set(value.models.map(entry => entry.id)).size !== value.models.length) ||
      (value.resident && (new Set(value.resident).size !== value.resident.length ||
        !value.resident.every(id => value.models?.some(entry => entry.id === id))))) {
    throw new Error('INVALID_NODE_IDENTITIES');
  }
  return value;
}

function validateMonitoring(value, ids) {
  if (!shape(value, [], ['windowsLocal','sources']) ||
      Object.hasOwn(value,'windowsLocal') && typeof value.windowsLocal!=='boolean' ||
      Object.hasOwn(value,'sources')&&!Array.isArray(value.sources) ||
      !list(value.sources??[],32,source=>
        shape(source,['nodeId','kind','publicKey','tokenId'],['nodeId','kind','publicKey','tokenId','name']) &&
        matches(source.nodeId,IDENTIFIER) && matches(source.tokenId,IDENTIFIER) &&
        /^[A-Za-z0-9_-]{59}$/.test(source.publicKey ?? '') &&
        ['JETSON_AGENT','V06_V07_BRIDGE'].includes(source.kind) &&
        nullable(source.name,acceptableLabel))) throw Error('INVALID_MONITORING_CONFIG');
  const keys=new Set();
  if (value.windowsLocal) {
    if (ids.has('windows-local')) throw Error('MONITORING_NODE_COLLISION');
    ids.add('windows-local');
  }
  for (const source of value.sources??[]){
    const id=source.nodeId.toLowerCase();
    if (id==='windows-local'||ids.has(id)||keys.has(source.publicKey)) throw Error('MONITORING_NODE_COLLISION');
    ids.add(id);
    keys.add(source.publicKey);
  }
}

export function validateConfig(value) {
  const fields=['version','mode','port','dataDir','tokenFile','nodes','maxConcurrent'];
  if (!shape(value,fields,[...fields,'monitoring']) ||
      value.version !== 1 || !['read-only', 'simulation'].includes(value.mode) ||
      !integer(value.port, 0, 65535) || [8875, 8897].includes(value.port) ||
      value.dataDir !== './data' || value.tokenFile !== './tokens.json' ||
      !Array.isArray(value.nodes) || value.nodes.length > 64 || !integer(value.maxConcurrent, 1, 16)) {
    throw new Error('INVALID_INSTALLATION_CONFIG');
  }
  const ids = new Set();
  const resources = new Map();
  for (const node of value.nodes) {
    validateNode(node);
    const id = node.id.toLowerCase();
    if (ids.has(id)) throw new Error('DUPLICATE_NODE_ID');
    ids.add(id);
    for (const alias of [node.id, node.resource, ...node.aliases]) {
      const key = alias.toLowerCase();
      if (resources.has(key) && resources.get(key) !== node.resource) throw new Error('NODE_ALIAS_CONFLICT');
      resources.set(key, node.resource);
    }
  }
  if (Object.hasOwn(value,'monitoring')) validateMonitoring(value.monitoring,ids);
  return value;
}

export function validateTokens(value) {
  if (!shape(value, ['version', 'tokens'], ['version', 'tokens', 'revokedIds']) ||
      value.version !== 1 || !list(value.tokens, 256, row => (
    shape(row, ['id', 'sha256', 'scopes', 'expiresAt']) && matches(row.id, IDENTIFIER) &&
    matches(row.sha256, SHA256) && integer(row.expiresAt, 1) && row.scopes?.length > 0 &&
    list(row.scopes, TOKEN_SCOPES.length, scope => TOKEN_SCOPES.includes(scope)) &&
    new Set(row.scopes).size === row.scopes.length
  ))) throw new Error('INVALID_TOKEN_REGISTRY');
  const retired = value.revokedIds ?? [];
  if (!list(retired, 4096, id => matches(id, IDENTIFIER)) ||
      (Object.hasOwn(value, 'revokedIds') && value.revokedIds === null) ||
      retired.length + value.tokens.length > 4096 ||
      new Set([...value.tokens.map(row => row.id), ...retired].map(id => id.toLowerCase())).size !== value.tokens.length + retired.length ||
      new Set(value.tokens.map(row => row.sha256)).size !== value.tokens.length) throw new Error('INVALID_TOKEN_REGISTRY');
  return value;
}
