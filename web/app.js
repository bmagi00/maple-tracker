// Maple Tracker - the page. Captures a shared window (or a video file),
// hands frames to the engine twice a second, and shows the numbers.
import { DigitReader, Session, LootMatcher, MapMatcher, LOOT_TYPES, atlasRenderer, crop, expToNext } from "./engine.js?v=__VERSION__";
import { GLYPHS } from "./glyphs.js?v=__VERSION__";
import { SEEDS } from "./seeds.js?v=__VERSION__";
import { MESO_SEEDS } from "./seeds-meso.js?v=__VERSION__";
import { FEED_SEEDS } from "./seeds-feed.js?v=__VERSION__";

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
  feedReader: new DigitReader(FEED_SEEDS),
});

// ------------------------------------------------------------ item names
// Item names and icons for MapleStory Classic (MCW/1) come from
// maplestory.io, fetched by your browser and kept for a week.
const ITEMS_KEY = "mt.items.v1", ITEMS_URL = "https://maplestory.io/api/MCW/1/item";
const iconUrl = id => `https://maplestory.io/api/MCW/1/item/${id}/icon`;
/** Draw text the way the game does (12px Arial; bold for the map name),
 *  from pictures of each letter: the same on every computer. */
const renderText = atlasRenderer(GLYPHS);
// Items new in a game patch that maplestory.io's list doesn't have yet
// (their names as the game shows them, and the kind in brackets). Once
// the list has an item, its entry there (with the icon) is used instead.
const EXTRA_ITEMS = [
  // Thanksgiving event, November 2026 patch
  ["Pumpkin Piece", "Etc"], ["Pie Flour", "Etc"], ["Turkey Egg", "Use"], ["Milk Jug", "Etc"],
  ["Pumpkin Pie", "Use"], ["Roasted Turkey", "Use"],
];
function useItems(list) {
  const items = list.map(([id, name, t]) => ({ id, name, type: LOOT_TYPES[t] })), have = new Set(items.map(it => it.name));
  for (const [name, type] of EXTRA_ITEMS) if (!have.has(name)) items.push({ id: null, name, type });
  lootMatcher.setItems(items);
  lootWorker?.postMessage({ items });
}
async function loadItems() {
  const cached = store.get(ITEMS_KEY, null);
  if (cached) useItems(cached.list);
  // checked again twice a day: game patches add items (and the list
  // on maplestory.io catches up with them)
  if (cached && Date.now() - cached.at < 12 * 36e5) return;
  try {
    const res = await fetch(ITEMS_URL);
    if (!res.ok) throw new Error(res.status);
    const list = [];
    for (const it of await res.json()) {
      const t = LOOT_TYPES.indexOf(it.typeInfo?.overallCategory), sub = it.typeInfo?.subCategory;
      // things that can drop: no cash-shop items, hair or faces
      if (t < 0 || it.isCash || sub === "Hair" || sub === "Face" || !it.name?.trim()) continue;
      list.push([it.id, it.name.trim(), t]);
    }
    store.set(ITEMS_KEY, { at: Date.now(), list });
    useItems(list);
  } catch { /* offline or blocked: items count as "Unknown item" */ }
}

