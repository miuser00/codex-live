import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { normalizeEvent } from './lib/events.mjs';

const projectRoot = dirname(fileURLToPath(import.meta.url));
const publicRoot = resolve(projectRoot, 'public');
const codexRoot = resolve(process.env.CODEX_HOME || `${process.env.USERPROFILE}\\.codex`);
const sessionsRoot = resolve(codexRoot, 'sessions');
const port = Number(process.env.CODEX_LIVE_WEB_PORT || 17346);
const host = process.env.CODEX_LIVE_WEB_HOST || '127.0.0.1';

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function tokenForPath(path) {
  return Buffer.from(relative(sessionsRoot, path), 'utf8').toString('base64url');
}

function pathForToken(token) {
  const decoded = Buffer.from(String(token), 'base64url').toString('utf8');
  const path = resolve(sessionsRoot, decoded);
  if (!path.startsWith(`${sessionsRoot}${sep}`) || !path.endsWith('.jsonl')) {
    throw new Error('invalid session path');
  }
  return path;
}

async function collectFiles(directory, output = []) {
  let entries = [];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return output;
  }
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await collectFiles(path, output);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) output.push(path);
  }
  return output;
}

async function loadTitles() {
  const titles = new Map();
  try {
    const raw = await fs.readFile(resolve(codexRoot, 'session_index.jsonl'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      try {
        const item = JSON.parse(line);
        if (item.id) titles.set(item.id, item.thread_name || item.title || '');
      } catch {}
    }
  } catch {}
  return titles;
}

function sessionId(path) {
  const match = path.match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i);
  return match?.[1] || relative(sessionsRoot, path);
}

async function listSessions() {
  const [files, titles] = await Promise.all([collectFiles(sessionsRoot), loadTitles()]);
  const sessions = [];
  for (const path of files) {
    try {
      const stat = await fs.stat(path);
      const id = sessionId(path);
      sessions.push({
        token: tokenForPath(path),
        id,
        title: titles.get(id) || id,
        path: relative(codexRoot, path),
        updatedAt: stat.mtime.toISOString(),
        size: stat.size,
      });
    } catch {}
  }
  sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return sessions.slice(0, 200);
}

async function readHistory(path) {
  const raw = await fs.readFile(path, 'utf8');
  const events = [];
  const lines = raw.split(/\r?\n/);
  let lineCount = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue;
    lineCount += 1;
    try {
      const item = normalizeEvent(JSON.parse(lines[index]), lineCount);
      if (item) events.push(item);
    } catch {}
  }
  const stat = await fs.stat(path);
  return { events, fileSize: stat.size, lineCount };
}

function json(response, data, status = 200) {
  const body = JSON.stringify(data);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

async function serveStatic(request, response) {
  const requested = request.url === '/' ? '/index.html' : request.url.split('?')[0];
  const isLucide = requested === '/vendor/lucide.js';
  const isMarkdownIt = requested === '/vendor/markdown-it.js';
  const path = isLucide
    ? resolve(projectRoot, 'node_modules/lucide/dist/umd/lucide.min.js')
    : isMarkdownIt
      ? resolve(publicRoot, 'vendor/markdown-it.min.js')
      : resolve(publicRoot, `.${requested}`);
  if (!isLucide && !isMarkdownIt && !path.startsWith(`${publicRoot}${sep}`)) return json(response, { error: 'not found' }, 404);
  try {
    const stat = await fs.stat(path);
    if (!stat.isFile()) throw new Error('not file');
    response.writeHead(200, { 'Content-Type': mimeTypes[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    createReadStream(path).pipe(response);
  } catch {
    json(response, { error: 'not found' }, 404);
  }
}

async function streamLive(request, response, url) {
  let path;
  try { path = pathForToken(url.searchParams.get('token')); } catch { return json(response, { error: 'invalid session' }, 400); }

  let offset = Number(url.searchParams.get('offset') || 0);
  let lineNumber = Number(url.searchParams.get('line') || 0);
  let carry = '';
  let decoder = new StringDecoder('utf8');
  let closed = false;
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  response.write(`event: ready\ndata: ${JSON.stringify({ path: relative(codexRoot, path) })}\n\n`);

  const sendEvent = (item) => {
    if (!item || closed) return;
    response.write(`data: ${JSON.stringify(item)}\n\n`);
  };

  const pump = async () => {
    if (closed) return;
    try {
      const stat = await fs.stat(path);
      if (stat.size < offset) {
        offset = 0;
        lineNumber = 0;
        carry = '';
        decoder = new StringDecoder('utf8');
      }
      if (stat.size > offset) {
        const length = Math.min(stat.size - offset, 4 * 1024 * 1024);
        const stream = createReadStream(path, { start: offset, end: offset + length - 1 });
        let chunk = '';
        let bytesRead = 0;
        for await (const part of stream) {
          bytesRead += part.length;
          chunk += decoder.write(part);
        }
        offset += bytesRead;
        const complete = `${carry}${chunk}`.split(/\r?\n/);
        carry = complete.pop() || '';
        for (const line of complete) {
          if (!line.trim()) continue;
          lineNumber += 1;
          try { sendEvent(normalizeEvent(JSON.parse(line), lineNumber)); } catch {}
        }
      }
    } catch {}
  };

  const timer = setInterval(pump, 350);
  const heartbeat = setInterval(() => { if (!closed) response.write(': heartbeat\n\n'); }, 15000);
  request.on('close', () => {
    closed = true;
    clearInterval(timer);
    clearInterval(heartbeat);
  });
  await pump();
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || `${host}:${port}`}`);
    if (url.pathname === '/api/sessions') return json(response, { sessions: await listSessions() });
    if (url.pathname === '/api/session') {
      let path;
      try { path = pathForToken(url.searchParams.get('token')); } catch { return json(response, { error: 'invalid session' }, 400); }
      const history = await readHistory(path);
      return json(response, { ...history, token: tokenForPath(path), path: relative(codexRoot, path) });
    }
    if (url.pathname === '/api/live') return streamLive(request, response, url);
    if (url.pathname === '/api/shutdown' && request.method === 'POST') {
      json(response, { stopping: true }, 202);
      setImmediate(() => server.close(() => process.exit(0)));
      return;
    }
    if (url.pathname === '/favicon.ico') {
      response.writeHead(204);
      return response.end();
    }
    return serveStatic(request, response);
  } catch (error) {
    json(response, { error: error.message || 'server error' }, 500);
  }
});

server.listen(port, host, () => {
  console.log(`Codex Live Web: http://${host}:${port}/`);
  console.log(`Watching: ${sessionsRoot}`);
});
