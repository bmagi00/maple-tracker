"""
Maple Tracker - EXP / mesos / items per hour for MapleStory Classic.

Reads the numbers off the screen (for example a Discord stream of the game
on a second PC) and never touches the game itself. Everything happens in a
small floating window that finds the HUD by itself: Start/Pause, Reset, Check reading.
The same stats are served as a web page other devices on the network can open.

Run it on a SECOND device, never on the PC you play on.

Run from source:  python maple_tracker.py
Self-test OCR:    python maple_tracker.py --selftest [result.txt]
Build Windows:    double-click build.bat
Build Mac:        bash build_mac.sh
Text reading uses Tesseract on Windows and Apple's built-in Vision on Mac.
"""

import base64
import csv
import ctypes
import difflib
import json
import logging
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import traceback
from collections import Counter
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import cv2
import mss
import numpy as np
import pytesseract

APP_NAME = "Maple Tracker"
IS_WIN = sys.platform == "win32"
IS_MAC = sys.platform == "darwin"

# Use real pixel coordinates on scaled (125%/150%) Windows displays, so the
# screenshot, the calibration boxes and the floating window all agree.
if IS_WIN:
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass


# ------------------------------------------------------------ files & paths

def _data_dir():
    """Where settings and logs live: next to the .exe if that folder is
    writable, otherwise %APPDATA%\\MapleTracker. On Mac the app bundle is
    read-only, so ~/Library/Application Support/MapleTracker.
    From source: current folder."""
    if getattr(sys, "frozen", False) and IS_MAC:
        d = Path.home() / "Library" / "Application Support" / "MapleTracker"
        d.mkdir(parents=True, exist_ok=True)
        return d
    if getattr(sys, "frozen", False):
        d = Path(sys.executable).resolve().parent
        try:
            probe = d / ".write_test"
            probe.write_text("ok")
            probe.unlink()
            return d
        except OSError:
            d = Path(os.environ.get("APPDATA", str(Path.home()))) / "MapleTracker"
            d.mkdir(parents=True, exist_ok=True)
            return d
    return Path.cwd()


DATA_DIR = _data_dir()
CONFIG_FILE = DATA_DIR / "tracker_config.json"
LOG_FILE = DATA_DIR / "tracker.log"
SESSIONS_DIR = DATA_DIR / "sessions"
DEBUG_DIR = DATA_DIR / "debug"

_handlers = [logging.FileHandler(LOG_FILE, encoding="utf-8")]
if sys.stdout:
    _handlers.append(logging.StreamHandler(sys.stdout))