// Map names (street and map) for reading the minimap, and what has
// dropped on each map before (kept in this browser).
const MAPS_KEY = "mt.maps.v1", MAPS_URL = "https://maplestory.io/api/MCW/1/map", MAP_LOOT_KEY = "mt.mapLoot";
session.mapMemory = store.get(MAP_LOOT_KEY, {});
function useMaps(list) { mapMatcher.setMaps(list.map(([id, street, name]) => ({ id, street, name }))); }
async function loadMaps() {
  const cached = store.get(MAPS_KEY, null);
  if (cached) useMaps(cached.list);
  if (cached && Date.now() - cached.at < 12 * 36e5) return;
  try {
    const res = await fetch(MAPS_URL);
    if (!res.ok) throw new Error(res.status);
    const data = await res.json(), list = [];
    for (const m of Array.isArray(data) ? data : data.items || data.maps || []) {
      const name = (m.name ?? m.mapName ?? "").trim(), street = (m.streetName ?? m.street ?? "").trim();
      if (name) list.push([m.id ?? m.mapId ?? null, street, name]);
    }
    if (!list.length) throw new Error("no maps");
    store.set(MAPS_KEY, { at: Date.now(), list });
    useMaps(list);
  } catch { /* offline or blocked: loot is remembered per session only */ }
}
const lootMatcher = session.lootMatcher = new LootMatcher(renderText);
// Items are named in a worker, so reading the screen never stops for it.
// If the worker can't start (or fails), naming happens here as before.
const lootWorker = (() => {
  try {
    const w = globalThis.LOOT_WORKER_SRC     // (test builds: everything in one file)
      ? new Worker(URL.createObjectURL(new Blob([globalThis.LOOT_WORKER_SRC], { type: "text/javascript" })))
      : new Worker(new URL("./loot-worker.js?v=__VERSION__", import.meta.url), { type: "module" });
    const waiting = new Map(); let next = 1;
    const fail = () => { session.lootAsk = null; for (const f of waiting.values()) f.reject(); waiting.clear(); };
    w.onmessage = ({ data }) => {
      const f = waiting.get(data.id); waiting.delete(data.id);
      if (f) data.error ? f.reject(new Error(data.error)) : f.resolve(data.r);
    };
    w.onerror = fail;
    session.lootAsk = (looks, known, kRef) => new Promise((resolve, reject) => {
      const id = next++; waiting.set(id, { resolve, reject });
      w.postMessage({ id, looks: looks.map(l => ({ n: l.n, cols: l.cols })), known, kRef });
    });
    return w;
  } catch { return null; }
})();
const mapMatcher = session.mapMatcher = new MapMatcher(renderText, t => renderText.measure(t, true));
function saveMapMemory() {
  if (!session.mapMemoryDirty) return;
  session.mapMemoryDirty = false;
  store.set(MAP_LOOT_KEY, session.mapMemory);
}

// -------------------------------------------------------- saved sessions
const SESS_KEY = "mt.sessions";
let saved = store.get(SESS_KEY, []);
let lastSessionSave = 0;
/** Save (or update) the current session in the history. */
function saveCurrent() {
  saveMapMemory();
  const r = session.record();
  lastSessionSave = Date.now();
  if (!r || r.played < 30) return;
  const i = saved.findIndex(s => s.id === r.id);
  if (i >= 0) saved[i] = r; else saved.unshift(r);
  saved = saved.slice(0, 500);
  store.set(SESS_KEY, saved);
  renderSessions();
}
addEventListener("pagehide", saveCurrent);

// ------------------------------------------------------- loot on or off
// Off for someone's first session (less to take in, less work for the
// computer); on from their second, unless they've chosen.
const LOOT_ON_KEY = "mt.loot.on";
let lootLoaded = false;
function applyLoot() {
  const pref = store.get(LOOT_ON_KEY, null);
  const on = session.lootOn = pref !== null ? !!pref : saved.some(s => s.id !== session.id);
  $("loot-on").checked = on;
  $("loot").classList.toggle("off", !on);
  $("loot-off").hidden = on;
  if (!on) session.lootPending = [];
  if (on && !lootLoaded) { lootLoaded = true; loadItems(); loadMaps(); }   // (the item list is only fetched when wanted)
}
$("loot-on").onchange = e => { store.set(LOOT_ON_KEY, e.target.checked); applyLoot(); };
applyLoot();
document.addEventListener("visibilitychange", () => { if (document.hidden) saveCurrent(); });

const compact = n => {
  if (n === null || n === undefined) return "–";
  const a = Math.abs(n);
  if (a < 1000) return String(Math.round(n));
  if (a < 1e6) return `${(n / 1e3).toFixed(a < 1e4 ? 1 : 0)}k`;
  return `${(n / 1e6).toFixed(a < 1e7 ? 2 : 1)}M`;
};
const playedText = s => { s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60;
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : m ? `${m}m` : `${s}s`; };
const dayText = t => new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const levelText = s => !s.levelStart && !s.levelEnd ? "–"
  : s.levelEnd && s.levelStart && s.levelEnd !== s.levelStart ? `${s.levelStart} → ${s.levelEnd}` : String(s.levelEnd || s.levelStart);

