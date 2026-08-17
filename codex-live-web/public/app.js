const preferenceKeys = {
  collapseToolCalls: 'codex-live-web.collapse-tool-calls',
  collapseToolOutputs: 'codex-live-web.collapse-tool-outputs',
  language: 'codex-live-web.language',
};

const translations = {
  'zh-CN': {
    openSessions: '打开会话列表', connecting: '正在连接', selectSession: '选择会话',
    followLatest: '跟随最新会话', autoScroll: '自动滚动', clearView: '清空当前视图', stopViewer: '停止查看器',
    switchLanguage: 'Switch to English', languageCode: 'EN', searchSessions: '搜索会话', refreshSessions: '刷新会话',
    sessionList: 'Codex 会话列表', eventTypes: '事件类型', filterAll: '全部', filterDialogue: '对话', filterTools: '工具',
    searchCurrentSession: '在当前会话中查找', collapseSettings: '工具折叠设置', collapse: '折叠',
    toolCall: '工具执行', toolOutput: '工具返回', readingSessions: '正在读取会话', reading: '正在读取',
    live: '实时', waitingToReconnect: '等待重连', turnStart: '开始', turnComplete: '完成',
    turnCompleteDuration: '完成 · {duration} 秒', user: '用户', developer: '开发者输入', reasoningSummary: '推理摘要',
    tokenUsage: 'Token 用量', cumulative: '累计 {value}', totalInput: '总输入', cachedInput: '缓存输入',
    totalOutput: '总输出', reasoningOutput: '推理输出', currentContext: '本轮上下文', noUsage: '暂无用量数据',
    noMatchingEvents: '没有匹配的事件', waitForToolOutput: '等待工具返回', functionCall: '函数调用',
    stopping: '正在停止', stopped: '已停止', stopFailed: '停止失败', connectionFailed: '连接失败',
    eventCount: '{count} 项', eventSingular: '项', eventPlural: '项',
  },
  en: {
    openSessions: 'Open session list', connecting: 'Connecting', selectSession: 'Select a session',
    followLatest: 'Follow latest session', autoScroll: 'Auto-scroll', clearView: 'Clear current view', stopViewer: 'Stop viewer',
    switchLanguage: '切换到中文', languageCode: '中', searchSessions: 'Search sessions', refreshSessions: 'Refresh sessions',
    sessionList: 'Codex session list', eventTypes: 'Event type', filterAll: 'All', filterDialogue: 'Dialogue', filterTools: 'Tools',
    searchCurrentSession: 'Search in current session', collapseSettings: 'Tool collapse settings', collapse: 'Collapse',
    toolCall: 'Tool call', toolOutput: 'Tool output', readingSessions: 'Loading sessions', reading: 'Loading',
    live: 'Live', waitingToReconnect: 'Waiting to reconnect', turnStart: 'Started', turnComplete: 'Completed',
    turnCompleteDuration: 'Completed · {duration} sec', user: 'User', developer: 'Developer input', reasoningSummary: 'Reasoning summary',
    tokenUsage: 'Token usage', cumulative: 'Total {value}', totalInput: 'Total input', cachedInput: 'Cached input',
    totalOutput: 'Total output', reasoningOutput: 'Reasoning output', currentContext: 'Current context', noUsage: 'No usage data',
    noMatchingEvents: 'No matching events', waitForToolOutput: 'Waiting for tool output', functionCall: 'Function call',
    stopping: 'Stopping', stopped: 'Stopped', stopFailed: 'Failed to stop', connectionFailed: 'Connection failed',
    eventCount: '{count} {unit}', eventSingular: 'item', eventPlural: 'items',
  },
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

function readStoredLanguage() {
  try {
    const value = localStorage.getItem(preferenceKeys.language);
    return Object.hasOwn(translations, value) ? value : 'zh-CN';
  } catch {
    return 'zh-CN';
  }
}

function storeLanguage(value) {
  try {
    localStorage.setItem(preferenceKeys.language, value);
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
  language: readStoredLanguage(),
  liveStatusMode: '',
  liveStatusKey: 'connecting',
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
  languageButton: document.querySelector('#languageButton'),
};

function t(key, replacements = {}) {
  const template = translations[state.language]?.[key] ?? translations['zh-CN'][key] ?? key;
  return template.replace(/\{(\w+)\}/g, (_, name) => replacements[name] ?? `{${name}}`);
}

function applyLanguage({ rerender = true } = {}) {
  document.documentElement.lang = state.language;
  document.querySelectorAll('[data-i18n]').forEach((element) => { element.textContent = t(element.dataset.i18n); });
  document.querySelectorAll('[data-i18n-label]').forEach((element) => {
    const label = t(element.dataset.i18nLabel);
    element.title = label;
    element.setAttribute('aria-label', label);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((element) => { element.placeholder = t(element.dataset.i18nPlaceholder); });
  document.querySelectorAll('[data-i18n-aria]').forEach((element) => { element.setAttribute('aria-label', t(element.dataset.i18nAria)); });
  elements.languageButton.title = t('switchLanguage');
  elements.languageButton.setAttribute('aria-label', t('switchLanguage'));
  elements.languageButton.querySelector('.language-code').textContent = t('languageCode');
  if (!state.activeSession) elements.activeTitle.textContent = t('selectSession');
  setLiveStatus(state.liveStatusMode, state.liveStatusKey);
  if (rerender) {
    renderSessions();
    renderTimeline();
  }
}

function setLanguage(language) {
  state.language = language;
  storeLanguage(language);
  applyLanguage();
}

function formatDate(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat(state.language, {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(value));
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function formatNumber(value) {
  return new Intl.NumberFormat(state.language).format(Number(value || 0));
}

function formatDecimal(value) {
  return new Intl.NumberFormat(state.language, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value);
}

function formatEventCount(count) {
  return t('eventCount', { count: formatNumber(count), unit: t(count === 1 ? 'eventSingular' : 'eventPlural') });
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
  setLiveStatus('loading', 'reading');
  renderSessions();

  const data = await fetchJson(`/api/session?token=${encodeURIComponent(token)}`);
  state.events = data.events || [];
  state.activeSession = { ...(state.sessions.find((item) => item.token === token) || { token, title: data.path, path: data.path }), fileSize: data.fileSize };
  elements.activeTitle.textContent = state.activeSession.title;
  elements.activeMeta.textContent = `${data.path} · ${formatBytes(data.fileSize)}`;
  renderTimeline();
  connectLive(token, data.fileSize, data.lineCount);
  closeSidebar();
}

function connectLive(token, offset, line) {
  const source = new EventSource(`/api/live?token=${encodeURIComponent(token)}&offset=${offset}&line=${line}`);
  state.eventSource = source;
  source.addEventListener('ready', () => setLiveStatus('live', 'live'));
  source.onmessage = (message) => {
    if (state.activeToken !== token) return;
    const event = JSON.parse(message.data);
    if (state.events.some((item) => item.id === event.id && item.line === event.line)) return;
    state.events.push(event);
    appendEventIfVisible(event);
  };
  source.onerror = () => setLiveStatus('error', 'waitingToReconnect');
}

function closeLive() {
  if (state.eventSource) state.eventSource.close();
  state.eventSource = null;
}

function setLiveStatus(mode, key) {
  state.liveStatusMode = mode;
  state.liveStatusKey = key;
  elements.liveStatus.className = `live-status ${mode}`;
  elements.liveStatus.lastChild.textContent = t(key);
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
  elements.eventCount.textContent = formatEventCount(count);
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
  elements.eventCount.textContent = formatEventCount(elements.timeline.querySelectorAll('[data-event]').length);
  refreshIcons(node);
  if (state.autoScroll) scrollToBottom(false);
}

function renderEvent(event) {
  if (event.kind === 'turn-start') return renderTurnDivider(event, t('turnStart'), 'play');
  if (event.kind === 'turn-complete') return renderTurnDivider(event, event.durationMs ? t('turnCompleteDuration', { duration: formatDecimal(event.durationMs / 1000) }) : t('turnComplete'), 'check');
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
    user: [t('user'), 'user-round'], assistant: ['Codex', 'sparkles'], developer: [t('developer'), 'braces'], 'reasoning-summary': [t('reasoningSummary'), 'brain'],
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
  const title = isCall ? toolDisplayName(event.name) : t('toolOutput');
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
      <span class="tool-title">${icon('gauge')}<strong>${t('tokenUsage')}</strong></span>
      <span class="token-summary">${t('cumulative', { value: formatNumber(usage.total.all) })}${icon('chevron-down')}</span>
    </summary>
    <div class="token-body">
      <div class="usage-grid">
        ${usageMetric(t('totalInput'), usage.total.input)}
        ${usageMetric(t('cachedInput'), usage.total.cached)}
        ${usageMetric(t('totalOutput'), usage.total.output)}
        ${usageMetric(t('reasoningOutput'), usage.total.reasoning)}
      </div>
      ${contextPercent === null ? '' : `
        <div class="context-row"><span>${t('currentContext')}</span><strong>${formatNumber(usage.last.all)} / ${formatNumber(usage.contextWindow)}</strong></div>
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
    elements.tokenOverviewBody.innerHTML = `<span class="no-usage">${t('noUsage')}</span>`;
    return;
  }
  const usage = latest.usage;
  const contextPercent = usage.contextWindow ? Math.min(100, (usage.last.all / usage.contextWindow) * 100) : null;
  elements.tokenOverviewLabel.textContent = `Token ${formatNumber(usage.total.all)}`;
  elements.tokenOverviewBody.innerHTML = `
    <div class="usage-grid">
      ${usageMetric(t('totalInput'), usage.total.input)}
      ${usageMetric(t('cachedInput'), usage.total.cached)}
      ${usageMetric(t('totalOutput'), usage.total.output)}
      ${usageMetric(t('reasoningOutput'), usage.total.reasoning)}
    </div>
    ${contextPercent === null ? '' : `
      <div class="context-row"><span>${t('currentContext')}</span><strong>${formatNumber(usage.last.all)} / ${formatNumber(usage.contextWindow)}</strong></div>
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
  div.innerHTML = `${icon('messages-square', 24)}<strong>${t('noMatchingEvents')}</strong>`;
  return div;
}

function shortId(value = '') {
  return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-5)}` : value;
}

function toolDisplayName(value = '') {
  const normalized = String(value).split('.').pop().toLowerCase();
  const labels = {
    exec: t('toolCall'),
    exec_command: t('toolCall'),
    shell_command: t('toolCall'),
    wait: t('waitForToolOutput'),
    function: t('functionCall'),
    tool: t('toolCall'),
  };
  return labels[normalized] || value || t('toolCall');
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
  setLiveStatus('loading', 'stopping');
  try {
    const response = await fetch('/api/shutdown', { method: 'POST' });
    if (!response.ok) throw new Error(response.statusText);
    closeLive();
    setLiveStatus('error', 'stopped');
    window.close();
  } catch (error) {
    button.disabled = false;
    setLiveStatus('error', 'stopFailed');
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
elements.languageButton.addEventListener('click', () => setLanguage(state.language === 'zh-CN' ? 'en' : 'zh-CN'));

applyLanguage({ rerender: false });
refreshIcons();
loadSessions({ preserveSelection: false }).catch((error) => {
  setLiveStatus('error', 'connectionFailed');
  elements.timeline.replaceChildren(createEmptyState());
  console.error(error);
});
setInterval(() => loadSessions().catch(() => {}), 3000);
