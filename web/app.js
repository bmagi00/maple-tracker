// Maple Tracker - the page. Captures a shared window (or a video file),
// hands frames to the engine twice a second, and shows the numbers.
import { DigitReader, Session, crop, expToNext } from "./engine.js?v=__VERSION__";
import { SEEDS } from "./seeds.js?v=__VERSION__";
import { MESO_SEEDS } from "./seeds-meso.js?v=__VERSION__";

const $ = id => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode: fine */ } },
};
const fmt = n => n === null || n === undefined || Number.isNaN(n) ? "–" : Math.round(n).toLocaleString();
const hms = s => { s = Math.max(0, Math.floor(s)); return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };

// ---------------------------------------------------------------- engine
const hudReader = new DigitReader(SEEDS, store.get("mt.learned.hud", {}));
const mesoSeeds = {};
for (const src of [MESO_SEEDS, SEEDS]) for (const [c, v] of Object.entries(src)) (mesoSeeds[c] ||= []).push(...v);
const mesoReader = new DigitReader(mesoSeeds, store.get("mt.learned.meso", {}));
const session = new Session(hudReader, {
  level: store.get("mt.level", null),
  onLevel: lv => store.set("mt.level", lv),
  mesoReader,
});

// ---------------------------------------------------------------- capture
const video = $("video"), work = $("work");
const wctx = work.getContext("2d", { willReadFrequently: true });
let stream = null, track = null, imageCapture = null, source = null;

async function shareWindow() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    showStatus("This browser can't share a window. Use Chrome or Edge on a computer.", true);
    return;
  }
  try {
    const s = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 10, max: 30 } }, audio: false,
      selfBrowserSurface: "exclude", surfaceSwitching: "include",
    });
    stopSource();
    stream = s; track = s.getVideoTracks()[0];
    track.addEventListener("ended", () => { stopSource(); session.stop(); render(); });
    imageCapture = "ImageCapture" in window ? new ImageCapture(track) : null;
    video.srcObject = s; await video.play();
    source = "window";
    begin();
  } catch (e) {
    if (e?.name !== "NotAllowedError") showStatus(`Couldn't share: ${e?.message || e}`, true);
  }
}

async function openVideo(file) {
  stopSource();
  video.srcObject = null; video.src = URL.createObjectURL(file);
  try { await video.play(); } catch (e) { showStatus("This browser can't play that video file.", true); return; }
  source = "file";
  video.addEventListener("ended", () => { session.stop(); render(); }, { once: true });
  begin();
}

function stopSource() {
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = track = imageCapture = null; source = null;
}

function begin() {
  session.relocate(); session.mesoBox = null;
  session.start();
  $("share").textContent = "Share a different window";
  render();
}

/** The current frame, as something drawImage accepts, with its size. */
async function currentFrame() {
  if (imageCapture && track?.readyState === "live") {
    try { const bmp = await imageCapture.grabFrame(); return { src: bmp, w: bmp.width, h: bmp.height, bitmap: bmp }; }
    catch { /* fall back to the video element */ }
  }
  if (video.readyState >= 2 && video.videoWidth) return { src: video, w: video.videoWidth, h: video.videoHeight };
  return null;
}

function region(frame, box) {
  const [x, y, w, h] = box || [0, 0, frame.w, frame.h];
  const bx = Math.max(0, Math.round(x)), by = Math.max(0, Math.round(y));
  const bw = Math.min(frame.w - bx, Math.round(w)), bh = Math.min(frame.h - by, Math.round(h));
  if (bw <= 0 || bh <= 0) return null;
  if (work.width !== bw || work.height !== bh) { work.width = bw; work.height = bh; }
  wctx.drawImage(frame.src, bx, by, bw, bh, 0, 0, bw, bh);
  const d = wctx.getImageData(0, 0, bw, bh);
  return { w: bw, h: bh, data: d.data };
}

// A worker keeps time even when this tab is in the background (browsers
// slow down timers in hidden tabs, but not in workers).
const metronome = new Worker(URL.createObjectURL(new Blob(
  ["setInterval(() => postMessage(0), 500);"], { type: "text/javascript" })));
