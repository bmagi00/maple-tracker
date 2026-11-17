// Maple Tracker - browser engine.
// Everything that reads the HUD and counts EXP. No DOM here, so the same
// file runs in the page and in Node tests. Images are {w, h, data} with
// RGBA bytes (what canvas getImageData returns).

// ------------------------------------------------------------- EXP table

/** EXP needed to finish `level` (MeowDB's MapleStory Classic formulas).
 *  Levels 1-49 match live Classic play; 50-89 follow the historical curve. */
export function expToNext(level) {
  if (!Number.isInteger(level) || level < 1 || level > 89) return null;
  if (level <= 5) return (Math.floor(level * level / 2) + 15) * level;
  if (level <= 50) { const q = Math.floor(level * level / 3); return (q + 19) * q; }
  let v = expToNext(50);
  for (let l = 51; l <= level; l++) v = Math.floor(v * 10548 / 10000);
  return v;
}

/** The single level whose requirement matches this amount and %. */
export function levelFromAmount(exp, pct) {
  const hits = [];
  for (let l = 1; l < 90; l++) {
    const req = expToNext(l);
    if (exp < req && Math.abs(exp / req * 100 - pct) <= 0.011) hits.push(l);
  }
  return hits.length === 1 ? hits[0] : null;
}

// --------------------------------------------------------- image helpers

export function crop(img, x, y, w, h) {
  x = Math.max(0, Math.round(x)); y = Math.max(0, Math.round(y));
  w = Math.min(img.w - x, Math.round(w)); h = Math.min(img.h - y, Math.round(h));
  const out = new Uint8ClampedArray(Math.max(0, w * h * 4));
  for (let r = 0; r < h; r++) {
    const s = ((y + r) * img.w + x) * 4;
    out.set(img.data.subarray(s, s + w * 4), r * w * 4);
  }
  return { w, h, data: out };
}

/** OpenCV-style HSV: H 0..180, S and V 0..255. */
function hsv(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 0) {
    if (mx === r) h = 60 * ((g - b) / d);
    else if (mx === g) h = 60 * ((b - r) / d) + 120;
    else h = 60 * ((r - g) / d) + 240;
    if (h < 0) h += 360;
  }
  return [h / 2, mx === 0 ? 0 : (d / mx) * 255, mx];
}

/** Connected components of a 0/1 mask: [{x, y, w, h, area}]. */
function components(mask, w, h, diagonal = false) {
  const seen = new Uint8Array(w * h), out = [], stack = new Int32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || seen[i]) continue;
    let x0 = w, y0 = h, x1 = -1, y1 = -1, area = 0, sp = 0;
    seen[i] = 1; stack[sp++] = i;
    while (sp) {
      const p = stack[--sp], px = p % w, py = (p - px) / w;
      area++;
      if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py;
      if (px > 0 && mask[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack[sp++] = p - 1; }
      if (px < w - 1 && mask[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack[sp++] = p + 1; }
      if (py > 0 && mask[p - w] && !seen[p - w]) { seen[p - w] = 1; stack[sp++] = p - w; }
      if (py < h - 1 && mask[p + w] && !seen[p + w]) { seen[p + w] = 1; stack[sp++] = p + w; }
      // Diagonal neighbours too: the game's own 1-pixel digits join at corners.
      if (!diagonal) continue;
      if (px > 0 && py > 0 && mask[p - w - 1] && !seen[p - w - 1]) { seen[p - w - 1] = 1; stack[sp++] = p - w - 1; }
      if (px < w - 1 && py > 0 && mask[p - w + 1] && !seen[p - w + 1]) { seen[p - w + 1] = 1; stack[sp++] = p - w + 1; }
      if (px > 0 && py < h - 1 && mask[p + w - 1] && !seen[p + w - 1]) { seen[p + w - 1] = 1; stack[sp++] = p + w - 1; }
      if (px < w - 1 && py < h - 1 && mask[p + w + 1] && !seen[p + w + 1]) { seen[p + w + 1] = 1; stack[sp++] = p + w + 1; }
    }
    out.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, area });
  }
  return out;
}

/** 3x3 dilate or erode, done as a horizontal then a vertical pass. */
function morph(mask, w, h, dilate) {
  const a = new Uint8Array(w * h), out = new Uint8Array(w * h);
  const pick = dilate ? (p, q, r) => p | q | r : (p, q, r) => p & q & r;
  const edge = dilate ? 0 : 1;
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++)
      a[o + x] = pick(x > 0 ? mask[o + x - 1] : edge, mask[o + x], x < w - 1 ? mask[o + x + 1] : edge);
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    out[i] = pick(y > 0 ? a[i - w] : edge, a[i], y < h - 1 ? a[i + w] : edge);
  }
  return out;
}

function percentileOfBytes(values, p) {
  const hist = new Uint32Array(256);
  for (const v of values) hist[v]++;
  const target = (p / 100) * (values.length - 1);
  let acc = 0;
  for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc > target) return i; }
  return 255;
}

/** Bilinear resize of a float array (cv2-style pixel centres). */
function resize(src, sw, sh, dw, dh) {
  const out = new Float32Array(dw * dh), fx = sw / dw, fy = sh / dh;
  for (let y = 0; y < dh; y++) {
    let sy = (y + 0.5) * fy - 0.5; sy = Math.min(Math.max(sy, 0), sh - 1);
    const y0 = Math.floor(sy), y1 = Math.min(y0 + 1, sh - 1), wy = sy - y0;
    for (let x = 0; x < dw; x++) {
      let sx = (x + 0.5) * fx - 0.5; sx = Math.min(Math.max(sx, 0), sw - 1);
      const x0 = Math.floor(sx), x1 = Math.min(x0 + 1, sw - 1), wx = sx - x0;
      out[y * dw + x] = (src[y0 * sw + x0] * (1 - wx) + src[y0 * sw + x1] * wx) * (1 - wy) +
                        (src[y1 * sw + x0] * (1 - wx) + src[y1 * sw + x1] * wx) * wy;
    }
  }
  return out;
}

