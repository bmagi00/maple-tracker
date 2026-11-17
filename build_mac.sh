#!/bin/bash
# Builds "Maple Tracker.app" and MapleTracker-mac.zip on a Mac.
# Text reading uses Apple's built-in Vision framework, so no Tesseract needed.
set -euo pipefail
cd "$(dirname "$0")"

echo "[1/3] Setting up a clean build environment..."
python3 -m venv .buildenv
PY=.buildenv/bin/python
"$PY" -m pip install --quiet --upgrade pip
"$PY" -m pip install --quiet pyinstaller mss opencv-python-headless numpy \
    pytesseract pillow pyobjc-framework-Vision pyobjc-framework-Quartz

echo "[2/3] Building MapleTracker.app..."
"$PY" -m PyInstaller --noconfirm --clean --windowed --name MapleTracker \
    --osx-bundle-identifier io.github.mapletracker \
    --hidden-import Vision --hidden-import Quartz --hidden-import Foundation \
    maple_tracker.py

echo "[3/3] Packing MapleTracker-mac.zip..."
rm -rf dist/pkg MapleTracker-mac.zip
mkdir -p dist/pkg/MapleTracker
ditto dist/MapleTracker.app dist/pkg/MapleTracker/MapleTracker.app
cp README.txt dist/pkg/MapleTracker/
ditto -c -k --keepParent dist/pkg/MapleTracker MapleTracker-mac.zip

echo "Done: MapleTracker-mac.zip"
