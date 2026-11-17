@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
set "NODE=node"
where node >nul 2>nul || set "NODE=D:\Program Files\nodejs\node.exe"
echo ============================================================
echo   WEEKLY REVIEW: merge this week notes into one page
echo ============================================================
echo.
"%NODE%" "%~dp0weekly-review.js" --open %*
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" goto failed
echo [OK] Weekly review page generated and opened.
goto end
:failed
echo [FAILED] exit code %RC%  --  see the message above.
:end
echo.
if /i not "%NOPAUSE%"=="1" pause >nul
exit /b %RC%