let busy = false, lastSave = 0, lastFrame = null;
metronome.onmessage = async () => {
  if (busy) return;
  busy = true;
  try {
    if (session.running && source) {
      const frame = await currentFrame();
      if (frame) {
        lastFrame = { w: frame.w, h: frame.h };
        session.tick(Date.now(), box => region(frame, box));
        drawSees(frame);
        frame.bitmap?.close?.();
      }
    }
    if (Date.now() - lastSave > 30000) {
      lastSave = Date.now();
      if (hudReader.dirty) { store.set("mt.learned.hud", hudReader.learned); hudReader.dirty = false; }
      if (mesoReader.dirty) { store.set("mt.learned.meso", mesoReader.learned); mesoReader.dirty = false; }
    }
  } finally {
    busy = false;
    render();
  }
};

// --------------------------------------------------------------- display
function drawSees(frame) {
  const last = session.log[session.log.length - 1];
  for (const [id, box, text] of [["see-exp", session.hud?.exp, last?.text], ["see-meso", session.mesoBox, last?.mesoText]]) {
    const c = $(id), ctx = c.getContext("2d");
    ctx.clearRect(0, 0, c.width, c.height);
    if (!box) continue;
    const [x, y, w, h] = box, k = Math.min(c.width / w, c.height / h);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(frame.src, x, y, w, h, (c.width - w * k) / 2, (c.height - h * k) / 2, w * k, h * k);
  }
  const expShown = !last ? "–" : last.pct !== ""
    ? `${last.exp !== "" ? fmt(last.exp) + " " : ""}[${Number(last.pct).toFixed(2)}%]`
    : last.text ? `not sure yet (reads “${last.text}”)` : "not found";
  const mesoShown = !last ? "–" : last.meso !== "" ? fmt(last.meso)
    : last.mesoText ? `not sure yet (reads “${last.mesoText}”)` : "inventory not visible";
  $("see-exp-text").textContent = `EXP: ${expShown}`;
  $("see-meso-text").textContent = `Mesos: ${mesoShown}`;
}

let statusOverride = null;
function showStatus(msg, warn = false) { statusOverride = { msg, warn, until: Date.now() + 8000 }; render(); }

