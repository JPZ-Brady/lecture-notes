@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
set "NODE=node"
where node >nul 2>nul || set "NODE=D:\Program Files\nodejs\node.exe"
echo ============================================================
echo   PICK CARDS: choose which classroom cards enter the study deck
echo   1) a page opens in your browser (ticked = goes to the deck)
echo   2) untick what you do NOT want, then press the confirm button
echo   3) the choice is saved to an exclusion list in this folder,
echo      and every future rebuild will respect it
echo   4) bottom of the page: the exclusion-list health check --
echo      it lists entries that no longer match any card (their card
echo      silently came back after a note was regenerated) and lets
echo      you re-attach or drop each one with a click
echo   (closing the window without confirming changes nothing)
echo ============================================================
echo.
"%NODE%" "%~dp0pick-cards.js"
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" goto failed
echo [OK] Done. The study deck has been updated.
goto end
:failed
echo [FAILED] exit code %RC%
echo   * rerun later, or just double-click this file again
:end
echo.
if /i not "%NOPAUSE%"=="1" pause >nul
exit /b %RC%