/** Area-average resize (for shrinking a glyph to the comparison grid). */
function resizeArea(src, sw, sh, dw, dh) {
  const out = new Float32Array(dw * dh), fx = sw / dw, fy = sh / dh;
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
    const ax = x * fx, bx = (x + 1) * fx, ay = y * fy, by = (y + 1) * fy;
    let sum = 0, wsum = 0;
    for (let yy = Math.floor(ay); yy < Math.ceil(by); yy++) {
      const wy = Math.min(by, yy + 1) - Math.max(ay, yy);
      if (wy <= 0 || yy >= sh) continue;
      for (let xx = Math.floor(ax); xx < Math.ceil(bx); xx++) {
        const wx = Math.min(bx, xx + 1) - Math.max(ax, xx);
        if (wx <= 0 || xx >= sw) continue;
        sum += src[yy * sw + xx] * wx * wy; wsum += wx * wy;
      }
    }
    out[y * dw + x] = wsum ? sum / wsum : 0;
  }
  return out;
}

// ----------------------------------------------------------- HUD finding
//
// The Classic HUD is a dark bar along the bottom of the game: a white "LV."
// label with orange number tiles, then HP, MP and "EXP. 152,225 [7.00%]"
// (or just "EXP. [65.99%]"). Find the orange tiles anywhere, check the
// "LV." label beside them, then find the '%' sign along the bar.

export function orangeRuns(img) {
  const { w, h, data } = img, m = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    const r = data[j], g = data[j + 1], b = data[j + 2];
    if (r < 110 || r - b < 50 || g > r) continue;          // quick reject: not orange
    const [H, S] = hsv(r, g, b);
    m[i] = H >= 4 && H <= 24 && S >= 90 ? 1 : 0;
  }
  const closed = morph(morph(m, w, h, true), w, h, false);
  return components(closed, w, h)
    .filter(c => c.h >= 9 && c.h <= 90 && c.w / c.h >= 0.55 && c.w / c.h <= 3.8 && c.area >= 0.45 * c.w * c.h)
    .map(c => [c.x, c.y, c.w, c.h]);
}

export function lvLabelScore(img, [x, y, w, h]) {
  const lx0 = Math.max(0, Math.floor(x - 3.6 * h)), lx1 = Math.max(0, Math.floor(x - 0.2 * h));
  const ly0 = Math.max(0, Math.floor(y - 0.25 * h)), ly1 = Math.min(img.h, Math.floor(y + 1.25 * h));
  if (lx1 - lx0 < h) return 0;
  let white = 0, dark = 0, n = 0;
  for (let yy = ly0; yy < ly1; yy++) for (let xx = lx0; xx < lx1; xx++) {
    const i = (yy * img.w + xx) * 4, r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
    if (Math.min(r, g, b) > 165) white++;
    if (Math.max(r, g, b) < 95) dark++;
    n++;
  }
  white /= n; dark /= n;
  return white >= 0.04 && white <= 0.45 && dark >= 0.35 ? white + dark : 0;
}

/** Find the EXP readout on the bar right of the level tiles, by looking
 *  for a '%' sign among digit-sized shapes. */
export function locateReadout(img, run, reader, diagonal = false) {
  const [x, y, w, th] = run;
  const y0 = Math.max(0, Math.floor(y - 1.2 * th)), y1 = Math.min(img.h, Math.floor(y + 1.1 * th));
  const x0 = x + w, x1 = Math.min(img.w, Math.round(x0 + 60 * th));   // the HUD bar only
  const band = crop(img, x0, y0, x1 - x0, y1 - y0);
  if (!band.w || !band.h) return null;
  const n = band.w * band.h, g = new Uint8Array(n);
  for (let i = 0; i < n; i++) g[i] = Math.min(band.data[i * 4], band.data[i * 4 + 1], band.data[i * 4 + 2]);
  const lo = percentileOfBytes(g, 50), hi = percentileOfBytes(g, 99.5);
  const mask = new Uint8Array(n);
  // A fairly low cut keeps thin, blurry strokes in one piece.
  for (let i = 0; i < n; i++) mask[i] = (g[i] - lo) / Math.max(8, hi - lo) > 0.35 ? 1 : 0;
  const dh = 0.55 * th;   // HUD digits are about half the tile height
  const glyphs = components(mask, band.w, band.h, diagonal)
    .filter(c => c.h >= 0.6 * dh && c.h <= 1.6 * dh && c.w <= 2.2 * dh && c.w >= 0.15 * dh)
    .sort((a, b) => a.x - b.x);
  // Group into words on the same text line (commas/points stay inside).
  const words = [];
  for (const c of glyphs) {
    const last = words[words.length - 1];
    const cy = c.y + c.h / 2;
    if (last && c.x - last.x1 <= 0.9 * dh && Math.abs(cy - last.cy) < 0.5 * dh) {
      last.items.push(c); last.x1 = Math.max(last.x1, c.x + c.w);
    } else {
      words.push({ items: [c], x0: c.x, x1: c.x + c.w, cy });
    }
  }
  const medH = wd => { const hs = wd.items.map(c => c.h).sort((a, b) => a - b); return hs[hs.length >> 1]; };
  // Walk along the bar from the level tiles; the first word ending in '%'
  // is the EXP readout (HP and MP end in ']' instead).
  for (let i = 0; i < words.length; i++) {
    const wd = words[i];
    if (wd.items.length < 3) continue;
    const pad = Math.round(0.3 * dh);
    const wtop = Math.min(...wd.items.map(c => c.y)), wbot = Math.max(...wd.items.map(c => c.y + c.h));
    const gx = Math.max(wd.x0, wd.x1 - 2.2 * dh) - pad;
    const gcrop = crop(band, gx, wtop - pad, wd.x1 - gx + pad, wbot - wtop + 2 * pad);
    if (!reader.isPercent(gcrop)) continue;
    // Include the EXP amount in front of it, if there is one: digits of the
    // same height, just before (the bracket sits in the gap).
    let left = wd.x0, top = wtop, bot = wbot;
    const h0 = medH(wd);
    // Does a shape look like a digit? (The bold 'EXP.' label sits right
    // next to the amount and is about as tall, so it has to be told apart.)
    const digitLike = c => {
      const p2 = Math.round(0.25 * dh);
      const one = crop(band, c.x - p2, Math.min(c.y, wtop) - p2, c.w + 2 * p2, Math.max(c.y + c.h, wbot) - Math.min(c.y, wtop) + 2 * p2);
      const r = reader.read(one);
      return r.glyphs.length === 1 && reader.bestScore(r.glyphs[0].vec, "0123456789") >= 0.75;
    };
    for (let j = i - 1, right = wd.x0, first = true; j >= 0; j--, first = false) {
      const p = words[j], gap = right - p.x1;
      if (gap > (first ? 2.5 : 1.2) * dh || Math.abs(p.cy - wd.cy) > 0.5 * dh) break;
      const items = p.items.slice();
      while (items.length && !digitLike(items[0])) items.shift();   // trim a label
      if (items.length < 2) break;
      const hs = items.map(c => c.h).sort((a, b) => a - b);
      if (Math.abs(hs[hs.length >> 1] - h0) > 0.25 * h0) break;
      left = items[0].x; right = items[0].x;
      top = Math.min(top, ...items.map(c => c.y)); bot = Math.max(bot, ...items.map(c => c.y + c.h));
      if (items.length < p.items.length) break;                       // label reached
    }
    // Little padding on the left: the bold 'EXP.' label is close by.
    const pl = 0.18 * th, pr = 0.4 * th, py = 0.3 * th;
    return [Math.round(x0 + left - pl), Math.round(y0 + top - py),
            Math.round(wd.x1 - left + pl + pr), Math.round(bot - top + 2 * py)];
  }
  return null;
}

