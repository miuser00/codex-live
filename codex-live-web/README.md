# Codex Live Web

Codex Live Web is a local browser viewer for Codex session logs. It shows user and assistant messages, tool calls, formatted code, live events, and collapsed token usage.

## Native release

`bin\CodexLiveWeb.exe` is the preferred runtime. It is a self-contained Windows x64 executable that embeds the HTTP server and all browser assets. Running it starts a loopback-only server and opens `http://127.0.0.1:17346/` in the default browser.

The target machine does not need Node.js, npm, Rust, or Codex CLI. The viewer reads `%USERPROFILE%\.codex\sessions`; set `CODEX_HOME` before starting if the Codex data directory is elsewhere. Set `CODEX_LIVE_WEB_PORT` to choose another port.

From the plugin root:

```powershell
& .\scripts\start.ps1
```

Check or stop the server with:

```powershell
& .\scripts\status.ps1
& .\scripts\stop.ps1
```

## Node.js prototype

The original Node.js implementation remains available for fast development:

```powershell
npm.cmd install
npm.cmd start
npm.cmd test
```

The prototype uses `server.mjs` and `lib/events.mjs`. The native Rust project is under `native\`; both implementations share `public\` and the same HTTP/SSE contract. `scripts\start.ps1` falls back to the Node prototype only when `bin\CodexLiveWeb.exe` is absent.

## Optional Codex registration

The distribution-level `install-plugin.ps1` detects a standalone Codex CLI or the `codex.exe` bundled with the VS Code Codex extension. If neither is available, registration is skipped without affecting standalone native use.

The service is loopback-only by default. Do not expose it to the public network because it displays local Codex session content.
