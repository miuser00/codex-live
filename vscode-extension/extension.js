'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const vscode = require('vscode');

const LAST_PORT_KEY = 'codexLiveWeb.lastPort';

function settings() {
  const configuration = vscode.workspace.getConfiguration('codexLiveWeb');
  return {
    port: configuration.get('port', 17346),
    codexHome: configuration.get('codexHome', '').trim(),
  };
}

function viewerUrl(port) {
  return `http://127.0.0.1:${port}/`;
}

function request(port, method, pathname, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const requestHandle = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method,
      timeout,
      headers: { Connection: 'close' },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode || 0,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    requestHandle.on('timeout', () => requestHandle.destroy(new Error('request timed out')));
    requestHandle.on('error', reject);
    requestHandle.end();
  });
}

async function isViewerRunning(port) {
  try {
    const response = await request(port, 'GET', '/api/sessions');
    if (response.statusCode !== 200) return false;
    return Array.isArray(JSON.parse(response.body).sessions);
  } catch {
    return false;
  }
}

async function isPortInUse(port) {
  try {
    await request(port, 'GET', '/', 700);
    return true;
  } catch {
    return false;
  }
}

async function waitForViewer(port) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await isViewerRunning(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

function ensureSupportedPlatform() {
  if (process.platform === 'win32' && process.arch === 'x64') return true;
  vscode.window.showErrorMessage('Codex Live Web VSIX 仅支持 Windows x64。');
  return false;
}

async function openViewer(port) {
  await vscode.env.openExternal(vscode.Uri.parse(viewerUrl(port)));
}

async function startViewer(context) {
  if (!ensureSupportedPlatform()) return;
  const { port, codexHome } = settings();

  if (await isViewerRunning(port)) {
    await context.globalState.update(LAST_PORT_KEY, port);
    await openViewer(port);
    vscode.window.showInformationMessage(`Codex Live Web 已在端口 ${port} 运行。`);
    return;
  }
  if (await isPortInUse(port)) {
    vscode.window.showErrorMessage(`端口 ${port} 已被其他程序占用，请修改 codexLiveWeb.port。`);
    return;
  }

  const executable = context.asAbsolutePath(path.join('bin', 'CodexLiveWeb.exe'));
  if (!fs.existsSync(executable)) {
    vscode.window.showErrorMessage('VSIX 中缺少 CodexLiveWeb.exe，请重新安装扩展。');
    return;
  }

  const environment = {
    ...process.env,
    CODEX_LIVE_WEB_PORT: String(port),
  };
  if (codexHome) environment.CODEX_HOME = codexHome;

  let child;
  try {
    child = spawn(executable, [], {
      cwd: path.dirname(executable),
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      env: environment,
    });
  } catch (error) {
    vscode.window.showErrorMessage(`无法启动 Codex Live Web：${error.message}`);
    return;
  }
  const launchError = await new Promise((resolve) => {
    child.once('spawn', () => resolve(null));
    child.once('error', resolve);
  });
  if (launchError) {
    vscode.window.showErrorMessage(`无法启动 Codex Live Web：${launchError.message}`);
    return;
  }
  child.unref();

  await context.globalState.update(LAST_PORT_KEY, port);
  if (await waitForViewer(port)) {
    vscode.window.showInformationMessage(`Codex Live Web 已启动：http://127.0.0.1:${port}/`);
  } else {
    vscode.window.showErrorMessage('Codex Live Web 启动超时，请检查 %LOCALAPPDATA%\\CodexLiveWeb\\codex-live-web-error.log。');
  }
}

async function openViewerCommand(context) {
  const { port } = settings();
  if (await isViewerRunning(port)) {
    await openViewer(port);
    return;
  }
  const action = await vscode.window.showInformationMessage('Codex Live Web 尚未运行。', '启动');
  if (action === '启动') await startViewer(context);
}

async function stopAtPort(port) {
  try {
    const response = await request(port, 'POST', '/api/shutdown');
    return response.statusCode === 202 && JSON.parse(response.body).stopping === true;
  } catch {
    return false;
  }
}

function forceStopAll() {
  return new Promise((resolve) => {
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    const taskkill = path.join(systemRoot, 'System32', 'taskkill.exe');
    execFile(taskkill, ['/F', '/T', '/IM', 'CodexLiveWeb.exe'], { windowsHide: true }, (error) => {
      resolve(!error);
    });
  });
}

async function stopViewer(context) {
  if (!ensureSupportedPlatform()) return;
  const configuredPort = settings().port;
  const lastPort = context.globalState.get(LAST_PORT_KEY, configuredPort);
  const ports = [...new Set([configuredPort, lastPort])];
  for (const port of ports) {
    if (await stopAtPort(port)) {
      vscode.window.showInformationMessage(`Codex Live Web 已停止（端口 ${port}）。`);
      return;
    }
  }

  const action = await vscode.window.showWarningMessage(
    '没有在已知端口找到查看器。是否强制停止所有 CodexLiveWeb.exe 实例？',
    { modal: true },
    '强制停止',
  );
  if (action !== '强制停止') return;
  if (await forceStopAll()) {
    vscode.window.showInformationMessage('所有 Codex Live Web 原生实例已停止。');
  } else {
    vscode.window.showInformationMessage('没有正在运行的 Codex Live Web 原生实例。');
  }
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('codexLiveWeb.start', () => startViewer(context)),
    vscode.commands.registerCommand('codexLiveWeb.open', () => openViewerCommand(context)),
    vscode.commands.registerCommand('codexLiveWeb.stop', () => stopViewer(context)),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