export function findHud(img, reader, why = {}) {
  const runs = orangeRuns(img);
  const scored = runs.map(r => [lvLabelScore(img, r), r]).sort((a, b) => b[0] - a[0]);
  Object.assign(why, { frame: `${img.w}x${img.h}`, orange: runs.length,
                       lvTiles: scored.filter(s => s[0] > 0).length, tried: [] });
  for (const [score, run] of scored.slice(0, 4)) {
    if (score <= 0) break;
    // Stream video: blurry digits, pieces touch at edges. The game window
    // itself: crisp 1-pixel digits whose strokes only meet at corners.
    for (const diagonal of [false, true]) {
      const box = locateReadout(img, run, reader, diagonal);
      // Only accept a spot whose numbers actually read as an EXP readout,
      // so look-alikes elsewhere on screen are skipped.
      const text = box ? reader.read(crop(img, ...box)).text : null;
      why.tried.push({ tiles: run, box, text });
      if (box && parseHudText(text)) return { tiles: run, exp: box };
    }
  }
  return null;
}

/** Plain-language reason the HUD wasn't found, for the page. */
export function explainMiss(why) {
  if (!why.frame) return "No picture from the shared window yet.";
  if (!why.lvTiles) return why.orange
    ? "Can't see the level tiles (LV.) - is the game's bottom bar visible and big enough?"
    : "Can't see the game's bottom bar in the shared window.";
  const t = why.tried[0];
  const th = t ? t.tiles[3] : 0;
  if (th && th < 16) return `The game looks small (level tiles ${th}px tall). Make the stream fullscreen or bigger.`;
  if (!t?.box) return "Found the level tiles, but not the EXP numbers next to them.";
  return `Found the EXP numbers but can't read them yet (reads "${t.text || "nothing"}"). A bigger, sharper stream helps.`;
}

// ------------------------------------------------------------ meso field
//
// With the Item Inventory window open, the meso total sits in a white field
// next to a gold coin: (coin) [   2,668,039 ] MESOS. Dark digits on white,
// so the crop is inverted and read with the same digit matcher.

/** White fields with a gold coin on their left: candidate meso boxes. */
export function mesoFields(img) {
  const { w, h, data } = img, m = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    const r = data[j], g = data[j + 1], b = data[j + 2];
    const mn = Math.min(r, g, b), mx = Math.max(r, g, b);
    m[i] = mn >= 228 && mx - mn <= 30 ? 1 : 0;
  }
  const fields = components(m, w, h).filter(c =>
    c.h >= 9 && c.h <= 50 && c.w / c.h >= 5 && c.w / c.h <= 18 && c.area >= 0.55 * c.w * c.h);
  const out = [];
  for (const f of fields.sort((a, b) => b.area - a.area)) {
    const cx0 = Math.max(0, Math.round(f.x - 1.8 * f.h)), cx1 = Math.max(0, f.x - 1);
    let gold = 0, n = 0;
    for (let y = f.y; y < f.y + f.h; y++) for (let x = cx0; x < cx1; x++) {
      const j = (y * w + x) * 4, [H, S, V] = hsv(data[j], data[j + 1], data[j + 2]);
      if (H >= 15 && H <= 35 && S >= 100 && V >= 130) gold++;
      n++;
    }
    if (n && gold / n >= 0.12) out.push([f.x + 2, f.y + 1, f.w - 4, f.h - 2]);
  }
  return out;
}

export function findMeso(img, reader) {
  for (const box of mesoFields(img))
    if (parseMeso(readMeso(crop(img, ...box), reader).text) !== null) return box;
  return null;
}

/** Read the meso field: invert (dark digits -> light) and match. */
export function readMeso(img, reader) {
  const inv = new Uint8ClampedArray(img.data.length);
  for (let i = 0; i < img.data.length; i += 4) {
    inv[i] = 255 - img.data[i]; inv[i + 1] = 255 - img.data[i + 1];
    inv[i + 2] = 255 - img.data[i + 2]; inv[i + 3] = 255;
  }
  return reader.read({ w: img.w, h: img.h, data: inv });
}

/** '2.668.039' -> 2668039 (commas read as points). */
export function parseMeso(text) {
  if (!text) return null;
  const t = text.replace(/\s+/g, "");
  if (!/^\d{1,3}(\.\d{3})*$/.test(t) && !/^\d{1,10}$/.test(t)) return null;
  return parseInt(t.replace(/\./g, ""), 10);
}

// ---------------------------------------------------------- digit reader

export const NORM_H = 22;
export const GW = 12, GH = 18;

