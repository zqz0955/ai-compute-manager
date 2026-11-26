const el = id => document.getElementById(id);
const unknown = 'UNKNOWN';
const offlineMessage = '請先連線以讀取資料。';
const apiRoot = '/acm/v1';
const inputLimit = 32768;
const encoder = new TextEncoder();
const active = new Set(['QUEUED', 'RUNNING', 'STOPPING']);
const taskStates = ['QUEUED', 'RUNNING', 'STOPPING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'INTERRUPTED'];
const labels = {
  SIMULATED: '模擬節點', ONLINE: '在線', OFFLINE: '離線', UNVERIFIED: '端點未確認',
  LOCKED: '實機保護', PAUSED: '暫緩採樣', DISABLED: '已停用', HOLD: '保留',
  READY: '可用', BUSY: '占用中', FRESH: '採樣有效', STALE: '採樣過期',
  QUEUED: '排隊', RUNNING: '執行中', STOPPING: '收尾中', SUCCEEDED: '完成',
  FAILED: '失敗', CANCELLED: '取消', INTERRUPTED: '結果不明', TIMED_OUT: '逾時', REJECTED: '拒絕',
};
const platforms = { 'orin-nano': 'Orin Nano', 'orin-nx': 'Orin NX', agx: 'AGX', 'dgx-spark': 'DGX Spark', linux: 'Linux', 'linux-arm64':'Linux ARM64', windows: 'Windows 本機' };
const gateLabels = { inference: '推論', cleanup: '實機清理', hardware: '實機', gpu: 'GPU', remoteAccess: '遠端存取' };
const placementReasons = {
  READ_ONLY_MODE: '唯讀模式禁止派送', OBSERVATION_NOT_EXECUTION_QUALIFICATION: '觀測資料不授予執行資格',
  TELEMETRY_STALE: '採樣已過期', TELEMETRY_UNKNOWN: '採樣或身分無法核對', NODE_OFFLINE: '節點已回報離線',
};
const modes = { simulation: '離線模擬', 'read-only': '唯讀管理' };
const observedSources = new Set(['WINDOWS_LOCAL', 'JETSON_AGENT', 'V06_V07_BRIDGE']);
const sampleMaxAgeMs = 15000;
const sources = { SIMULATION: '離線模擬', CONFIGURED_ONLY: '僅配置資料', WINDOWS_LOCAL:'Windows 本機採樣',
  JETSON_AGENT:'Jetson Agent 遙測', V06_V07_BRIDGE:'既有唯讀監控轉接', OBSERVED:'實際遙測', MIXED:'實際與模擬來源' };
const dualOverlap = { observed: '觀測到重疊', sequential: '先後執行', pending: '擷取時待判定', unknown: '時間重疊未知' };
const fmt = new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 2 });
const dateFmt = new Intl.DateTimeFormat('zh-TW', {
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

let session;
const finite = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isFinite(value) && value >= min && value <= max;
const number = (value, unit, min = 0) => finite(value, min) ? fmt.format(value) + (unit ? ' ' + unit : '') : unknown;
const gib = value => finite(value) ? number(value / 1024 ** 3, 'GiB') : unknown;
const percent = value => finite(value, 0, 100) ? number(value, '%') : unknown;
const timestamp = value => finite(value, 0, 8640000000000000);
const time = value => timestamp(value) ? dateFmt.format(value) : unknown;
const display = value => typeof value === 'string' && value.length ? value : unknown;
const rows = value => Array.isArray(value) ? value : [];
const structured = value => value && typeof value === 'object' ? JSON.stringify(value, null, 2) : display(value);
const stateName = state => Object.hasOwn(labels, state) ? labels[state] + ' · ' + state : display(state);
const jobPath = id => apiRoot + '/jobs/' + encodeURIComponent(id);
const modeOf = mode => Object.hasOwn(modes, mode) ? modes[mode] : unknown;
const sourceOf = source => Object.hasOwn(sources, source) ? sources[source] + ' · ' + source : display(source);

function make(tag, text, className) {
  const item = document.createElement(tag);
  if (text !== undefined) item.textContent = text;
  if (className) item.className = className;
  return item;
}

function statusBadge(status, item = make('span', '', 'badge')) {
  item.textContent = stateName(status);
  item.dataset.state = display(status);
  return item;
}

function facts(values, list = make('dl', '', 'facts')) {
  list.replaceChildren();
  for (const [label, value] of values) {
    const entry = make('dd');
    entry.append(value ?? unknown);
    list.append(make('dt', label), entry);
  }
  return list;
}

function selectOptions(id, options, placeholder) {
  const select = el(id);
  const previous = select.value;
  const choices = placeholder ? [['', placeholder], ...options] : options;
  select.replaceChildren(...choices.map(([value, name]) => new Option(name, value)));
  if (choices.some(([value]) => value === previous)) select.value = previous;
  select.disabled = options.length === 0;
}

async function request(path, token, signal, { method = 'GET', body, idempotencyKey } = {}) {
  const headers = { Authorization: 'Bearer ' + token };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (idempotencyKey) headers['Idempotency-Key']=idempotencyKey;
  const response = await fetch(path, {
    headers, signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store', credentials: 'omit', mode: 'same-origin', redirect: 'error',
  });
  const data = await response.json();
  if (!response.ok) {
    throw Object.assign(Error(data.error?.message || '請求失敗'), {
      code: data.error?.code, status: response.status, requestId: data.requestId,
    });
  }
  return data;
}

function describeError(error) {
  if (error.status) {
    const parts = ['HTTP ' + error.status, error.code, error.message, error.requestId ? '請求 ' + error.requestId : null];
    return parts.filter(Boolean).join(' · ');
  }
  return error.name === 'TimeoutError' ? '連線等候逾時。' : '無法取得有效的同源回應。';
}

function nodeName(id, nodes = rows(session.dashboard?.nodes)) {
  return nodes.find(node => node.id === id)?.name || display(id);
}

function metric(label, value) {
  const cell = make('div', '', 'metric');
  cell.append(make('span', label), make('strong', value));
  return cell;
}

function nodeCard(node) {
  const metrics = node.metrics || {};
  const card = make('article', '', 'panel node');
  const heading = make('div', '', 'section-head');
  const identity = make('div');
  const platform = Object.hasOwn(platforms, node.platform) ? platforms[node.platform] : display(node.platform);
  identity.append(make('h3', display(node.name)), make('p', platform + ' · ' + node.id, 'muted endpoint'));
  heading.append(identity, statusBadge(node.status));
  const summary = make('div', '', 'metrics');
  summary.append(
    metric('CPU 使用率', percent(metrics.cpuPercent)),
    metric('GPU 使用率', percent(metrics.gpuPercent)),
    metric('RAM 使用／總量', gib(metrics.ramUsedBytes) + ' / ' + gib(metrics.ramBytes ?? node.ramBytes)),
    metric('磁碟使用／總量', gib(metrics.diskUsedBytes) + ' / ' + gib(metrics.diskBytes ?? node.diskBytes)),
  );
  const hardware = make('div', '', 'node-state-row');
  hardware.append(
    make('span', 'CPU 核心 ' + number(node.cpuCores), 'chip'),
    make('span', 'GPU 記憶體 ' + gib(node.gpuBytes), 'chip'),
    make('span', '交換空間 ' + gib(metrics.swapUsedBytes) + ' / ' + gib(node.swapBytes), 'chip'),
    make('span', '溫度 ' + number(metrics.temperatureC, '°C', -100), 'chip'),
  );
  const provenance = [
    sourceOf(node.source),
    '採樣 · ' + stateName(node.freshness),
    '使用狀態 · ' + stateName(node.availability),
    'GPU 能力 · ' + [display(node.gpu?.state), node.gpu?.backend].filter(Boolean).join(' / '),
  ];
  const footer = make('div', '', 'node-footer');
  const history = make('a', '查看監控歷史', 'link');
  history.href = '#history';
  history.setAttribute('aria-label', '查看 ' + display(node.name) + ' 的監控歷史');
  history.addEventListener('click', () => {
    el('history-node').value = node.id;
    changeHistoryNode();
  });
  footer.append(make('span', '採樣時間 · ' + time(metrics.sampledAt), 'muted'), history);
  card.append(heading, summary, hardware, make('p', provenance.join('　'), 'muted work-note'));
  if (rows(node.aliases).length) card.append(make('p', '資源別名 · ' + node.aliases.join('、'), 'muted work-note'));
  card.append(footer);
  return card;
}

function emptyPanel(text) {
  return make('p', text, 'panel fleet-empty empty-state muted');
}

function renderModels() {
  const all = rows(session.dashboard?.nodes);
  const selectedNode = el('model-node').value;
  const nodes = selectedNode ? all.filter(node => node.id === selectedNode) : all;
  const cards = nodes.map(node => {
    const panel = make('article', '', 'panel work-panel');
    const resident = rows(node.resident);
    panel.append(make('h3', display(node.name)), make('p', '駐留模型 · ' + (
      Array.isArray(node.resident) ? resident.join('、') || '清單為空' : unknown
    ), 'muted work-note'));
    if (!rows(node.models).length) panel.append(make('p', node.models===null?'已安裝模型 · UNKNOWN':'已安裝模型清單為空。', 'muted'));
    for (const model of rows(node.models)) {
      const entry = make('div', '', 'model-row');
      entry.append(make('h4', display(model.id)), facts([
        ['資料來源', sourceOf(node.source)],
        ['摘要', make('code', display(model.digest), 'digest')],
        ['Context', number(model.context, 'tokens')],
        ['輸出上限', number(model.maxTokens, 'tokens')],
        ['裝置', display(model.device)],
      ]));
      panel.append(entry);
    }
    return panel;
  });
  el('model-inventory').replaceChildren(...(cards.length ? cards : [emptyPanel(session.dashboard ? '尚無節點模型紀錄。' : offlineMessage)]));
}

function renderDiagnostics() {
  const data = session.dashboard;
  const placement = data?.placement;
  const readonlyJudgment = placement?.kind === 'READ_ONLY_ADMISSION' && placement.status === 'REJECTED';
  facts([
    ['版本', display(data?.version)],
    ['工作模式', modeOf(data?.mode)],
    ['資料來源', sourceOf(data?.source)],
    ['既有歷史', data?.archive ? display(data.archive.source) : data ? '未導入' : unknown],
    ...Object.entries(data?.gates || {}).map(([key, value]) => [
      Object.hasOwn(gateLabels, key) ? gateLabels[key] : key,
      typeof value === 'boolean' ? (value ? '啟用' : 'HOLD') : structured(value),
    ]),
    ['唯讀准入判斷', readonlyJudgment ? '拒絕派送 · 唯讀模式' :
      placement?.status === 'NOT_EVALUATED' ? 'NOT_EVALUATED · 此視圖未評估可派送資格' : unknown],
    ...(readonlyJudgment ? [
      ['判斷時間', time(placement.evaluatedAt)],
      ['選擇結果', Array.isArray(placement.selection) && placement.selection.length === 0 ? '無選取節點' : unknown],
      ['資源操作', placement.reservationPerformed === false && placement.dispatchPerformed === false ?
        '本診斷未執行資源預留或派送；尚未驗證實機佇列及優先級。' : unknown],
      ...rows(placement.nodes).map(row => [nodeName(row.nodeId) + ' · 不可派送',
        rows(row.reasons).map(reason => (placementReasons[reason] || unknown) + ' · ' + display(reason)).join('；') +
        '；目前採樣：' + stateName(rows(data.nodes).find(node => node.id === row.nodeId)?.freshness)]),
    ] : []),
  ], el('gate-facts'));
  const lockList = rows(data?.locks);
  el('lock-status').textContent = !data ? offlineMessage : lockList.length ? lockList.length + ' 筆鎖定紀錄。' : '目前沒有資源鎖紀錄。';
  el('locks').replaceChildren(...lockList.map(lock => {
    const item = make('li');
    const header = make('div', '', 'section-head wrap');
    header.append(make('strong', display(lock.resource)), statusBadge(lock.state || lock.phase));
    item.append(header, facts([
      ['節點', nodeName(lock.nodeId)], ['工作', display(lock.jobId)], ['嘗試', display(lock.attemptId)],
      ['理由', structured(lock.reason || rows(data.jobs).find(job => job.id === lock.jobId)?.cleanup?.reason)],
      ['別名', rows(lock.aliases).join('、') || unknown],
    ]));
    return item;
  }));
  const events = rows(data?.events);
  el('event-status').textContent = data ? (events.length ? events.length + ' 筆事件。' : '目前沒有事件紀錄。') : offlineMessage;
  el('event-table').hidden = !events.length;
  el('events').replaceChildren(...events.slice().reverse().map(event => {
    const row = make('tr');
    row.append(make('td', time(event.at)), make('td', display(event.event)),
      make('td', display(event.jobId) + ' / ' + nodeName(event.nodeId)), make('td', event.detail ? structured(event.detail) : '—'));
    return row;
  }));
}

function renderDashboard() {
  const data = session.dashboard;
  const nodes = rows(data?.nodes);
  const options = nodes.map(node => [node.id, node.name || node.id]);
  const mode = modeOf(data?.mode);
  el('mode').textContent = data ? display(data.version) + ' · ' + mode : 'v1.0.0-preview.1 · 尚未連線';
  el('mode-notice').hidden = !data;
  el('mode-notice').dataset.mode = data?.mode || '';
  el('mode-notice').textContent = data?.mode === 'simulation'
    ? '離線模擬 · 模擬節點的資源、採樣與工作結果來自模擬。實機執行維持 HOLD。'
    : '唯讀管理 · 僅顯示可讀取的紀錄，實機推論與遠端操作維持 HOLD。';
  el('node-count').textContent = data ? nodes.length + ' 個裝置' : '';
  el('nodes').replaceChildren(...(nodes.length ? nodes.map(nodeCard) :
    [emptyPanel(data ? '尚無節點紀錄。' : offlineMessage)]));
  selectOptions('model-node', options, '全部節點');
  selectOptions('task-node', options, '全部節點');
  selectOptions('history-node', options, nodes.length ? undefined : '尚無節點');
  updateHistoryCompare();
  selectOptions('task-state-filter', data ? taskStates.map(state => [state, stateName(state)]) : [], '全部狀態');
  el('history-refresh').disabled = !options.length;
  const models = new Map(nodes.filter(node=>node.source==='SIMULATION').flatMap(node => rows(node.models)).map(model => [model.id, model.id]));
  selectOptions('run-model', [...models], models.size ? undefined : '尚無可選模型');
  renderModels();
  renderTaskList();
  renderArchive(data?.archive);
  renderDiagnostics();
  syncRunControls();
}

function expireObservations(current) {
  clearTimeout(current.sampleExpiry);
  if (session !== current || !current.dashboard) return false;
  const now = Math.max(Date.now(), current.receivedAt + performance.now() - current.receivedTick);
  let changed = false;
  let next = Infinity;
  const data = current.dashboard;
  data.nodes = data.nodes.map(node => {
    if (!observedSources.has(node.source) || node.freshness !== 'FRESH') return node;
    const sampledAt = node.metrics?.sampledAt;
    const remaining = timestamp(sampledAt) ? sampleMaxAgeMs - Math.max(0, now - sampledAt) : 0;
    if (remaining > 0) {
      next = Math.min(next, remaining);
      return node;
    }
    changed = true;
    return { ...node, status: unknown, freshness: 'STALE', metrics: { sampledAt },
      ramBytes: null, swapBytes: null, diskBytes: null, models: null, resident: null };
  });
  if (changed && !data.nodes.some(node => observedSources.has(node.source) && node.freshness === 'FRESH')) {
    data.source = data.mode === 'simulation' ? 'SIMULATION' : 'CONFIGURED_ONLY';
  }
  if (Number.isFinite(next)) {
    current.sampleExpiry = setTimeout(() => {
      if (expireObservations(current)) renderDashboard();
    }, Math.ceil(next));
  }
  return changed;
}

async function loadDashboard() {
  const current = session;
  if (!current.readToken || current.refreshing) return;
  current.refreshing = true;
  accessControls();
  el('access-status').textContent = '正在讀取總覽…';
  try {
    const data = await request(apiRoot + '/dashboard', current.readToken, current.controller.signal);
    if (session !== current) return;
    if (!Object.hasOwn(modes, data.mode) || !Array.isArray(data.nodes) || !Array.isArray(data.jobs)) throw Error('dashboard response');
    current.dashboard = data;
    current.receivedAt = Date.now();
    current.receivedTick = performance.now();
    expireObservations(current);
    el('access-status').textContent = '已讀取工作區。' + (
      current.runToken ? ' 模型執行憑證已提供，由服務在使用時驗證。' : ''
    );
    renderDashboard();
    if (historyNodes().join() !== current.history?.key) void loadHistory();
  } catch (error) {
    if (session !== current) return;
    current.dashboard = null;
    clearTimeout(current.sampleExpiry);
    stopViewing();
    current.history = null;
    renderDashboard();
    clearHistory(offlineMessage);
    el('access-status').textContent = '總覽讀取失敗 · ' + describeError(error);
  } finally {
    if (session === current) {
      current.refreshing = false;
      accessControls();
    }
  }
}

const metrics = [
  { name: 'CPU 使用率', unit: '%', get: row => finite(row.cpuPercent, 0, 100) ? row.cpuPercent : null, fixed: 100 },
  { name: 'GPU 使用率', unit: '%', get: row => finite(row.gpuPercent, 0, 100) ? row.gpuPercent : null, fixed: 100 },
  { name: 'RAM 使用量', unit: 'GiB', get: row => finite(row.ramUsedBytes) ? row.ramUsedBytes / 1024 ** 3 : null },
  { name: '磁碟使用量', unit: 'GiB', get: row => finite(row.diskUsedBytes) ? row.diskUsedBytes / 1024 ** 3 : null },
  { name: '溫度', unit: '°C', get: row => finite(row.temperatureC, -100) ? row.temperatureC : null },
];

function svg(tag, attributes, text) {
  const item = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attributes)) item.setAttribute(key, value);
  if (text) item.textContent = text;
  return item;
}

