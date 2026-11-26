@echo off
setlocal DisableDelayedExpansion
if "%~1"=="" goto usage
if not "%~2"=="" goto usage
node "%~dp0server.mjs" --config "%~1"
exit /b %ERRORLEVEL%

:usage
echo Usage: start.cmd "C:\absolute\install\config.json" 1>&2
exit /b 2