/** Split a readout crop into characters. Returns {band, sat, bw, bh, boxes}. */
export function segment(img) {
  const { w: W, h: H, data } = img, n = W * H;
  if (n === 0) return null;
  const g = new Uint8Array(n), sat = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = data[i * 4], gg = data[i * 4 + 1], b = data[i * 4 + 2];
    g[i] = Math.min(r, gg, b);
    const mx = Math.max(r, gg, b);
    sat[i] = mx ? (mx - g[i]) / mx : 0;
  }
  const lo = percentileOfBytes(g, 30), hi = percentileOfBytes(g, 99.5);
  const wv = new Float32Array(n);
  for (let i = 0; i < n; i++) wv[i] = Math.min(1, Math.max(0, (g[i] - lo) / Math.max(8, hi - lo)));
  // Rows with text: some ink, but not a solid bar.
  const ink = [];
  for (let y = 0; y < H; y++) {
    let c = 0;
    for (let x = 0; x < W; x++) if (wv[y * W + x] > 0.5) c++;
    const fill = c / W;
    ink.push(fill > Math.max(1 / W, 0.03) && fill < 0.8);
  }
  let best = [0, 0, 0], run = 0, start = 0;
  for (let i = 0; i <= H; i++) {
    if (i < H && ink[i]) { if (run === 0) start = i; run++; }
    else { if (run > best[0]) best = [run, start, i]; run = 0; }
  }
  const [, r0, r1] = best;
  if (r1 - r0 < 4) return null;
  const pad = Math.max(1, Math.floor((r1 - r0) / 4));
  const ya = Math.max(0, r0 - pad), yb = Math.min(H, r1 + pad), sh = yb - ya;
  const scale = NORM_H / (r1 - r0);
  const bw = Math.max(1, Math.round(W * scale)), bh = Math.max(1, Math.round(sh * scale));
  const band = resize(wv.subarray(ya * W, yb * W), W, sh, bw, bh);
  const satb = resize(sat.subarray(ya * W, yb * W), W, sh, bw, bh);
  const col = new Int32Array(bw);
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) if (band[y * bw + x] > 0.45) col[x]++;
  const segs = [];
  let x = 0;
  while (x < bw) {
    if (col[x] === 0) { x++; continue; }
    let s = x;
    while (x < bw && col[x] > 0) x++;
    if (x - s > 3 * NORM_H) return null;          // a bar or smear, not characters
    while (x - s > 1.05 * NORM_H) {               // two characters stuck together
      const a = s + Math.floor(0.35 * NORM_H), b = Math.min(x - Math.floor(0.3 * NORM_H), s + Math.floor(0.85 * NORM_H));
      if (b <= a) break;
      let cut = a;
      for (let k = a; k < b; k++) if (col[k] < col[cut]) cut = k;
      segs.push([s, cut]); s = cut;
    }
    segs.push([s, x]);
  }
  const boxes = [];
  for (const [s, e] of segs) {
    let top = -1, bot = -1;
    for (let y = 0; y < bh; y++) {
      let any = false;
      for (let xx = s; xx < e; xx++) if (band[y * bw + xx] > 0.45) { any = true; break; }
      if (any) { if (top < 0) top = y; bot = y; }
    }
    if (top >= 0 && (e - s) * (bot - top + 1) >= 4) boxes.push([s, top, e - s, bot - top + 1]);
  }
  return { band, sat: satb, bw, bh, boxes };
}

/** Characters: ['tall', box] digits/% , ['dot', box], ['gap', null]. */
export function characters(img) {
  const seg = segment(img);
  if (!seg) return null;
  const { band, sat, bw, boxes } = seg;
  const isBracket = ([x, y, w, h]) => {
    if (w < 0.22 * NORM_H) return true;
    let s = 0, c = 0;
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
      if (band[yy * bw + xx] > 0.45) { s += sat[yy * bw + xx]; c++; }
    }
    return c > 0 && s / c > 0.32;
  };
  let tall = boxes.filter(b => b[3] >= 0.55 * NORM_H && !isBracket(b));
  if (!tall.length) return { seg, chars: [] };
  const hs = tall.map(b => b[3]).sort((a, b) => a - b);
  const med = hs.length % 2 ? hs[(hs.length - 1) / 2] : (hs[hs.length / 2 - 1] + hs[hs.length / 2]) / 2;
  const kept = tall.filter(b => !(b[2] < 0.36 * NORM_H && b[3] > 1.08 * med));
  if (kept.length) tall = kept;
  const first = tall[0][0], last = tall[tall.length - 1][0];
  const chars = [];
  let prevEnd = null;
  for (const b of boxes) {
    const [x, y, w, h] = b;
    let kind;
    if (tall.includes(b)) kind = "tall";
    else if (h < 0.4 * NORM_H && w < 0.4 * NORM_H && x > first && x < last && y > 0.45 * NORM_H) kind = "dot";
    else continue;
    if (prevEnd !== null && x - prevEnd > 0.55 * NORM_H) chars.push(["gap", null]);
    chars.push([kind, b]);
    prevEnd = x + w;
  }
  return { seg, chars };
}

export function glyphVec(seg, [x, y, w, h]) {
  const { band, bw } = seg, target = GW / GH;
  let pw = w, ph = h, ox = 0, oy = 0;
  if (w / h < target) { const p = Math.round(h * target - w); pw = w + p; ox = Math.floor(p / 2); }
  else { const p = Math.round(w / target - h); ph = h + p; oy = Math.floor(p / 2); }
  const g = new Float32Array(pw * ph);
  for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
    g[(yy + oy) * pw + xx + ox] = band[(y + yy) * bw + x + xx];
  }
  return resizeArea(g, pw, ph, GW, GH);
}

function normalized(v) {
  let m = 0; for (const a of v) m += a; m /= v.length;
  const out = new Float32Array(v.length); let s = 0;
  for (let i = 0; i < v.length; i++) { out[i] = v[i] - m; s += out[i] * out[i]; }
  s = Math.sqrt(s) + 1e-6;
  for (let i = 0; i < v.length; i++) out[i] /= s;
  return out;
}

function shifted(v) {
  const out = [];
  for (const dy of [-1, 0, 1]) for (const dx of [-1, 0, 1]) {
    const s = new Float32Array(GW * GH);
    for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
      const yy = y + dy, xx = x + dx;
      s[y * GW + x] = (yy >= 0 && yy < GH && xx >= 0 && xx < GW) ? v[yy * GW + xx] : 0;
    }
    out.push(normalized(s));
  }
  return out;
}

/** Reads the HUD's numbers by comparing each character with examples of
 *  the game's own digits; learns from readings the tracker accepts. */