let pip = null;
function render() {
  const s = session.snapshot();
  // HUD block
  const tiles = $("lv-tiles");
  const lvText = s.level ? String(s.level) : "?";
  if (tiles.dataset.v !== lvText) {
    tiles.dataset.v = lvText;
    tiles.replaceChildren(...[...lvText].map(ch => Object.assign(document.createElement("span"), { className: "tile", textContent: ch })));
  }
  const pctEl = $("pct");
  if (s.pct !== null) { pctEl.textContent = `${s.pct.toFixed(2)}%`; pctEl.classList.add("live"); }
  else { pctEl.textContent = s.status === "searching" ? "looking for the HUD…" : "waiting for the HUD"; pctEl.classList.remove("live"); }
  $("gauge-fill").style.width = `${s.pct ?? 0}%`;
  $("gauge-bar").setAttribute("aria-valuenow", s.pct ?? 0);
  const eta = $("eta");
  if (s.eta) { eta.textContent = `Next level in ${hms(s.eta)}${s.level ? ` (${fmt(expToNext(s.level) * (1 - s.pct / 100))} EXP to go)` : ""}`; eta.classList.add("live"); }
  else if (s.needsLevel) { eta.textContent = "Your HUD shows only the %. Set your level to see EXP."; eta.classList.remove("live"); }
  else if (!source) { eta.textContent = "Share the window that shows the game, and keep its bottom bar visible."; eta.classList.remove("live"); }
  else if (s.status === "searching") { eta.textContent = "Make sure the game's bottom bar (LV, HP, MP, EXP) is visible in the shared window."; eta.classList.remove("live"); }
  else { eta.textContent = "Working out your pace…"; eta.classList.remove("live"); }

  // rates
  const rateText = (el, v) => {
    const pending = v === null || v === undefined;
    el.textContent = pending ? (source && s.running ? "Measuring…" : "–") : fmt(v);
    el.classList.toggle("pending", pending);
  };
  rateText($("exp-hr"), s.expHr);
  $("exp-now").textContent = s.nowHr ? `${fmt(s.nowHr)}/hr over the last 5 minutes` : " ";
  $("exp-total").innerHTML = s.exp !== null ? `<strong>+${fmt(s.exp)}</strong> EXP this session` : (s.needsLevel ? "Set your level to count EXP" : " ");
  rateText($("meso-hr"), s.mesoHr);
  $("meso-now").textContent = s.mesoTotal !== null ? `Total ${fmt(s.mesoTotal)}${s.mesoVisible ? "" : " (inventory not visible)"}` : " ";
  $("meso-total").innerHTML = s.mesos !== null
    ? `<strong>+${fmt(s.mesos)}</strong> mesos this session${s.mesoSpent ? `, ${fmt(s.mesoSpent)} spent` : ""}`
    : "Open your Item Inventory window in the game to track mesos.";

  // session line
  $("clock").textContent = hms(s.elapsed);
  $("dot").classList.toggle("on", s.running);
  const st = $("status");
  let msg, warn = false;
  if (statusOverride && Date.now() < statusOverride.until) ({ msg, warn } = statusOverride);
  else if (!source) msg = "Not tracking";
  else if (!s.running) msg = "Paused";
  else if (s.status === "searching") { msg = session.miss ? `Looking for the HUD. ${session.miss}` : "Looking for the HUD"; warn = !!session.miss; }
  else if (s.stale) { msg = "Can't read the EXP right now. Is something covering the bottom bar?"; warn = true; }
  else msg = source === "file" ? "Tracking the video" : "Tracking";
  st.textContent = msg; st.classList.toggle("warn", warn);
  const ev = [];
  if (s.levels) ev.push(`${s.levels} level-up${s.levels > 1 ? "s" : ""}`);
  if (s.lost) ev.push(`${fmt(s.lost)} EXP lost to deaths`);
  $("events").textContent = ev.join(", ");
  const tg = $("toggle");
  tg.disabled = !source; tg.textContent = s.running ? "Pause" : "Resume";

  // prompts
  if (s.needsLevel && !asked.level && !promptOpen) askLevel("Your HUD shows only the EXP percentage. What level is your character? I'll turn % into EXP from here.");
  else if (s.mesoNeedsTeach && !asked.meso && !promptOpen) askMeso();

  document.title = s.running && s.expHr ? `${fmt(s.expHr)} EXP/hr · Maple Tracker` : "Maple Tracker";
  renderPip(s);
}

// ---------------------------------------------------------------- prompts
const asked = { level: false, meso: false };
let promptOpen = null;
function openPrompt(kind, label, initial, onSave) {
  promptOpen = kind;
  $("prompt-label").textContent = label;
  $("prompt-input").value = initial ?? "";
  $("prompt-error").textContent = "";
  $("prompt").hidden = false;
  $("prompt-input").focus();
  $("prompt-form").onsubmit = async e => {
    e.preventDefault();
    const err = await onSave($("prompt-input").value.trim());
    if (err) { $("prompt-error").textContent = err; return; }
    closePrompt();
  };
}
function closePrompt() { $("prompt").hidden = true; promptOpen = null; render(); }
$("prompt-cancel").onclick = () => { if (promptOpen) asked[promptOpen] = true; closePrompt(); };

