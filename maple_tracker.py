"""
Maple Tracker - EXP / mesos / items per hour for MapleStory Classic.

Reads the numbers off the screen (for example a Discord stream of the game
on a second PC) and never touches the game itself. Everything happens in a
small floating window: Calibrate, Check reading, Start/Pause, Reset.
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
    "monitor": 1,              # set by Calibrate
    "poll_seconds": 0.5,       # how often to read the screen
    "frames_per_read": 3,      # frames blended per read to cancel stream noise
    "upscale": 4,              # bigger = better OCR on small, blurry text
    "denoise": True,           # smooth out video-compression blockiness
    "web_port": 8765,          # other devices open http://<this PC's IP>:8765
    "overlay_opacity": 0.92,
    "overlay_pos": [40, 40],   # remembered when you close the window
    "regions": {},             # set by Calibrate
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


def read_exp(sct, cfg):
    img = grab(sct, cfg, cfg["regions"]["exp"], cfg["frames_per_read"])
    return parse_exp_text(ocr(img, cfg, "exp"))


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


def check_reading(cfg):
    """One-off read of every box, for the 'Check reading' menu item."""
    DEBUG_DIR.mkdir(exist_ok=True)
    r = cfg["regions"]
    out = []
    with mss.mss() as sct:
        reading = read_exp(sct, cfg)
        out.append("EXP:   " + (f"{reading[0]:,}  [{reading[1]:.2f}%]" if reading
                                else "couldn't read"))
        if "mesos" in r:
            out.append(f"Mesos: {fmt(read_mesos(sct, cfg))}")
        if "pickups" in r:
            lines = read_pickup_lines(sct, cfg)
            out.append("Pickup messages: " + ("\n  " + "\n  ".join(lines) if lines
                                              else "none on screen right now"))
        for key, reg in r.items():
            raw = grab(sct, cfg, reg, cfg["frames_per_read"])
            cv2.imwrite(str(DEBUG_DIR / f"{key}_captured.png"), raw)
            cv2.imwrite(str(DEBUG_DIR / f"{key}_ocr.png"), preprocess(raw, cfg))
    out.append("\nThese should match the game exactly. If not, Calibrate again "
               "with tighter boxes around just the numbers.")
    return "\n".join(out)


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
    report.append("RESULT: " + ("PASS" if passed else "FAIL"))
    text = "\n".join(report)
    log.info("\n%s", text)
    if out_path:
        Path(out_path).write_text(text + "\n", encoding="utf-8")
    return 0 if passed else 1


# ------------------------------------------------------------------ trackers

class ExpTracker:
    """Turns noisy EXP readings into total EXP gained, handling level-ups."""

    def __init__(self):
        self.last = None        # (exp, pct) last accepted reading
        self.pending = None     # reading waiting for confirmation
        self.level_req = None   # EXP needed for the current level
        self.rejects = 0
        self.gained = 0
        self.lost = 0           # EXP lost to deaths
        self.levels = 0

    def _plausible(self, exp, pct):
        """EXP / percent should always give the same level requirement.
        If it doesn't, a digit was probably misread."""
        if self.level_req is None or pct < 2:
            return True
        if self.last and self.last[1] - pct > 30:   # looks like a level-up
            return True
        req = exp / (pct / 100)
        return abs(req - self.level_req) / self.level_req < 0.03

    def update(self, reading):
        if reading is None:
            return
        # Debounce: only accept a value once it's been read twice in a row.
        if reading != self.pending:
            self.pending = reading
            return
        exp, pct = reading
        if not self._plausible(exp, pct):
            self.rejects += 1
            if self.rejects >= 10:   # consistently "wrong" = our baseline was bad
                self.level_req = None
                self.rejects = 0
            return
        self.rejects = 0

        old_req = self.level_req
        if pct >= 2:
            self.level_req = exp / (pct / 100)

        if self.last is None:
            self.last = reading
            return
        old_exp, old_pct = self.last
        if exp > old_exp:
            self.gained += exp - old_exp
        elif exp < old_exp:
            if old_pct - pct > 30:  # big drop in % = level up
                req = old_req or (old_exp / (old_pct / 100) if old_pct else 0)
                self.gained += max(0, req - old_exp) + exp
                self.levels += 1
            else:                    # small drop = died
                self.lost += old_exp - exp
        self.last = reading


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
    return {"running": False, "elapsed": 0, "exp": 0, "exp_hr": None, "mesos": None,
            "mesos_hr": None, "has_mesos": False, "levels": 0, "lost": 0,
            "items": [], "has_items": False, "warning": warning}