function chart(spec, group, scale, bounds, comparing) {
  const panel = make('article', '', 'panel history-chart');
  const title = spec.name + '（' + spec.unit + '）';
  panel.append(make('h3', comparing ? title + ' · ' + nodeName(group.id) : title));
  const timeline = group.samples.filter(sample => timestamp(sample.sampledAt));
  const values = timeline.map(spec.get).filter(value => value !== null);
  if (!values.length) {
    panel.append(make('p', 'UNKNOWN · 尚無有效採樣', 'muted work-note'));
    return panel;
  }
  const graph = svg('svg', {
    viewBox: '0 0 460 128', role: 'img', 'aria-label': nodeName(group.id) + ' · ' + title + '變化圖。明細見採樣資料表。',
  });
  const [first, last] = bounds;
  const [min, max] = scale;
  for (const [y, value] of [[16, max], [58, (min + max) / 2], [100, min]]) {
    graph.append(svg('line', { x1: 45, x2: 448, y1: y, y2: y, class: 'chart-grid' }),
      svg('text', { x: 41, y: y + 4, 'text-anchor': 'end', class: 'chart-axis' }, fmt.format(value)));
  }
  let previous = null;
  let path = '';
  for (const row of timeline) {
    const value = spec.get(row);
    if (value === null) {
      previous = null;
      continue;
    }
    const x = last === first ? 246.5 : 45 + 403 * (row.sampledAt - first) / (last - first);
    const y = 100 - 84 * (value - min) / (max - min);
    const command = previous !== null && row.sampledAt - previous <= 15000 ? 'L' : 'M';
    path += command + x.toFixed(2) + ' ' + y.toFixed(2);
    graph.append(svg('circle', { cx: x, cy: y, r: 2.6, class: 'chart-point' }));
    previous = row.sampledAt;
  }
  graph.append(svg('path', { d: path, class: 'chart-line' }));
  panel.append(graph, make('p', values.length + ' 筆有效讀數 · ' + time(timeline[0].sampledAt) +
    ' 至 ' + time(timeline.at(-1).sampledAt), 'muted work-note'));
  return panel;
}