function askLevel(label = "What level is your character right now?") {
  asked.level = true;
  openPrompt("level", label, session.snapshot().level ?? store.get("mt.level", ""), v => {
    const lv = parseInt(v, 10);
    if (!(lv >= 1 && lv <= 89)) return "Type a level from 1 to 89.";
    session.setLevel(lv); store.set("mt.level", lv);
    return null;
  });
}
function askMeso() {
  asked.meso = true;
  openPrompt("meso", "I can see your meso total but don't know all of its digits yet. Type the number shown in the inventory, and I'll learn them.", "", v => {
    if (!source) return "Share the game window first.";
    return teachFromCurrentFrame(v);
  });
}
async function teachFromCurrentFrame(v) {
  const frame = await currentFrame();
  if (!frame) return "Share the game window first.";
  const err = session.teachMeso(box => region(frame, box), v);
  frame.bitmap?.close?.();
  if (!err) store.set("mt.learned.meso", mesoReader.learned);
  return err;
}
// ---------------------------------------------------------------- pop-out
async function popOut() {
  if (pip) { pip.focus?.(); return; }
  pip = await window.documentPictureInPicture.requestWindow({ width: 260, height: 250 });
  for (const sheet of document.styleSheets) {
    try {
      const style = document.createElement("style");
      style.textContent = [...sheet.cssRules].map(r => r.cssText).join("\n");
      pip.document.head.append(style);
    } catch {
      const link = document.createElement("link"); link.rel = "stylesheet"; link.href = sheet.href;
      pip.document.head.append(link);
    }
  }
  pip.document.body.className = "pip";
  pip.document.body.append($("mini").content.cloneNode(true));
  pip.document.querySelector("[data-k=toggle]").onclick = toggle;
  pip.addEventListener("pagehide", () => { pip = null; });
  render();
}
function renderPip(s) {
  if (!pip) return;
  const q = k => pip.document.querySelector(`[data-k=${k}]`);
  q("dot").classList.toggle("on", s.running);
  q("clock").textContent = hms(s.elapsed);
  q("lv").textContent = s.level ? `Lv ${s.level}${s.pct !== null ? ` · ${s.pct.toFixed(2)}%` : ""}` : (s.pct !== null ? `${s.pct.toFixed(2)}%` : "");
  q("fill").style.width = `${s.pct ?? 0}%`;
  q("eta").textContent = s.eta ? `Next level in ${hms(s.eta)}` : "";
  q("exphr").textContent = fmt(s.expHr);
  q("expnow").textContent = s.nowHr ? `now ${fmt(s.nowHr)}/hr` : "";
  q("mesohr").textContent = fmt(s.mesoHr);
  q("toggle").textContent = s.running ? "Pause" : "Resume";
}

// ---------------------------------------------------------------- controls
function toggle() { if (!source) return; session.running ? session.stop() : session.start(); render(); }
$("share").onclick = shareWindow;
$("toggle").onclick = toggle;
$("reset").onclick = () => { session.reset(); session.log = []; render(); };
$("set-level").onclick = () => askLevel();
$("teach-meso").onclick = () => askMeso();
$("refind").onclick = () => { session.relocate(); session.mesoBox = null; showStatus("Looking for the HUD again"); };
$("file").onchange = e => { const f = e.target.files[0]; if (f) openVideo(f); e.target.value = ""; };
$("download").onclick = () => {
  const cols = ["time", "text", "exp", "pct", "decision", "gained", "mesoText", "meso", "mesoDecision", "note"];
  const esc = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = [cols.join(","), ...session.log.map(r => cols.map(c => esc(r[c])).join(","))].join("\n");
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(new Blob([csv], { type: "text/csv" })),
    download: `maple-tracker-readings-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.csv`,
  });
  a.click(); URL.revokeObjectURL(a.href);
};
$("snapshot").onclick = async () => {
  const frame = lastFrame && source ? await currentFrame() : null;
  if (!frame) { showStatus("Share the game window first.", true); return; }
  const c = document.createElement("canvas"); c.width = frame.w; c.height = frame.h;
  c.getContext("2d").drawImage(frame.src, 0, 0);
  frame.bitmap?.close?.();
  c.toBlob(b => {
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(b), download: "maple-tracker-what-it-sees.png" });
    a.click(); URL.revokeObjectURL(a.href);
  }, "image/png");
};
if ("documentPictureInPicture" in window) { $("popout").hidden = false; $("popout").onclick = popOut; }
if (!navigator.mediaDevices?.getDisplayMedia) showStatus("Window sharing needs Chrome or Edge on a computer.", true);

window.__mapleTracker = { session }; // for the browser test
render();