class Engine:
    """Reads the screen in a background thread. Start/pause/reset are safe
    to call from the window or the web page at any time."""

    def __init__(self, cfg, reader=None):
        self.cfg = cfg
        r = cfg["regions"]
        self.has_mesos = "mesos" in r or "pickups" in r
        self.has_items = "pickups" in r
        self.lock = threading.Lock()
        self.running = False
        self._alive = True
        self._reader = reader or self._read_screen
        self.last_error = None
        self._new_trackers()
        SESSIONS_DIR.mkdir(exist_ok=True)
        self.log_path = SESSIONS_DIR / f"session_{datetime.now():%Y%m%d_%H%M%S}.csv"
        self._log_started = False
        threading.Thread(target=self._loop, daemon=True).start()

    # -- controls
    def _new_trackers(self):
        r = self.cfg["regions"]
        self.exp = ExpTracker()
        self.meso = MesoTotalTracker() if "mesos" in r else None
        self.pick = (PickupTracker(self.cfg["meso_pattern"], self.cfg["item_pattern"])
                     if "pickups" in r else None)
        self.banked = 0.0                 # seconds from earlier stretches
        self.started_at = time.time() if self.running else None
        self.last_ok = time.time()
        self.skip_pickup_frame = True

    def start(self):
        with self.lock:
            if self.running:
                return
            # Forget the last reading so anything gained while paused
            # isn't counted, and messages already on screen aren't recounted.
            self.exp.last = self.exp.pending = None
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

    def reset(self):
        with self.lock:
            self._new_trackers()

    def shutdown(self):
        self.stop()
        self._alive = False

    # -- state
    def _elapsed(self):
        return self.banked + (time.time() - self.started_at if self.started_at else 0)

    def snapshot(self):
        with self.lock:
            el = self._elapsed()
            hrs = el / 3600
            if self.meso:
                mesos = self.meso.gained
            elif self.pick:
                mesos = self.pick.mesos
            else:
                mesos = None
            settled = el >= 60  # per-hour rates are wild in the first minute
            warning = None
            if self.running and time.time() - self.last_ok > 15:
                warning = (f"Reader error: {self.last_error}" if self.last_error else
                           "Can't read EXP. Stream paused, mouse over the stream, "
                           "or window moved?")
            return {
                "running": self.running,
                "elapsed": round(el, 1),
                "exp": round(self.exp.gained),
                "exp_hr": round(self.exp.gained / hrs) if settled else None,
                "mesos": mesos,
                "mesos_hr": round(mesos / hrs) if settled and mesos is not None else None,
                "has_mesos": self.has_mesos,
                "levels": self.exp.levels,
                "lost": round(self.exp.lost),
                "items": [[k, v] for k, v in self.pick.items.most_common()] if self.pick else [],
                "has_items": self.has_items,
                "warning": warning,
            }

    # -- background loop
    def _read_screen(self, sct):
        r = self.cfg["regions"]
        return (read_exp(sct, self.cfg),
                read_mesos(sct, self.cfg) if "mesos" in r else None,
                read_pickup_lines(sct, self.cfg) if "pickups" in r else None)

    def _loop(self):
        last_log = time.time()
        with mss.mss() as sct:   # mss must live in the thread that uses it
            while self._alive:
                if not self.running:
                    time.sleep(0.2)
                    continue
                try:
                    reading, mesos, lines = self._reader(sct)
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
                        if reading:
                            self.last_ok = time.time()
                        self.exp.update(reading)
                        if self.meso:
                            self.meso.update(mesos)
                        if self.pick and lines is not None:
                            if self.skip_pickup_frame:
                                self.pick.prev = lines
                                self.skip_pickup_frame = False
                            else:
                                self.pick.update(lines)
                if time.time() - last_log >= 60:
                    last_log = time.time()
                    self._log()
                time.sleep(self.cfg["poll_seconds"])

    def _log(self):
        s = self.snapshot()
        try:
            with open(self.log_path, "a", newline="") as f:
                w = csv.writer(f)
                if not self._log_started:
                    w.writerow(["time", "elapsed_s", "exp_gained", "exp_per_hr",
                                "mesos_gained", "mesos_per_hr"])
                w.writerow([datetime.now().strftime("%H:%M:%S"), int(s["elapsed"]),
                            s["exp"], s["exp_hr"], s["mesos"], s["mesos_hr"]])
            self._log_started = True
        except OSError:
            log.exception("couldn't write session log")