function renderSessions() {
  const cur = session.record();
  const rows = [...(cur && cur.played >= 30 ? [{ ...cur, current: true }] : []), ...saved.filter(s => !cur || s.id !== cur.id)];
  const body = $("sessions-body");
  // best EXP/hr among sessions long enough for the rate to mean something
  const rated = rows.filter(s => s.exp !== null && s.played >= 300);
  const best = rated.length > 1 ? rated.reduce((b, s) => s.exp / s.played > b.exp / b.played ? s : b) : null;
  body.replaceChildren(...rows.map(s => {
    const tr = document.createElement("tr");
    if (s.current) tr.className = "current";
    const hrs = s.played / 3600;
    const expTxt = s.exp !== null ? `+${compact(s.exp)}` : s.pctGained !== null ? `+${s.pctGained}%` : "–";
    const cells = [
      [dayText(s.start), ""], [playedText(s.played), ""], [levelText(s), ""],
      [expTxt, "num exp-cell"], [s.exp !== null && hrs > 0 ? compact(s.exp / hrs) : "–", "num"],
      [s.mesos !== null ? `+${compact(s.mesos)}` : "–", "num meso-cell"],
      [s.mesos !== null && hrs > 0 ? compact(s.mesos / hrs) : "–", "num"],
      [s.loot?.length ? String(s.loot.reduce((a, e) => a + e[1], 0)) : "–", "num"],
    ];
    for (const [text, cls] of cells) { const td = document.createElement("td"); td.textContent = text; if (cls) td.className = cls; tr.append(td); }
    if (s.loot?.length) tr.children[7].title = s.loot.slice(0, 12).map(([name, n]) => `${n} × ${name}`).join("\n");
    const tag = (td, cls, text) => td.append(Object.assign(document.createElement("span"), { className: `tag ${cls}`, textContent: text }));
    if (s.current) tag(tr.children[0], "now", "Now");
    if (best && s.id === best.id) tag(tr.children[4], "best", "Best");
    const td = document.createElement("td");
    if (!s.current) {
      const del = Object.assign(document.createElement("button"), { className: "del", type: "button", textContent: "✕", title: "Delete this session" });
      del.setAttribute("aria-label", `Delete the session from ${dayText(s.start)}`);
      del.onclick = () => { saved = saved.filter(x => x.id !== s.id); store.set(SESS_KEY, saved); renderSessions(); };
      td.append(del);
    }
    tr.append(td);
    return tr;
  }));
  $("sessions-table").hidden = !rows.length;
  $("sessions-empty").hidden = !!rows.length;
  const played = rows.reduce((a, s) => a + s.played, 0), exp = rows.reduce((a, s) => a + (s.exp || 0), 0);
  const mesos = rows.reduce((a, s) => a + (s.mesos || 0), 0);
  $("totals").textContent = rows.length
    ? `${rows.length} session${rows.length > 1 ? "s" : ""}, ${playedText(played)} played, ${compact(exp)} EXP, ${compact(mesos)} mesos`
    : "";
}

// cumulative EXP and mesos over the session, for the small charts under the rates
const trail = { id: null, pts: [], step: 5, lastT: -Infinity, drawn: -1 };
function sampleTrail(s) {
  if (trail.id !== session.id) Object.assign(trail, { id: session.id, pts: [], step: 5, lastT: -Infinity, drawn: -1 });
  if (!s.running || s.elapsed - trail.lastT < trail.step) return;
  trail.lastT = s.elapsed;
  trail.pts.push([s.elapsed, s.exp, s.mesos]);
  if (trail.pts.length > 360) { trail.pts = trail.pts.filter((_, i) => i % 2 === 0); trail.step *= 2; }
}
function drawSpark(svg, k) {
  const pts = trail.pts.filter(p => p[k] !== null && p[k] !== undefined);
  if (pts.length < 2) { svg.replaceChildren(); return; }
  const t0 = pts[0][0], t1 = pts[pts.length - 1][0];
  let lo = Math.min(0, ...pts.map(p => p[k])), hi = Math.max(...pts.map(p => p[k]));
  if (hi - lo < 1) hi = lo + 1;
  const W = 300, H = 64, pad = 3;
  const xy = pts.map(p => [((p[0] - t0) / Math.max(1, t1 - t0)) * W, H - pad - ((p[k] - lo) / (hi - lo)) * (H - 2 * pad)]);
  const d = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
  const ns = "http://www.w3.org/2000/svg";
  const area = document.createElementNS(ns, "path"); area.setAttribute("class", "area"); area.setAttribute("d", `${d}L${W},${H}L0,${H}Z`);
  const line = document.createElementNS(ns, "path"); line.setAttribute("class", "line"); line.setAttribute("d", d);
  svg.replaceChildren(area, line);
}
function renderTrail(s) {
  sampleTrail(s);
  if (trail.drawn === trail.pts.length) return;
  trail.drawn = trail.pts.length;
  drawSpark($("spark-exp"), 1);
  drawSpark($("spark-meso"), 2);
}