export class DigitReader {
  constructor(seeds, learned = {}) {
    this.MIN = 0.72; this.MARGIN = 0.07; this.SURE = 0.85; this.LEARN = 0.86; this.MAX_LEARNED = 24;
    this.seeds = seeds; this.learned = learned; this.dirty = false;
    this._rebuild();
  }
  _rebuild() {
    this.tpl = [];
    for (const src of [this.seeds, this.learned])
      for (const [c, list] of Object.entries(src))
        for (const v of list) this.tpl.push([c, normalized(Float32Array.from(v))]);
  }
  classify(vec) {
    if (!this.tpl.length) return ["?", 0];
    const sh = shifted(vec), best = {};
    for (const [c, t] of this.tpl) {
      let m = -1;
      for (const s of sh) { let d = 0; for (let i = 0; i < t.length; i++) d += s[i] * t[i]; if (d > m) m = d; }
      if (!(c in best) || m > best[c]) best[c] = m;
    }
    const ranked = Object.entries(best).sort((a, b) => b[1] - a[1]);
    const [c, s] = ranked[0], second = ranked[1] ? ranked[1][1] : 0;
    return [s >= this.MIN && s - second >= this.MARGIN ? c : "?", s];
  }
  /** A '%' can fall apart into two pieces (slash and circles) at some
   *  sizes. Join neighbouring pieces when together they look like '%'. */
  joinPercent(r) {
    const out = [];
    for (let i = 0; i < r.chars.length; i++) {
      const a = r.chars[i], b = r.chars[i + 1];
      if (a[0] === "tall" && b && b[0] === "tall") {
        const [ax, ay, aw, ah] = a[1], [bx, by, bw, bh] = b[1];
        const gap = bx - (ax + aw), w = bx + bw - ax;
        if (gap <= 0.15 * NORM_H && w >= 0.6 * NORM_H && w <= 1.2 * NORM_H) {
          const y = Math.min(ay, by), box = [ax, y, w, Math.max(ay + ah, by + bh) - y];
          const v = glyphVec(r.seg, box);
          const sp = this.scoreFor(v, "%");
          if (sp >= 0.7 && sp > this.classify(glyphVec(r.seg, a[1]))[1] &&
              sp > this.classify(glyphVec(r.seg, b[1]))[1]) {
            out.push(["tall", box]); i++; continue;
          }
        }
      }
      out.push(a);
    }
    r.chars = out;
    return r;
  }
  isPercent(img) {
    const r = characters(img);
    if (!r || !r.chars.length) return false;
    this.joinPercent(r);
    const tall = r.chars.filter(c => c[0] === "tall");
    if (!tall.length) return false;
    const b = tall[tall.length - 1][1];
    if (b[2] < 0.65 * b[3]) return false;               // '%' is wider than digits
    return this.scoreFor(glyphVec(r.seg, b), "%") >= 0.6;
  }
  bestScore(vec, chars) {
    let m = -1;
    for (const c of chars) m = Math.max(m, this.scoreFor(vec, c));
    return m;
  }
  scoreFor(vec, char) {
    const sh = shifted(vec); let m = -1;
    for (const [c, t] of this.tpl) {
      if (c !== char) continue;
      for (const s of sh) { let d = 0; for (let i = 0; i < t.length; i++) d += s[i] * t[i]; if (d > m) m = d; }
    }
    return m;
  }
  /** -> {text: '152.225 7.00%', glyphs: [{c, score, vec}], sure} */
  read(img) {
    const r = characters(img);
    if (!r || !r.chars.length) return { text: null, glyphs: [], sure: false };
    this.joinPercent(r);
    let text = ""; const glyphs = [];
    for (const [kind, b] of r.chars) {
      if (kind === "gap") text += " ";
      else if (kind === "dot") text += ".";
      else {
        const vec = glyphVec(r.seg, b), [c, score] = this.classify(vec);
        text += c; glyphs.push({ c, score, vec });
      }
    }
    const sure = glyphs.length > 0 && glyphs.every(g => g.c !== "?" && g.score >= this.SURE);
    return { text: text.trim(), glyphs, sure };
  }
  /** Learn every character of a crop from text the user typed. */
  teach(img, label) {
    const r = characters(img);
    if (!r) return false;
    this.joinPercent(r);
    const tall = r.chars.filter(c => c[0] === "tall").map(c => c[1]);
    const lab = [...label].filter(c => /[0-9%]/.test(c));
    if (tall.length !== lab.length) return false;
    tall.forEach((b, k) => {
      const list = (this.learned[lab[k]] ||= []);
      list.push(Array.from(glyphVec(r.seg, b), v => Math.round(v * 1000) / 1000));
      if (list.length > this.MAX_LEARNED) list.shift();
    });
    this.dirty = true; this._rebuild();
    return true;
  }
  confirm(glyphs) {
    for (const g of glyphs) {
      if (g.c === "?" || g.score < this.LEARN || g.score >= 0.97) continue;
      const list = (this.learned[g.c] ||= []);
      list.push(Array.from(g.vec, v => Math.round(v * 1000) / 1000));
      if (list.length > this.MAX_LEARNED) list.shift();
      this.dirty = true;
    }
    if (this.dirty) this._rebuild();
  }
}

/** '152.225 7.00%' -> [152225, 7.0]; '65.99%' -> [null, 65.99]; else null.
 *  The % always has two decimals and is below 100, so a lost decimal point
 *  or a bracket read as '1'/'?' can be undone; amounts must fit the table. */
export function parseHudText(text) {
  if (!text || !text.includes("%")) return null;
  let s = text.slice(0, text.lastIndexOf("%")).trimEnd();
  if (s.length < 2 || !/^\d\d$/.test(s.slice(-2))) return null;
  const dec = s.slice(-2); s = s.slice(0, -2);
  if (s.endsWith(".") || s.endsWith(" ")) s = s.slice(0, -1);
  for (const drop of [0, 1]) for (const k of [2, 1]) {
    const ip = s.slice(-k); let rest = s.slice(0, s.length - k);
    if (ip.length !== k || !/^\d+$/.test(ip)) continue;
    const unsureTens = k === 1 && rest.slice(-1) === "?";
    if (drop) {
      if (!rest || !"1?".includes(rest.slice(-1))) continue;
      rest = rest.slice(0, -1);
    }
    const pct = parseFloat(`${ip}.${dec}`);
    if (!/\d/.test(rest)) {
      if (unsureTens) continue;
      return [null, pct];
    }
    const words = rest.replace(/\?/g, " ").split(/\s+/).filter(Boolean);
    const amountTxt = words.length ? words[words.length - 1].replace(/^\.+|\.+$/g, "") : "";
    if (!/^\d[\d.]*$/.test(amountTxt)) continue;
    // A stray '1' in front can be the edge of the 'EXP.' label; the EXP
    // table decides which reading is real.
    for (const t of [amountTxt, amountTxt.startsWith("1") ? amountTxt.slice(1).replace(/^\./, "") : null]) {
      if (!t || !/^\d[\d.]*$/.test(t)) continue;
      const amount = parseInt(t.replace(/\./g, ""), 10);
      if (levelFromAmount(amount, pct)) return [amount, pct];
    }
  }
  return null;
}

