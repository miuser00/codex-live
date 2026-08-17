---
name: "codex-live-web"
description: "Start and use the local Codex Live Web viewer for live sessions, tool calls, code blocks, and collapsed token usage."
---

# Codex Live Web

Use this skill when the user asks to inspect live Codex dialogue, tool calls, or formatted output.

## Start

Run from the plugin root:

```powershell
& .\scripts\start.ps1
```

The start script prefers `bin\CodexLiveWeb.exe`, a self-contained native Windows executable with no Node.js runtime dependency. It starts a server bound to `127.0.0.1:17346` and opens the default browser. It reads `%USERPROFILE%\\.codex\\sessions`; set `CODEX_HOME` to use another Codex data directory. When the native executable is absent in a development checkout, the script falls back to the Node.js prototype.

If the default port is busy, choose another one:

```powershell
$env:CODEX_LIVE_WEB_PORT = 17347
& .\scripts\start.ps1
```

## Viewer behavior

- Select a session in the sidebar and filter all, dialogue, or tools.
- Markdown is rendered as paragraphs and tool input uses syntax highlighting.
- Token usage is aggregated in a collapsed Token panel.
- Encrypted reasoning is shown only when a readable summary exists; opaque ciphertext is omitted.
- New JSONL events are pushed over SSE while the session is active.

## Stop and status

```powershell
& .\scripts\status.ps1
& .\scripts\stop.ps1
```

Keep this service on the loopback address. It displays local Codex session contents and should not be exposed publicly.
