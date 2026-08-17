import hljs from 'highlight.js/lib/common';
import beautify from 'js-beautify';
import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
  breaks: true,
  highlight(code, language) {
    const languageName = (language || '').trim().toLowerCase();
    try {
      if (languageName && hljs.getLanguage(languageName)) {
        return `<pre class="code-block"><code class="hljs language-${escapeHtml(languageName)}">${hljs.highlight(code, { language: languageName }).value}</code></pre>`;
      }
      return `<pre class="code-block"><code class="hljs">${hljs.highlightAuto(code).value}</code></pre>`;
    } catch {
      return `<pre class="code-block"><code>${escapeHtml(code)}</code></pre>`;
    }
  },
});

const originalLinkOpen = md.renderer.rules.link_open;
md.renderer.rules.link_open = (tokens, index, options, env, self) => {
  const token = tokens[index];
  const href = token.attrGet('href') || '';
  if (/^(https?:|mailto:)/i.test(href)) {
    token.attrSet('target', '_blank');
    token.attrSet('rel', 'noreferrer noopener');
  } else {
    token.attrSet('href', '#');
  }
  return originalLinkOpen
    ? originalLinkOpen(tokens, index, options, env, self)
    : self.renderToken(tokens, index, options);
};

export function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function renderMarkdown(value = '') {
  return md.render(String(value));
}

export function highlightCode(value = '', language = '') {
  const source = String(value);
  const languageName = String(language || '').trim().toLowerCase();
  try {
    const result = languageName && hljs.getLanguage(languageName)
      ? hljs.highlight(source, { language: languageName })
      : hljs.highlightAuto(source);
    return `<pre class="code-block"><code class="hljs${languageName ? ` language-${escapeHtml(languageName)}` : ''}">${result.value}</code></pre>`;
  } catch {
    return `<pre class="code-block"><code>${escapeHtml(source)}</code></pre>`;
  }
}

function asText(content) {
  if (!Array.isArray(content)) return '';
  return content.map((part) => part?.text || '').filter(Boolean).join('\n');
}

function formatJsonOrText(value) {
  if (value === undefined || value === null) return { text: '', language: 'text' };
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  try {
    const parsed = JSON.parse(text);
    return { text: JSON.stringify(parsed, null, 2), language: 'json' };
  } catch {
    return { text, language: 'text' };
  }
}

function eventTime(event) {
  return event.timestamp || event.payload?.timestamp || event.payload?.time || null;
}

function tokenUsage(info = {}) {
  const total = info.total_token_usage || {};
  const last = info.last_token_usage || {};
  return {
    total: {
      input: total.input_tokens ?? 0,
      cached: total.cached_input_tokens ?? 0,
      output: total.output_tokens ?? 0,
      reasoning: total.reasoning_output_tokens ?? 0,
      all: total.total_tokens ?? 0,
    },
    last: {
      input: last.input_tokens ?? 0,
      cached: last.cached_input_tokens ?? 0,
      output: last.output_tokens ?? 0,
      reasoning: last.reasoning_output_tokens ?? 0,
      all: last.total_tokens ?? 0,
    },
    contextWindow: info.model_context_window ?? null,
  };
}

function messageEvent({ line, role, text, timestamp }) {
  if (!text) return null;
  return {
    id: `line-${line}`,
    line,
    kind: role === 'user' ? 'user' : role === 'developer' ? 'developer' : 'assistant',
    role,
    timestamp,
    html: renderMarkdown(text),
    searchText: text,
  };
}

export function normalizeEvent(event, line) {
  if (!event?.payload) return null;
  const payload = event.payload;
  const timestamp = eventTime(event);

  if (event.type === 'event_msg') {
    if (payload.type === 'user_message') {
      return messageEvent({ line, role: 'user', text: payload.message, timestamp });
    }
    if (payload.type === 'agent_message') {
      return messageEvent({ line, role: 'assistant', text: payload.message, timestamp });
    }
    if (payload.type === 'task_started') {
      return { id: `line-${line}`, line, kind: 'turn-start', timestamp, turnId: payload.turn_id };
    }
    if (payload.type === 'task_complete') {
      return { id: `line-${line}`, line, kind: 'turn-complete', timestamp, durationMs: payload.duration_ms ?? null };
    }
    if (payload.type === 'token_count') {
      return { id: `line-${line}`, line, kind: 'token', timestamp, usage: tokenUsage(payload.info) };
    }
    return null;
  }

  if (event.type !== 'response_item') return null;

  if (payload.type === 'message') {
    if (payload.role === 'developer') {
      const text = asText(payload.content);
      return messageEvent({ line, role: 'developer', text, timestamp });
    }
    return null;
  }

  if (payload.type === 'reasoning') {
    const summary = asText(payload.summary);
    if (!summary) return null;
    return {
      id: payload.id || `line-${line}`,
      line,
      kind: 'reasoning-summary',
      timestamp,
      html: renderMarkdown(summary),
      searchText: summary,
    };
  }

  if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
    const isFunction = payload.type === 'function_call';
    const formatted = formatJsonOrText(isFunction ? payload.arguments : payload.input);
    const name = payload.name || (isFunction ? 'function' : 'tool');
    const language = isFunction ? 'json' : inferLanguage(formatted.text);
    const displayText = language === 'javascript'
      ? beautify.js(formatted.text, { indent_size: 2, wrap_line_length: 110, preserve_newlines: true })
      : formatted.text;
    return {
      id: payload.id || `line-${line}`,
      line,
      kind: 'tool-call',
      timestamp,
      name,
      callId: payload.call_id || payload.id || '',
      code: highlightCode(displayText, language),
      searchText: `${name} ${formatted.text}`,
    };
  }

  if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
    const formatted = formatJsonOrText(payload.output);
    return {
      id: payload.id || `line-${line}`,
      line,
      kind: 'tool-output',
      timestamp,
      callId: payload.call_id || payload.id || '',
      code: highlightCode(formatted.text, inferLanguage(formatted.text)),
      searchText: formatted.text,
    };
  }

  return null;
}

function inferLanguage(text) {
  if (/^\s*diff --git |^\+\+\+ |^--- /m.test(text)) return 'diff';
  if (/\b(const|let|var|await|async|function|import|export)\b/.test(text)) return 'javascript';
  if (/^\s*(PS [A-Z]:|Get-|Set-|New-|Remove-|Start-Process|Write-Host)/m.test(text)) return 'powershell';
  if (/^\s*(npm |node |git |cd |ls |rg |curl |ffmpeg |winget )/m.test(text)) return 'bash';
  return 'text';
}

export function normalizeLines(text) {
  const lines = String(text).split(/\r?\n/);
  const normalized = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      const event = JSON.parse(line);
      const item = normalizeEvent(event, index + 1);
      if (item) normalized.push(item);
    } catch {
      // Codex writes complete JSONL records; skip a partial record during live tailing.
    }
  }
  return normalized;
}
