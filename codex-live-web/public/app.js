const preferenceKeys = {
  collapseToolCalls: 'codex-live-web.collapse-tool-calls',
  collapseToolOutputs: 'codex-live-web.collapse-tool-outputs',
};

function readStoredBoolean(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value === 'true';
  } catch {
    return fallback;
  }
}

function storeBoolean(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch {}
}

const state = {
  sessions: [],
  activeToken: null,
  activeSession: null,
  events: [],
  eventSource: null,
  filter: 'all',
  search: '',
  sessionSearch: '',
  autoScroll: true,
  followLatest: true,
  collapseToolCalls: readStoredBoolean(preferenceKeys.collapseToolCalls, false),
  collapseToolOutputs: readStoredBoolean(preferenceKeys.collapseToolOutputs, true),
};

const markdown = window.markdownit?.({ html: false, linkify: true, typographer: true, breaks: true });
if (markdown) {
  const originalLinkOpen = markdown.renderer.rules.link_open;
  markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
    const token = tokens[index];
    const href = token.attrGet('href') || '';
    if (/^(https?:|mailto:)/i.test(href)) {
      token.attrSet('target', '_blank');
      token.attrSet('rel', 'noreferrer noopener');
    } else {
      token.attrSet('href', '#');
    }
    return originalLinkOpen ? originalLinkOpen(tokens, index, options, env, self) : self.renderToken(tokens, index, options);
  };
}

const elements = {
  timeline: document.querySelector('#timeline'),
  emptyState: document.querySelector('#emptyState'),
  sessionList: document.querySelector('#sessionList'),
  activeTitle: document.querySelector('#activeTitle'),
  activeMeta: document.querySelector('#activeMeta'),
  liveStatus: document.querySelector('#liveStatus'),
  eventCount: document.querySelector('#eventCount'),
  eventSearch: document.querySelector('#eventSearch'),
  sessionSearch: document.querySelector('#sessionSearch'),
  followButton: document.querySelector('#followButton'),
  autoscrollButton: document.querySelector('#autoscrollButton'),
  collapseToolCalls: document.querySelector('#collapseToolCalls'),
  collapseToolOutputs: document.querySelector('#collapseToolOutputs'),
  tokenOverview: document.querySelector('#tokenOverview'),
  tokenOverviewLabel: document.querySelector('#tokenOverviewLabel'),
  tokenOverviewBody: document.querySelector('#tokenOverviewBody'),
  sidebar: document.querySelector('#sidebar'),
  sidebarScrim: document.querySelector('#sidebarScrim'),
};

function formatDate(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(value));
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function formatNumber(value) {
  return new Intl.NumberFormat('zh-CN').format(Number(value || 0));
}

function icon(name, size = 16) {
  return `<i data-lucide="${name}" style="width:${size}px;height:${size}px"></i>`;
}

function refreshIcons(root = document) {
  if (window.lucide) window.lucide.createIcons({ root });
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || response.statusText);
  return response.json();
}

async function loadSessions({ preserveSelection = true } = {}) {
  const data = await fetchJson('/api/sessions');
  const previousLatest = state.sessions[0]?.token;
  state.sessions = data.sessions || [];
  renderSessions();

  const latest = state.sessions[0];
  if (!latest) return;
  if (!state.activeToken || (!preserveSelection && latest.token !== state.activeToken)) {
    await selectSession(latest.token, { following: true });
  } else if (state.followLatest && previousLatest && latest.token !== previousLatest && latest.token !== state.activeToken) {
    await selectSession(latest.token, { following: true });
  }
}

function renderSessions() {
  const needle = state.sessionSearch.toLowerCase();
  const visible = state.sessions.filter((session) => `${session.title} ${session.path} ${session.id}`.toLowerCase().includes(needle));
  elements.sessionList.replaceChildren();
  for (const session of visible) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `session-row${session.token === state.activeToken ? ' selected' : ''}`;
    button.dataset.token = session.token;
    button.innerHTML = `
      <span class="session-title">${escapeHtml(session.title)}</span>
      <span class="session-meta"><time>${formatDate(session.updatedAt)}</time><span>${formatBytes(session.size)}</span></span>
    `;
    button.addEventListener('click', () => selectSession(session.token, { following: session.token === state.sessions[0]?.token }));
    elements.sessionList.append(button);
  }
}