function clearHistory(message) {
  el('history-status').textContent = message;
  el('history-charts').replaceChildren();
  el('history-samples').replaceChildren();
  el('history-details').hidden = true;
}

function historyNodes() {
  return [el('history-node').value, el('history-compare').value].filter(Boolean);
}

function updateHistoryCompare() {
  const primary = el('history-node').value;
  const options = rows(session.dashboard?.nodes).filter(node => node.id !== primary).map(node => [node.id, node.name || node.id]);
  selectOptions('history-compare', options, '單一節點');
}

function changeHistoryNode() {
  updateHistoryCompare();
  void loadHistory();
}

async function loadHistory() {
  const current = session;
  const ids = historyNodes();
  if (!current.dashboard || !ids.length) {
    clearHistory(current.dashboard ? '目前沒有可查詢的節點。' : offlineMessage);
    return;
  }
  const selected = { key: ids.join() };
  current.history = selected;
  clearHistory('正在讀取監控採樣…');
  el('history-refresh').disabled = true;
  try {
    const results = await Promise.allSettled(ids.map(async id => {
      const path = apiRoot + '/dashboard/history?' + new URLSearchParams({ nodeId: id });
      const data = await request(path, current.readToken, current.controller.signal);
      if (!Array.isArray(data.samples)) throw Error('history response');
      return data.samples.filter(sample => sample?.nodeId === id).sort((a, b) => (a.sampledAt ?? 0) - (b.sampledAt ?? 0));
    }));
    if (session !== current || current.history !== selected) return;
    const groups = results.map((result, index) => ({
      id: ids[index], samples: result.status === 'fulfilled' ? result.value : [], error: result.reason,
    }));
    el('history-status').textContent = groups.map(group => {
      const { id, error, samples } = group;
      const source = [...new Set(samples.map(sample => sourceOf(sample.source)))].join('／');
      const detail = error ? '讀取失敗 · ' + describeError(error) :
        samples.length ? samples.length + ' 筆採樣 · ' + source : '目前未導入可讀取的採樣。';
      return nodeName(id) + ' · ' + detail;
    }).join('\n');
    const samples = groups.flatMap(group => group.samples);
    if (!samples.length) return;
    const comparing = groups.length > 1;
    const timeline = samples.filter(sample => timestamp(sample.sampledAt));
    const times = timeline.map(sample => sample.sampledAt);
    const bounds = [Math.min(...times), Math.max(...times)];
    el('history-charts').replaceChildren(...metrics.flatMap(spec => {
      const values = timeline.map(spec.get).filter(value => value !== null);
      const scale = [Math.min(0, ...values), spec.fixed ?? Math.max(1, ...values)];
      return groups.map(group => chart(spec, group, scale, bounds, comparing));
    }));
    samples.sort((a, b) => (b.sampledAt ?? 0) - (a.sampledAt ?? 0));
    el('history-samples').replaceChildren(...samples.map(sample => {
      const row = make('tr');
      row.append(make('td', time(sample.sampledAt)), make('td', nodeName(sample.nodeId) + ' / ' + sourceOf(sample.source)),
        ...metrics.map(spec => make('td', number(spec.get(sample), spec.unit, -100))));
      return row;
    }));
    el('history-details').hidden = false;
  } catch (error) {
    if (session === current && current.history === selected) clearHistory('監控歷史讀取失敗 · ' + describeError(error));
  } finally {
    if (session === current && current.history === selected) el('history-refresh').disabled = false;
  }
}