// --------------------------------------------------------------- trackers

/** HUD shows the amount: 152,225 [7.00%]. EXP and % must agree on the
 *  level total; drops and level-ups must repeat; misread events are undone. */
export class ExpTracker {
  constructor() {
    this.CONFIRM = 3; this.REBASELINE = 20;
    this.last = null; this.req = null; this.reqPct = null; this.pending = [];
    this.rejects = 0; this.gained = 0; this.lost = 0; this.levels = 0; this.undo = null;
  }
  static req(exp, pct) { return pct >= 0.5 ? exp / (pct / 100) : null; }
  static tol(...p) { return p.reduce((a, x) => a + (x ? 0.006 / x : 0), 0) + 0.001; }
  fits(exp, pct, req, reqPct) {
    const r = ExpTracker.req(exp, pct);
    if (r === null || req === null) return null;
    return Math.abs(r - req) / req <= ExpTracker.tol(pct, reqPct);
  }
  snap() { return [this.last, this.req, this.reqPct, this.gained, this.lost, this.levels]; }
  restore(s) { [this.last, this.req, this.reqPct, this.gained, this.lost, this.levels] = s; }
  setLast(r, newLevel = false) {
    const [exp, pct] = r; this.last = r; const q = ExpTracker.req(exp, pct);
    if (newLevel) { this.req = q; this.reqPct = q ? pct : null; }
    else if (q && (this.req === null || pct > (this.reqPct || 0))) { this.req = q; this.reqPct = pct; }
  }
  agrees(a, b) {
    if (b[0] < a[0] || b[1] < a[1] - 0.011) return false;
    return this.fits(b[0], b[1], ExpTracker.req(a[0], a[1]), a[1]) !== false;
  }
  tryUndo(r) {
    if (!this.undo) return false;
    const [last, req, reqPct] = this.undo;
    if (!last || r[0] < last[0] || r[1] < last[1] - 0.011) return false;
    if (!this.fits(r[0], r[1], req, reqPct)) return false;
    this.restore(this.undo); this.undo = null; this.pending = []; return true;
  }
  update(r) {
    if (!r) return "unreadable";
    const undone = this.tryUndo(r);
    const [exp, pct] = r;
    if (!this.last) return this.pend(r, "start");
    const [oe, op] = this.last;
    if (exp >= oe && pct >= op - 0.011) {
      const fit = this.fits(exp, pct, this.req, this.reqPct);
      if (fit) {
        this.pending = []; this.rejects = 0; this.gained += exp - oe; this.setLast(r);
        if (exp > oe) this.undo = null;
        return undone ? "undo" : exp > oe ? "gain" : "same";
      }
      if (fit === false) return this.reject();
      return this.pend(r, "unverified");
    }
    if (this.fits(exp, pct, this.req, this.reqPct) === false && !(op - pct > 30 || pct < 0.5)) return this.reject();
    return this.pend(r, "drop");
  }
  reject() {
    this.pending = []; this.rejects++;
    if (this.rejects >= this.REBASELINE) {
      this.undo = this.undo || this.snap();
      this.last = this.req = this.reqPct = null; this.rejects = 0; return "rebaseline";
    }
    return "rejected";
  }
  pend(r, why) {
    if (this.pending.length && this.agrees(this.pending[this.pending.length - 1], r)) this.pending.push(r);
    else this.pending = [r];
    return this.pending.length < this.CONFIRM ? `wait-${why}` : this.resolve();
  }
  resolve() {
    const first = this.pending[0], latest = this.pending[this.pending.length - 1];
    this.pending = []; this.rejects = 0;
    if (!this.last) { this.setLast(latest, true); return "baseline"; }
    const [oe, op] = this.last, [le, lp] = latest;
    if (le >= oe && lp >= op - 0.011) { this.gained += le - oe; this.setLast(latest); return "gain-confirmed"; }
    const fit = this.fits(le, lp, this.req, this.reqPct);
    if (fit || (fit === null && op - lp < 30)) {
      this.undo = this.snap(); this.lost += Math.max(0, oe - first[0]);
      this.gained += le - first[0]; this.setLast(latest); return "death";
    }
    const nr = ExpTracker.req(le, lp), ratio = nr && this.req ? nr / this.req : null;
    if ((ratio !== null && ratio > 1 && ratio <= 3.5) || (ratio === null && op >= 70)) {
      this.undo = this.snap();
      if (this.req) this.gained += Math.max(0, this.req - oe);
      this.gained += le; this.levels++; this.setLast(latest, true); return "level-up";
    }
    return "rejected-pattern";
  }
}