async function selectSession(token, { following = false } = {}) {
  closeLive();
  state.activeToken = token;
  state.followLatest = following;
  elements.followButton.classList.toggle('active', state.followLatest);
  setLiveStatus('loading', '正在读取');
  renderSessions();

  const data = await fetchJson(`/api/session?token=${encodeURIComponent(token)}`);
  state.events = data.events || [];
  state.activeSession = state.sessions.find((item) => item.token === token) || { token, title: data.path, path: data.path };
  elements.activeTitle.textContent = state.activeSession.title;
  elements.activeMeta.textContent = `${data.path} · ${formatBytes(data.fileSize)}`;
  renderTimeline();
  connectLive(token, data.fileSize, data.lineCount);
  closeSidebar();
}

function connectLive(token, offset, line) {
  const source = new EventSource(`/api/live?token=${encodeURIComponent(token)}&offset=${offset}&line=${line}`);
  state.eventSource = source;
  source.addEventListener('ready', () => setLiveStatus('live', '实时'));
  source.onmessage = (message) => {
    if (state.activeToken !== token) return;
    const event = JSON.parse(message.data);
    if (state.events.some((item) => item.id === event.id && item.line === event.line)) return;
    state.events.push(event);
    appendEventIfVisible(event);
  };
  source.onerror = () => setLiveStatus('error', '等待重连');
}

function closeLive() {
  if (state.eventSource) state.eventSource.close();
  state.eventSource = null;
}

function setLiveStatus(mode, label) {
  elements.liveStatus.className = `live-status ${mode}`;
  elements.liveStatus.lastChild.textContent = label;
}

function eventMatches(event) {
  if (event.kind === 'token') return false;
  if (state.filter === 'dialogue' && !['user', 'assistant', 'developer', 'reasoning-summary'].includes(event.kind)) return false;
  if (state.filter === 'tools' && !['tool-call', 'tool-output'].includes(event.kind)) return false;
  if (state.search && !(event.searchText || '').toLowerCase().includes(state.search)) return false;
  return true;
}

function renderTimeline() {
  updateTokenOverview();
  const fragment = document.createDocumentFragment();
  let count = 0;
  for (const event of state.events) {
    if (!eventMatches(event)) continue;
    const node = renderEvent(event);
    if (node) { fragment.append(node); count += 1; }
  }
  elements.timeline.replaceChildren(fragment);
  if (count === 0) elements.timeline.append(createEmptyState());
  elements.eventCount.textContent = `${count} 项`;
  refreshIcons(elements.timeline);
  if (state.autoScroll) scrollToBottom(false);
}

function appendEventIfVisible(event) {
  if (event.kind === 'token') {
    updateTokenOverview();
    return;
  }
  if (!eventMatches(event)) return;
  const empty = elements.timeline.querySelector('.empty-state');
  if (empty) empty.remove();
  const node = renderEvent(event);
  if (!node) return;
  elements.timeline.append(node);
  elements.eventCount.textContent = `${elements.timeline.querySelectorAll('[data-event]').length} 项`;
  refreshIcons(node);
  if (state.autoScroll) scrollToBottom(false);
}

function renderEvent(event) {
  if (event.kind === 'turn-start') return renderTurnDivider(event, '开始', 'play');
  if (event.kind === 'turn-complete') return renderTurnDivider(event, event.durationMs ? `完成 · ${(event.durationMs / 1000).toFixed(1)} 秒` : '完成', 'check');
  if (event.kind === 'token') return renderTokenEvent(event);
  if (event.kind === 'tool-call' || event.kind === 'tool-output') return renderToolEvent(event);
  if (['user', 'assistant', 'developer', 'reasoning-summary'].includes(event.kind)) return renderMessageEvent(event);
  return null;
}