let renderedEvents = -1;
function renderLog() {
  const ev = session.events;
  const key = ev.length + (ev[ev.length - 1]?.t || 0);
  if (key === renderedEvents) return;
  renderedEvents = key;
  const list = $("log-list");
  list.replaceChildren(...ev.slice(-200).reverse().map(e => {
    const li = document.createElement("li");
    li.className = `ev-${e.kind}`;
    const time = document.createElement("time");
    time.dateTime = new Date(e.t).toISOString();
    time.textContent = new Date(e.t).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    const mark = document.createElement("span"); mark.className = "mark"; mark.setAttribute("aria-hidden", "true");
    const text = document.createElement("span"); text.textContent = e.text;
    li.append(time, mark, text);
    return li;
  }));
  $("log-empty").hidden = ev.length > 0;
}

// ---------------------------------------------------------------- capture
const video = $("video"), work = $("work");
const wctx = work.getContext("2d", { willReadFrequently: true });
let stream = null, track = null, imageCapture = null, source = null, captureFull = false;
const CAPTURE_FPS = 10;

async function shareWindow() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    showStatus("This browser can't share a window. Use Chrome or Edge on a computer.", true);
    return;
  }
  try {
    // Ask for the screen's real pixels: on a Mac (Retina) browsers otherwise
    // send half-size pictures, too blurry for the game's small digits.
    // Open the picker on "Window"; browser tabs are refused below.
    const opts = { audio: false, selfBrowserSurface: "exclude", surfaceSwitching: "include", preferCurrentTab: false };
    // Ten pictures a second is what the tracker reads; a little headroom so
    // a fresh one is never far off. No more: capturing costs the game too.
    const vopts = { frameRate: { ideal: CAPTURE_FPS, max: 15 }, displaySurface: "window" };
    let s;
    try { s = await navigator.mediaDevices.getDisplayMedia({ ...opts, video: { ...vopts, resizeMode: "none" } }); captureFull = true; }
    catch (e) {
      if (e?.name !== "OverconstrainedError" && e?.name !== "TypeError") throw e;
      s = await navigator.mediaDevices.getDisplayMedia({ ...opts, video: vopts }); captureFull = false;
    }
    // A browser tab can't show the game: say so and stop.
    if (s.getVideoTracks()[0]?.getSettings?.().displaySurface === "browser") {
      s.getTracks().forEach(t => t.stop());
      showStatus("That's a browser tab. Click Share game window again and pick the MapleStory window (or your entire screen).", true);
      return;
    }
    stopSource();
    stream = s; track = s.getVideoTracks()[0];
    track.addEventListener("ended", () => { stopSource(); session.stop(); saveCurrent(); render(); });
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
  $("share").textContent = "Share game window";
  $("stop").hidden = true;
}
/** The Stop sharing button: end the share and pause (the session is kept). */
function stopSharing() {
  if (!source) return;
  if (source === "file") { video.pause(); video.removeAttribute("src"); video.load(); }
  stopSource(); session.stop(); saveCurrent(); render();
}

function begin() {
  session.relocate(); session.mesoBox = null;
  session.start();
  applyLoot();
  $("share").textContent = "Share a different window";
  $("stop").hidden = false;
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
  ["setInterval(() => postMessage(0), 100);"], { type: "text/javascript" })));