/** HUD shows only the %: [65.99%]. EXP = % x the level's requirement. */
export class PctTracker {
  constructor(startLevel = null) {
    this.CONFIRM = 3; this.BIG_STEP = 2.0;
    this.startLevel = startLevel; this.offset = 0; this.pctBy = {}; this.lostBy = {};
    this.last = null; this.pending = []; this.undo = null; this.sinceEvent = 0;
  }
  get level() { return this.startLevel ? this.startLevel + this.offset : null; }
  expOf(table) {
    if (!this.startLevel) return null;
    let t = 0;
    for (const [off, p] of Object.entries(table)) {
      const req = expToNext(this.startLevel + Number(off));
      if (req === null) return null;
      t += p / 100 * req;
    }
    return t;
  }
  get gained() { return this.expOf(this.pctBy); }
  get lost() { return this.expOf(this.lostBy) || 0; }
  get levels() { return this.offset; }
  get pctGained() { return Object.values(this.pctBy).reduce((a, b) => a + b, 0); }
  setLevel(level) { this.startLevel = Math.max(1, level - this.offset); }
  add(p, table = this.pctBy, off = this.offset) { table[off] = (table[off] || 0) + p; }
  snap() { return [this.last, this.offset, { ...this.pctBy }, { ...this.lostBy }]; }
  tryUndo(p) {
    if (!this.undo) return false;
    const old = this.undo[0];
    if (old === null || !(p - old >= -0.011 && p - old <= this.BIG_STEP)) return false;
    [this.last, this.offset, this.pctBy, this.lostBy] = this.undo;
    this.undo = null; this.pending = []; return true;
  }
  update(p) {
    if (p === null || p === undefined) return "unreadable";
    const undone = this.tryUndo(p);
    if (this.last === null) return this.pend(p, "start");
    const d = p - this.last;
    if (d >= -0.011 && d <= this.BIG_STEP) {
      this.pending = [];
      if (d > 0) {
        this.add(d); this.last = p; this.sinceEvent += d;
        if (this.sinceEvent >= 0.3) this.undo = null;
      }
      return undone ? "undo" : d > 0 ? "gain" : "same";
    }
    return this.pend(p, d > 0 ? "jump" : "drop");
  }
  pend(p, why) {
    const prev = this.pending[this.pending.length - 1];
    if (this.pending.length && p - prev >= -0.011 && p - prev <= this.BIG_STEP) this.pending.push(p);
    else this.pending = [p];
    return this.pending.length < this.CONFIRM ? `wait-${why}` : this.resolve();
  }
  resolve() {
    const first = this.pending[0], latest = this.pending[this.pending.length - 1];
    this.pending = [];
    if (this.last === null) { this.last = latest; return "baseline"; }
    const old = this.last;
    this.undo = this.snap(); this.sinceEvent = 0;
    if (latest >= old) { this.add(latest - old); this.last = latest; return "jump-confirmed"; }
    if (old - latest > 30 && latest < 50) {
      this.add(100 - old); this.offset++; this.add(latest); this.last = latest; return "level-up";
    }
    this.add(old - first, this.lostBy); this.add(latest - first); this.last = latest; return "death";
  }
}

/** Meso total from the inventory window. Increases count as gained;
 *  drops (buying, repairs) are spending and don't count against you.
 *  Big jumps must repeat; a doubtful reading must repeat. */
export class MesoTracker {
  constructor() {
    this.CONFIRM = 2; this.BIG = 100000;
    this.last = null; this.pending = []; this.gained = 0; this.spent = 0;
  }
  update(v, sure = true) {
    if (v === null || v === undefined) return "unreadable";
    if (this.last === null) return this.pend(v, "start");
    const d = v - this.last;
    if (d === 0) { this.pending = []; return "same"; }
    if (d > 0 && d <= this.BIG && sure) { this.gained += d; this.last = v; this.pending = []; return "gain"; }
    return this.pend(v, d > 0 ? "jump" : "drop");
  }
  pend(v, why) {
    if (this.pending.length && this.pending[this.pending.length - 1] === v) this.pending.push(v);
    else this.pending = [v];
    if (this.pending.length < this.CONFIRM) return `wait-${why}`;
    this.pending = [];
    if (this.last === null) { this.last = v; return "baseline"; }
    const d = v - this.last;
    if (d > 0) this.gained += d; else this.spent -= d;
    this.last = v;
    return d > 0 ? "gain-confirmed" : "spent";
  }
}

// ---------------------------------------------------------------- session

export const ACCEPTED = new Set(["gain", "same", "gain-confirmed", "jump-confirmed", "baseline",
                                 "level-up", "death", "undo"]);

/** Ties it together: finds the HUD in frames, reads it, feeds a tracker.
 *  The page calls tick(now, getFrame) on a timer. */
export class Session {
  constructor(reader, { level = null, onLevel = () => {}, mesoReader = null } = {}) {
    this.reader = reader; this.onLevel = onLevel; this.startLevel = level;
    this.mesoReader = mesoReader;
    this.hud = null; this.status = "idle"; this.lastOk = 0; this.lastSearch = 0;
    this.mesoBox = null; this.mesoOk = 0; this.mesoSearch = 0; this.mesoSeen = false;
    this.prevUnsure = null; this.log = [];
    this.reset();
  }
  reset() {
    this.meso = new MesoTracker();
    this.exp = new ExpTracker(); this.pct = new PctTracker(this.startLevel);
    this.mode = null; this.votes = []; this.history = [];
    this.elapsedBanked = 0; this.startedAt = this.running ? Date.now() : null;
  }
  start(now = Date.now()) {
    if (this.running) return;
    this.exp.last = null; this.exp.pending = [];
    this.meso.last = null; this.meso.pending = [];
    this.pct.last = null; this.pct.pending = []; this.pct.undo = null;
    this.running = true; this.startedAt = now; this.lastOk = now;
  }
  stop(now = Date.now()) {
    if (!this.running) return;
    this.elapsedBanked += (now - this.startedAt) / 1000; this.startedAt = null; this.running = false;
  }
  elapsed(now = Date.now()) {
    return this.elapsedBanked + (this.startedAt ? (now - this.startedAt) / 1000 : 0);
  }
  setLevel(level) { this.startLevel = level; this.pct.setLevel(level); }
  relocate() { this.hud = null; this.lastSearch = 0; }
  gained() { return this.mode === "amount" ? this.exp.gained : this.pct.gained; }