function renderMessageEvent(event) {
  const article = document.createElement('article');
  article.className = `event message-event ${event.kind}`;
  article.dataset.event = event.id;
  const labels = {
    user: ['用户', 'user-round'], assistant: ['Codex', 'sparkles'], developer: ['开发者输入', 'braces'], 'reasoning-summary': ['推理摘要', 'brain'],
  };
  const [label, iconName] = labels[event.kind];
  article.innerHTML = `
    <header class="event-header">
      <span class="event-role">${icon(iconName)}${label}</span>
      <time>${formatDate(event.timestamp)}</time>
    </header>
    <div class="rich-content">${event.html || renderMarkdown(event.markdown || '')}</div>
  `;
  return article;
}

function renderToolEvent(event) {
  const details = document.createElement('details');
  details.className = `event tool-event ${event.kind}`;
  details.dataset.event = event.id;
  const isCall = event.kind === 'tool-call';
  const title = isCall ? toolDisplayName(event.name) : '工具返回';
  details.open = isCall ? !state.collapseToolCalls : !state.collapseToolOutputs;
  details.innerHTML = `
    <summary>
      <span class="tool-title">${icon(isCall ? 'terminal' : 'square-terminal')}<strong>${escapeHtml(title)}</strong></span>
      <span class="tool-meta"><code>${escapeHtml(shortId(event.callId))}</code><time>${formatDate(event.timestamp)}</time>${icon('chevron-down')}</span>
    </summary>
    <div class="tool-body">${event.code || renderCode(event.codeText || '', event.language || 'text')}</div>
  `;
  return details;
}

function renderTokenEvent(event) {
  const details = document.createElement('details');
  details.className = 'event token-event';
  details.dataset.event = event.id;
  const usage = event.usage;
  const contextPercent = usage.contextWindow ? Math.min(100, (usage.last.all / usage.contextWindow) * 100) : null;
  details.innerHTML = `
    <summary>
      <span class="tool-title">${icon('gauge')}<strong>Token 用量</strong></span>
      <span class="token-summary">累计 ${formatNumber(usage.total.all)}${icon('chevron-down')}</span>
    </summary>
    <div class="token-body">
      <div class="usage-grid">
        ${usageMetric('总输入', usage.total.input)}
        ${usageMetric('缓存输入', usage.total.cached)}
        ${usageMetric('总输出', usage.total.output)}
        ${usageMetric('推理输出', usage.total.reasoning)}
      </div>
      ${contextPercent === null ? '' : `
        <div class="context-row"><span>本轮上下文</span><strong>${formatNumber(usage.last.all)} / ${formatNumber(usage.contextWindow)}</strong></div>
        <div class="context-track"><span style="width:${contextPercent.toFixed(2)}%"></span></div>
      `}
    </div>
  `;
  return details;
}

function updateTokenOverview() {
  const latest = [...state.events].reverse().find((event) => event.kind === 'token');
  if (!latest) {
    elements.tokenOverviewLabel.textContent = 'Token';
    elements.tokenOverviewBody.innerHTML = '<span class="no-usage">暂无用量数据</span>';
    return;
  }
  const usage = latest.usage;
  const contextPercent = usage.contextWindow ? Math.min(100, (usage.last.all / usage.contextWindow) * 100) : null;
  elements.tokenOverviewLabel.textContent = `Token ${formatNumber(usage.total.all)}`;
  elements.tokenOverviewBody.innerHTML = `
    <div class="usage-grid">
      ${usageMetric('总输入', usage.total.input)}
      ${usageMetric('缓存输入', usage.total.cached)}
      ${usageMetric('总输出', usage.total.output)}
      ${usageMetric('推理输出', usage.total.reasoning)}
    </div>
    ${contextPercent === null ? '' : `
      <div class="context-row"><span>本轮上下文</span><strong>${formatNumber(usage.last.all)} / ${formatNumber(usage.contextWindow)}</strong></div>
      <div class="context-track"><span style="width:${contextPercent.toFixed(2)}%"></span></div>
    `}
  `;
}

function usageMetric(label, value) {
  return `<div class="usage-metric"><span>${label}</span><strong>${formatNumber(value)}</strong></div>`;
}

function renderTurnDivider(event, label, iconName) {
  const div = document.createElement('div');
  div.className = 'turn-divider';
  div.dataset.event = event.id;
  div.innerHTML = `<span>${icon(iconName)}${label}</span><time>${formatDate(event.timestamp)}</time>`;
  return div;
}

