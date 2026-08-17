import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeEvent, renderMarkdown } from '../lib/events.mjs';

test('renders message paragraphs and highlighted fenced code', () => {
  const event = normalizeEvent({
    timestamp: '2026-08-16T00:00:00Z',
    type: 'event_msg',
    payload: { type: 'agent_message', message: '第一段\n\n```js\nconst value = 42;\n```' },
  }, 2);
  assert.equal(event.kind, 'assistant');
  assert.match(event.html, /<p>第一段<\/p>/);
  assert.match(event.html, /class="hljs language-js"/);
  assert.match(event.html, /hljs-keyword/);
});

test('never exposes encrypted reasoning without a readable summary', () => {
  const event = normalizeEvent({
    type: 'response_item',
    payload: { type: 'reasoning', summary: [], encrypted_content: 'gAAAAA-secret' },
  }, 3);
  assert.equal(event, null);
});

test('token usage is normalized for collapsed rendering', () => {
  const event = normalizeEvent({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: 120, cached_input_tokens: 80, output_tokens: 40, total_tokens: 160 },
        last_token_usage: { input_tokens: 30, total_tokens: 45 },
        model_context_window: 1000,
      },
    },
  }, 4);
  assert.equal(event.kind, 'token');
  assert.equal(event.usage.total.all, 160);
  assert.equal(event.usage.contextWindow, 1000);
});

test('single-line JavaScript tool input is beautified before highlighting', () => {
  const event = normalizeEvent({
    type: 'response_item',
    payload: {
      type: 'custom_tool_call',
      id: 'tool-1',
      call_id: 'call-1',
      name: 'exec',
      input: 'const value={answer:42};await run(value);',
    },
  }, 5);
  assert.equal(event.kind, 'tool-call');
  assert.match(event.code, /\n/);
  assert.match(event.code, /language-javascript/);
});

test('HTML in messages is escaped by markdown renderer', () => {
  const html = renderMarkdown('<script>alert(1)</script>');
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});