function renderTaskList() {
  const source = session.dashboard;
  const jobs = rows(source?.jobs);
  const selectedNode = el('task-node').value;
  const selectedState = el('task-state-filter').value;
  const counts = el('task-counts');
  counts.hidden = !source;
  counts.replaceChildren(...[
    ['排隊', jobs.filter(job => job.state === 'QUEUED').length],
    ['執行與收尾', jobs.filter(job => job.state === 'RUNNING' || job.state === 'STOPPING').length],
    ['完成', jobs.filter(job => job.state === 'SUCCEEDED').length],
    ['結果不明', jobs.filter(job => job.state === 'INTERRUPTED').length],
  ].map(([label, count]) => {
    const tile = make('div');
    tile.append(make('strong', count), make('span', label));
    return tile;
  }));
  const filtered = jobs.filter(job => (!selectedNode || job.nodeId === selectedNode) && (!selectedState || job.state === selectedState));
  filtered.sort((a, b) => Number(active.has(b.state)) - Number(active.has(a.state)) || (b.createdAt ?? 0) - (a.createdAt ?? 0));
  el('task-list-status').textContent = !source ? offlineMessage : filtered.length ? filtered.length + ' 筆工作。' : '目前沒有符合條件的工作。';
  const list = el('task-list');
  const focused = list.contains(document.activeElement) ? document.activeElement.dataset.jobId : '';
  list.replaceChildren(...filtered.map(job => {
    const row = make('li');
    const button = make('button', '', 'history-choice');
    button.type = 'button';
    button.dataset.jobId = job.id;
    button.setAttribute('aria-pressed', String(session.view?.id === job.id));
    button.append(make('strong', stateName(job.state) + ' · ' + display(job.model)),
      make('span', nodeName(job.nodeId) + ' · ' + time(job.createdAt), 'muted'));
    row.append(button);
    return row;
  }));
  if (focused) [...list.querySelectorAll('button')].find(button => button.dataset.jobId === focused)?.focus({ preventScroll: true });
}