function createEmptyState() {
  const div = document.createElement('div');
  div.className = 'empty-state';
  div.innerHTML = `${icon('messages-square', 24)}<strong>没有匹配的事件</strong>`;
  return div;
}

function shortId(value = '') {
  return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-5)}` : value;
}

function toolDisplayName(value = '') {
  const normalized = String(value).split('.').pop().toLowerCase();
  const labels = {
    exec: '工具执行',
    exec_command: '工具执行',
    shell_command: '工具执行',
    wait: '等待工具返回',
    function: '函数调用',
    tool: '工具执行',
  };
  return labels[normalized] || value || '工具执行';
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char]);
}

function renderMarkdown(value = '') {
  return markdown ? markdown.render(String(value)) : `<p>${escapeHtml(value).replaceAll('\n', '<br>')}</p>`;
}

function renderCode(value = '', language = 'text') {
  const safeLanguage = String(language).replace(/[^a-z0-9_-]/gi, '') || 'text';
  return `<pre class="code-block"><code class="hljs language-${safeLanguage}">${escapeHtml(value)}</code></pre>`;
}

function scrollToBottom(smooth) {
  elements.timeline.scrollTo({ top: elements.timeline.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
}

function closeSidebar() {
  document.body.classList.remove('sidebar-open');
}

document.querySelectorAll('[data-filter]').forEach((button) => {
  button.addEventListener('click', () => {
    state.filter = button.dataset.filter;
    document.querySelectorAll('[data-filter]').forEach((item) => item.classList.toggle('selected', item === button));
    renderTimeline();
  });
});

elements.eventSearch.addEventListener('input', (event) => {
  state.search = event.target.value.trim().toLowerCase();
  renderTimeline();
});

elements.sessionSearch.addEventListener('input', (event) => {
  state.sessionSearch = event.target.value.trim();
  renderSessions();
});

document.querySelector('#refreshButton').addEventListener('click', () => loadSessions());
document.querySelector('#clearButton').addEventListener('click', () => {
  state.events = [];
  renderTimeline();
});

document.querySelector('#shutdownButton').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  setLiveStatus('loading', '正在停止');
  try {
    const response = await fetch('/api/shutdown', { method: 'POST' });
    if (!response.ok) throw new Error(response.statusText);
    closeLive();
    setLiveStatus('error', '已停止');
    window.close();
  } catch (error) {
    button.disabled = false;
    setLiveStatus('error', '停止失败');
    console.error(error);
  }
});

elements.autoscrollButton.addEventListener('click', () => {
  state.autoScroll = !state.autoScroll;
  elements.autoscrollButton.classList.toggle('active', state.autoScroll);
  if (state.autoScroll) scrollToBottom(true);
});

elements.followButton.addEventListener('click', async () => {
  state.followLatest = !state.followLatest;
  elements.followButton.classList.toggle('active', state.followLatest);
  if (state.followLatest && state.sessions[0]?.token !== state.activeToken) {
    await selectSession(state.sessions[0].token, { following: true });
  }
});

elements.collapseToolCalls.checked = state.collapseToolCalls;
elements.collapseToolOutputs.checked = state.collapseToolOutputs;

elements.collapseToolCalls.addEventListener('change', (event) => {
  state.collapseToolCalls = event.target.checked;
  storeBoolean(preferenceKeys.collapseToolCalls, state.collapseToolCalls);
  renderTimeline();
});

elements.collapseToolOutputs.addEventListener('change', (event) => {
  state.collapseToolOutputs = event.target.checked;
  storeBoolean(preferenceKeys.collapseToolOutputs, state.collapseToolOutputs);
  renderTimeline();
});

document.querySelector('#sidebarToggle').addEventListener('click', () => document.body.classList.add('sidebar-open'));
elements.sidebarScrim.addEventListener('click', closeSidebar);

refreshIcons();
loadSessions({ preserveSelection: false }).catch((error) => {
  setLiveStatus('error', '连接失败');
  elements.timeline.replaceChildren(createEmptyState());
  console.error(error);
});
setInterval(() => loadSessions().catch(() => {}), 3000);