class App:
    """Holds the config and the current engine (rebuilt after Calibrate)."""

    def __init__(self):
        self.cfg = load_config()
        self.engine = None
        self.make_engine()

    def make_engine(self):
        if self.engine:
            self.engine.shutdown()
        self.engine = Engine(self.cfg) if "exp" in self.cfg["regions"] else None

    def snapshot(self):
        if not self.cfg["_tesseract_found"]:
            s = self.engine.snapshot() if self.engine else blank_snapshot()
            s["warning"] = ("Text reader (Tesseract) not found. Use the full "
                            "MapleTracker folder, or install Tesseract.")
            return s
        if not self.engine:
            return blank_snapshot("Not set up yet. Use this on a second device, "
                                  "not the PC you play on. Put the Discord "
                                  "stream on screen and press Calibrate.")
        return self.engine.snapshot()

    def start(self):
        if self.engine:
            self.engine.start()

    def stop(self):
        if self.engine:
            self.engine.stop()

    def reset(self):
        if self.engine:
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
    $("exp").textContent = n(s.exp) + " total";
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
        ("exp", "Step 1 of 3: drag a box around the EXP numbers on the bottom bar, "
                "e.g. 12345[12.34%]", True),
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
        self.meso_box, self.meso_hr, self.meso_tot = self._stat(body, "MESOS / HR")
        self.meso_box.grid(row=1, sticky="we")
        self.extra = tk.Label(body, text="", fg=SUB, bg=BG, font=(FONT, 9),
                              anchor="w", justify="left")
        self.extra.grid(row=2, sticky="we", pady=(6, 0))
        self.items_box = tk.Frame(body, bg=BG)
        tk.Label(self.items_box, text="ITEMS", fg=DIM, bg=BG,
                 font=(FONT, 8, "bold")).pack(anchor="w", pady=(8, 0))
        self.items = tk.Label(self.items_box, text="—", fg=SUB, bg=BG, font=(FONT, 9),
                              anchor="w", justify="left")
        self.items.pack(fill="x")
        self.items_box.grid(row=3, sticky="we")
        self.warn = tk.Label(body, text="", fg=BAD, bg=BG, font=(FONT, 9),
                             wraplength=250, anchor="w", justify="left")
        self.warn.grid(row=4, sticky="we", pady=(6, 0))

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
        self.menu.add_command(label="Calibrate...", command=self.calibrate)
        self.menu.add_command(label="Check reading", command=self.check)
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
        if not self.app.engine:
            return self.calibrate()
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

    def check(self):
        if not self.app.engine:
            self.messagebox.showinfo(APP_NAME, "Press Calibrate first.", parent=self.root)
            return
        if not self.app.cfg["_tesseract_found"]:
            self.messagebox.showerror(APP_NAME, "The text reader (Tesseract) is missing. "
                                      "Make sure you kept the whole MapleTracker folder.",
                                      parent=self.root)
            return
        try:
            report = check_reading(self.app.cfg)
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
        if not self.app.cfg["regions"]:
            return False
        if self._mon_cache is None:
            with mss.mss() as sct:
                self._mon_cache = monitor_rect(sct, self.app.cfg)
        mon = self._mon_cache
        wx, wy = self.root.winfo_rootx(), self.root.winfo_rooty()
        ww, wh = self.root.winfo_width(), self.root.winfo_height()
        for x, y, w, h in self.app.cfg["regions"].values():
            rx, ry = mon["left"] + x, mon["top"] + y
            if wx < rx + w and rx < wx + ww and wy < ry + h and ry < wy + wh:
                return True
        return False

    def refresh(self, reschedule=True):
        s = self.app.snapshot()
        self.dot.config(fg=GOOD if s["running"] else DIM)
        self.time.config(text=hms(s["elapsed"]))
        self.exp_hr.config(text=fmt(s["exp_hr"]))
        self.exp_tot.config(text=f"{fmt(s['exp'])} total")
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
        if not self.app.engine:
            label = "Calibrate"
        else:
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