function archivedJob(job) {
  const item = make('div', '', 'archive-job');
  item.append(make('strong', display(job.model)), facts([
    ['工作', display(job.id)], ['節點識別碼', display(job.nodeId)], ['類型', display(job.kind)],
    ['擷取時狀態', stateName(job.state)], ['建立', time(job.createdAt)],
    ['開始', time(job.startedAt)], ['結束', time(job.finishedAt)],
    ['錯誤', display(job.errorCode)],
  ]));
  return item;
}

function renderArchive(archive) {
  el('archive-status').textContent = archive
    ? '以下為舊版快照中的唯讀摘要。HOLD 筆數對應快照擷取當時的狀態。'
    : session.dashboard ? '既有工作與雙模型歷史尚未導入。' : offlineMessage;
  el('archive-facts').hidden = !archive;
  el('archive-records').hidden = !archive;
  const tasks = rows(archive?.tasks);
  const duals = rows(archive?.duals);
  facts([
    ['快照來源', display(archive?.source)], ['擷取時間', time(archive?.capturedAt)],
    ['歷史 API 請求', number(archive?.requestsCount)], ['歷史 HOLD', number(archive?.holdsCount)],
  ], el('archive-facts'));
  el('archive-task-count').textContent = tasks.length ? '顯示 ' + tasks.length + ' 筆工作摘要。' : '這份快照沒有工作摘要。';
  el('archive-dual-count').textContent = duals.length ? '顯示 ' + duals.length + ' 組雙模型摘要。' : '這份快照沒有雙模型摘要。';
  el('archive-tasks').replaceChildren(...tasks.map(job => {
    const row = make('li');
    row.append(archivedJob(job));
    return row;
  }));
  el('archive-duals').replaceChildren(...duals.map(group => {
    const row = make('li');
    const overlap = Object.hasOwn(dualOverlap, group.parallel) ? dualOverlap[group.parallel] : unknown;
    row.append(make('strong', display(group.id)), make('p', time(group.createdAt) + ' · ' + overlap, 'muted work-note'),
      ...rows(group.lanes).map(archivedJob));
    return row;
  }));
}