logging.basicConfig(level=logging.INFO, handlers=_handlers,
                    format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("maple")

DEFAULT_CONFIG = {
    "tesseract_cmd": "",       # blank = auto-detect (bundled copy first)
    "monitor": 1,              # where the HUD was last found
    "poll_seconds": 0.5,       # how often to read the screen
    "frames_per_read": 3,      # frames blended per read to cancel stream noise
    "upscale": 4,              # bigger = better OCR on small, blurry text
    "denoise": True,           # smooth out video-compression blockiness
    "web_port": 8765,          # other devices open http://<this PC's IP>:8765
    "overlay_opacity": 0.92,
    "overlay_pos": [40, 40],   # remembered when you close the window
    "regions": {},             # optional boxes drawn by hand (advanced)
    # Pickup-message patterns (lines are lowercased before matching).
    "meso_pattern": r"mesos?\s*\(?\s*\+?\s*([\d,]+)",
    "item_pattern": r"gained an? item\s*\(?([^)]+)\)?",
}


OCR_BACKEND = "tesseract"   # "vision" on Mac; set by load_config()


def find_tesseract(cfg):
    """Bundled copy (inside the .exe folder) first, then the usual installs."""
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
    candidates = [base / "tesseract" / ("tesseract.exe" if IS_WIN else "tesseract")]
    if cfg.get("tesseract_cmd"):
        candidates.append(Path(cfg["tesseract_cmd"]))
    candidates += [Path(r"C:\Program Files\Tesseract-OCR\tesseract.exe"),
                   Path(r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe")]
    for c in candidates:
        if c.is_file():
            if (c.parent / "tessdata").is_dir():
                os.environ["TESSDATA_PREFIX"] = str(c.parent / "tessdata")
            return str(c)
    return shutil.which("tesseract")


def load_config():
    cfg = dict(DEFAULT_CONFIG)
    if CONFIG_FILE.exists():
        try:
            cfg.update(json.loads(CONFIG_FILE.read_text()))
        except Exception:
            log.exception("Bad config file, using defaults")
    global OCR_BACKEND
    OCR_BACKEND = "tesseract"
    if IS_MAC:
        try:
            import Vision  # noqa: F401  (Apple's built-in text recognition)
            OCR_BACKEND = "vision"
        except Exception:
            log.warning("Apple Vision unavailable, falling back to Tesseract")
    tess = find_tesseract(cfg) if OCR_BACKEND == "tesseract" else None
    if tess:
        pytesseract.pytesseract.tesseract_cmd = tess
    cfg["_tesseract_found"] = OCR_BACKEND == "vision" or bool(tess)
    return cfg


def save_config(cfg):
    CONFIG_FILE.write_text(json.dumps(
        {k: v for k, v in cfg.items() if not k.startswith("_")}, indent=2))


# ---------------------------------------------------------------- utilities

def monitor_rect(sct, cfg):
    mons = sct.monitors
    idx = cfg.get("monitor", 1)
    return mons[idx] if 0 < idx < len(mons) else mons[1]


def grab(sct, cfg, region, frames=1):
    """Screenshot a region. With frames > 1, takes several shots a few
    milliseconds apart and keeps the per-pixel median, which removes most
    of the flicker that stream compression adds to static UI text."""
    mon = monitor_rect(sct, cfg)
    box = {"left": mon["left"] + region[0], "top": mon["top"] + region[1],
           "width": region[2], "height": region[3]}
    shots = []
    for i in range(max(1, frames)):
        if i:
            time.sleep(0.04)  # ~1 stream frame at 30fps
        shots.append(np.array(sct.grab(box))[:, :, :3])
    if len(shots) == 1:
        return np.ascontiguousarray(shots[0])
    return np.median(np.stack(shots), axis=0).astype(np.uint8)


def preprocess(img, cfg):
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    up = cfg["upscale"]
    gray = cv2.resize(gray, None, fx=up, fy=up, interpolation=cv2.INTER_CUBIC)
    if cfg["denoise"]:
        gray = cv2.medianBlur(gray, 3)
    _, th = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    if th.mean() < 127:          # Tesseract wants dark text on light
        th = cv2.bitwise_not(th)
    return cv2.copyMakeBorder(th, 10, 10, 10, 10, cv2.BORDER_CONSTANT, value=255)


TESS_CONFIGS = {
    "exp": "--psm 7 -c tessedit_char_whitelist=0123456789,.[]%",
    "digits": "--psm 7 -c tessedit_char_whitelist=0123456789,",
    "lines": "--psm 6",
}
# Vision has no character whitelist, so fix the usual letter/digit mix-ups
# in number-only boxes.
DIGIT_FIX = str.maketrans({"O": "0", "o": "0", "D": "0", "l": "1", "I": "1",
                           "|": "1", "i": "1", "S": "5", "s": "5", "B": "8"})


def _vision_lines(img):
    """Apple's built-in text recognition (macOS 10.15+). Returns lines
    top to bottom."""
    import Vision
    from Foundation import NSData
    ok, buf = cv2.imencode(".png", img)
    data = NSData.dataWithBytes_length_(buf.tobytes(), int(buf.size))
    handler = Vision.VNImageRequestHandler.alloc().initWithData_options_(data, None)
    req = Vision.VNRecognizeTextRequest.alloc().init()
    req.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
    req.setUsesLanguageCorrection_(False)
    success, err = handler.performRequests_error_([req], None)
    if not success:
        raise RuntimeError(f"Vision text recognition failed: {err}")
    rows = []
    for obs in req.results() or []:
        cands = obs.topCandidates_(1)
        if cands and len(cands):
            box = obs.boundingBox()  # origin is bottom-left, 0..1
            rows.append((-box.origin.y, box.origin.x, str(cands[0].string())))
    rows.sort()
    return [r[2] for r in rows]


def ocr(img, cfg, mode):
    """mode: 'exp' (12345[12.34%]), 'digits' (1,234,567) or 'lines' (free text)."""
    pre = preprocess(img, cfg)
    if OCR_BACKEND == "vision":
        text = "\n".join(_vision_lines(pre))
        return text if mode == "lines" else text.translate(DIGIT_FIX)
    return pytesseract.image_to_string(pre, config=TESS_CONFIGS[mode])


def to_int(s):
    digits = re.sub(r"[^\d]", "", s)
    return int(digits) if digits else None


def fmt(n):
    return "—" if n is None else f"{n:,.0f}"


def hms(seconds):
    s = int(seconds)
    return f"{s // 3600}:{s // 60 % 60:02d}:{s % 60:02d}"


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))  # no packet is sent
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


# ------------------------------------------------------------------ readers

EXP_RE = re.compile(r"([\d][\d,]*)\s*\[?\s*(\d{1,3}(?:\.\d+)?)\s*%")


def parse_exp_text(text):
    m = EXP_RE.search(re.sub(r"\s+", "", text))
    if not m:
        return None
    exp, pct = to_int(m.group(1)), float(m.group(2))
    if exp is None or not (0 <= pct < 100):
        return None
    return exp, pct


LAST_OCR = {"exp": ""}   # raw text of the latest EXP read, for the readings log


def read_mesos(sct, cfg):
    img = grab(sct, cfg, cfg["regions"]["mesos"], cfg["frames_per_read"])
    return to_int(ocr(img, cfg, "digits"))


def read_pickup_lines(sct, cfg):
    # Single frame: pickup messages move, so blending frames would smear them.
    img = grab(sct, cfg, cfg["regions"]["pickups"], 1)
    text = ocr(img, cfg, "lines")
    lines = []
    for raw in text.splitlines():
        line = re.sub(r"\s+", " ", raw).strip().lower()
        if len(line) >= 6:
            lines.append(line)
    return lines


def _render_text(text, light_on_dark=True, scale=0.6):
    """Draw small UI-style text, roughly like the game's status bar."""
    font = cv2.FONT_HERSHEY_SIMPLEX
    (w, h), base = cv2.getTextSize(text, font, scale, 1)
    bg, fg = ((40, 30, 25), (235, 235, 235)) if light_on_dark else ((235, 235, 235), (30, 30, 30))
    img = np.full((h + base + 10, w + 12, 3), bg, np.uint8)
    cv2.putText(img, text, (6, h + 5), font, scale, fg, 1, cv2.LINE_AA)
    return img


def selftest(out_path=None):
    """Reads a few rendered samples with the real text reader. Used by the
    automatic builds to prove the packaged app can read text."""
    cfg = load_config()
    cases = [
        ("exp", "12,345[61.72%]", lambda t: parse_exp_text(t) == (12345, 61.72)),
        ("digits", "1,234,567", lambda t: to_int(t) == 1234567),
        ("lines", "You have gained mesos (+77)",
         lambda t: re.search(PickupTracker(cfg["meso_pattern"], cfg["item_pattern"])
                             .meso_re, t.lower()) is not None and "77" in t),
    ]
    report = [f"{APP_NAME} self-test  |  platform={sys.platform}  backend={OCR_BACKEND}"
              f"  frozen={bool(getattr(sys, 'frozen', False))}"]
    passed = True
    if not cfg["_tesseract_found"]:
        report.append("FAIL  text reader not found")
        passed = False
    else:
        for light_on_dark in (True, False):
            for mode, text, check in cases:
                try:
                    got = ocr(_render_text(text, light_on_dark), cfg, mode).strip()
                    ok = check(got)
                except Exception as e:
                    got, ok = f"error: {e}", False
                passed &= ok
                style = "light-on-dark" if light_on_dark else "dark-on-light"
                report.append(f"{'PASS' if ok else 'FAIL'}  {mode:<6} {style:<13} "
                              f"expected {text!r}  read {got!r}")
    reader = DigitReader()
    seeds = reader.seeds
    hits = sum(reader.classify(v)[0] == c for c, vs in seeds.items() for v in vs)
    total = sum(len(vs) for vs in seeds.values())
    ok = total > 0 and hits == total
    passed &= ok
    report.append(f"{'PASS' if ok else 'FAIL'}  digit examples recognised: {hits}/{total}")
    for text, want in (("65.99%", (None, 65.99)), ("152.2257.00%", (152225, 7.0)),
                       ("?5.99%", None)):
        ok = parse_hud_text(text) == want
        passed &= ok
        report.append(f"{'PASS' if ok else 'FAIL'}  parse {text!r} -> {parse_hud_text(text)}")
    report.append("RESULT: " + ("PASS" if passed else "FAIL"))
    text = "\n".join(report)
    log.info("\n%s", text)
    if out_path:
        Path(out_path).write_text(text + "\n", encoding="utf-8")
    return 0 if passed else 1


# ------------------------------------------------------------------ EXP table

def exp_to_next(level):
    """EXP needed to finish `level`, from MeowDB's MapleStory Classic formulas.
    Levels 1-49 match live Classic play; 50-89 follow the historical curve."""
    if not isinstance(level, int) or level < 1 or level > 89:
        return None
    if level <= 5:
        return (level * level // 2 + 15) * level
    if level <= 50:
        q = level * level // 3
        return (q + 19) * q
    v = exp_to_next(50)
    for _ in range(51, level + 1):
        v = v * 10548 // 10000
    return v


def level_from_amount(exp, pct):
    """The single level whose EXP requirement matches this amount and %."""
    hits = [lv for lv in range(1, 90)
            if exp < exp_to_next(lv) and abs(exp / exp_to_next(lv) * 100 - pct) <= 0.011]
    return hits[0] if len(hits) == 1 else None


# ------------------------------------------------- HUD finding & digit reader
#
# The Classic HUD is a dark bar along the bottom of the game: a white "LV."
# label with orange number tiles, then HP, MP and "EXP. 152,225 [7.00%]"
# (or just "EXP. [65.99%]"). We find the orange tiles anywhere on screen,
# check the "LV." label beside them, then look along the bar for the % reading.

def _orange_runs(frame):
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    m = cv2.inRange(hsv, (4, 90, 110), (24, 255, 255))
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    n, _, st, _ = cv2.connectedComponentsWithStats(m)
    runs = []
    for i in range(1, n):
        x, y, w, h, area = (int(v) for v in st[i])
        # one to three touching tiles, mostly filled with orange
        if 9 <= h <= 90 and 0.55 <= w / h <= 3.8 and area >= 0.45 * w * h:
            runs.append((x, y, w, h))
    return runs


def _lv_label_score(frame, run):
    """The level tiles sit right of a white 'LV.' label on a dark bar."""
    x, y, w, h = run
    H = frame.shape[0]
    lx0, lx1 = max(0, int(x - 3.6 * h)), max(0, int(x - 0.2 * h))
    ly0, ly1 = max(0, int(y - 0.25 * h)), min(H, int(y + 1.25 * h))
    if lx1 - lx0 < h:
        return 0.0
    box = frame[ly0:ly1, lx0:lx1]
    white = float((box.min(axis=2) > 165).mean())
    dark = float((box.max(axis=2) < 95).mean())
    return white + dark if 0.04 <= white <= 0.45 and dark >= 0.35 else 0.0


def _white_mask(img, up):
    g = img.min(axis=2)  # white text is bright in every channel
    g = cv2.resize(g, None, fx=up, fy=up, interpolation=cv2.INTER_CUBIC)
    _, th = cv2.threshold(g, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    return cv2.copyMakeBorder(255 - th, 12, 12, 12, 12, cv2.BORDER_CONSTANT, value=255)


def _ocr_words(img):
    """Words with boxes: [(text, left, top, width, height)]."""
    d = pytesseract.image_to_data(img, config="--psm 11",
                                  output_type=pytesseract.Output.DICT)
    return [(d["text"][i].strip(), d["left"][i], d["top"][i], d["width"][i], d["height"][i])
            for i in range(len(d["text"])) if d["text"][i].strip()]


def _locate_readout(frame, run):
    """Search the bar right of the level tiles for the '%' reading."""
    x, y, w, th = run
    H, W = frame.shape[:2]
    y0, y1 = max(0, int(y - 1.2 * th)), min(H, int(y + 1.1 * th))
    x0 = x + w
    band = frame[y0:y1, x0:W]
    if band.size == 0:
        return None
    base_up = max(2, min(5, round(36 / th)))
    for up in (base_up, base_up + 1, base_up + 2):
        words = _ocr_words(_white_mask(band, up))
        pct = [wd for wd in words if re.search(r"\d[.,]?\d\d\s*%", wd[0])
               or ("%" in wd[0] and re.search(r"\d", wd[0]))]
        if pct:
            break
    else:
        return None
    t, l, tp, ww, hh = pct[-1]
    left = l
    for t2, l2, tp2, w2, h2 in words:   # an EXP amount just before it
        if l2 < l and abs(tp2 - tp) < hh and l - (l2 + w2) < 3 * hh \
                and re.fullmatch(r"[\d,.]{2,}", t2.strip("[(1Il|")):
            left = min(left, l2)
    s = 1 / up
    rx0, rx1 = x0 + (left - 12) * s, x0 + (l + ww - 12) * s
    ry0, ry1 = y0 + (tp - 12) * s, y0 + (tp + hh - 12) * s
    px, py = 0.4 * th, 0.35 * th
    return (int(rx0 - px), int(ry0 - py), int(rx1 - rx0 + 2 * px), int(ry1 - ry0 + 2 * py))


def find_hud(frame):
    """Returns {'tiles': box, 'exp': box} in frame coordinates, or None."""
    scored = sorted(((_lv_label_score(frame, r), r) for r in _orange_runs(frame)),
                    key=lambda t: -t[0])
    for score, run in scored[:4]:
        if score <= 0:
            break
        box = _locate_readout(frame, run)
        if box:
            return {"tiles": run, "exp": box}
    return None


NORM_H = 22          # digits are rescaled to this height before comparing
GLYPH_W, GLYPH_H = 12, 18


def _segment(crop):
    """Split a readout crop into characters.
    Returns (band, sat_band, [(x, y, w, h)]) in the rescaled band."""
    g = crop.min(axis=2).astype(np.float32)   # drops coloured brackets and bars
    lo, hi = np.percentile(g, 30), np.percentile(g, 99.5)
    w = np.clip((g - lo) / max(8.0, hi - lo), 0, 1)
    ink = (w > 0.5).sum(axis=1) > max(1, 0.03 * w.shape[1])
    best, run, start = (0, 0, 0), 0, 0
    for i, r in enumerate(list(ink) + [False]):     # tallest run of inked rows
        if r:
            start = i if run == 0 else start
            run += 1
        else:
            best = max(best, (run, start, i))
            run = 0
    r0, r1 = best[1], best[2]
    if r1 - r0 < 4:
        return None, None, []
    pad = max(1, (r1 - r0) // 4)
    scale = NORM_H / (r1 - r0)
    band = cv2.resize(w[max(0, r0 - pad):r1 + pad], None, fx=scale, fy=scale,
                      interpolation=cv2.INTER_CUBIC)
    sat = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)[:, :, 1].astype(np.float32) / 255
    sat = cv2.resize(sat[max(0, r0 - pad):r1 + pad], (band.shape[1], band.shape[0]),
                     interpolation=cv2.INTER_LINEAR)
    b = band > 0.45
    col = b.sum(axis=0)
    segs, x = [], 0
    while x < len(col):
        if col[x] == 0:
            x += 1
            continue
        s = x
        while x < len(col) and col[x] > 0:
            x += 1
        while x - s > 1.05 * NORM_H:       # two characters stuck together
            lo_, hi_ = s + int(0.35 * NORM_H), min(x - int(0.3 * NORM_H), s + int(0.85 * NORM_H))
            if hi_ <= lo_:
                break
            cut = lo_ + int(np.argmin(col[lo_:hi_]))
            segs.append((s, cut))
            s = cut
        segs.append((s, x))
    boxes = []
    for s, e in segs:
        rows = np.where(b[:, s:e].any(axis=1))[0]
        if len(rows) and (e - s) * len(rows) >= 4:
            boxes.append((s, int(rows[0]), e - s, int(rows[-1] - rows[0] + 1)))
    return band, sat, boxes


def _glyph_vec(band, box):
    x, y, w, h = box
    g = band[y:y + h, x:x + w]
    target = GLYPH_W / GLYPH_H
    if w / h < target:
        p = int(round(h * target - w))
        g = np.pad(g, ((0, 0), (p // 2, p - p // 2)))
    else:
        p = int(round(w / target - h))
        g = np.pad(g, ((p // 2, p - p // 2), (0, 0)))
    return cv2.resize(g, (GLYPH_W, GLYPH_H), interpolation=cv2.INTER_AREA).astype(np.float32)


def _corr(a, b):
    a = a - a.mean()
    b = b - b.mean()
    d = float(np.sqrt((a * a).sum() * (b * b).sum()))
    return float((a * b).sum()) / d if d > 1e-6 else 0.0


def _characters(crop):
    """Characters of a readout: ('tall', box) digits/% and ('dot', box),
    with bracket slivers, coloured brackets and stray specks removed.
    Also marks big gaps (where a bracket was) as ('gap', None)."""
    band, sat, boxes = _segment(crop)
    if band is None:
        return None, []
    def bracket(b):
        x, y, w, h = b
        m = band[y:y + h, x:x + w] > 0.45
        return w < 0.22 * NORM_H or (m.any() and sat[y:y + h, x:x + w][m].mean() > 0.32)
    tall = [b for b in boxes if b[3] >= 0.55 * NORM_H and not bracket(b)]
    if not tall:
        return band, []
    # Brackets are thin and a bit taller than the digits.
    med_h = float(np.median([b[3] for b in tall]))
    tall = [b for b in tall if not (b[2] < 0.3 * NORM_H and b[3] > 1.08 * med_h)] or tall
    first, last = tall[0][0], tall[-1][0]
    out, prev_end = [], None
    for b in boxes:
        x, y, w, h = b
        if b in tall:
            kind = "tall"
        elif h < 0.4 * NORM_H and w < 0.4 * NORM_H and first < x < last and y > 0.45 * NORM_H:
            kind = "dot"
        else:
            continue
        if prev_end is not None and x - prev_end > 0.55 * NORM_H:
            out.append(("gap", None))
        out.append((kind, b))
        prev_end = x + w
    return band, out


# Examples of the HUD's digits (0-6, 9 and %) cut from a MapleStory Classic
# stream screenshot. Missing ones (7, 8) and variations are learned from the
# user's own screen while tracking.
SEED_GLYPHS_B64 = (
    "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"
    "GxDJyFDGUK2eklqcXKRupaBeU2qorqOgnpZfVFKUmBefX5SSChJ3S8wpTtVRUC/OSCxIVbdS0DDW"
    "UTC00FEwNNLUUahVIAdwCUoryMsryMsrqiiIh7bMmTtn/ryFKzbOK2g9+/rh1SvXH77+eHnatCfv"
    "dvfUtEybP68lbtbT6zXGsiomlmZacvNfnInkYWBgZmHn4Jhx90AACwMEZC1dXuRu6+xuI8vMIGpX"
    "v+va9duX1kfwMjAwe6x88vbdoyPVpjIMDGL+5U1NdXWt1bEMTLziCqrK6g6d22bpejlwgcwQbr19"
    "tGzNRCMQW6Lp8oHoibOLo+OTUrInzC6Xdiyev+Pg8ePbu/2UmIScO3acOH1oWYoiGwMjj7yukZG+"
    "uigLQ3b31MkTp02dNG16T+qy28/vX7956+6L5+cmH/n+8fyuvQdPXL28u/3grU1pDu4BoVHRIQ4n"
    "rs4w4xSSlpGTkxU/fqFLhYGRk52ViZFp3e42UwEJBVkxTgaGtK6p/W0tPd3lNhwM4gGz7n1++eHD"
    "lQpFBgb5pNWnThw/urs/Rp1Z1DA4LTs1uaBrcrqyurKMtLyYpFnTzjl1lc7g4BFpuX18xeo8NTZO"
    "dgHj3gvbqqe05yenZRfVTZ5VohbcuunQoTNnd9W6yjDp5Kw+tPfo4aXhEgwM7GJqOlo6OioCTAxp"
    "nVN7O7p7evu66+PnXHh868qNm7fu3j4+Zdv7H5f27D1w5NTpXV1bHpwqdLB39Q2OCHE8fHetNTMH"
    "r6CotJzkqTsL1SExxMS84/IKB14BcSkxDgaG7KmL+xqbejrLrLkYhF07z7159/3dhRJVZgaRgOXn"
    "Tp06uqsz3JiBWzMyJyMptbCtM49LUkVGXFxI2rRx04Kk0kg2kIns1VeOTN3Yo8vIxcUnX39qY87U"
    "GYXJBaUlJX1ziuU9Klcfv3Tz4v5mL3lmab8FJ06eO7YuTpyBgYlPWU9XT0dNiJEBAFBLAwQtAAAA"
    "CAAAACEA7WX+cf//////////BQAUADkubnB5AQAQAAgDAAAAAAAA6gIAAAAAAACb7BfqGxDJyFDG"
    "UK2eklqcXKRupaBeU2qorqOgnpZfVFKUmBefX5SSChJ3S8wpTtVRUC/OSCxIVbdS0DDWUTC00FEw"
    "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"
)


def _load_seed_glyphs():
    if not SEED_GLYPHS_B64:
        return {}
    import io
    data = np.load(io.BytesIO(base64.b64decode(SEED_GLYPHS_B64)))
    return {k: [v.astype(np.float32) / 255 for v in data[k]] for k in data.files}


class DigitReader:
    """Reads the HUD's EXP numbers by comparing each character with examples
    of the game's own digits. It learns from readings the tracker accepts,
    so it adapts to the size and blur of the user's stream. Tesseract fills
    in a character only when the comparison isn't sure."""

    MIN_SCORE, MARGIN = 0.72, 0.07
    LEARN_SCORE = 0.86
    MAX_LEARNED = 24

    def __init__(self, path=None):
        self.path = path
        self.seeds = _load_seed_glyphs()
        self.learned = {}
        self.candidates = []       # (char, vec) from Tesseract, awaiting agreement
        self.dirty = False
        if path and Path(path).exists():
            try:
                data = np.load(path)
                self.learned = {k: [v for v in data[k]] for k in data.files}
            except Exception:
                log.exception("couldn't load learned digits")

    def templates(self):
        chars = set(self.seeds) | set(self.learned)
        return {c: self.seeds.get(c, []) + self.learned.get(c, []) for c in chars}

    def classify(self, vec):
        """Best match over every example, allowing a 1-pixel shift either way."""
        tm = self.templates()
        chars = [c for c, ts in tm.items() for _ in ts]
        if not chars:
            return "?", 0.0
        T = np.stack([t for c, ts in tm.items() for t in ts]).reshape(len(chars), -1)
        T = T - T.mean(axis=1, keepdims=True)
        T /= np.linalg.norm(T, axis=1, keepdims=True) + 1e-6
        p = np.pad(vec, 1)
        S = np.stack([p[1 + dy:1 + dy + GLYPH_H, 1 + dx:1 + dx + GLYPH_W]
                      for dy in (-1, 0, 1) for dx in (-1, 0, 1)]).reshape(9, -1)
        S = S - S.mean(axis=1, keepdims=True)
        S /= np.linalg.norm(S, axis=1, keepdims=True) + 1e-6
        per_example = (S @ T.T).max(axis=0)
        best_by_char = {}
        for c, s in zip(chars, per_example):
            best_by_char[c] = max(best_by_char.get(c, -1.0), float(s))
        ranked = sorted(((s, c) for c, s in best_by_char.items()), reverse=True)
        best, c = ranked[0]
        second = ranked[1][0] if len(ranked) > 1 else 0.0
        return (c if best >= self.MIN_SCORE and best - second >= self.MARGIN else "?"), best

    def read(self, crop):
        """Returns (text, glyphs) where text looks like '152.225 7.00%' and
        glyphs = [(char, score, vec, source)] for the tall characters."""
        band, chars = _characters(crop)
        if band is None or not chars:
            return None, []
        text, glyphs = [], []
        for kind, b in chars:
            if kind == "gap":
                text.append(" ")
            elif kind == "dot":
                text.append(".")
            else:
                v = _glyph_vec(band, b)
                c, score = self.classify(v)
                text.append(c)
                glyphs.append([c, score, v, "match"])
        text = "".join(text).strip()
        if "?" in text:
            text = self._fill_with_tesseract(crop, text, glyphs)
        return text, glyphs

    def _fill_with_tesseract(self, crop, text, glyphs):
        if OCR_BACKEND != "tesseract":
            return text
        try:
            t = pytesseract.image_to_string(
                _white_mask(crop, 4),
                config="--psm 7 -c tessedit_char_whitelist=0123456789.,%").strip()
        except Exception:
            return text
        t_chars = [c for c in t if c.isdigit() or c == "%"]
        mine = [g[0] for g in glyphs]
        # Line the two up, allowing Tesseract to see an extra bracket at
        # either end. Fill only if exactly one alignment agrees everywhere
        # the matcher is sure.
        fits = []
        for off in range(0, len(t_chars) - len(mine) + 1):
            seg = t_chars[off:off + len(mine)]
            if all(m == "?" or m == tc for m, tc in zip(mine, seg)):
                fits.append(seg)
        if len(fits) != 1:
            return text
        seg = fits[0]
        it = iter(seg)
        filled = []
        for ch in text:
            filled.append(ch if ch in " ." else next(it))
        for g, tc in zip(glyphs, seg):
            if g[0] == "?":
                g[0], g[3] = tc, "tesseract"
        return "".join(filled)

    def confirm(self, glyphs):
        """Called when the tracker accepted a reading made from these glyphs."""
        for c, score, v, source in glyphs:
            if c == "?":
                continue
            if source == "match" and score >= self.LEARN_SCORE:
                if score < 0.97:       # only keep examples that add something
                    self._add(c, v)
            elif source == "tesseract":
                # Needs two more agreeing sightings before it becomes an example.
                same = [cv for cc, cv in self.candidates if cc == c and _corr(cv, v) > 0.88]
                if len(same) >= 2:
                    self._add(c, v)
                    self.candidates = [(cc, cv) for cc, cv in self.candidates
                                       if not (cc == c and _corr(cv, v) > 0.88)]
                else:
                    self.candidates = (self.candidates + [(c, v)])[-200:]

    def _add(self, c, v):
        lst = self.learned.setdefault(c, [])
        lst.append(v)
        if len(lst) > self.MAX_LEARNED:
            del lst[0]
        self.dirty = True

    def save(self):
        if not (self.path and self.dirty):
            return
        try:
            with open(self.path, "wb") as f:
                np.savez_compressed(f, **{k: np.stack(v) for k, v in self.learned.items() if v})
            self.dirty = False
        except Exception:
            log.exception("couldn't save learned digits")


def parse_hud_text(text):
    """'152.225 7.00%' -> (152225, 7.0); '65.99%' -> (None, 65.99).

    The % always has two decimals and is below 100, so the possible ways to
    split the text are few: a lost decimal point or a bracket read as '1' or
    '?' can be undone. A reading with an amount must match the EXP table for
    some level. Anything still ambiguous returns None."""
    if not text or "%" not in text:
        return None
    s = text[:text.rindex("%")].rstrip()
    if len(s) < 2 or not s[-2:].isdigit():
        return None
    dec, s = s[-2:], s[:-2]
    if s.endswith((".", " ")):
        s = s[:-1]                     # the decimal point, or a lost one
    for drop in (0, 1):                # 1 = one bracket glyph before the %
        for k in (2, 1):               # digits before the decimal point
            ip, rest = s[-k:], s[:-k]
            if len(ip) != k or not ip.isdigit():
                continue
            unsure_tens = k == 1 and rest[-1:] == "?"   # '?5.99' could be 75.99
            if drop:
                if not rest or rest[-1] not in "1?":
                    continue
                rest = rest[:-1]
            pct = float(f"{ip}.{dec}")
            if not any(ch.isdigit() for ch in rest):
                if unsure_tens:
                    continue
                return None, pct       # nothing but brackets/spaces before it
            # With an amount, the EXP table settles any doubt about the split.
            words = rest.replace("?", " ").split()
            amount_txt = words[-1].strip(".") if words else ""
            if not re.fullmatch(r"\d[\d.]*", amount_txt or "x"):
                continue
            amount = int(amount_txt.replace(".", ""))
            if level_from_amount(amount, pct):
                return amount, pct
    return None


# ------------------------------------------------------------------ trackers

class ExpTracker:
    """Turns noisy EXP readings into total EXP gained, handling level-ups.

    The key check: EXP divided by the percentage always gives the same total
    for the current level. A reading where both numbers agree is almost
    certainly correct, so it's accepted right away, even when EXP changes
    every second. Anything that doesn't fit (a drop, a level-up, or a level
    we can't verify yet) must show up in several readings in a row before it
    counts, because a misread on a still frame tends to repeat."""

    CONFIRM = 3          # readings in a row needed for drops / level-ups
    REBASELINE = 20      # this many rejects in a row = start over

    def __init__(self):
        self.last = None        # (exp, pct) last accepted reading
        self.req = None         # EXP needed for the current level (estimate)
        self.req_pct = None     # the % that estimate came from
        self.pending = []       # readings waiting for confirmation
        self.rejects = 0
        self.gained = 0
        self.lost = 0           # EXP lost to deaths
        self.levels = 0
        self.undo = None        # state before the last level-up/death/rebaseline

    def _snapshot(self):
        return (self.last, self.req, self.req_pct, self.gained, self.lost, self.levels)

    def _try_undo(self, reading):
        """A real level-up or death never jumps straight back to the old
        numbers. If the old level's numbers reappear before any new progress,
        the 'event' was a misread repeated on a still frame: take it back."""
        if not self.undo:
            return False
        last, req, req_pct = self.undo[:3]
        exp, pct = reading
        if last is None or exp < last[0] or pct < last[1] - 0.011:
            return False
        if not self._fits(exp, pct, req, req_pct):
            return False
        (self.last, self.req, self.req_pct,
         self.gained, self.lost, self.levels) = self.undo
        self.undo = None
        self.pending = []
        return True

    # -- helpers
    @staticmethod
    def _req(exp, pct):
        return exp / (pct / 100) if pct >= 0.5 else None

    @staticmethod
    def _tol(*pcts):
        # The game shows % to 2 decimals, so it can be off by up to 0.005.
        return sum(0.006 / p for p in pcts if p) + 0.001

    def _fits(self, exp, pct, req, req_pct):
        """True/False if the reading fits that level total, None if unknown."""
        r = self._req(exp, pct)
        if r is None or req is None:
            return None
        return abs(r - req) / req <= self._tol(pct, req_pct)

    def _set_last(self, reading, new_level=False):
        exp, pct = reading
        self.last = reading
        r = self._req(exp, pct)
        if new_level:
            self.req, self.req_pct = (r, pct) if r else (None, None)
        elif r and (self.req is None or pct > (self.req_pct or 0)):
            self.req, self.req_pct = r, pct   # higher % = more precise

    def _agrees(self, a, b):
        """Two readings in a row that could both be right: EXP and % didn't
        go backwards, and they imply the same level total."""
        (ea, pa), (eb, pb) = a, b
        if eb < ea or pb < pa - 0.011:
            return False
        fit = self._fits(eb, pb, self._req(ea, pa), pa)
        return fit is not False

    # -- main entry point; returns a short label for the diagnostic log
    def update(self, reading):
        if reading is None:
            return "unreadable"
        undone = self._try_undo(reading)
        exp, pct = reading
        if self.last is None:
            return self._pend(reading, "start")
        old_exp, old_pct = self.last
        if exp >= old_exp and pct >= old_pct - 0.011:
            fit = self._fits(exp, pct, self.req, self.req_pct)
            if fit:
                self.pending = []
                self.rejects = 0
                self.gained += exp - old_exp
                self._set_last(reading)
                if exp > old_exp:
                    self.undo = None   # real progress since the event: keep it
                if undone:
                    return "undo"
                return "gain" if exp > old_exp else "same"
            if fit is False:
                return self._reject()
            return self._pend(reading, "unverified")   # % too low to check yet
        # Lower than before: death, level-up, or a misread.
        if self._fits(exp, pct, self.req, self.req_pct) is False and \
                not (old_pct - pct > 30 or pct < 0.5):
            return self._reject()
        return self._pend(reading, "drop")

    def _reject(self):
        self.pending = []
        self.rejects += 1
        if self.rejects >= self.REBASELINE:   # our baseline itself was wrong
            self.undo = self.undo or self._snapshot()
            self.last = self.req = self.req_pct = None
            self.rejects = 0
            return "rebaseline"
        return "rejected"

    def _pend(self, reading, why):
        if self.pending and self._agrees(self.pending[-1], reading):
            self.pending.append(reading)
        else:
            self.pending = [reading]
        if len(self.pending) < self.CONFIRM:
            return f"wait-{why}"
        return self._resolve()

    def _resolve(self):
        first, latest = self.pending[0], self.pending[-1]
        self.pending = []
        self.rejects = 0
        if self.last is None:
            self._set_last(latest, new_level=True)
            return "baseline"
        old_exp, old_pct = self.last
        f_exp = first[0]
        l_exp, l_pct = latest
        if l_exp >= old_exp and l_pct >= old_pct - 0.011:
            self.gained += l_exp - old_exp     # verified by repetition
            self._set_last(latest)
            return "gain-confirmed"
        fit = self._fits(l_exp, l_pct, self.req, self.req_pct)
        if fit or (fit is None and old_pct - l_pct < 30):
            self.undo = self._snapshot()
            self.lost += max(0, old_exp - f_exp)          # died
            self.gained += l_exp - f_exp
            self._set_last(latest)
            return "death"
        new_req = self._req(l_exp, l_pct)
        ratio = new_req / self.req if new_req and self.req else None
        # Each level needs more EXP than the last, so the new total must grow.
        if (ratio is not None and 1.0 < ratio <= 3.5) or \
                (ratio is None and old_pct >= 70):
            self.undo = self._snapshot()
            if self.req:
                self.gained += max(0, self.req - old_exp)  # rest of old level
            self.gained += l_exp
            self.levels += 1
            self._set_last(latest, new_level=True)
            return "level-up"
        return "rejected-pattern"


class PctTracker:
    """For HUDs that show only the percentage, like 'EXP. [65.99%]'.

    Tracks progress in % per level; EXP = % x that level's requirement from
    the EXP table, so it needs to know the starting level (asked once, then
    counted up at each level-up). Small forward steps count right away. Big
    jumps, drops (deaths) and level-ups must repeat over several reads, and
    are undone if the old number comes back before any new progress."""

    CONFIRM = 3
    BIG_STEP = 2.0          # % per read; bigger jumps need confirming

    def __init__(self, start_level=None):
        self.start_level = start_level
        self.offset = 0                 # level-ups this session
        self.pct_by_offset = {}         # % gained while at start_level + offset
        self.lost_by_offset = {}
        self.last = None
        self.pending = []
        self.undo = None
        self.progress_since_event = 0.0
        self.rejects = 0

    # -- totals
    @property
    def level(self):
        return self.start_level + self.offset if self.start_level else None

    def _exp(self, table):
        if not self.start_level:
            return None
        total = 0.0
        for off, pct in table.items():
            req = exp_to_next(self.start_level + off)
            if req is None:
                return None
            total += pct / 100 * req
        return total

    @property
    def gained(self):
        return self._exp(self.pct_by_offset)

    @property
    def lost(self):
        return self._exp(self.lost_by_offset) or 0

    @property
    def levels(self):
        return self.offset

    @property
    def pct_gained(self):
        return sum(self.pct_by_offset.values())

    def set_level(self, level):
        """Level as shown right now; earlier levels this session are implied."""
        self.start_level = max(1, int(level) - self.offset)

    def _add(self, pct, off=None, table=None):
        table = self.pct_by_offset if table is None else table
        off = self.offset if off is None else off
        table[off] = table.get(off, 0.0) + pct

    def _snapshot(self):
        return (self.last, self.offset, dict(self.pct_by_offset), dict(self.lost_by_offset))

    # -- main entry point; returns a short label for the diagnostic log
    def update(self, pct):
        if pct is None:
            return "unreadable"
        if self._try_undo(pct):
            label = "undo"
        else:
            label = None
        if self.last is None:
            return self._pend(pct, "start")
        d = pct - self.last
        if -0.011 <= d <= self.BIG_STEP:
            self.pending = []
            self.rejects = 0
            if d > 0:
                self._add(d)
                self.last = pct
                self.progress_since_event += d
                if self.progress_since_event >= 0.3:
                    self.undo = None    # real progress since the event: keep it
            return label or ("gain" if d > 0 else "same")
        return self._pend(pct, "jump" if d > 0 else "drop")

    def _try_undo(self, pct):
        if not self.undo:
            return False
        old_last = self.undo[0]
        if old_last is None or not (-0.011 <= pct - old_last <= self.BIG_STEP):
            return False
        self.last, self.offset, self.pct_by_offset, self.lost_by_offset = self.undo
        self.undo = None
        self.pending = []
        return True

    def _pend(self, pct, why):
        if self.pending and -0.011 <= pct - self.pending[-1] <= self.BIG_STEP:
            self.pending.append(pct)
        else:
            self.pending = [pct]
        if len(self.pending) < self.CONFIRM:
            return f"wait-{why}"
        return self._resolve()

    def _resolve(self):
        first, latest = self.pending[0], self.pending[-1]
        self.pending = []
        if self.last is None:
            self.last = latest
            return "baseline"
        old = self.last
        self.undo = self._snapshot()
        self.progress_since_event = 0.0
        if latest >= old:                             # big jump, seen repeatedly
            self._add(latest - old)
            self.last = latest
            return "jump-confirmed"
        if old - latest > 30 and latest < 50:         # went past 100%: level-up
            self._add(100 - old)
            self.offset += 1
            self._add(latest)
            self.last = latest
            return "level-up"
        self._add(old - first, table=self.lost_by_offset)    # died
        self._add(latest - first)
        self.last = latest
        return "death"


class MesoTotalTracker:
    """Inventory meso total: counts increases, ignores spending."""

    def __init__(self):
        self.last = None
        self.pending = None
        self.gained = 0

    def update(self, value):
        if value is None:
            return
        if value != self.pending:
            self.pending = value
            return
        if self.last is not None and value > self.last:
            delta = value - self.last
            if delta < 5_000_000:  # sanity cap against OCR garbage
                self.gained += delta
        self.last = value


class PickupTracker:
    """Counts new pickup messages by diffing each frame against the last one."""

    def __init__(self, meso_pattern, item_pattern):
        self.prev = []
        self.meso_re = re.compile(meso_pattern)
        self.item_re = re.compile(item_pattern)
        self.mesos = 0
        self.items = Counter()

    def update(self, lines):
        unmatched_prev = list(self.prev)
        for line in lines:
            match = None
            for p in unmatched_prev:
                if difflib.SequenceMatcher(None, line, p).ratio() > 0.8:
                    match = p
                    break
            if match is not None:
                unmatched_prev.remove(match)   # same message as last frame
            else:
                self._count(line)              # brand new message
        self.prev = lines

    def _count(self, line):
        m = self.meso_re.search(line)
        if m:
            n = to_int(m.group(1))
            if n and n < 1_000_000:
                self.mesos += n
            return
        m = self.item_re.search(line)
        if m:
            name = m.group(1).strip(" .").title()
            if name:
                self.items[name] += 1


# ------------------------------------------------------------------- engine

def blank_snapshot(warning=None):
    return {"running": False, "status": "idle", "elapsed": 0, "exp": 0, "exp_hr": None,
            "now_hr": None, "pct_hr": None, "level": None, "pct": None, "eta": None,
            "mode": None, "needs_level": False, "mesos": None, "mesos_hr": None,
            "has_mesos": False, "levels": 0, "lost": 0, "items": [], "has_items": False,
            "warning": warning}


class Engine:
    """Reads the screen in a background thread. Start/pause/reset are safe
    to call from the window or the web page at any time.

    Normally it finds the HUD by itself anywhere on screen (and again if
    the stream window moves). An EXP box drawn by hand in the advanced menu
    is used instead when present."""

    RELOCATE_AFTER = 6.0      # seconds without a readable EXP before searching again
    ACCEPTED = ("gain", "same", "gain-confirmed", "jump-confirmed", "baseline",
                "level-up", "death", "undo")

    def __init__(self, cfg, reader=None):
        self.cfg = cfg
        r = cfg["regions"]
        self.has_mesos = "mesos" in r or "pickups" in r
        self.has_items = "pickups" in r
        self.lock = threading.Lock()
        self.running = False
        self._alive = True
        self._custom_reader = reader is not None
        self._reader = reader or self._read_screen
        self.last_error = None
        self.digits = DigitReader(DATA_DIR / "learned_digits.npz")
        self.hud = None
        if "exp" in r:
            self.hud = {"mon": cfg.get("monitor", 1), "exp": r["exp"], "manual": True}
        elif self._custom_reader:
            self.hud = {"mon": 1, "exp": None, "manual": True}
        self.status = "idle"
        self.last_search = 0.0
        self._glyphs = []
        self._new_trackers()
        SESSIONS_DIR.mkdir(exist_ok=True)
        stamp = f"{datetime.now():%Y%m%d_%H%M%S}"
        self.log_path = SESSIONS_DIR / f"session_{stamp}.csv"
        self._log_started = False
        # Every EXP read (what was read + what the tracker decided), so a bad
        # session can be diagnosed. About 150 KB per hour.
        self.readings_path = SESSIONS_DIR / f"readings_{stamp}.csv"
        self._readings_file = None
        self._readings_rows = 0
        threading.Thread(target=self._loop, daemon=True).start()

    # -- controls
    def _new_trackers(self):
        r = self.cfg["regions"]
        self.exp = ExpTracker()
        self.pctt = PctTracker(self.cfg.get("level"))
        self.mode = None            # "amount" (12,345 [7.00%]) or "pct" ([65.99%])
        self.mode_votes = []
        self.meso = MesoTotalTracker() if "mesos" in r else None
        self.pick = (PickupTracker(self.cfg["meso_pattern"], self.cfg["item_pattern"])
                     if "pickups" in r else None)
        self.banked = 0.0                 # seconds from earlier stretches
        self.started_at = time.time() if self.running else None
        self.last_ok = time.time()
        self.skip_pickup_frame = True
        self.history = []                 # (elapsed, exp gained) for the recent pace

    def start(self):
        with self.lock:
            if self.running:
                return
            # Forget the last reading so anything gained while paused
            # isn't counted, and messages already on screen aren't recounted.
            self.exp.last = None
            self.exp.pending = []
            self.pctt.last = None
            self.pctt.pending = []
            self.pctt.undo = None
            if self.meso:
                self.meso.last = self.meso.pending = None
            self.skip_pickup_frame = True
            self.running = True
            self.started_at = self.last_ok = time.time()

    def stop(self):
        with self.lock:
            if not self.running:
                return
            self.banked += time.time() - self.started_at
            self.started_at = None
            self.running = False
        self.digits.save()

    def reset(self):
        with self.lock:
            self._new_trackers()

    def relocate(self):
        with self.lock:
            if not (self.hud and self.hud.get("manual")):
                self.hud = None
                self.last_search = 0.0

    def set_level(self, level):
        with self.lock:
            self.pctt.set_level(level)
            self.cfg["level"] = int(level)
        save_config(self.cfg)

    def shutdown(self):
        self.stop()
        self._alive = False
        if self._readings_file:
            try:
                self._readings_file.close()
            except OSError:
                pass
            self._readings_file = None

    # -- state
    def _elapsed(self):
        return self.banked + (time.time() - self.started_at if self.started_at else 0)

    def _gained(self):
        return self.exp.gained if self.mode == "amount" else self.pctt.gained

    def _level_and_pct(self):
        if self.mode == "amount" and self.exp.last:
            return level_from_amount(*self.exp.last), self.exp.last[1]
        if self.mode == "pct" and self.pctt.last is not None:
            return self.pctt.level, self.pctt.last
        return None, None

    def capture_boxes(self):
        """Screen rectangles being read (for the 'window is covering it' check)."""
        out = []
        with mss.mss() as sct:
            mons = sct.monitors
            def mon(i):
                return mons[i] if 0 < i < len(mons) else mons[1]
            if self.hud and self.hud.get("exp"):
                m = mon(self.hud["mon"])
                x, y, w, h = self.hud["exp"]
                out.append((m["left"] + x, m["top"] + y, w, h))
            m = mon(self.cfg.get("monitor", 1))
            for key in ("mesos", "pickups"):
                if key in self.cfg["regions"]:
                    x, y, w, h = self.cfg["regions"][key]
                    out.append((m["left"] + x, m["top"] + y, w, h))
        return out

    def snapshot(self):
        with self.lock:
            el = self._elapsed()
            hrs = el / 3600
            settled = el >= 60  # per-hour rates are wild in the first minute
            if self.meso:
                mesos = self.meso.gained
            elif self.pick:
                mesos = self.pick.mesos
            else:
                mesos = None
            gained = self._gained()
            level, pct = self._level_and_pct()
            needs_level = self.mode == "pct" and self.pctt.start_level is None
            pct_hr = None
            if self.mode == "pct" and settled:
                pct_hr = self.pctt.pct_gained / hrs
            exp_hr = round(gained / hrs) if settled and gained is not None else None
            # Recent pace: the last ~5 minutes.
            now_hr = None
            if gained is not None and self.history:
                old = next((h for h in self.history if el - h[0] <= 300), None)
                if old and el - old[0] >= 60:
                    now_hr = round((gained - old[1]) / ((el - old[0]) / 3600))
            eta = None
            req = exp_to_next(level) if level else None
            rate = (now_hr or exp_hr)
            if req and pct is not None and rate:
                eta = (100 - pct) / 100 * req / rate * 3600
            elif pct is not None and pct_hr:
                eta = (100 - pct) / pct_hr * 3600
            warning = None
            if self.running:
                if self.status == "searching":
                    warning = ("Looking for the HUD... Show the stream with the "
                               "game's bottom bar (LV / HP / MP / EXP) visible.")
                elif time.time() - self.last_ok > 15:
                    warning = (f"Reader error: {self.last_error}" if self.last_error else
                               "Can't read EXP. Stream paused, covered, or moved? "
                               "(Searching again.)")
                elif needs_level:
                    warning = "Your HUD only shows %. Set your level (menu) to see EXP."
            return {
                "running": self.running,
                "status": self.status,
                "elapsed": round(el, 1),
                "exp": round(gained) if gained is not None else None,
                "exp_hr": exp_hr,
                "now_hr": now_hr,
                "pct_hr": round(pct_hr, 2) if pct_hr is not None else None,
                "level": level,
                "pct": pct,
                "eta": round(eta) if eta else None,
                "mode": self.mode,
                "needs_level": needs_level,
                "mesos": mesos,
                "mesos_hr": round(mesos / hrs) if settled and mesos is not None else None,
                "has_mesos": self.has_mesos,
                "levels": self.exp.levels if self.mode == "amount" else self.pctt.levels,
                "lost": round((self.exp.lost if self.mode == "amount" else self.pctt.lost) or 0),
                "items": [[k, v] for k, v in self.pick.items.most_common()] if self.pick else [],
                "has_items": self.has_items,
                "warning": warning,
            }

    # -- finding and reading the HUD
    def _search(self, sct):
        """Look for the HUD on every monitor, the last-used one first."""
        self.status = "searching"
        self.last_search = time.time()
        mons = sct.monitors
        order = [self.cfg.get("monitor", 1)] + [i for i in range(1, len(mons))]
        for i in dict.fromkeys(order):
            if not 0 < i < len(mons):
                continue
            m = mons[i]
            frame = np.ascontiguousarray(np.array(sct.grab(m))[:, :, :3])
            sx = frame.shape[1] / m["width"]          # 2 on Retina Macs
            hud = find_hud(frame)
            if hud:
                x, y, w, h = hud["exp"]
                box = [int(x / sx), int(y / sx), max(1, int(w / sx)), max(1, int(h / sx))]
                self.hud = {"mon": i, "exp": box, "manual": False}
                self.cfg["monitor"] = i
                self.status = "tracking"
                self.last_ok = time.time()
                log.info("HUD found on monitor %s at %s", i, box)
                return True
        return False

    def _grab_exp(self, sct):
        mons = sct.monitors
        i = self.hud["mon"]
        m = mons[i] if 0 < i < len(mons) else mons[1]
        x, y, w, h = self.hud["exp"]
        box = {"left": m["left"] + x, "top": m["top"] + y, "width": w, "height": h}
        shots = []
        for k in range(max(1, self.cfg["frames_per_read"])):
            if k:
                time.sleep(0.04)
            shots.append(np.array(sct.grab(box))[:, :, :3])
        if len(shots) == 1:
            return np.ascontiguousarray(shots[0])
        return np.median(np.stack(shots), axis=0).astype(np.uint8)

    def _read_screen(self, sct):
        r = self.cfg["regions"]
        crop = self._grab_exp(sct)
        text, glyphs = self.digits.read(crop)
        LAST_OCR["exp"] = text or ""
        self._glyphs = glyphs
        parsed = parse_hud_text(text)
        return (parsed,
                read_mesos(sct, self.cfg) if "mesos" in r else None,
                read_pickup_lines(sct, self.cfg) if "pickups" in r else None)

    def _feed(self, parsed):
        """Send one reading to the right tracker; returns its decision."""
        if parsed is not None and self.mode is None:
            self.mode_votes.append("amount" if parsed[0] is not None else "pct")
            if len(self.mode_votes) >= 3:
                self.mode = max(set(self.mode_votes), key=self.mode_votes.count)
            else:
                return "wait-mode"
        if self.mode == "amount":
            if parsed is None or parsed[0] is None:
                return self.exp.update(None)
            return self.exp.update(parsed)
        if self.mode == "pct":
            before = self.pctt.offset
            decision = self.pctt.update(parsed[1] if parsed else None)
            if self.pctt.offset != before and self.pctt.level:
                self.cfg["level"] = self.pctt.level
                self._save_level = True
            return decision
        return "unreadable"

    def check_now(self):
        """One-off look for the 'Check reading' menu item."""
        DEBUG_DIR.mkdir(exist_ok=True)
        with mss.mss() as sct:
            if not self.hud:
                found = self._search(sct)
                if not found:
                    self.status = "idle" if not self.running else self.status
                    return ("Couldn't find the HUD on screen.\n\nShow the stream "
                            "with the game's bottom bar (LV, HP, MP, EXP) visible, "
                            "not covered by other windows, then try again.")
            crop = self._grab_exp(sct)
        cv2.imwrite(str(DEBUG_DIR / "exp_captured.png"), crop)
        text, glyphs = self.digits.read(crop)
        parsed = parse_hud_text(text)
        where = "your box" if self.hud.get("manual") else f"monitor {self.hud['mon']}"
        lines = [f"Found the EXP readout on {where}.", f"Read: {text or '(nothing)'}"]
        if parsed:
            amount, pct = parsed
            if amount is not None:
                lv = level_from_amount(amount, pct)
                lines.append(f"EXP {amount:,} at {pct:.2f}%  (level {lv})")
            else:
                lines.append(f"{pct:.2f}% (your HUD shows only the percentage)")
        else:
            lines.append("Not sure about every digit yet. It learns the font from "
                         "your stream as it goes; give it a minute of tracking.")
        lines.append("\nIt should match the game. A picture of what was read is in "
                     "the data folder (debug/exp_captured.png).")
        return "\n".join(lines)

    # -- background loop
    def _loop(self):
        last_log = last_save = time.time()
        self._save_level = False
        with mss.mss() as sct:   # mss must live in the thread that uses it
            while self._alive:
                if not self.running:
                    time.sleep(0.2)
                    continue
                if not self._custom_reader:
                    lost = time.time() - self.last_ok > self.RELOCATE_AFTER
                    if self.hud is None or (lost and not self.hud.get("manual")
                                            and time.time() - self.last_search > 5):
                        try:
                            if not self._search(sct):
                                time.sleep(1.5)
                                continue
                        except Exception:
                            log.exception("HUD search failed")
                            time.sleep(2)
                            continue
                try:
                    parsed, mesos, lines = self._reader(sct)
                    self.last_error = None
                except Exception as e:
                    msg = str(e).strip().splitlines()[0][:150] if str(e).strip() else repr(e)
                    if msg != self.last_error:
                        log.warning("read error: %s", msg)
                    self.last_error = msg
                    time.sleep(1)
                    continue
                with self.lock:
                    if self.running:
                        if parsed:
                            self.last_ok = time.time()
                            self.status = "tracking"
                        decision = self._feed(parsed)
                        if decision in self.ACCEPTED and self._glyphs:
                            self.digits.confirm(self._glyphs)
                        self._log_reading(parsed, decision)
                        if self.meso:
                            self.meso.update(mesos)
                        if self.pick and lines is not None:
                            if self.skip_pickup_frame:
                                self.pick.prev = lines
                                self.skip_pickup_frame = False
                            else:
                                self.pick.update(lines)
                        el = self._elapsed()
                        g = self._gained()
                        if g is not None and (not self.history or el - self.history[-1][0] >= 5):
                            self.history = (self.history + [(el, g)])[-80:]
                if self._save_level:
                    self._save_level = False
                    save_config(self.cfg)
                now = time.time()
                if now - last_log >= 60:
                    last_log = now
                    self._log()
                if now - last_save >= 60:
                    last_save = now
                    self.digits.save()
                time.sleep(self.cfg["poll_seconds"])

    def _log_reading(self, parsed, decision):
        try:
            if self._readings_file is None:
                self._readings_file = open(self.readings_path, "a", newline="",
                                           encoding="utf-8")
                csv.writer(self._readings_file).writerow(
                    ["time", "read_text", "exp", "pct", "decision",
                     "exp_gained_total", "level_ups"])
            g = self._gained()
            csv.writer(self._readings_file).writerow(
                [datetime.now().strftime("%H:%M:%S.%f")[:-3],
                 LAST_OCR["exp"].replace("\n", " | "),
                 parsed[0] if parsed and parsed[0] is not None else "",
                 parsed[1] if parsed else "",
                 decision, round(g) if g is not None else "",
                 self.exp.levels if self.mode == "amount" else self.pctt.levels])
            self._readings_rows += 1
            if self._readings_rows % 10 == 0:
                self._readings_file.flush()
        except OSError:
            pass

    def _log(self):
        s = self.snapshot()
        try:
            with open(self.log_path, "a", newline="") as f:
                w = csv.writer(f)
                if not self._log_started:
                    w.writerow(["time", "elapsed_s", "level", "pct", "exp_gained",
                                "exp_per_hr", "mesos_gained", "mesos_per_hr"])
                w.writerow([datetime.now().strftime("%H:%M:%S"), int(s["elapsed"]),
                            s["level"], s["pct"], s["exp"], s["exp_hr"],
                            s["mesos"], s["mesos_hr"]])
            self._log_started = True
        except OSError:
            log.exception("couldn't write session log")


class App:
    """Holds the config and the engine (rebuilt after manual boxes change)."""

    def __init__(self):
        self.cfg = load_config()
        self.engine = None
        self.make_engine()

    def make_engine(self):
        if self.engine:
            self.engine.shutdown()
        self.engine = Engine(self.cfg)

    def snapshot(self):
        s = self.engine.snapshot()
        if not self.cfg["_tesseract_found"]:
            s["warning"] = ("Text reader (Tesseract) not found. Use the full "
                            "MapleTracker folder, or install Tesseract.")
        return s

    def start(self):
        self.engine.start()

    def stop(self):
        self.engine.stop()

    def reset(self):
        self.engine.reset()


# --------------------------------------------------------------- web view

WEB_PAGE = r"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Maple Tracker</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #1b1d23; color: #e8e8e8; padding: 14px 16px;
         font: 14px "Segoe UI", system-ui, sans-serif; }
  .hdr { display: flex; align-items: center; gap: 7px; font-size: 12px;
         font-weight: 700; color: #f5a623; letter-spacing: .08em; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #5c616b; }
  .dot.on { background: #2ecc71; box-shadow: 0 0 6px #2ecc71; }
  .time { margin-left: auto; color: #8a8f98; font: 12px Consolas, monospace; }
  .lbl { color: #8a8f98; font-size: 11px; font-weight: 700; letter-spacing: .08em;
         margin-top: 14px; }
  .big { font-size: 30px; font-weight: 700; font-variant-numeric: tabular-nums;
         line-height: 1.15; }
  .sub { color: #b8bcc4; font-size: 13px; font-variant-numeric: tabular-nums; }
  .items { font-size: 13px; line-height: 1.55; color: #c8ccd4; }
  .items b { display: inline-block; min-width: 2.4em; color: #e8e8e8;
             font-variant-numeric: tabular-nums; }
  .warn { color: #ff6b5b; font-size: 12px; margin-top: 10px; }
  .btns { display: flex; gap: 8px; margin-top: 16px; }
  button { flex: 1; background: #2a2d35; color: #e8e8e8; border: 0; border-radius: 6px;
           padding: 9px; font: inherit; cursor: pointer; }
  button:hover { background: #353944; }
</style></head><body>
<div class="hdr"><span class="dot" id="dot"></span>MAPLE TRACKER
  <span class="time" id="time">0:00:00</span></div>
<div class="lbl">EXP / HR</div>
<div class="big" id="exphr">—</div><div class="sub" id="exp">0 total</div>
<div class="sub" id="info" style="margin-top:6px;color:#e8e8e8"></div>
<div id="mesobox"><div class="lbl">MESOS / HR</div>
  <div class="big" id="mesohr">—</div><div class="sub" id="meso">0 total</div></div>
<div class="sub" id="extra" style="margin-top:10px"></div>
<div id="itembox"><div class="lbl">ITEMS</div><div class="items" id="items">—</div></div>
<div class="warn" id="warn"></div>
<div class="btns"><button id="toggle">Start</button><button id="reset">Reset</button></div>
<script>
const $ = id => document.getElementById(id);
const n = v => v === null || v === undefined ? "—" : Math.round(v).toLocaleString();
function hms(s) { s = Math.floor(s);
  return Math.floor(s / 3600) + ":" + String(Math.floor(s / 60) % 60).padStart(2, "0")
       + ":" + String(s % 60).padStart(2, "0"); }
let running = false;
async function tick() {
  try {
    const s = await (await fetch("/stats", { cache: "no-store" })).json();
    running = s.running;
    $("dot").className = "dot" + (s.running ? " on" : "");
    $("time").textContent = hms(s.elapsed);
    $("exphr").textContent = n(s.exp_hr);
    $("exp").textContent = (s.exp === null ? "set your level for EXP" : n(s.exp) + " total")
      + (s.now_hr ? "  ·  now " + n(s.now_hr) + "/hr" : "");
    const info = [];
    if (s.level) info.push("Lv " + s.level);
    if (s.pct !== null && s.pct !== undefined) info.push(s.pct.toFixed(2) + "%");
    if (s.eta) info.push("next level in " + hms(s.eta));
    $("info").textContent = s.status === "searching" ? "Looking for the HUD..." : info.join("  ·  ");
    $("mesobox").style.display = s.has_mesos ? "" : "none";
    $("mesohr").textContent = n(s.mesos_hr);
    $("meso").textContent = n(s.mesos) + " total";
    const extra = [];
    if (s.levels) extra.push(s.levels + " level-up" + (s.levels > 1 ? "s" : ""));
    if (s.lost) extra.push(n(s.lost) + " EXP lost to deaths");
    $("extra").textContent = extra.join("  ·  ");
    $("itembox").style.display = s.has_items ? "" : "none";
    const box = $("items"); box.textContent = s.items.length ? "" : "—";
    for (const [name, c] of s.items.slice(0, 10)) {
      const row = document.createElement("div"), b = document.createElement("b");
      b.textContent = c + "×"; row.append(b, " " + name); box.appendChild(row);
    }
    $("warn").textContent = s.warning || "";
    $("toggle").textContent = s.running ? "Pause" : (s.elapsed > 0 ? "Resume" : "Start");
    document.title = s.running && s.exp_hr !== null ? n(s.exp_hr) + " EXP/hr" : "Maple Tracker";
  } catch (e) {
    $("warn").textContent = "Can't reach the tracker PC. Is it still running?";
    $("dot").className = "dot";
  }
}
$("toggle").onclick = () => fetch(running ? "/stop" : "/start", { method: "POST" }).then(tick);
$("reset").onclick = () => { if (confirm("Reset this session?"))
  fetch("/reset", { method: "POST" }).then(tick); };
tick(); setInterval(tick, 2000);
</script></body></html>"""


def start_web_server(app, port):
    actions = {"/start": app.start, "/stop": app.stop, "/reset": app.reset}

    class Handler(BaseHTTPRequestHandler):
        def _send(self, body, ctype, code=200):
            data = body.encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path in ("/", "/index.html"):
                self._send(WEB_PAGE, "text/html; charset=utf-8")
            elif self.path.startswith("/stats"):
                self._send(json.dumps(app.snapshot()), "application/json")
            else:
                self._send("not found", "text/plain", 404)

        def do_POST(self):
            fn = actions.get(self.path)
            if not fn:
                return self._send("not found", "text/plain", 404)
            fn()
            self._send(json.dumps(app.snapshot()), "application/json")

        def log_message(self, *args):
            pass

    try:
        server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    except OSError as e:
        log.warning("Web view disabled (port %s unavailable: %s)", port, e)
        return None
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://{lan_ip()}:{port}"
    log.info("Web view: %s", url)
    return url


# ---------------------------------------------------------------------- GUI

BG, FG, SUB, DIM = "#1b1d23", "#e8e8e8", "#b8bcc4", "#8a8f98"
ACCENT, GOOD, BAD, BTN, BTN_HOVER = "#f5a623", "#2ecc71", "#ff6b5b", "#2a2d35", "#353944"
if IS_MAC:
    FONT, MONO = "Helvetica Neue", "Menlo"
else:
    FONT, MONO = "Segoe UI", "Consolas"


def flat_button(tk, parent, text, cmd, **kw):
    b = tk.Button(parent, text=text, command=cmd, bg=BTN, fg=FG, bd=0, relief="flat",
                  activebackground=BTN_HOVER, activeforeground=FG,
                  disabledforeground="#5c616b", font=(FONT, 9), cursor="hand2",
                  pady=4, padx=10, **kw)
    b.bind("<Enter>", lambda e: b.config(bg=BTN_HOVER))
    b.bind("<Leave>", lambda e: b.config(bg=BTN))
    return b


class Calibrator:
    """Full-screen picker: shows a screenshot and lets you drag boxes."""

    STEPS = [
        ("exp", "Step 1 of 3 (optional): drag a box around the EXP numbers on the "
                "bottom bar, e.g. 12,345 [12.34%]. Skip to let the app find it", False),
        ("mesos", "Step 2 of 3 (optional): drag a box around the meso total in "
                  "your inventory window", False),
        ("pickups", "Step 3 of 3 (optional): drag a box over where the "
                    "'You have gained...' pickup messages appear", False),
    ]

    def __init__(self, tk, root, cfg, on_done):
        self.tk, self.root, self.cfg, self.on_done = tk, root, cfg, on_done
        self.regions = {}
        self.step = 0
        self.rect = None
        self.start = None
        self.box = None

    # 1. countdown so the user can bring the stream up
    def begin(self):
        tk = self.tk
        self.root.withdraw()
        t = self.toast = tk.Toplevel(self.root)
        t.overrideredirect(True)
        t.attributes("-topmost", True)
        t.configure(bg=BG, highlightthickness=2, highlightbackground=ACCENT)
        self.toast_lbl = tk.Label(t, fg=FG, bg=BG, font=(FONT, 12), justify="center",
                                  padx=28, pady=20)
        self.toast_lbl.pack()
        self._countdown(5, first=True)

    def _countdown(self, n, first=False):
        if n == 0:
            self.toast.destroy()
            self.root.update()
            self.root.after(300, self._capture)  # let the popup disappear first
            return
        self.toast_lbl.config(text="Show the game or Discord stream fullscreen,\n"
                                   "and move your mouse onto that screen.\n\n"
                                   f"Taking a screenshot in {n}...")
        if first:
            self.toast.update_idletasks()
            sw, sh = self.toast.winfo_screenwidth(), self.toast.winfo_screenheight()
            w, h = self.toast.winfo_reqwidth(), self.toast.winfo_reqheight()
            self.toast.geometry(f"+{(sw - w) // 2}+{(sh - h) // 3}")
        self.root.after(1000, self._countdown, n - 1)

    # 2. screenshot the monitor under the mouse and show it full screen
    def _capture(self):
        tk = self.tk
        px, py = self.root.winfo_pointerxy()
        with mss.mss() as sct:
            mons = sct.monitors
            self.mon_idx = 1
            for i, m in enumerate(mons[1:], start=1):
                if (m["left"] <= px < m["left"] + m["width"]
                        and m["top"] <= py < m["top"] + m["height"]):
                    self.mon_idx = i
                    break
            m = self.mon = mons[self.mon_idx]
            shot = np.ascontiguousarray(np.array(sct.grab(m))[:, :, :3])
        # Retina Macs capture at 2x the screen's point size. Show the picture
        # at point size so box coordinates match what grab() expects.
        if shot.shape[1] != m["width"] or shot.shape[0] != m["height"]:
            shot = cv2.resize(shot, (m["width"], m["height"]), interpolation=cv2.INTER_AREA)
        ok, buf = cv2.imencode(".png", shot)
        self.photo = tk.PhotoImage(data=base64.b64encode(buf.tobytes()).decode("ascii"))

        w = self.win = tk.Toplevel(self.root)
        w.overrideredirect(True)
        w.attributes("-topmost", True)
        w.geometry(f"{m['width']}x{m['height']}+{m['left']}+{m['top']}")
        c = self.canvas = tk.Canvas(w, width=m["width"], height=m["height"], bg="black",
                                    highlightthickness=0, cursor="crosshair")
        c.pack()
        c.create_image(0, 0, image=self.photo, anchor="nw")

        bar = tk.Frame(c, bg=BG, highlightthickness=2, highlightbackground=ACCENT)
        self.banner = tk.Label(bar, fg=FG, bg=BG, font=(FONT, 11), padx=14, pady=10,
                               wraplength=min(700, m["width"] - 360), justify="left")
        self.banner.pack(side="left")
        self.ok_btn = flat_button(tk, bar, "Confirm (Enter)", self.confirm)
        self.ok_btn.pack(side="left", padx=(0, 6), pady=8)
        self.skip_btn = flat_button(tk, bar, "Skip", self.skip)
        self.skip_btn.pack(side="left", padx=(0, 6), pady=8)
        flat_button(tk, bar, "Cancel", self.cancel).pack(side="left", padx=(0, 10), pady=8)
        c.create_window(m["width"] // 2, 16, window=bar, anchor="n")

        c.bind("<ButtonPress-1>", self._press)
        c.bind("<B1-Motion>", self._drag)
        w.bind("<Return>", lambda e: self.confirm())
        w.bind("<Escape>", lambda e: self.skip() if not self.STEPS[self.step][2]
               else self.cancel())
        w.after(100, w.focus_force)
        self._show_step()

    def _show_step(self, note=""):
        key, text, required = self.STEPS[self.step]
        self.banner.config(text=text + (f"\n{note}" if note else ""),
                           fg=BAD if note else FG)
        self.skip_btn.config(state="disabled" if required else "normal")

    def _press(self, e):
        self.start = (e.x, e.y)
        if self.rect:
            self.canvas.delete(self.rect)
        self.rect = self.canvas.create_rectangle(e.x, e.y, e.x, e.y,
                                                 outline=ACCENT, width=2)
        self.box = None

    def _drag(self, e):
        if not self.start:
            return
        x0, y0 = self.start
        self.canvas.coords(self.rect, x0, y0, e.x, e.y)
        w, h = abs(e.x - x0), abs(e.y - y0)
        self.box = [min(x0, e.x), min(y0, e.y), w, h] if w >= 5 and h >= 5 else None

    def confirm(self):
        if not self.box:
            self._show_step("Draw a box first: click and drag on the screenshot.")
            return
        key = self.STEPS[self.step][0]
        self.regions[key] = self.box
        x, y, w, h = self.box
        self.canvas.itemconfig(self.rect, outline=GOOD)
        self.canvas.create_text(x + 3, y - 3, text=key.upper(), anchor="sw",
                                fill=GOOD, font=(FONT, 9, "bold"))
        self.rect = self.start = self.box = None
        self._next()

    def skip(self):
        if self.STEPS[self.step][2]:
            return
        if self.rect:
            self.canvas.delete(self.rect)
        self.rect = self.start = self.box = None
        self._next()

    def _next(self):
        self.step += 1
        if self.step < len(self.STEPS):
            self._show_step()
            return
        self.cfg["monitor"] = self.mon_idx
        self.cfg["regions"] = self.regions
        save_config(self.cfg)
        log.info("Calibrated monitor %s: %s", self.mon_idx, self.regions)
        self.win.destroy()
        self.on_done(True)

    def cancel(self):
        self.win.destroy()
        self.on_done(False)


class Overlay:
    """Small borderless always-on-top window. Drag it anywhere;
    click the gear (or right-click) for the menu."""

    def __init__(self, app, url):
        import tkinter as tk
        from tkinter import messagebox
        self.tk, self.messagebox = tk, messagebox
        self.app, self.url = app, url
        cfg = app.cfg

        r = self.root = tk.Tk()
        r.title(APP_NAME)
        r.overrideredirect(True)
        r.attributes("-topmost", True)
        r.attributes("-alpha", cfg["overlay_opacity"])
        r.configure(bg=BG, highlightthickness=1, highlightbackground="#3a3e47")
        x, y = cfg["overlay_pos"]
        r.geometry(f"+{x}+{y}")
        r.minsize(270, 0)

        top = tk.Frame(r, bg=BG)
        top.pack(fill="x", padx=14, pady=(10, 0))
        self.dot = tk.Label(top, text="●", fg=DIM, bg=BG, font=(FONT, 10))
        self.dot.pack(side="left")
        tk.Label(top, text="MAPLE TRACKER", fg=ACCENT, bg=BG,
                 font=(FONT, 9, "bold")).pack(side="left", padx=(4, 0))
        close = tk.Label(top, text="✕", fg=DIM, bg=BG, font=(FONT, 10), cursor="hand2")
        close.pack(side="right")
        close.bind("<ButtonRelease-1>", lambda e: self.close())
        gear = tk.Label(top, text="⚙", fg=DIM, bg=BG, font=(FONT, 11), cursor="hand2")
        gear.pack(side="right", padx=(0, 8))
        gear.bind("<ButtonRelease-1>", self.show_menu)
        self.time = tk.Label(top, text="0:00:00", fg=DIM, bg=BG, font=(MONO, 10))
        self.time.pack(side="right", padx=(0, 10))

        body = tk.Frame(r, bg=BG)
        body.pack(fill="x", padx=14)
        body.columnconfigure(0, weight=1)
        self.exp_box, self.exp_hr, self.exp_tot = self._stat(body, "EXP / HR")
        self.exp_box.grid(row=0, sticky="we")
        self.info = tk.Label(body, text="", fg=FG, bg=BG, font=(FONT, 9),
                             anchor="w", justify="left")
        self.info.grid(row=1, sticky="we", pady=(4, 0))
        self.meso_box, self.meso_hr, self.meso_tot = self._stat(body, "MESOS / HR")
        self.meso_box.grid(row=2, sticky="we")
        self.extra = tk.Label(body, text="", fg=SUB, bg=BG, font=(FONT, 9),
                              anchor="w", justify="left")
        self.extra.grid(row=3, sticky="we", pady=(6, 0))
        self.items_box = tk.Frame(body, bg=BG)
        tk.Label(self.items_box, text="ITEMS", fg=DIM, bg=BG,
                 font=(FONT, 8, "bold")).pack(anchor="w", pady=(8, 0))
        self.items = tk.Label(self.items_box, text="—", fg=SUB, bg=BG, font=(FONT, 9),
                              anchor="w", justify="left")
        self.items.pack(fill="x")
        self.items_box.grid(row=4, sticky="we")
        self.warn = tk.Label(body, text="", fg=BAD, bg=BG, font=(FONT, 9),
                             wraplength=250, anchor="w", justify="left")
        self.warn.grid(row=5, sticky="we", pady=(6, 0))

        btns = tk.Frame(r, bg=BG)
        btns.pack(fill="x", padx=14, pady=(8, 8))
        self.toggle_btn = flat_button(tk, btns, "Start", self.toggle)
        self.toggle_btn.pack(side="left", expand=True, fill="x", padx=(0, 4))
        flat_button(tk, btns, "Reset", self.reset).pack(side="left", expand=True,
                                                        fill="x", padx=(4, 0))
        if url:
            foot = tk.Label(r, text=f"Other devices: {url}", fg=DIM, bg=BG,
                            font=(FONT, 8), cursor="hand2")
            foot.pack(pady=(0, 10))
            foot.bind("<ButtonRelease-1>", lambda e: self.copy_url())

        self.menu = tk.Menu(r, tearoff=0, bg=BTN, fg=FG, activebackground=BTN_HOVER,
                            activeforeground=FG, font=(FONT, 9))
        self.menu.add_command(label="Check reading", command=self.check)
        self.menu.add_command(label="Find the HUD again", command=self.relocate)
        self.menu.add_command(label="Set my level...", command=self.ask_level)
        self.menu.add_command(label="Draw boxes myself (advanced)...", command=self.calibrate)
        self.menu.add_separator()
        if url:
            self.menu.add_command(label="Copy address for other devices",
                                  command=self.copy_url)
        self.menu.add_command(label="Open data folder", command=self.open_folder)
        self.menu.add_separator()
        self.menu.add_command(label="Quit", command=self.close)

        self._drag_from = None
        r.bind_all("<ButtonPress-1>", self._press, add="+")
        r.bind_all("<B1-Motion>", self._drag, add="+")
        # Right-click: Button-3 on Windows, Button-2 / Control-click on Mac.
        for seq in (("<Button-2>", "<Control-Button-1>") if IS_MAC else ("<Button-3>",)):
            r.bind_all(seq, self.show_menu, add="+")
        self._mon_cache = None
        self.refresh()

    # -- widgets
    def _stat(self, parent, label):
        tk = self.tk
        f = tk.Frame(parent, bg=BG)
        tk.Label(f, text=label, fg=DIM, bg=BG,
                 font=(FONT, 8, "bold")).pack(anchor="w", pady=(10, 0))
        big = tk.Label(f, text="—", fg=FG, bg=BG, font=(FONT, 20, "bold"))
        big.pack(anchor="w")
        small = tk.Label(f, text="0 total", fg=SUB, bg=BG, font=(FONT, 9))
        small.pack(anchor="w")
        return f, big, small

    def _mine(self, e):
        """Only react to events in this window, not the calibration screen."""
        try:
            return e.widget.winfo_toplevel() is self.root
        except Exception:
            return False

    # -- dragging
    def _press(self, e):
        if not self._mine(e) or isinstance(e.widget, self.tk.Button):
            self._drag_from = None
            return
        self._drag_from = (e.x_root - self.root.winfo_x(), e.y_root - self.root.winfo_y())

    def _drag(self, e):
        if self._drag_from and self._mine(e):
            dx, dy = self._drag_from
            self.root.geometry(f"+{e.x_root - dx}+{e.y_root - dy}")

    # -- actions
    def show_menu(self, e):
        if self._mine(e):
            try:
                self.menu.tk_popup(e.x_root, e.y_root)
            finally:
                self.menu.grab_release()

    def toggle(self):
        eng = self.app.engine
        (eng.stop if eng.running else eng.start)()
        self.refresh(reschedule=False)

    def reset(self):
        self.app.reset()
        self.refresh(reschedule=False)

    def calibrate(self):
        self.app.stop()
        Calibrator(self.tk, self.root, self.app.cfg, self._calibrated).begin()

    def _calibrated(self, ok):
        if ok:
            self.app.make_engine()
            self._mon_cache = None
        self.root.deiconify()
        self.root.attributes("-topmost", True)
        self.refresh(reschedule=False)
        if ok:
            self.root.after(300, self.check)

    def relocate(self):
        self.app.engine.relocate()
        self.refresh(reschedule=False)

    def ask_level(self, reason=None):
        from tkinter import simpledialog
        current = self.app.snapshot().get("level") or self.app.cfg.get("level")
        prompt = (reason + "\n\n" if reason else "") + "What level is your character right now?"
        lv = simpledialog.askinteger(APP_NAME, prompt, parent=self.root, minvalue=1,
                                     maxvalue=89, initialvalue=current)
        if lv:
            self.app.engine.set_level(lv)
        self._asked_level = True
        self.refresh(reschedule=False)

    def check(self):
        if not self.app.cfg["_tesseract_found"]:
            self.messagebox.showerror(APP_NAME, "The text reader (Tesseract) is missing. "
                                      "Make sure you kept the whole MapleTracker folder.",
                                      parent=self.root)
            return
        try:
            report = self.app.engine.check_now()
        except Exception as e:
            log.exception("check reading failed")
            report = f"Couldn't read the screen:\n{e}"
        if self._covers_capture_box():
            report += "\n\nNote: this tracker window is covering one of your boxes."
        self.messagebox.showinfo("Check reading", report, parent=self.root)

    def copy_url(self):
        self.root.clipboard_clear()
        self.root.clipboard_append(self.url)

    def open_folder(self):
        try:
            if IS_WIN:
                os.startfile(str(DATA_DIR))
            else:
                subprocess.Popen(["open" if IS_MAC else "xdg-open", str(DATA_DIR)])
        except Exception:
            self.messagebox.showinfo(APP_NAME, str(DATA_DIR), parent=self.root)

    def close(self):
        self.app.stop()
        try:
            self.app.cfg["overlay_pos"] = [self.root.winfo_x(), self.root.winfo_y()]
            save_config(self.app.cfg)
        except Exception:
            log.exception("couldn't save window position")
        self.root.destroy()

    def _covers_capture_box(self):
        try:
            boxes = self.app.engine.capture_boxes()
        except Exception:
            return False
        wx, wy = self.root.winfo_rootx(), self.root.winfo_rooty()
        ww, wh = self.root.winfo_width(), self.root.winfo_height()
        for rx, ry, w, h in boxes:
            if wx < rx + w and rx < wx + ww and wy < ry + h and ry < wy + wh:
                return True
        return False

    def refresh(self, reschedule=True):
        s = self.app.snapshot()
        self.dot.config(fg=GOOD if s["running"] else DIM)
        self.time.config(text=hms(s["elapsed"]))
        self.exp_hr.config(text=fmt(s["exp_hr"]))
        total = f"{fmt(s['exp'])} total" if s["exp"] is not None else "set your level for EXP"
        if s.get("now_hr"):
            total += f"  ·  now {fmt(s['now_hr'])}/hr"
        self.exp_tot.config(text=total)
        info = []
        if s.get("level"):
            info.append(f"Lv {s['level']}")
        if s.get("pct") is not None:
            info.append(f"{s['pct']:.2f}%")
        if s.get("eta"):
            info.append(f"next level in {hms(s['eta'])}")
        if s.get("status") == "searching":
            info = ["Looking for the HUD..."]
        self.info.config(text="  ·  ".join(info))
        if s.get("needs_level") and not getattr(self, "_asked_level", False):
            self._asked_level = True
            self.root.after(100, lambda: self.ask_level(
                "Your HUD only shows the EXP percentage. Tell me your level once and "
                "I'll turn % into EXP and count level-ups from there."))
        if s["has_mesos"]:
            self.meso_box.grid()
            self.meso_hr.config(text=fmt(s["mesos_hr"]))
            self.meso_tot.config(text=f"{fmt(s['mesos'])} total")
        else:
            self.meso_box.grid_remove()
        extra = []
        if s["levels"]:
            extra.append(f"{s['levels']} level-up{'s' if s['levels'] > 1 else ''}")
        if s["lost"]:
            extra.append(f"{fmt(s['lost'])} EXP lost to deaths")
        self.extra.config(text="  ·  ".join(extra))
        if s["has_items"]:
            self.items_box.grid()
            rows = [f"{n:>3}×  {name}" for name, n in s["items"][:6]]
            if len(s["items"]) > 6:
                rows.append(f"…and {len(s['items']) - 6} more")
            self.items.config(text="\n".join(rows) or "—")
        else:
            self.items_box.grid_remove()
        warn = s["warning"] or ""
        if s["running"] and self._covers_capture_box():
            warn = "This window is covering a capture box. Drag it somewhere else."
        self.warn.config(text=warn)
        label = "Pause" if s["running"] else ("Resume" if s["elapsed"] > 0 else "Start")
        self.toggle_btn.config(text=label)
        if reschedule:
            self.root.after(1000, self.refresh)

    def mainloop(self):
        self.root.mainloop()


# --------------------------------------------------------------------- main

def mac_check_screen_permission(overlay):
    """macOS only lets apps see other windows after you allow Screen
    Recording. Without it, screenshots show just the desktop wallpaper."""
    try:
        import Quartz
        if Quartz.CGPreflightScreenCaptureAccess():
            return
        Quartz.CGRequestScreenCaptureAccess()  # adds the app to the list
    except Exception:
        log.exception("couldn't check Screen Recording permission")
        return
    overlay.messagebox.showinfo(
        APP_NAME,
        "Maple Tracker needs permission to read your screen.\n\n"
        "1. Open System Settings > Privacy & Security > Screen & System "
        "Audio Recording (called Screen Recording on older macOS).\n"
        "2. Turn on Maple Tracker.\n"
        "3. Quit and reopen Maple Tracker.",
        parent=overlay.root)


def main():
    if "--selftest" in sys.argv:
        i = sys.argv.index("--selftest")
        out = sys.argv[i + 1] if len(sys.argv) > i + 1 else None
        sys.exit(selftest(out))
    log.info("%s starting (data folder: %s)", APP_NAME, DATA_DIR)
    try:
        app = App()
        url = start_web_server(app, app.cfg["web_port"])
        overlay = Overlay(app, url)
        if IS_MAC:
            overlay.root.after(600, mac_check_screen_permission, overlay)
        overlay.mainloop()
        app.stop()
    except Exception:
        log.exception("crashed")
        try:
            import tkinter as tk
            from tkinter import messagebox
            r = tk.Tk()
            r.withdraw()
            messagebox.showerror(APP_NAME, "Something went wrong:\n\n"
                                 f"{traceback.format_exc(limit=2)}\n"
                                 f"Details were saved to:\n{LOG_FILE}")
        except Exception:
            pass


if __name__ == "__main__":
    main()
