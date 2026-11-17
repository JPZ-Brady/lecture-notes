@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
set "NODE=node"
where node >nul 2>nul || set "NODE=D:\Program Files\nodejs\node.exe"
echo ============================================================
echo   ONE-CLICK: process EVERY audio waiting in the recording folder
echo   1) drop lecture audio into the  recording  folder
echo      (a subfolder named after the course gives that course name)
echo   2) double-click this file and wait: a few minutes per hour of audio
echo   Each file is named automatically, archived, and carded.
echo ============================================================
echo.
"%NODE%" "%~dp0make-notes.js" --all %*
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" goto failed
echo [OK] Finished (see the summary above for how many succeeded).
echo      notes      -^> the notes folder (auto-named: course + date)
echo      playback   -^> the audio folder (copy, so you can re-listen)
echo      source     -^> recording folder, subfolder "processed"
goto end
:failed
echo [FAILED] exit code %RC%  --  the step above did NOT finish.
echo   * transcripts are already saved, so rerunning is cheap
echo   * double-click the notes-only launcher to redo just that step
echo   * see the newest file in the logs folder for details
:end
echo.
if /i not "%NOPAUSE%"=="1" pause >nul
exit /b %RC%