function renderJob(job) {
  el('task-state').hidden = !job;
  el('task-result').hidden = !job;
  if (!job) {
    el('task-answer').textContent = '';
    el('task-evidence').textContent = '';
    el('task-facts').replaceChildren();
    el('task-cleanup').textContent = '';
    el('task-cancel').hidden = true;
    return;
  }
  statusBadge(job.state, el('task-state'));
  const usage = job.usage || {};
  facts([
    ['工作', display(job.id)],
    ['類型', display(job.kind)],
    ['模型', display(job.model)],
    ['節點', nodeName(job.nodeId)],
    ['嘗試', display(job.attemptId)],
    ['建立', time(job.createdAt)],
    ['開始', time(job.startedAt)],
    ['結束', time(job.finishedAt)],
    ['耗時', number(job.durationMs, 'ms')],
    ['Token 用量', '輸入 ' + number(usage.prompt_tokens) + ' ／ 輸出 ' + number(usage.completion_tokens) + ' ／ 共 ' + number(usage.total_tokens)],
    ['排程決策', display(job.decision?.code || job.decision)],
    ['錯誤', job.error ? display(job.error.code || job.error) : '—'],
    ['清理回報', job.cleanup?.confirmed === true ? '已確認' : job.cleanup?.confirmed === false ? 'HOLD · 未確認' : unknown],
  ], el('task-facts'));
  const held = job.cleanup?.confirmed === false;
  el('task-cleanup').hidden = !held;
  el('task-cleanup').textContent = held ? 'HOLD · 清理未確認。理由 · ' + structured(job.cleanup.reason || job.cleanup.code) : '';
  el('task-answer').textContent = typeof job.output === 'string'
    ? (job.output || '模型回傳空白文字。')
    : '目前無可顯示的輸出。模型回應僅提供給工作建立者。';
  el('task-evidence').textContent = JSON.stringify({
    decision: job.decision ?? null, error: job.error ?? null, cleanup: job.cleanup ?? null,
  }, null, 2);
  const canCancel = session.dashboard?.mode === 'simulation' && session.runToken &&
    job.canCancel === true && (job.state === 'QUEUED' || job.state === 'RUNNING');
  el('task-cancel').hidden = !canCancel;
  el('task-cancel').disabled = !canCancel || session.view?.cancelling;
  if (session.lastRunId === job.id) el('run-status').textContent = '本次測試 · ' + stateName(job.state) + ' · ' + job.id;
}

function updateJob(current, view, job) {
  if (session !== current || current.view !== view) return;
  if (job?.id !== view.id) throw Error('job response');
  view.job = job;
  if (current.dashboard) {
    // 管理列表維持摘要，完整輸出只在本次已授權的工作檢視中展示。
    const { output, canCancel, ...summary } = job;
    current.dashboard.jobs = [summary, ...current.dashboard.jobs.filter(row => row.id !== job.id)];
  }
  renderJob(job);
  renderTaskList();
}

