@echo off
setlocal
powershell -ExecutionPolicy Bypass -File "%~dp0build_windows.ps1"
