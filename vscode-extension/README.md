# Codex Live Web

在默认浏览器中实时查看本机 Codex 会话、工具执行、工具返回和 token 用量。

这个 VSIX 面向 Windows x64，内置 Rust 原生 `CodexLiveWeb.exe`。目标机器只需要 VS Code 和默认浏览器，不需要单独安装 Node.js、npm、Rust、Codex CLI 或 Visual C++ 运行库。

## 命令

打开命令面板（`Ctrl+Shift+P`）后可以使用：

- `Codex Live Web: 启动并打开`
- `Codex Live Web: 打开查看器`
- `Codex Live Web: 停止`

## 设置

- `codexLiveWeb.port`：本地监听端口，默认 `17346`。
- `codexLiveWeb.codexHome`：可选的 Codex 数据目录绝对路径；留空时使用环境变量 `CODEX_HOME` 或 `%USERPROFILE%\.codex`。

服务只监听 `127.0.0.1`。它会读取本机 Codex 会话内容，请勿通过反向代理暴露到公网。