async function observeJob(current, view) {
  if (current.view !== view || view.fetch || view.cancelling) return;
  clearTimeout(view.timer);
  const controller = new AbortController();
  view.fetch = controller;
  const signal = AbortSignal.any([current.controller.signal, controller.signal]);
  const before = view.job.state;
  try {
    let result;
    if (view.useOwner) {
      try {
        result = await request(jobPath(view.id), current.runToken, signal);
      } catch (error) {
        if (![401, 403, 404].includes(error.status)) throw error;
        view.useOwner = false;
      }
    }
    if (!result) result = await request(jobPath(view.id), current.readToken, signal);
    if (session !== current || current.view !== view || controller.signal.aborted) return;
    updateJob(current, view, result.job);
    el('task-detail-status').textContent = '';
    if (active.has(before) && !active.has(view.job.state)) void loadDashboard();
  } catch (error) {
    if (session !== current || current.view !== view || controller.signal.aborted) return;
    renderJob({ ...view.job, output: undefined, canCancel: false });
    el('task-detail-status').textContent = '工作狀態讀取失敗 · ' + describeError(error);
    if (error.status && error.status < 500 && error.status !== 429) return;
  } finally {
    if (view.fetch === controller) view.fetch = null;
  }
  if (session === current && current.view === view && active.has(view.job.state)) {
    view.timer = setTimeout(() => void observeJob(current, view), 2400);
  }
}

function stopObservation(view) {
  if (!view) return;
  clearTimeout(view.timer);
  view.fetch?.abort();
  view.fetch = null;
}

function stopViewing() {
  stopObservation(session.view);
  session.view = null;
  el('task-detail-status').textContent = '選取工作以查看詳情。';
  renderJob(null);
}

function selectJob(job) {
  if (!job) return;
  stopViewing();
  const current = session;
  const view = { id: job.id, job, useOwner: Boolean(current.runToken), cancelling: false };
  current.view = view;
  el('task-detail-status').textContent = '正在讀取工作…';
  renderJob(job);
  renderTaskList();
  void observeJob(current, view);
}

async function cancelJob() {
  const current = session;
  const view = current.view;
  if (!view || view.cancelling || el('task-cancel').disabled) return;
  view.cancelling = true;
  stopObservation(view);
  el('task-cancel').disabled = true;
  el('task-detail-status').textContent = '正在送出取消請求…';
  try {
    const data = await request(jobPath(view.id) + '/cancel', current.runToken, current.controller.signal, { method: 'POST' });
    if (session !== current || current.view !== view) return;
    updateJob(current, view, data.job);
    el('task-detail-status').textContent = '取消請求已回應，請依工作狀態與清理紀錄判讀。';
  } catch (error) {
    if (session === current && current.view === view) el('task-detail-status').textContent =
      '取消請求未能確認 · ' + describeError(error);
  } finally {
    if (session === current && current.view === view) {
      view.cancelling = false;
      renderJob(view.job);
      void observeJob(current, view);
      void loadDashboard();
    }
  }
}

function accessControls() {
  const unavailable = !session.readToken || session.refreshing;
  el('dashboard-refresh').disabled = unavailable;
  el('task-refresh').disabled = unavailable;
  el('clear-credentials').disabled = !session.readToken && !session.runToken;
}

function inputBytes() {
  const used = encoder.encode(el('run-input').value).length;
  el('input-count').textContent = fmt.format(used) + ' / 32,768 UTF-8 bytes';
  el('run-input').setCustomValidity(used <= inputLimit ? '' : '測試輸入超過 32,768 UTF-8 bytes。');
  return used;
}

function modelTokenLimit() {
  const model = el('run-model').value;
  const limits = rows(session.dashboard?.nodes).filter(node=>node.source==='SIMULATION').flatMap(node => rows(node.models))
    .filter(row => row.id === model && Number.isInteger(row.maxTokens) && row.maxTokens > 0)
    .map(row => row.maxTokens);
  const limit = Math.min(64, ...limits);
  const control = el('max-tokens');
  control.max = String(limit);
  if (Number(control.value) > limit) control.value = String(limit);
}

function syncRunControls() {
  const data = session.dashboard;
  const gate = data?.gates?.inference;
  let blocked;
  if (!data) blocked = '請先讀取總覽以確認測試模式。';
  else if (data.mode !== 'simulation' || gate !== 'SIMULATION') {
    blocked = 'HOLD · 此模式禁止建立模型測試。';
  } else if (!session.runToken) blocked = '請在存取權限區加入 models:run 憑證。';
  else if (!el('run-model').value) blocked = '目前沒有可建立測試的已安裝模型。';
  el('run-controls').disabled = Boolean(blocked || session.sending);
  el('run-availability').textContent = blocked ||
    '離線模擬 · 排程器選擇節點，耗時與輸出來自模擬工作。';
  modelTokenLimit();
}

