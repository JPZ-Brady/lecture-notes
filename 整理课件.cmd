@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
set "NODE=node"
where node >nul 2>nul || set "NODE=D:\Program Files\nodejs\node.exe"
echo ============================================================
echo   IMPORT SLIDES: file teacher PDF/PPTX/DOCX decks into
echo   courseware\<COURSE NAME>\ and build a course map there
echo ------------------------------------------------------------
echo   1) put the new deck into the  recordings  folder (or into
echo      courseware\_pending\) - any name is fine
echo   2) run this file; it reads the deck text and works out
echo      which module it belongs to (module code, then acronym
echo      such as KRR, then course-name keywords)
echo   3) it copies the deck into courseware\<COURSE NAME>\
echo      byte-checks the copy, deletes the original, and writes
echo      course-map.md / course-map.json next to it
echo   If the course cannot be identified it goes to
echo   courseware\_pending\ instead of guessing. Nothing is ever
echo   overwritten, and nothing is deleted before a byte-check.
echo   Intros are ON by default for a NEW deck: the AI writes a
echo   1-2 sentence Chinese intro per lecture (costs one API call;
echo   an already-introduced deck is never charged twice).
echo   Extra flags, e.g.:
echo      this-file.cmd --no-intro  (pure machine map, zero API)
echo      this-file.cmd --dry       (report only, do not move files)
echo ============================================================
echo.
"%NODE%" "%~dp0import-slides.js" %*
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" goto failed
echo [OK] Done. Decks are filed under courseware\<COURSE NAME>\.
goto end
:failed
echo [FAILED] exit code %RC%
echo   * your files are untouched; fix the problem and rerun
:end
echo.
if /i not "%NOPAUSE%"=="1" pause >nul
exit /b %RC%
