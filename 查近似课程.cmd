@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
set "NODE=node"
where node >nul 2>nul || set "NODE=D:\Program Files\nodejs\node.exe"
echo ============================================================
echo   SIMILAR COURSES: search entries for one of your modules
echo ------------------------------------------------------------
echo   Reads the course map of a module and builds ready-made
echo   search links (Bing / Google / GitHub / MOOC sites / NPTEL
echo   / MIT OCW ...) using keywords taken from YOUR OWN slides,
echo   plus a blank comparison table to fill in.
echo   It opens the page in your browser.
echo   NOTE: this page does NOT conclude which course matches.
echo   Matching is a factual claim and needs clickable sources,
echo   so the verdict goes into  similar-courses.md  in the same
echo   courseware folder (written by you or by the AI, with URLs).
echo ============================================================
echo.
"%NODE%" "%~dp0similar-courses.js"
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" goto failed
echo [OK] Done. Check the browser tab that just opened.
goto end
:failed
echo [FAILED] exit code %RC%
echo   * if it says "no course map", first run:  node import-slides.js
:end
echo.
if /i not "%NOPAUSE%"=="1" pause >nul
exit /b %RC%