async function submitJob(event) {
  event.preventDefault();
  const current = session;
  if (el('run-controls').disabled || current.sending || inputBytes() > inputLimit) return;
  const input = el('run-input').value;
  if (!input.trim()) {
    el('run-status').textContent = '請輸入要測試的文字。';
    el('run-input').focus();
    return;
  }
  const body = {
    model: el('run-model').value,
    input,
    max_tokens: Number(el('max-tokens').value),
    priority: Number(el('run-priority').value),
  };
  const serialized=JSON.stringify(body);
  const idempotencyKey=current.pendingRun?.serialized===serialized?current.pendingRun.key:crypto.randomUUID();
  current.pendingRun={serialized,key:idempotencyKey};
  current.sending = true;
  syncRunControls();
  el('run-status').textContent = '正在建立模擬工作…';
  try {
    const data = await request(apiRoot + '/jobs', current.runToken, current.controller.signal, { method: 'POST', body, idempotencyKey });
    if (session !== current) return;
    if (typeof data.job?.id !== 'string') throw Error('job response');
    current.pendingRun=null;
    current.lastRunId = data.job.id;
    el('run-result-link').hidden = false;
    el('run-input').value = '';
    inputBytes();
    selectJob(data.job);
    updateJob(current, current.view, data.job);
  } catch (error) {
    if (session === current) el('run-status').textContent = (!error.status || error.status >= 500
      ? '送出結果未確認。請先更新任務中心，重送相同內容會核對原請求。'
      : '工作建立失敗。') + ' ' + describeError(error);
  } finally {
    if (session === current) {
      current.sending = false;
      syncRunControls();
    }
  }
}

function resetSession(readToken = '', runToken = '') {
  session?.controller.abort();
  clearTimeout(session?.sampleExpiry);
  stopObservation(session?.view);
  session = { readToken, runToken, controller: new AbortController(), dashboard: null, view: null, history: null };
  el('access').reset();
  el('run-form').reset();
  el('run-result-link').hidden = true;
  el('run-status').textContent = '';
  el('access-status').textContent = '輸入管理讀取憑證以載入工作區。';
  inputBytes();
  stopViewing();
  clearHistory(offlineMessage);
  renderDashboard();
  accessControls();
}

el('enrollment').addEventListener('submit',event=>{
  event.preventDefault();
  const get=id=>el('enroll-'+id).value.trim();
  const idPattern=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
  const nodeId=get('id'),tokenId=get('publisher'),publicKey=get('key'),name=get('name'),kind=get('source');
  if(!idPattern.test(nodeId)||nodeId.toLowerCase()==='windows-local'||!idPattern.test(tokenId)||
      !/^[A-Za-z0-9_-]{59}$/.test(publicKey)||!['JETSON_AGENT','V06_V07_BRIDGE'].includes(kind)){
    el('enroll-result').hidden=true;
    el('enroll-status').textContent='請核對節點、發送者識別及 Ed25519 公鑰。';
    return;
  }
  el('enroll-output').value=JSON.stringify({nodeId,kind,publicKey,tokenId,...(name?{name}:{})},null,2);
  el('enroll-result').hidden=false;
  el('enroll-status').textContent='設定已備妥。請由本機管理員核對後加入設定檔，重新手動啟動。';
});
el('copy-enrollment').addEventListener('click',async()=>{
  try {
    await navigator.clipboard.writeText(el('enroll-output').value);
    el('enroll-status').textContent='已複製唯讀來源設定。';
  } catch {
    el('enroll-output').select();
    el('enroll-status').textContent='請使用鍵盤複製選取的設定。';
  }
});
el('access').addEventListener('submit', event => {
  event.preventDefault();
  const read = el('read-token').value.trim();
  const run = el('run-token').value.trim();
  el('access').reset();
  if (!read && !run) {
    el('access-status').textContent = '請輸入要套用的憑證。';
    return;
  }
  resetSession(read || session.readToken, run || (read && read !== session.readToken ? '' : session.runToken));
  if (session.readToken) void loadDashboard();
  else el('access-status').textContent = '模型執行憑證已提供。請加入管理讀取憑證以載入工作區。';
});
el('clear-credentials').addEventListener('click', () => {
  resetSession();
  el('read-token').focus();
});
el('dashboard-refresh').addEventListener('click', () => void loadDashboard());
el('task-refresh').addEventListener('click', () => {
  void loadDashboard();
  if (session.view) void observeJob(session, session.view);
});
el('model-node').addEventListener('change', renderModels);
el('task-node').addEventListener('change', renderTaskList);
el('task-state-filter').addEventListener('change', renderTaskList);
el('history-node').addEventListener('change', changeHistoryNode);
el('history-compare').addEventListener('change', () => void loadHistory());
el('history-refresh').addEventListener('click', () => void loadHistory());
el('task-list').addEventListener('click', event => {
  const button = event.target.closest('button[data-job-id]');
  if (!button) return;
  selectJob(rows(session.dashboard?.jobs).find(job => job.id === button.dataset.jobId));
  el('task-detail').focus({ preventScroll: true });
});
el('task-cancel').addEventListener('click', () => void cancelJob());
el('run-model').addEventListener('change', modelTokenLimit);
el('run-input').addEventListener('input', inputBytes);
el('run-form').addEventListener('submit', submitJob);
el('run-result-link').addEventListener('click', () => {
  if (session.view?.id !== session.lastRunId) selectJob(rows(session.dashboard?.jobs).find(job => job.id === session.lastRunId));
  el('task-detail').focus({ preventScroll: true });
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && expireObservations(session)) renderDashboard();
});
window.addEventListener('pagehide', () => resetSession());

function markNavigation() {
  const hash = location.hash === '#task-detail' ? '#tasks' : location.hash;
  const links = [...document.querySelectorAll('.work-nav a')];
  const current = links.find(link => link.getAttribute('href') === hash) || links[0];
  for (const link of links) {
    if (link === current) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  }
}

window.addEventListener('hashchange', markNavigation);
resetSession();
markNavigation();