let busy = false, lastSave = 0, lastFrame = null, lastHudTick = 0, lastSees = 0;
// Ten times a second: the pickup messages appear and fade within about a
// second and a half, and a burst can push several off the top in a moment.
// The HUD and inventory are read twice a second.
metronome.onmessage = async () => {
  if (busy) return;
  busy = true;
  try {
    if (session.running && source) {
      const frame = await currentFrame();
      if (frame) {
        lastFrame = { w: frame.w, h: frame.h };
        const now = Date.now(), get = box => region(frame, box);
        if (now - lastHudTick >= 480) { lastHudTick = now; session.tick(now, get); }
        session.tickFeed(now, get);
        if (now - lastSees >= 480 && $("trouble").open) { lastSees = now; drawSees(frame); }
        frame.bitmap?.close?.();
      }
    }
    if (session.running && Date.now() - lastSessionSave > 15000) saveCurrent();
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
  for (const [id, box, text] of [["see-exp", session.hud?.exp, last?.text], ["see-meso", session.mesoBox, last?.mesoText],
                                  ["see-feed", session.feedReader?.box(), null]]) {
    const c = $(id), ctx = c.getContext("2d");
    ctx.clearRect(0, 0, c.width, c.height);
    if (!box) continue;
    const [x, y, w, h] = box, k = Math.min(c.width / w, c.height / h);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(frame.src, x, y, w, h, (c.width - w * k) / 2, (c.height - h * k) / 2, w * k, h * k);
  }
  const expShown = !last ? "–" : last.pct !== ""
    ? `${last.exp !== "" ? fmt(last.exp) + " " : ""}[${Number(last.pct).toFixed(2)}%]`
    : last.text ? `not sure yet (reads “${last.text}”)` : (session.miss || "not found");
  const mesoShown = !last ? "–" : last.meso !== "" ? fmt(last.meso)
    : last.mesoText ? `not sure yet (reads “${last.mesoText}”)` : "inventory not visible";
  $("see-exp-text").textContent = `EXP: ${expShown}`;
  $("see-meso-text").textContent = `Mesos: ${mesoShown}`;
  const obs = session.feedObs || [];
  $("see-feed-text").textContent = !session.feedReader?.anchor ? "Pickup messages: not found yet"
    : `Pickup messages: ${obs.length ? obs.slice().sort((a, b) => b.slot - a.slot).map(o => o.type === "other" ? "?" : `${o.type} ${o.value ?? "?"}`).join(", ") : "none on screen"}`;
}

let statusOverride = null, searchingSince = null;
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
  else { pctEl.textContent = s.status === "searching" ? "getting ready…" : "waiting for the game"; pctEl.classList.remove("live"); }
  $("gauge-fill").style.width = `${s.pct ?? 0}%`;
  $("gauge-bar").setAttribute("aria-valuenow", s.pct ?? 0);
  const eta = $("eta");
  if (s.eta) { eta.textContent = `Next level in ${hms(s.eta)}${s.level ? ` (${fmt(expToNext(s.level) * (1 - s.pct / 100))} EXP to go)` : ""}`; eta.classList.add("live"); }
  else if (s.needsLevel) { eta.textContent = "Your HUD shows only the %. Set your level to see EXP."; eta.classList.remove("live"); }
  else if (!source) { eta.textContent = "Share the window that shows the game, and keep its bottom bar visible."; eta.classList.remove("live"); }
  else if (s.status === "searching") { eta.textContent = "Calibrating…"; eta.classList.remove("live"); }
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
  $("meso-now").textContent = s.mesoVisible && s.mesoTotal !== null ? `Total ${fmt(s.mesoTotal)}, read from your inventory`
    : s.feedActive ? `Counting the pickup messages${s.mesoTotal !== null ? ` (last total seen ${fmt(s.mesoTotal)})` : ""}`
    : s.mesoTotal !== null ? `Total ${fmt(s.mesoTotal)} (inventory not visible)` : "\u00a0";
  $("meso-total").innerHTML = s.mesos !== null
    ? `<strong>+${fmt(s.mesos)}</strong> mesos this session${s.mesoSpent ? `, ${fmt(s.mesoSpent)} spent` : ""}${s.mesoSold ? `, ${fmt(s.mesoSold)} from selling (not counted)` : ""}`
    : "Pick up some mesos, or open your Item Inventory for your total.";

  // session line
  $("clock").textContent = hms(s.elapsed);
  $("dot").classList.toggle("on", s.running);
  const st = $("status");
  let msg, warn = false;
  if (statusOverride && Date.now() < statusOverride.until) ({ msg, warn } = statusOverride);
  else if (!source) msg = "Not tracking";
  else if (!s.running) msg = "Paused";
  else if (s.status === "searching") {
    // Finding the game's bar can take a little while: say so plainly. Only
    // after a long time, a gentle nudge (the details are in Troubleshooting).
    searchingSince ??= Date.now();
    if (session.selfShare) {
      msg = "Right now the shared screen shows this tracker, not the game. Switch back to MapleStory: tracking picks up as soon as the game is on screen (Picture-in-Picture keeps your numbers in view). With two screens, share the one with the game.";
      warn = true;
    } else msg = Date.now() - searchingSince < 120000
      ? "Kill some mobs to start tracking. It can take 30 seconds to a minute while it calibrates to MapleStory's heads-up display."
      : "Still calibrating. Check that the screen or window you shared shows the game, including its bottom bar.";
  }
  else if (s.stale) { msg = "Can't read the EXP right now. Is something covering the bottom bar?"; warn = true; }
  else msg = source === "file" ? "Tracking the video" : "Tracking";
  if (s.status !== "searching") searchingSince = null;
  st.textContent = msg; st.classList.toggle("warn", warn);
  const ev = [];
  if (s.levels) ev.push(`${s.levels} level-up${s.levels > 1 ? "s" : ""}`);
  if (s.lost) ev.push(`${fmt(s.lost)} EXP lost to deaths`);
  $("events").textContent = ev.join(", ");
  const tg = $("toggle");
  tg.disabled = !source; tg.textContent = s.running ? "Pause" : "Resume";

  // prompts
  if (s.needsLevel && !asked.level && !promptOpen) askLevel("Your HUD shows only the EXP percentage. What level is your character? I'll turn % into EXP from here.");

  document.body.classList.toggle("idle", !source && !s.elapsed);
  renderTrail(s);
  renderLoot(s);
  renderLog();
  if (Date.now() - (render.sessionsAt || 0) > 5000) { render.sessionsAt = Date.now(); renderSessions(); }
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
// ------------------------------------------------------------------ loot
let lootDrawn = "";
function renderLoot(s) {
  const list = s.loot || [], sig = `${s.map}|` + list.map(e => `${e.name}:${e.count}`).join("|");
  if (sig === lootDrawn) return;
  lootDrawn = sig;
  const total = list.reduce((a, e) => a + e.count, 0);
  $("loot-count").textContent = [s.map, total ? `${total} item${total > 1 ? "s" : ""}` : ""].filter(Boolean).join(", ");
  $("loot-empty").hidden = !!list.length;
  $("loot-list").replaceChildren(...list.map(e => {
    const li = document.createElement("li");
    const pic = document.createElement("span"); pic.className = "loot-pic";
    if (e.id) {
      const img = Object.assign(document.createElement("img"), { src: iconUrl(e.id), alt: "", loading: "lazy", width: 32, height: 32 });
      img.onerror = () => img.remove();
      pic.append(img);
    } else pic.textContent = "?";
    const name = Object.assign(document.createElement("span"), { className: "loot-name", textContent: e.name });
    const n = Object.assign(document.createElement("span"), { className: "loot-n", textContent: `×${e.count.toLocaleString()}` });
    li.append(pic, name, n);
    return li;
  }));
}

// ---------------------------------------------------------------- pop-out
// ------------------------------------------------------------ pop-out
// A small always-on-top window to lay over the game on one screen.
// Chrome and Edge: a real little page (Document Picture-in-Picture).
// Elsewhere: the same numbers drawn into a video, shown with the browser's
// ordinary video picture-in-picture.
const OV_SIZE = "mt.overlay.size";
async function popOut() {
  if (pip) { pip.focus?.(); return; }
  if (!("documentPictureInPicture" in window)) return popOutVideo();
  const size = store.get(OV_SIZE, { width: 210, height: 80 });
  pip = await window.documentPictureInPicture.requestWindow(size);
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
  pip.document.title = "Maple Tracker";
  pip.document.body.className = "pip";
  pip.document.body.append($("mini").content.cloneNode(true));
  // remember the size the player chose, for next time
  pip.addEventListener("resize", () => store.set(OV_SIZE, { width: pip.innerWidth, height: pip.innerHeight }));
  pip.addEventListener("pagehide", () => { pip = null; render(); });
  overlayTip();
  render();
}
/** Sharing the whole screen with the overlay on it: it would cover the game
 *  in the picture the tracker reads. Say so once. */
function overlayTip() {
  const surface = track?.getSettings?.().displaySurface;
  if (surface === "monitor") showStatus("You're sharing your whole screen, so the pop-out is in the picture too. Share just the game window, or keep the pop-out away from the bottom bar and the bottom-right corner.", true);
}
function overlayText(s) {
  const rate = v => v === null || v === undefined ? (s.running ? "…" : "–") : fmt(v);
  return { exphr: rate(s.expHr), mesohr: rate(s.mesoHr) };
}
function renderPip(s) {
  if (pipVideo) drawOverlayCanvas(s);
  if (!pip) return;
  const q = k => pip.document.querySelector(`[data-k=${k}]`), t = overlayText(s);
  pip.document.querySelector(".ov").classList.toggle("paused", !s.running);
  q("exphr").textContent = t.exphr;
  q("mesohr").textContent = t.mesohr;
}

// Fallback: the overlay drawn on a canvas, streamed into a video, popped
// out with video picture-in-picture (Safari and older browsers). Firefox
// has no button for websites to call, but shows its own pop-out button on
// the video.
let pipVideo = null, pipCanvas = null;
async function popOutVideo() {
  if (!pipCanvas) {
    pipCanvas = Object.assign(document.createElement("canvas"), { width: 400, height: 150 });
    pipVideo = Object.assign(document.createElement("video"), { muted: true, playsInline: true, autoplay: true });
    pipVideo.className = "ov-video";
    pipVideo.srcObject = pipCanvas.captureStream(4);
    drawOverlayCanvas(session.snapshot());
  }
  await pipVideo.play().catch(() => {});
  if (pipVideo.requestPictureInPicture) {
    try { await pipVideo.requestPictureInPicture(); overlayTip(); return; } catch { /* fall through */ }
  }
  // Firefox: show the video on the page; its own pop-out button does the rest.
  const holder = $("ov-fallback");
  holder.hidden = false;
  if (!holder.contains(pipVideo)) holder.prepend(pipVideo);
}
function drawOverlayCanvas(s) {
  const c = pipCanvas, g = c.getContext("2d"), t = overlayText(s), css = getComputedStyle(document.documentElement);
  const v = n => css.getPropertyValue(n).trim();
  g.fillStyle = v("--slate-800"); g.fillRect(0, 0, c.width, c.height);
  g.globalAlpha = s.running ? 1 : 0.55; g.textBaseline = "top";
  const num = (y, text, color, label) => {
    g.font = "800 60px 'Baloo 2', system-ui, sans-serif"; g.fillStyle = color; g.fillText(text, 18, y);
    const w = g.measureText(text).width;
    g.font = "400 22px 'Atkinson Hyperlegible', system-ui, sans-serif"; g.fillStyle = v("--muted"); g.fillText(label, 28 + w, y + 30);
  };
  num(10, t.exphr, v("--gauge"), "EXP/hr");
  num(80, t.mesohr, v("--gold"), "mesos/hr");
  g.globalAlpha = 1;
}

// ---------------------------------------------------------------- controls
function toggle() {
  if (!source) return;
  session.running ? session.stop() : session.start();
  captureRate(session.running ? CAPTURE_FPS : 1);
  saveCurrent(); render();
}
/** How many pictures a second the share takes: one while paused, so a
 *  paused share costs the game next to nothing. */
function captureRate(fps) {
  if (source !== "window" || !track?.applyConstraints) return;
  const c = { frameRate: { ideal: fps, max: fps === CAPTURE_FPS ? 15 : fps } };
  if (captureFull) c.resizeMode = "none";
  track.applyConstraints(c).catch(() => {});
}
$("share").onclick = shareWindow;
$("stop").onclick = stopSharing;
$("share-2").onclick = shareWindow;
$("toggle").onclick = toggle;
$("reset").onclick = () => {
  saveCurrent();                       // the finished session stays in the history
  session.reset(); session.log = [];
  render(); renderSessions();
};
$("sessions-csv").onclick = () => {
  const cols = ["start", "end", "played_s", "level_start", "level_end", "pct_start", "pct_end", "exp", "pct_gained", "exp_per_hr", "mesos", "mesos_per_hr", "mesos_spent", "level_ups", "exp_lost", "items", "maps"];
  const rows = saved.map(s => [new Date(s.start).toISOString(), new Date(s.end).toISOString(), s.played, s.levelStart, s.levelEnd,
    s.pctStart, s.pctEnd, s.exp, s.pctGained, s.exp !== null && s.played ? Math.round(s.exp / (s.played / 3600)) : "",
    s.mesos, s.mesos !== null && s.played ? Math.round(s.mesos / (s.played / 3600)) : "", s.mesoSpent, s.levelUps, s.expLost,
    (s.loot || []).map(([name, n]) => `${n} ${name}`).join("; "), (s.maps || []).join("; ")]);
  const esc = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = [cols.join(","), ...rows.map(r => r.map(esc).join(","))].join("\n");
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([csv], { type: "text/csv" })), download: "maple-tracker-sessions.csv" });
  a.click(); URL.revokeObjectURL(a.href);
};
$("sessions-clear").onclick = () => {
  if (!saved.length || !confirm("Delete all saved sessions? This can't be undone.")) return;
  saved = []; store.set(SESS_KEY, saved); renderSessions();
};
$("set-level").onclick = () => askLevel();
$("refind").onclick = () => { session.relocate(); session.mesoBox = null; showStatus("Looking for the HUD again"); };
$("file").onchange = e => { const f = e.target.files[0]; if (f) openVideo(f); e.target.value = ""; };
$("download").onclick = () => {
  const cols = ["time", "text", "exp", "pct", "decision", "gained", "mesoText", "meso", "mesoDecision", "pickups", "pickupMesos", "note",
                "item", "itemResult", "itemDetail", "itemPicture"];
  const esc = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  // Item lines get rows of their own (the latest few hundred, kept only
  // while this tab is open): the name given, what became of it, and a small
  // picture of the line as read, to check the name against.
  const items = (session.lootLog || []).map(l => ({
    time: l.time, item: l.name && l.count > 1 ? `${l.name} x${l.count}` : l.name, itemResult: l.verdict,
    itemDetail: `line seen ${l.born.slice(11, 22)}; looks ${l.looks}; fit ${l.cost}; next best ${l.second} (+${l.margin})`,
    itemPicture: l.pic,
  }));
  const rows = [...session.log, ...items].sort((p, q) => (p.time < q.time ? -1 : p.time > q.time ? 1 : 0));
  const csv = [cols.join(","), ...rows.map(r => cols.map(c => esc(r[c])).join(","))].join("\n");
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(new Blob([csv], { type: "text/csv" })),
    download: `maple-tracker-readings-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.csv`,
  });
  a.click(); URL.revokeObjectURL(a.href);
};
$("snapshot").onclick = async () => {
  if (!(lastFrame && source)) { showStatus("Share the game window first.", true); return; }
  // On one screen the page itself covers the game: give time to switch back.
  showStatus("Saving a picture in 5 seconds: switch to the game now.");
  await new Promise(r => setTimeout(r, 5000));
  const frame = source ? await currentFrame() : null;
  if (!frame) { showStatus("Share the game window first.", true); return; }
  const c = document.createElement("canvas"); c.width = frame.w; c.height = frame.h;
  c.getContext("2d").drawImage(frame.src, 0, 0);
  frame.bitmap?.close?.();
  c.toBlob(b => {
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(b), download: "maple-tracker-what-it-sees.png" });
    a.click(); URL.revokeObjectURL(a.href);
  }, "image/png");
};
// Every browser gets the button: Chrome and Edge get the small page,
// others the video version.
$("popout").hidden = false; $("popout").onclick = popOut;
if (!navigator.mediaDevices?.getDisplayMedia) showStatus("Window sharing needs Chrome or Edge on a computer.", true);

window.__mapleTracker = { session }; // for the browser test
render();
