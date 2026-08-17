@echo off
setlocal

tasklist /FI "IMAGENAME eq CodexLiveWeb.exe" 2>NUL | find /I "CodexLiveWeb.exe" >NUL
if errorlevel 1 goto not_running

taskkill /F /T /IM CodexLiveWeb.exe >NUL 2>&1
if errorlevel 1 goto failed

if defined LOCALAPPDATA del /Q "%LOCALAPPDATA%\CodexLiveWeb\codex-live-web.pid" >NUL 2>&1
echo Codex Live Web stopped.
exit /B 0

:not_running
if defined LOCALAPPDATA del /Q "%LOCALAPPDATA%\CodexLiveWeb\codex-live-web.pid" >NUL 2>&1
echo Codex Live Web is not running.
exit /B 0

:failed
echo Failed to stop Codex Live Web.
exit /B 1
