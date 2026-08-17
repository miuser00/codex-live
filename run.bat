@echo off
set "APP=%~dp0dist\CodexLiveWeb.exe"
if not exist "%APP%" (
  echo CodexLiveWeb.exe was not found. Run build-native.ps1 on the development machine first.
  exit /b 1
)
start "" "%APP%"