  /** getFrame(box|null) -> image of that box (or the whole frame). */
  tick(now, getFrame) {
    if (!this.running) return null;
    const lost = now - this.lastOk > 6000;
    if (!this.hud || (lost && now - this.lastSearch > 5000)) {
      this.status = "searching"; this.lastSearch = now;
      const full = getFrame(null);
      if (!full) { this.miss = "No picture from the shared window yet."; return null; }
      const why = {};
      const hud = findHud(full, this.reader, why);
      if (!hud) {
        this.miss = explainMiss(why);
        const row = { time: new Date(now).toISOString(), text: why.tried[0]?.text || "", exp: "", pct: "",
                      decision: "hud-not-found", gained: "", mesoText: "", meso: "", mesoDecision: "",
                      note: `${why.frame}; orange ${why.orange}; LV tiles ${why.lvTiles}; tried ${JSON.stringify(why.tried)}` };
        this.log.push(row); if (this.log.length > 20000) this.log.shift();
        return row;
      }
      this.miss = null;
      this.hud = hud; this.status = "tracking"; this.lastOk = now;
    }
    const img = getFrame(this.hud.exp);
    if (!img) return null;
    const { text, glyphs, sure } = this.reader.read(img);
    let parsed = parseHudText(text);
    if (parsed && parsed[0] === null && !sure) {
      // A % alone has no arithmetic check: a doubtful one must repeat.
      const same = this.prevUnsure && parsed[1] === this.prevUnsure[1];
      this.prevUnsure = parsed;
      if (!same) parsed = null;
    } else this.prevUnsure = null;
    if (parsed) { this.lastOk = now; this.status = "tracking"; }
    const decision = this.feed(parsed);
    if (parsed && ACCEPTED.has(decision) && glyphs.length) this.reader.confirm(glyphs);
    const el = this.elapsed(now), g = this.gained();
    if (g !== null && (!this.history.length || el - this.history[this.history.length - 1][0] >= 5)) {
      this.history.push([el, g]); if (this.history.length > 80) this.history.shift();
    }
    const mrow = this.mesoReader ? this.tickMeso(now, getFrame) : null;
    const row = { time: new Date(now).toISOString(), text: text || "", exp: parsed?.[0] ?? "",
                  pct: parsed?.[1] ?? "", decision, gained: g === null ? "" : Math.round(g),
                  mesoText: mrow?.text ?? "", meso: mrow?.value ?? "", mesoDecision: mrow?.decision ?? "" };
    this.log.push(row); if (this.log.length > 20000) this.log.shift();
    return row;
  }
  /** The meso total, if the Item Inventory window is open. */
  tickMeso(now, getFrame) {
    if (!this.mesoBox || (now - this.mesoOk > 4000 && now - this.mesoSearch > 4000)) {
      this.mesoSearch = now;
      const full = getFrame(null);
      const box = full ? findMeso(full, this.mesoReader) : null;
      // A field we can see but not read yet: ask the user to type it once.
      this.mesoUnreadable = !box && !!full && mesoFields(full).length > 0;
      if (!box) return null;
      this.mesoUnreadable = false;
      this.mesoBox = box; this.mesoOk = now;
    }
    const img = getFrame(this.mesoBox);
    if (!img) return null;
    const r = readMeso(img, this.mesoReader), value = parseMeso(r.text);
    if (value !== null) { this.mesoOk = now; this.mesoSeen = true; }
    const decision = this.meso.update(value, r.sure);
    if (value !== null && r.sure && ACCEPTED.has(decision)) this.mesoReader.confirm(r.glyphs);
    return { text: r.text || "", value: value ?? "", decision };
  }
  teachMeso(getFrame, typed) {
    const digits = String(typed).replace(/\D/g, "");
    if (!digits) return "Type the number shown in the inventory, like 2,668,039.";
    let box = this.mesoBox;
    if (!box) {
      const full = getFrame(null);
      const fields = full ? mesoFields(full) : [];
      box = fields[0];
    }
    if (!box) return "Couldn't find the inventory's meso field. Open the Item Inventory window so it's visible.";
    const img = getFrame(box);
    const inv = new Uint8ClampedArray(img.data.length);
    for (let i = 0; i < inv.length; i += 4) {
      inv[i] = 255 - img.data[i]; inv[i + 1] = 255 - img.data[i + 1]; inv[i + 2] = 255 - img.data[i + 2]; inv[i + 3] = 255;
    }
    if (!this.mesoReader.teach({ w: img.w, h: img.h, data: inv }, digits))
      return "That doesn't match the number of digits I see. Check the number and try again.";
    this.mesoBox = box; this.mesoOk = Date.now();
    return null;
  }
  feed(parsed) {
    if (parsed && this.mode === null) {
      this.votes.push(parsed[0] !== null ? "amount" : "pct");
      if (this.votes.length < 3) return "wait-mode";
      const a = this.votes.filter(v => v === "amount").length;
      this.mode = a * 2 >= this.votes.length ? "amount" : "pct";
    }
    if (this.mode === "amount") return this.exp.update(parsed && parsed[0] !== null ? parsed : null);
    if (this.mode === "pct") {
      const before = this.pct.offset;
      const d = this.pct.update(parsed ? parsed[1] : null);
      if (this.pct.offset !== before && this.pct.level) this.onLevel(this.pct.level);
      return d;
    }
    return "unreadable";
  }
  snapshot(now = Date.now()) {
    const el = this.elapsed(now), hrs = el / 3600, settled = el >= 60, g = this.gained();
    let level = null, pct = null;
    if (this.mode === "amount" && this.exp.last) { level = levelFromAmount(...this.exp.last); pct = this.exp.last[1]; }
    if (this.mode === "pct" && this.pct.last !== null) { level = this.pct.level; pct = this.pct.last; }
    const expHr = settled && g !== null ? g / hrs : null;
    let nowHr = null;
    if (g !== null && this.history.length) {
      const old = this.history.find(h => el - h[0] <= 300);
      if (old && el - old[0] >= 60) nowHr = (g - old[1]) / ((el - old[0]) / 3600);
    }
    const pctHr = this.mode === "pct" && settled ? this.pct.pctGained / hrs : null;
    let eta = null;
    const req = level ? expToNext(level) : null, rate = nowHr || expHr;
    if (req && pct !== null && rate > 0) eta = (100 - pct) / 100 * req / rate * 3600;
    else if (pct !== null && pctHr > 0) eta = (100 - pct) / pctHr * 3600;
    const mesos = this.mesoSeen ? this.meso.gained : null;
    const mesoVisible = !!this.mesoBox && now - this.mesoOk < 6000;
    return {
      mesos, mesoHr: settled && mesos !== null ? mesos / hrs : null, mesoTotal: this.meso.last,
      mesoSpent: this.meso.spent, mesoVisible, mesoTracking: !!this.mesoReader,
      mesoNeedsTeach: !!this.mesoUnreadable && !mesoVisible,
      running: !!this.running, status: this.status, elapsed: el, mode: this.mode,
      exp: g, expHr, nowHr, pctHr, level, pct, eta,
      needsLevel: this.mode === "pct" && !this.pct.startLevel,
      levels: this.mode === "amount" ? this.exp.levels : this.pct.levels,
      lost: (this.mode === "amount" ? this.exp.lost : this.pct.lost) || 0,
      stale: this.running && now - this.lastOk > 15000,
    };
  }
}
