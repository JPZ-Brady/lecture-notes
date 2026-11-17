@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
set "NODE=node"
where node >nul 2>nul || set "NODE=D:\Program Files\nodejs\node.exe"
echo ============================================================
echo   NOTES ONLY: rebuild notes from the newest transcript
echo   No re-transcription, so it is fast and cheap, and the
echo   file name stays the same as the first run.
echo ============================================================
echo.
"%NODE%" "%~dp0make-notes.js" %*
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" goto failed
echo [OK] Finished. Notes are in the notes folder.
goto end
:failed
echo [FAILED] exit code %RC%  --  see the message above.
echo   * see the newest file in the logs folder for details
:end
echo.
if /i not "%NOPAUSE%"=="1" pause >nul
exit /b %RC%
