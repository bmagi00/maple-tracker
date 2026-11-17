@echo off
setlocal
cd /d "%~dp0"
title Maple Tracker build

rem On GitHub's build servers (CI=true) never wait for a key press.
set "PAUSE=pause"
if /i "%CI%"=="true" set "PAUSE=rem"

echo.
echo ===== Building Maple Tracker =====
echo.

where python >nul 2>nul
if errorlevel 1 goto :nopython

rem Find Tesseract: TESSERACT_DIR if set, the default install, or whatever is on PATH.
if not defined TESSERACT_DIR set "TESSERACT_DIR=C:\Program Files\Tesseract-OCR"
set "TESS=%TESSERACT_DIR%"
if exist "%TESS%\tesseract.exe" goto :havetess
for /f "delims=" %%i in ('where tesseract 2^>nul') do set "TESS=%%~dpi"
if "%TESS:~-1%"=="\" set "TESS=%TESS:~0,-1%"
if not exist "%TESS%\tesseract.exe" goto :notess
:havetess
echo Using Tesseract from "%TESS%"

echo [1/4] Setting up a clean build environment...
if not exist ".buildenv\Scripts\python.exe" python -m venv .buildenv
if errorlevel 1 goto :fail
set "PY=.buildenv\Scripts\python.exe"
"%PY%" -m pip install --quiet --upgrade pip
"%PY%" -m pip install --quiet pyinstaller mss opencv-python-headless numpy pytesseract pillow
if errorlevel 1 goto :fail

echo [2/4] Copying the text reader (Tesseract) into the app...
if exist build_tess rmdir /s /q build_tess
robocopy "%TESS%" "build_tess\tesseract" /E /XF *.traineddata unins*.* /XD doc /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 goto :fail
if not exist "build_tess\tesseract\tessdata" mkdir "build_tess\tesseract\tessdata"
copy /y "%TESS%\tessdata\eng.traineddata" "build_tess\tesseract\tessdata\" >nul
if errorlevel 1 goto :fail
if exist "%TESS%\tessdata\osd.traineddata" copy /y "%TESS%\tessdata\osd.traineddata" "build_tess\tesseract\tessdata\" >nul

echo [3/4] Building MapleTracker.exe - this takes a minute or two...
"%PY%" -m PyInstaller --noconfirm --clean --windowed --name MapleTracker --add-data "build_tess\tesseract;tesseract" maple_tracker.py
if errorlevel 1 goto :fail

echo [4/4] Packing MapleTracker.zip...
copy /y "README.txt" "dist\MapleTracker\README.txt" >nul
if exist MapleTracker.zip del MapleTracker.zip
powershell -NoProfile -Command "Compress-Archive -Path 'dist\MapleTracker' -DestinationPath 'MapleTracker.zip' -Force"
if errorlevel 1 goto :fail

echo.
echo ===== Done! =====
echo Share MapleTracker.zip with your friends.
echo To try it yourself, open dist\MapleTracker\MapleTracker.exe
echo.
%PAUSE%
exit /b 0

:nopython
echo Python wasn't found. Install it from python.org, tick "Add python.exe to PATH", then run this again.
%PAUSE%
exit /b 1

:notess
echo Tesseract wasn't found in "%TESSERACT_DIR%" or on PATH.
echo Install it from https://github.com/UB-Mannheim/tesseract/wiki then run this again.
%PAUSE%
exit /b 1

:fail
echo.
echo Build failed - scroll up to see the error message.
%PAUSE%
exit /b 1
