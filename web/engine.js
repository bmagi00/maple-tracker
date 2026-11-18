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
export function locateReadout(img, run, reader, diagonal = false, thicken = 0) {
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
  // A stretched picture (a small game filling a big or Retina screen) makes
  // thin grey strokes that fall apart into specks: thicken them so each
  // digit holds together.
  let m = mask;
  for (let k = 0; k < thicken; k++) m = morph(m, band.w, band.h, true);
  const dh = 0.55 * th;   // HUD digits are about half the tile height
  const glyphs = components(m, band.w, band.h, diagonal)
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
  // A '%' drawn thin can fall into small pieces that the size filter
  // drops: let a word take in small pieces right after it on its line.
  if (thicken) {
    const bits = components(m, band.w, band.h, diagonal).filter(c => c.h < 1.6 * dh && c.w < 1.2 * dh).sort((a, b) => a.x - b.x);
    for (const wd of words) {
      for (const c of bits) {
        if (c.x < wd.x1 || c.x - wd.x1 > 0.5 * dh) continue;
        if (Math.abs(c.y + c.h / 2 - wd.cy) > 0.6 * dh) continue;
        wd.x1 = Math.max(wd.x1, c.x + c.w);
      }
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
    // Walk left one character at a time over the amount ("441,495"),
    // allowing the comma's gap; stop at the label ("EXP.", taller and
    // bolder) or a wider gap.
    const before = words.slice(0, i).filter(p => Math.abs(p.cy - wd.cy) <= 0.5 * dh).flatMap(p => p.items)
      .sort((p, q) => p.x - q.x);
    let right = wd.x0, gapLimit = 2.5 * dh;           // first gap: the '[' sits there
    for (let k = before.length - 1; k >= 0; k--) {
      const c = before[k], gap = right - (c.x + c.w);
      if (gap > gapLimit) break;
      const dhgt = Math.abs(c.h - h0);
      const hOk = dhgt <= Math.max(1, 0.12 * h0) || (dhgt <= Math.max(1, 0.25 * h0) && digitLike(c));
      if (!hOk) break;
      left = c.x; right = c.x;
      top = Math.min(top, c.y); bot = Math.max(bot, c.y + c.h);
      gapLimit = 1.3 * dh;                            // between digits, a comma at most
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
  // The bar is nearly always in the lower part of the picture, and its
  // tiles aren't tiny: prefer those (busy maps have plenty of orange).
  const rank = r => { const s = lvLabelScore(img, r); return s <= 0 ? 0 : s + 0.6 * (r[1] / img.h) + (r[3] >= 11 ? 0.2 : 0); };
  const scored = runs.map(r => [rank(r), r]).sort((a, b) => b[0] - a[0]);
  Object.assign(why, { frame: `${img.w}x${img.h}`, orange: runs.length,
                       lvTiles: scored.filter(s => s[0] > 0).length, tried: [] });
  let pctOnly = null;
  for (const [score, run] of scored.slice(0, 6)) {
    if (score <= 0) break;
    // Stream video: blurry digits, pieces touch at edges. The game window
    // itself: crisp 1-pixel digits whose strokes only meet at corners.
    // Last: thickened strokes (stretched pictures), more for bigger HUDs.
    const passes = [[false, 0], [true, 0], [false, 1], ...(run[3] >= 20 ? [[false, 2]] : [])];
    for (const [diagonal, thicken] of passes) {
      const box = locateReadout(img, run, reader, diagonal, thicken);
      // Only accept a spot whose numbers actually read as an EXP readout,
      // so look-alikes elsewhere on screen are skipped.
      const text = box ? reader.read(crop(img, ...box)).text : null;
      why.tried.push({ tiles: run, box, text });
      const p = box && parseHudText(text);
      if (!p) continue;
      if (p[0] !== null) return { tiles: run, exp: box };
      // Only the %: fine for a HUD that shows only the %, but keep looking
      // for a reading with the EXP amount first.
      pctOnly ||= { tiles: run, exp: box };
    }
  }
  return pctOnly;
}

/** Is the shared picture this tracker's own page? (Sharing the screen the
 *  browser is on, instead of the one with the game.) The page is mostly two
 *  slate colours that game maps don't cover so evenly. */
export function looksLikeTracker(img) {
  // (generous: Mac screen capture shifts colours a little)
  const { w, h, data } = img, near = (r, g, b, R, G, B) => Math.abs(r - R) <= 14 && Math.abs(g - G) <= 14 && Math.abs(b - B) <= 16;
  let n = 0, hit = 0;
  for (let y = 0; y < h; y += 6) for (let x = 0; x < w; x += 6) {
    const i = (y * w + x) * 4, r = data[i], g = data[i + 1], b = data[i + 2];
    n++;
    if (near(r, g, b, 31, 38, 50) || near(r, g, b, 42, 51, 66) || near(r, g, b, 35, 43, 56)) hit++;
  }
  return n > 0 && hit / n > 0.35;
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

/** Read the meso field: invert (dark digits -> light) and match. The
 *  field is wide and the number small, so trim to the digits first. */
export function readMeso(img, reader) {
  let x0 = img.w, x1 = -1;
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
    const i = (y * img.w + x) * 4;
    if (Math.min(img.data[i], img.data[i + 1], img.data[i + 2]) < 200) { if (x < x0) x0 = x; if (x > x1) x1 = x; }
  }
  if (x1 > x0 && x1 - x0 < img.w - 6) img = crop(img, Math.max(0, x0 - 3), 0, Math.min(img.w, x1 + 4) - Math.max(0, x0 - 3), img.h);
  const plain = invert(img, 1);
  const r = reader.read(plain);
  if (parseMeso(r.text) !== null) return r;
  // A scaled-up or blurry picture turns the thin strokes light grey and
  // broken: try again with the contrast turned up.
  const strong = reader.read(invert(img, 2.2));
  return parseMeso(strong.text) !== null ? strong : r;
}
/** Dark-on-white to light-on-dark, with optional contrast boost. */
function invert(img, gain) {
  const n = img.w * img.h, m = new Uint8Array(n);
  for (let i = 0; i < n; i++) m[i] = Math.min(img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2]);
  const bg = percentileOfBytes(m, 80);
  const inv = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const v = gain === 1 ? 255 - Math.max(img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2])   // as before
      : Math.max(0, Math.min(255, (bg - m[i]) * gain + 255 - bg));
    inv[i * 4] = inv[i * 4 + 1] = inv[i * 4 + 2] = v; inv[i * 4 + 3] = 255;
  }
  return { w: img.w, h: img.h, data: inv };
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
  /** All labels, best first: [[char, score], ...] */
  rank(vec) {
    const sh = shifted(vec), best = {};
    for (const [c, t] of this.tpl) {
      let m = -1;
      for (const s of sh) { let d = 0; for (let i = 0; i < t.length; i++) d += s[i] * t[i]; if (d > m) m = d; }
      if (!(c in best) || m > best[c]) best[c] = m;
    }
    return Object.entries(best).sort((a, b) => b[1] - a[1]);
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
    this.level = null;    // known level: worked out once, then +1 per level-up
  }
  static req(exp, pct) { return pct >= 0.5 ? exp / (pct / 100) : null; }
  static tol(...p) { return p.reduce((a, x) => a + (x ? 0.006 / x : 0), 0) + 0.001; }
  fits(exp, pct, req, reqPct) {
    const r = ExpTracker.req(exp, pct);
    if (r === null || req === null) return null;
    return Math.abs(r - req) / req <= ExpTracker.tol(pct, reqPct);
  }
  snap() { return [this.last, this.req, this.reqPct, this.gained, this.lost, this.levels, this.level]; }
  restore(s) { [this.last, this.req, this.reqPct, this.gained, this.lost, this.levels, this.level] = s; }
  setLast(r, newLevel = false) {
    const [exp, pct] = r; this.last = r; const q = ExpTracker.req(exp, pct);
    // Work the level out from the amount only when the % is big enough to
    // tell levels apart (just after a level-up, 0.3% fits several levels).
    if (this.level === null && pct >= 2) this.level = levelFromAmount(exp, pct);
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
      this.gained += le; this.levels++;
      this.level = this.level !== null ? this.level + 1 : null;
      this.setLast(latest, true); return "level-up";
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
    // A total that suddenly has 2+ fewer (or more) digits is almost always
    // a misread (part of the number hidden or blurred): it must hold for a
    // good while before it's believed.
    const odd = this.last !== null && Math.abs(String(v).length - String(this.last).length) >= 2;
    if (this.pending.length < (odd ? 12 : this.CONFIRM)) return `wait-${why}`;
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
  static RATE_START = 15;   // seconds before the first per-hour estimate
  constructor(reader, { level = null, onLevel = () => {}, mesoReader = null, feedReader = null } = {}) {
    this.reader = reader; this.onLevel = onLevel; this.startLevel = level;
    this.mesoReader = mesoReader;
    // The pickup messages (bottom right): mesos without the inventory open.
    this.feedReader = feedReader ? new FeedReader(feedReader) : null;
    this.feedOk = 0; this.feedObs = [];
    this.hud = null; this.status = "idle"; this.lastOk = 0; this.lastSearch = 0;
    this.mesoBox = null; this.mesoOk = 0; this.mesoSearch = 0; this.mesoSeen = false;
    this.prevUnsure = null; this.log = [];
    this.reset();
  }
  reset() {
    this.resetCount = (this.resetCount || 0) + 1;
    // A new saved session: its id, when it began, and what happened in it.
    this.id = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    this.events = []; this.startedWall = null;
    this.levelStart = null; this.pctStart = null; this.lastDecile = null;
    this.announced = false; this.lostAnnounced = false;
    this.meso = new MesoTracker();
    // Mesos gained this session from either source: the inventory total
    // while it's visible, the pickup messages while it isn't.
    this.mesoGained = 0; this.mesoFromFeed = 0; this.mesoFromInv = 0; this.feedSeen = false;
    this.pickups = new FeedTracker();
    this.exp = new ExpTracker(); this.pct = new PctTracker(this.startLevel);
    this.mode = null; this.votes = []; this.history = [];
    this.elapsedBanked = 0; this.startedAt = this.running ? Date.now() : null;
    if (this.running) { this.startedWall = Date.now(); this.event(this.startedWall, "start", "Started a new session"); }
  }
  start(now = Date.now()) {
    if (this.running) return;
    if (this.startedWall === null) { this.startedWall = now; this.event(now, "start", "Started tracking"); }
    else this.event(now, "pause", "Resumed");
    this.exp.last = null; this.exp.pending = [];
    this.meso.last = null; this.meso.pending = [];
    this.pct.last = null; this.pct.pending = []; this.pct.undo = null;
    this.running = true; this.startedAt = now; this.lastOk = now;
  }
  stop(now = Date.now()) {
    if (!this.running) return;
    this.event(now, "pause", "Paused");
    this.elapsedBanked += (now - this.startedAt) / 1000; this.startedAt = null; this.running = false;
  }
  elapsed(now = Date.now()) {
    return this.elapsedBanked + (this.startedAt ? (now - this.startedAt) / 1000 : 0);
  }
  setLevel(level) {
    this.startLevel = level; this.pct.setLevel(level);
    if (this.levelStart === null || this.mode === "pct") this.levelStart = this.pct.startLevel;
  }

  /** Something worth showing in the session log. */
  event(now, kind, text) {
    this.events.push({ t: now, kind, text });
    if (this.events.length > 500) this.events.shift();
  }
  currentLevel() {
    if (this.mode === "amount" && this.exp.last) return this.exp.level ?? levelFromAmount(...this.exp.last);
    if (this.mode === "pct") return this.pct.level;
    return null;
  }
  currentPct() {
    if (this.mode === "amount" && this.exp.last) return this.exp.last[1];
    if (this.mode === "pct") return this.pct.last;
    return null;
  }
  /** The summary kept in the saved-sessions history. */
  record(now = Date.now()) {
    if (this.startedWall === null) return null;
    const g = this.gained();
    return {
      id: this.id, start: this.startedWall, end: now, played: Math.round(this.elapsed(now)),
      levelStart: this.levelStart, levelEnd: this.currentLevel(),
      pctStart: this.pctStart, pctEnd: this.currentPct(),
      exp: g === null ? null : Math.round(g),
      pctGained: this.mode === "pct" ? Math.round(this.pct.pctGained * 100) / 100 : null,
      mesos: this.mesoSeen || this.feedSeen ? this.mesoGained : null, mesoSpent: this.meso.spent || 0,
      levelUps: this.mode === "amount" ? this.exp.levels : this.pct.levels,
      expLost: Math.round((this.mode === "amount" ? this.exp.lost : this.pct.lost) || 0),
    };
  }
  /** Turn a tracker decision into session-log entries. */
  noteDecision(now, decision, lostBefore) {
    const fmtN = n => Math.round(n).toLocaleString("en-US");
    const lv = this.currentLevel(), pct = this.currentPct();
    if (pct === null) return;
    if (!this.announced && ACCEPTED.has(decision)) {
      this.announced = true;
      this.levelStart = this.levelStart ?? lv; this.pctStart = pct;
      this.lastDecile = Math.floor(pct / 10);
      this.event(now, "info", lv ? `Tracking level ${lv} from ${pct.toFixed(2)}%` : `Tracking from ${pct.toFixed(2)}%`);
      return;
    }
    if (decision === "undo") {
      // The last level-up or death was a misread after all.
      for (let i = this.events.length - 1; i >= 0; i--)
        if (this.events[i].kind === "level" || this.events[i].kind === "death") { this.events.splice(i, 1); break; }
      this.lastDecile = Math.floor(pct / 10);
      return;
    }
    if (decision === "level-up") {
      this.event(now, "level", lv ? `Level up! Now level ${lv}` : "Level up!");
      this.lastDecile = Math.floor(pct / 10);
      return;
    }
    if (decision === "death") {
      const lostNow = (this.mode === "amount" ? this.exp.lost : this.pct.lost) || 0;
      const d = lostNow - lostBefore;
      this.event(now, "death", d > 0 ? `Died: lost ${fmtN(d)} EXP` : "Died");
      this.lastDecile = Math.floor(pct / 10);
      return;
    }
    const dec = Math.floor(pct / 10);
    if (this.lastDecile !== null && dec > this.lastDecile && ACCEPTED.has(decision)) {
      this.event(now, "milestone", `Reached ${dec * 10}%${lv ? ` of level ${lv}` : ""}`);
    }
    if (ACCEPTED.has(decision)) this.lastDecile = Math.max(this.lastDecile ?? dec, dec);
  }
  relocate() { this.hud = null; this.lastSearch = 0; }
  gained() { return this.mode === "amount" ? this.exp.gained : this.pct.gained; }

  /** getFrame(box|null) -> image of that box (or the whole frame). */
  tick(now, getFrame) {
    if (!this.running) return null;
    const lost = now - this.lastOk > 6000;
    if (lost && this.hud && !this.lostAnnounced) {
      this.lostAnnounced = true;
      this.event(now, "lost", "Can't see the EXP numbers; looking for the HUD");
    }
    if (!this.hud || (lost && now - this.lastSearch > 5000)) {
      this.status = "searching"; this.lastSearch = now;
      const full = getFrame(null);
      if (!full) { this.miss = "No picture from the shared window yet."; return null; }
      const why = {};
      const hud = findHud(full, this.reader, why);
      this.selfShare = !hud && looksLikeTracker(full);
      if (!hud) {
        this.miss = this.selfShare ? "The shared picture shows this tracker, not the game." : explainMiss(why);
        const row = { time: new Date(now).toISOString(), text: why.tried[0]?.text || "", exp: "", pct: "",
                      decision: "hud-not-found", gained: "", mesoText: "", meso: "", mesoDecision: "",
                      note: `${why.frame}; orange ${why.orange}; LV tiles ${why.lvTiles}; tried ${JSON.stringify(why.tried)}` };
        this.log.push(row); if (this.log.length > 20000) this.log.shift();
        return row;
      }
      this.miss = null;
      this.event(now, "hud", this.hadHud ? "Found the HUD again" : "Found the HUD");
      this.hadHud = true; this.lostAnnounced = false;
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
    const lostBefore = (this.mode === "amount" ? this.exp.lost : this.pct.lost) || 0;
    const decision = this.feed(parsed);
    this.noteDecision(now, decision, lostBefore);
    if (parsed && ACCEPTED.has(decision) && glyphs.length) this.reader.confirm(glyphs);
    const el = this.elapsed(now), g = this.gained();
    if (g !== null && (!this.history.length || el - this.history[this.history.length - 1][0] >= 5)) {
      this.history.push([el, g]); if (this.history.length > 80) this.history.shift();
    }
    const mrow = this.mesoReader ? this.tickMeso(now, getFrame) : null;
    const row = { time: new Date(now).toISOString(), text: text || "", exp: parsed?.[0] ?? "",
                  pct: parsed?.[1] ?? "", decision, gained: g === null ? "" : Math.round(g),
                  mesoText: mrow?.text ?? "", meso: mrow?.value ?? "", mesoDecision: mrow?.decision ?? "",
                  pickups: this.feedObs.map(o => `${o.slot}:${o.type}${o.value ?? "?"}`).join(" "), pickupMesos: this.mesoFromFeed };
    this.log.push(row); if (this.log.length > 20000) this.log.shift();
    return row;
  }
  /** The meso total, if the Item Inventory window is open. */
  tickMeso(now, getFrame) {
    if ((!this.mesoBox || now - this.mesoOk > 4000) && now - this.mesoSearch > 4000) {
      // (a full-picture search: at most every 4 seconds)
      this.mesoSearch = now;
      const full = getFrame(null);
      const box = full ? findMeso(full, this.mesoReader) : null;
      // A field we can see but not read yet: ask the user to type it once.
      this.mesoUnreadable = !box && !!full && mesoFields(full).length > 0;
      if (!box) return null;
      this.mesoUnreadable = false;
      this.mesoBox = box; this.mesoOk = now;
    }
    if (!this.mesoBox) return null;
    const img = getFrame(this.mesoBox);
    if (!img) return null;
    const r = readMeso(img, this.mesoReader), value = parseMeso(r.text);
    if (value !== null) {
      // Back after being hidden while the pickups were being counted: those
      // pickups are already in, so start again from the new total.
      if (this.feedSeen && this.mesoOk && now - this.mesoOk > 3000) { this.meso.last = null; this.meso.pending = []; }
      this.mesoOk = now; this.mesoSeen = true;
    }
    const before = { gained: this.meso.gained, spent: this.meso.spent };
    const decision = this.meso.update(value, r.sure);
    if (value !== null && r.sure && ACCEPTED.has(decision)) this.mesoReader.confirm(r.glyphs);
    const fmtN = n => Math.round(n).toLocaleString("en-US");
    if (decision === "spent") this.event(now, "meso", `Spent ${fmtN(this.meso.spent - before.spent)} mesos`);
    const got = this.meso.gained - before.gained;
    this.mesoGained += got; this.mesoFromInv += got;
    if (got >= 1000) this.event(now, "meso", `+${fmtN(got)} mesos`);
    return { text: r.text || "", value: value ?? "", decision };
  }
  /** Pickup messages: called often (about 10 times a second). */
  inventoryVisible(now) { return !!this.mesoBox && now - this.mesoOk < 2500; }
  tickFeed(now, getFrame) {
    if (!this.running || !this.feedReader) return null;
    const fr = this.feedReader;
    const full = () => getFrame(null);
    if (!fr.anchor) {
      if (now - fr.lastSearch < 1000) return null;     // about 0.15 s of work each try
      fr.lastSearch = now;
      const img = full();
      if (!img || !fr.locate(img)) return null;
      this.event(now, "hud", "Found the pickup messages");
    } else if (now - this.feedOk > 30000 && now - fr.lastSearch > 10000) {
      // Nothing for a while: maybe the window moved. Look again (keep the
      // old spot unless a new one turns up).
      fr.lastSearch = now;
      const keep = fr.anchor, img = full();
      if (!img || !fr.locate(img)) fr.anchor = keep;
    }
    const box = fr.box(), img = box && getFrame(box);
    if (!img) return null;
    const obs = fr.read(img);
    if (obs.length) this.feedOk = now;
    this.feedObs = obs;
    const inv = this.inventoryVisible(now), fmtN = n => Math.round(n).toLocaleString("en-US");
    for (const ev of this.pickups.update(now, obs)) {
      let d = 0;
      if (ev.type === "meso" && ev.value !== null) d += ev.value;
      if (ev.corrected?.type === "meso" && ev.corrected.value !== null) d -= ev.corrected.value;
      if (!d) continue;
      this.feedSeen = true;
      if (inv) continue;                 // the inventory total counts it
      this.mesoGained += d; this.mesoFromFeed += d;
      if (d >= 1000) this.event(now, "meso", `+${fmtN(d)} mesos`);
    }
    return obs;
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
  /** EXP, % and mesos per hour at elapsed time `el` (seconds). */
  computeRates(el, g) {
    if (el < Session.RATE_START) return { expHr: null, nowHr: null, pctHr: null, mesoHr: null };
    const hrs = el / 3600;
    const expHr = g !== null ? g / hrs : null;
    let nowHr = null;   // recent pace: the last 5 minutes (or all of it, if shorter)
    if (g !== null && this.history.length && el >= 2 * Session.RATE_START) {
      const old = this.history.find(h => el - h[0] <= 300);
      if (old && el - old[0] >= Session.RATE_START) nowHr = (g - old[1]) / ((el - old[0]) / 3600);
    }
    const pctHr = this.mode === "pct" ? this.pct.pctGained / hrs : null;
    const mesoHr = this.mesoSeen || this.feedSeen ? this.mesoGained / hrs : null;
    return { expHr, nowHr, pctHr, mesoHr };
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
    const el = this.elapsed(now), g = this.gained();
    // Per-hour rates start after 15 seconds, then update once a second.
    const step = el < Session.RATE_START ? -1 : Math.floor(el);
    if (!this.rates || this.rates.step !== step || this.rates.reset !== this.resetCount)
      this.rates = { step, reset: this.resetCount, ...this.computeRates(el, g) };
    const { expHr, nowHr, pctHr, mesoHr } = this.rates;
    let level = null, pct = null;
    if (this.mode === "amount" && this.exp.last) { level = this.exp.level ?? levelFromAmount(...this.exp.last); pct = this.exp.last[1]; }
    if (this.mode === "pct" && this.pct.last !== null) { level = this.pct.level; pct = this.pct.last; }
    let eta = null;
    const req = level ? expToNext(level) : null, rate = nowHr || expHr;
    if (req && pct !== null && rate > 0) eta = (100 - pct) / 100 * req / rate * 3600;
    else if (pct !== null && pctHr > 0) eta = (100 - pct) / pctHr * 3600;
    const mesos = this.mesoSeen || this.feedSeen ? this.mesoGained : null;
    const mesoVisible = !!this.mesoBox && now - this.mesoOk < 6000;
    const feedActive = !!this.feedReader?.anchor && now - this.feedOk < 60000;
    return {
      mesos, mesoHr, mesoTotal: this.meso.last,
      mesoSpent: this.meso.spent, mesoVisible, mesoTracking: !!this.mesoReader,
      feedActive, mesoFromFeed: this.mesoFromFeed, mesoFromInv: this.mesoFromInv,
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

// ------------------------------------------------------- pickup messages
//
// Bottom-right of the game, the game writes a line for every pickup and
// kill, newest at the bottom, pushing older lines up:
//     You received EXP (+25)
//     Bonus EXP for PARTY (+8)
//     You have gained mesos (+11)
// Lines are right-aligned, light text with a dark outline, see-through over
// the map. Each stays bright for about a second, then fades out.

/** Text-likeness of every pixel: bright, with a dark outline close by, and
 *  brighter than the map behind it on that row. */
export function feedInk(img) {
  const { w, h, data } = img, n = w * h;
  const L = new Float32Array(n), sat = new Float32Array(n), hue = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const r = data[j], g = data[j + 1], b = data[j + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    L[i] = mx; sat[i] = mx ? (mx - mn) / mx : 0;
    // The game writes these lines in white or yellow: red and green about
    // equal. Tan rock, wood and skin have much more red than green.
    hue[i] = Math.min(1, Math.max(0, 1 - (r - g - 18) / 24));
  }
  // 5x5 minimum (horizontal pass, then vertical)
  const t = new Float32Array(n), mn5 = new Float32Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = 255;
    for (let k = Math.max(0, x - 2); k <= Math.min(w - 1, x + 2); k++) m = Math.min(m, L[y * w + k]);
    t[y * w + x] = m;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = 255;
    for (let k = Math.max(0, y - 2); k <= Math.min(h - 1, y + 2); k++) m = Math.min(m, t[k * w + x]);
    mn5[y * w + x] = m;
  }
  // mean along the row over 41 pixels
  const ink = new Float32Array(n), raw = new Float32Array(n), R = 20;
  const pre = new Float64Array(w + 1);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) pre[x + 1] = pre[x] + L[o + x];
    for (let x = 0; x < w; x++) {
      const a0 = Math.max(0, x - R), a1 = Math.min(w, x + R + 1);
      const mean = (pre[a1] - pre[a0]) / (a1 - a0);
      const c = L[o + x] - mn5[o + x];
      const a = Math.min(1, Math.max(0, (c - 40) / 80));
      const b = Math.min(1, Math.max(0, (L[o + x] - mean - 10) / 50));
      ink[o + x] = a * b * hue[o + x];
      raw[o + x] = c;
    }
  }
  return { w, h, ink, raw, sat, L };
}

/** Text lines in an ink map. The feed's lines all end at the same x, so
 *  find that right edge first (the commonest row end), then the rows that
 *  end there, grouped into lines. `xr` can be given once it's known. */
export function feedLines(f, xr = null) {
  const { w, h, ink, raw } = f, T = 0.4;
  // Columns lit in most rows are borders and edges, not text: skip them.
  const colRows = new Int32Array(w);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (ink[y * w + x] > T) colRows[x]++;
  const skip = new Uint8Array(w);
  for (let x = 0; x < w; x++) if (colRows[x] > 0.35 * h) for (let k = Math.max(0, x - 1); k <= Math.min(w - 1, x + 1); k++) skip[k] = 1;
  const at = (x, y) => !skip[x] && ink[y * w + x] > T;
  const rowEnd = new Int32Array(h).fill(-1), rowCount = new Int32Array(h);
  for (let y = 0; y < h; y++) {
    let c = 0;
    for (let x = 0; x < w; x++) if (at(x, y)) { c++; rowEnd[y] = x; }
    rowCount[y] = c;
  }
  if (xr === null) {
    // Candidate edges: the commonest row ends. Keep the one whose lines end
    // in a bracket, like "(+25)".
    const hist = new Float32Array(w);
    for (let y = 0; y < h; y++) if (rowCount[y] >= 3 && rowEnd[y] >= 0) hist[rowEnd[y]] += 1;
    const sm = new Float32Array(w);
    for (let x = 0; x < w; x++) for (let k = Math.max(0, x - 3); k <= Math.min(w - 1, x + 3); k++) sm[x] += hist[k];
    const peaks = [];
    for (let x = 0; x < w; x++) if (sm[x] >= 6 && (x === 0 || sm[x] >= sm[x - 1]) && (x === w - 1 || sm[x] > sm[x + 1])) peaks.push([sm[x], x]);
    peaks.sort((a, b) => b[0] - a[0]);
    let best = { xr: null, lines: [], score: 0 };
    for (const [, px] of peaks.slice(0, 5)) {
      let m = 0, c = 0;
      for (let k = Math.max(0, px - 3); k <= Math.min(w - 1, px + 3); k++) { m += k * hist[k]; c += hist[k]; }
      const r = feedLines(f, Math.round(m / c));
      const th = feedTextHeight(r.lines);
      const score = th ? r.lines.filter(l => feedEnd(f, l, th)).length : 0;
      if (score > best.score) best = { ...r, score };
    }
    return best;
  }
  // rows whose ink ends near the edge (a ')' is a few pixels wide)
  const near = new Uint8Array(h);
  for (let y = 0; y < h; y++) {
    let c = 0;
    for (let x = Math.max(0, xr - 8); x <= Math.min(w - 1, xr + 3); x++) if (at(x, y)) c++;
    near[y] = c > 0 ? 1 : 0;
  }
  const bands = [];
  for (let y = 0; y < h;) {
    if (!near[y]) { y++; continue; }
    let e = y;
    while (e + 1 < h && near[e + 1]) e++;
    bands.push([y, e + 1]); y = e + 1;
  }
  const lines = [];
  for (const [y0, y1] of bands) {
    const bh = y1 - y0;
    if (bh < 6 || bh > 60) continue;
    const col = new Int32Array(w);
    for (let y = y0; y < y1; y++) for (let x = 0; x <= Math.min(w - 1, xr + 3); x++) if (at(x, y)) col[x]++;
    let x1 = Math.min(w - 1, xr + 3);
    while (x1 >= 0 && col[x1] < 1) x1--;
    if (x1 < 0) continue;
    let x0 = x1, gap = 0;
    for (let x = x1; x >= 0; x--) {
      if (col[x] >= 1) { x0 = x; gap = 0; } else if (++gap > 0.9 * bh) break;
    }
    if (x1 - x0 < 3 * bh) continue;
    let s = 0, c = 0, st = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x <= x1; x++) if (at(x, y)) { s += raw[y * w + x]; st += f.sat[y * w + x]; c++; }
    lines.push({ y0, y1, x0, x1: x1 + 1, strength: c ? s / c : 0, sat: c ? st / c : 0, ink: c });
  }
  return { xr, lines };
}

/** The right-aligned text in rows y0..y1 ending near x = xr, or null. */
export function feedLineAt(f, y0, y1, xr) {
  const { w, h, ink, raw } = f, T = 0.4;
  y0 = Math.max(0, Math.round(y0)); y1 = Math.min(h, Math.round(y1));
  const bh = y1 - y0;
  if (bh < 4) return null;
  const col = new Int32Array(w);
  for (let y = y0; y < y1; y++) for (let x = 0; x <= Math.min(w - 1, xr + 3); x++) if (ink[y * w + x] > T) col[x]++;
  let c = 0;
  for (let x = Math.max(0, xr - 6); x <= Math.min(w - 1, xr + 3); x++) c += col[x];
  if (c < Math.max(3, 0.25 * bh)) return null;          // nothing ends here
  let x1 = Math.min(w - 1, xr + 3);
  while (x1 >= 0 && col[x1] < 1) x1--;
  let x0 = x1, gap = 0;
  for (let x = x1; x >= 0; x--) { if (col[x] >= 1) { x0 = x; gap = 0; } else if (++gap > 0.9 * bh) break; }
  if (x1 - x0 < 3 * bh) return null;
  let s = 0, n = 0, st = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x <= x1; x++) if (ink[y * w + x] > T) { s += raw[y * w + x]; st += f.sat[y * w + x]; n++; }
  return { y0, y1, x0, x1: x1 + 1, strength: n ? s / n : 0, sat: n ? st / n : 0, ink: n };
}

/** Columns lit in most rows are window edges and borders, not text (the
 *  lines end only a few pixels from the game window's edge): clear them. */
export function maskBorders(f, run = 0.6 * f.h) {
  // A border is lit in one long unbroken stretch; text columns break
  // between lines.
  const { w, h, ink } = f;
  for (let x = 0; x < w; x++) {
    let cur = 0, longest = 0;
    for (let y = 0; y < h; y++) { if (ink[y * w + x] > 0.4) { if (++cur > longest) longest = cur; } else cur = 0; }
    if (longest < run) continue;
    for (let k = Math.max(0, x - 1); k <= Math.min(w - 1, x + 1); k++) for (let y = 0; y < h; y++) ink[y * w + k] = 0;
  }
}

/** The line spacing: autocorrelation of how much text ends near the right
 *  edge, row by row, in rows top..bot. Null if there's no clear period. */
export function feedPitch(f, xr, th, top = 0, bot = f.h) {
  const x0 = Math.max(0, Math.round(xr - 4 * th)), p = [];
  for (let y = top; y < bot; y++) { let c = 0; for (let x = x0; x <= Math.min(f.w - 1, xr + 2); x++) if (f.ink[y * f.w + x] > 0.4) c++; p.push(c); }
  if (p.length < 3 * th) return null;
  const mean = p.reduce((a, b) => a + b, 0) / p.length, q = p.map(v => v - mean);
  const ac = lag => { let v = 0; for (let y = 0; y + lag < q.length; y++) v += q[y] * q[y + lag]; return v / (q.length - lag); };
  let lag = 0, best = -Infinity;
  const acs = [];
  for (let L = Math.ceil(0.9 * th); L <= Math.floor(2.2 * th); L++) { const v = ac(L); acs.push([L, v]); if (v > best) { best = v; lag = L; } }
  if (best <= 0) return null;
  // a multiple of the spacing can score as well: take the smallest strong peak
  for (let i = 1; i < acs.length - 1; i++) {
    const [L, v] = acs[i];
    if (v >= 0.8 * best && v >= acs[i - 1][1] && v >= acs[i + 1][1]) { lag = L; best = v; break; }
  }
  const a0 = ac(lag - 1), a2 = ac(lag + 1), d = a0 - 2 * best + a2;
  return d < 0 ? lag + 0.5 * (a0 - a2) / d : lag;
}

/** Typical text height of feed lines (bracket height): the median band. */
export function feedTextHeight(lines) {
  const hs = lines.map(l => l.y1 - l.y0).filter(v => v >= 8 && v <= 40).sort((a, b) => a - b);
  return hs.length ? hs[hs.length >> 1] : null;
}

/** The "(+N)" at the right end of a line. `th` is the feed's text height
 *  (from its line spacing), so every line is scaled the same way.
 *  -> {seg, boxes, open, close, inner, prefix} where open/close are the
 *  bracket boxes, inner the boxes between them, prefix the text width in
 *  front of the bracket divided by th. Null if it doesn't end in a bracket. */
export function feedEnd(f, line, th) {
  const { w, ink } = f;
  const ya = Math.max(0, Math.round((line.y0 + line.y1) / 2 - 0.62 * th)), yb = Math.min(f.h, Math.round(ya + 1.24 * th));
  const sh = yb - ya;
  const xa = Math.max(line.x0, Math.round(line.x1 - 6 * th)), sw = line.x1 - xa + 1;
  if (sw < 2 || sh < 4) return null;
  const src = new Float32Array(sw * sh);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    const xx = xa + x; src[y * sw + x] = xx < w ? ink[(ya + y) * w + xx] : 0;
  }
  const scale = NORM_H / th, bw = Math.max(1, Math.round(sw * scale)), bh = Math.round(sh * scale);
  const band = resize(src, sw, sh, bw, bh);
  const T = 0.35, col = new Int32Array(bw);
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) if (band[y * bw + x] > T) col[x]++;
  const boxes = [];
  for (let x = 0; x < bw;) {
    if (col[x] === 0) { x++; continue; }
    const s = x; while (x < bw && col[x] > 0) x++;
    let top = -1, bot = -1;
    for (let y = 0; y < bh; y++) {
      let any = false;
      for (let k = s; k < x; k++) if (band[y * bw + k] > T) { any = true; break; }
      if (any) { if (top < 0) top = y; bot = y; }
    }
    if (top >= 0 && (bot - top + 1) * (x - s) >= 9) pushSplit(s, x);
  }
  // Characters blurred together (a '3' touching its ')'): split a box that's
  // too wide at its thinnest column, if that column is clearly thinner.
  function pushSplit(s, e) {
    if (e - s > 0.72 * NORM_H) {
      let cut = -1, cv = Infinity, mx = 0;
      for (let x = s; x < e; x++) mx = Math.max(mx, col[x]);
      for (let x = s + Math.floor(0.25 * (e - s)); x <= s + Math.ceil(0.75 * (e - s)); x++) if (col[x] < cv) { cv = col[x]; cut = x; }
      if (cut > s && cut < e - 1 && cv <= 0.4 * mx) { pushSplit(s, cut); pushSplit(cut + 1, e); return; }
    }
    let top = -1, bot = -1;
    for (let y = 0; y < bh; y++) {
      let any = false;
      for (let k = s; k < e; k++) if (band[y * bw + k] > T) { any = true; break; }
      if (any) { if (top < 0) top = y; bot = y; }
    }
    if (top >= 0 && (bot - top + 1) * (e - s) >= 9) boxes.push([s, top, e - s, bot - top + 1]);
  }
  const paren = b => b[3] >= 0.7 * NORM_H && b[2] <= 0.5 * NORM_H;
  const last = boxes[boxes.length - 1];
  if (!last || !paren(last)) return null;
  // The '+' is the landmark: small, squarish, at mid height; '(' is the
  // box just before it.
  const mid = last[1] + last[3] / 2;
  const plusLike = b => b[3] >= 0.25 * NORM_H && b[3] < 0.68 * NORM_H && b[2] >= 0.22 * NORM_H && b[2] <= 0.8 * NORM_H &&
    Math.abs(b[1] + b[3] / 2 - mid) <= 0.22 * NORM_H;
  let open = -1;
  for (let i = boxes.length - 2; i >= Math.max(1, boxes.length - 9); i--) {
    if (plusLike(boxes[i]) && paren(boxes[i - 1])) { open = i - 1; break; }
  }
  if (open < 0) {
    // no '+': a line like "Lupin's Banana x1 earned. (Etc)" - '(' looks like ')'
    const twin = b => paren(b) && Math.abs(b[3] - last[3]) <= 0.18 * NORM_H && Math.abs(b[1] - last[1]) <= 0.15 * NORM_H;
    for (let i = boxes.length - 2; i >= Math.max(0, boxes.length - 6); i--) if (twin(boxes[i])) { open = i; break; }
  }
  if (open < 0) return null;
  const inner = boxes.slice(open + 1, boxes.length - 1);
  const prefix = ((xa - line.x0) + boxes[open][0] / scale) / th;
  const bottom = ya + (last[1] + last[3]) / scale;     // the ')' bottom, in pixels
  return { seg: { band, bw, bh }, boxes, open: boxes[open], close: last, inner, prefix, bottom };
}

/** Type of a feed line from the width of the text before its bracket
 *  (in text heights), which doesn't depend on the number. */
export function feedType(prefix, sat = null) {
  if (prefix >= 8.6 && prefix < 10.5) return "exp";      // You received EXP (+25)
  // Bonus EXP for PARTY (+8) is yellow, You have gained mesos (+11) white;
  // their widths are close, so the colour decides.
  if (prefix >= 10.5 && prefix < 14.0) {
    if (sat !== null) return sat < 0.25 ? "meso" : "party";
    return prefix < 12.4 ? "party" : "meso";
  }
  return "other";
}

/** Read one line: {type, value, sure, text}. */
export function readFeedLine(f, line, th, reader) {
  const e = feedEnd(f, line, th);
  if (!e) return { type: "other", value: null, sure: false, text: "", prefix: undefined };
  const small = e.inner.filter(b => b[3] < 0.75 * NORM_H);
  let tall = e.inner.filter(b => b[3] >= 0.75 * NORM_H);
  // Two digits blurred together: split at the thinnest column.
  const split = [];
  for (const b of tall) {
    if (b[2] <= 0.72 * NORM_H) { split.push(b); continue; }
    const { band, bw } = e.seg;
    let cut = -1, cv = Infinity;
    for (let x = b[0] + Math.floor(0.35 * b[2]); x <= b[0] + Math.ceil(0.65 * b[2]); x++) {
      let s = 0; for (let y = b[1]; y < b[1] + b[3]; y++) s += band[y * bw + x];
      if (s < cv) { cv = s; cut = x; }
    }
    split.push([b[0], b[1], cut - b[0], b[3]], [cut + 1, b[1], b[0] + b[2] - cut - 1, b[3]]);
  }
  tall = split;
  let text = "", sure = tall.length > 0, letters = false;
  const vecs = [];
  for (const b of tall) {
    const vec = glyphVec(e.seg, b);
    vecs.push(vec);
    let [c, score] = reader.classify(vec);
    if (c === "?") {
      // second chance for a blurry digit: the best match if it's clearly
      // ahead (never "sure" - the tracker wants it read twice)
      const r = reader.rank(vec);
      if (r[0][1] >= 0.62 && r[0][1] - (r[1]?.[1] ?? 0) >= 0.03) c = r[0][0];
      sure = false;
    }
    if (c === "E" || c === "t" || c === "c") letters = true;
    text += c;
    if (c === "?" || score < reader.SURE) sure = false;
  }
  let type = letters ? "item" : feedType(e.prefix, line.sat ?? null);
  const plus = small.length >= 1 && (!tall.length || small[0][0] < tall[0][0]);
  const value = type !== "item" && plus && /^[0-9]{1,7}$/.test(text) ? Number(text) : null;
  if (type === "other" && value === null) sure = false;
  return { type, value, sure: sure && value !== null, text: (plus ? "+" : "") + text, prefix: e.prefix, bottom: e.bottom, vecs };
}

/** Finds the pickup feed and reads its lines. Keeps where it is
 *  (right edge, text height, line spacing, bottom line) once found. */
/** Text height (bracket height) as a share of the line spacing. */
export const FEED_TH = 0.76;

export class FeedReader {
  constructor(reader) { this.reader = reader; this.anchor = null; this.samples = []; this.lastSearch = 0; this.lastSeen = 0; }
  /** Search the lower right of the picture for the feed. */
  locate(full) {
    const rx = Math.floor(full.w * 0.5), ry = Math.floor(full.h * 0.35);
    const img = crop(full, rx, ry, full.w - rx, full.h - ry);
    const f = feedInk(img);
    const r = feedLines(f);
    if (!r.xr || !r.lines.length) return null;
    const th = feedTextHeight(r.lines);
    if (!th) return null;
    const read = r.lines.map(l => ({ l, r: readFeedLine(f, l, th, this.reader) }));
    const good = read.filter(x => x.r.value !== null && x.r.type !== "other");
    if (!good.length) return null;
    const real = read.filter(x => x.r.prefix !== undefined);       // lines ending in brackets
    if (!real.length) return null;
    // Line spacing: the period of the text rows ending at the right edge
    // (which doesn't need every line to be readable).
    const xr = r.xr;
    const top = Math.max(0, Math.min(...r.lines.map(l => l.y0)) - th), bot = Math.min(f.h, Math.max(...r.lines.map(l => l.y1)) + 2 * th);
    const pitch = feedPitch(f, xr, th, top, bot) || 1.25 * th;
    // The bottom line: the lowest readable one, then further down while
    // there's text one spacing lower.
    let yb = Math.max(...real.map(x => x.r.bottom));
    for (let n = 0; n < 3; n++) {
      const l = feedLineAt(f, yb + pitch - 1.08 * FEED_TH * pitch, yb + pitch + 0.12 * FEED_TH * pitch, xr);
      if (!l || readFeedLine(f, l, FEED_TH * pitch, this.reader).prefix === undefined) break;
      yb += pitch;
    }
    const ys = [yb];
    this.anchor = { xr: rx + r.xr, th: FEED_TH * pitch, pitch, yb: ry + ys[ys.length - 1], w: full.w, h: full.h };
    this.samples = [];
    return this.anchor;
  }
  /** The box the feed lives in (frame coordinates). */
  box() {
    const a = this.anchor; if (!a) return null;
    const x0 = Math.max(0, Math.round(a.xr - 19 * a.th)), y0 = Math.max(0, Math.round(a.yb - 8.4 * a.pitch));
    // a little below the bottom line too, in case the real bottom is lower
    return [x0, y0, Math.min(a.w, Math.round(a.xr + a.th)) - x0, Math.min(a.h, Math.round(a.yb + 1.6 * a.pitch)) - y0];
  }
  /** Lines in a crop of box(): [{slot, type, value, sure, strength, text}].
   *  Line k sits k line-spacings above the bottom line. */
  read(img) {
    const a = this.anchor, [bx, by] = this.box();
    const f = feedInk(img), xr = Math.round(a.xr - bx);
    maskBorders(f, 2 * a.pitch);
    let out = [];
    for (let k = -1; k < 8; k++) {
      const yb = a.yb - by - k * a.pitch;
      const l = feedLineAt(f, yb - 1.08 * a.th, yb + 0.12 * a.th, xr);
      if (!l) continue;
      out.push({ slot: k, strength: l.strength, ...readFeedLine(f, l, a.th, this.reader) });
    }
    // A real line below the bottom: the bottom is lower than we thought.
    if (out.some(o => o.slot === -1 && o.type !== "other" && o.prefix !== undefined)) {
      a.yb += a.pitch; out.forEach(o => o.slot++);
    }
    out = out.filter(o => o.slot >= 0).sort((p, q) => q.slot - p.slot);
    // Busy moments (4+ lines) measure the spacing well: keep the median.
    if (out.filter(o => o.prefix !== undefined).length >= 4) {
      const pp = feedPitch(f, xr, a.th);
      if (pp && Math.abs(pp / a.pitch - 1) < 0.15) {
        this.samples.push(pp); if (this.samples.length > 60) this.samples.shift();
        if (this.samples.length >= 3) {
          const srt = this.samples.slice().sort((x, y) => x - y), m = srt[srt.length >> 1];
          a.pitch = m; a.th = FEED_TH * m;
        }
      }
    }
    // Fine-tune the bottom from where the bottom line's ')' really is.
    // (The spacing found when locating is kept: it's measured over many rows.)
    for (const o of out) {
      if (o.slot !== 0 || o.type === "other" || o.bottom === undefined) continue;
      const off = by + o.bottom - a.yb;
      if (Math.abs(off) <= 0.3 * a.pitch) a.yb += 0.1 * off;
    }
    if (out.length) this.lastSeen = Date.now();
    return out;
  }
}

/** Follows the feed's lines as new ones push them up, so every pickup is
 *  counted once. A line keeps its place until something new arrives below
 *  it; it is bright for about a second, then fades. Each update decides how
 *  many new lines arrived since the last look, by which story fits best. */
export class FeedTracker {
  constructor() {
    this.stack = [];          // bottom first: {type, value, reads, last, seen, miss, counted}
    this.ref = null;          // brightness of a fresh line
    this.cap = 99;            // most lines the game shows at once
    this.mesos = 0; this.kills = 0; this.items = 0; this.missed = 0; this.unsure = 0;
    this.nextId = 1;
  }
  fresh() { return this.ref ? 0.82 * this.ref : 0; }
  update(now, obs) {
    for (const o of obs) {
      if (this.ref === null || o.strength > this.ref) this.ref = o.strength;
      else this.ref -= (this.ref - o.strength) * 0.002;
    }
    const bySlot = new Map(obs.map(o => [o.slot, o]));
    const top = obs.length ? Math.max(...obs.map(o => o.slot)) : -1;
    // the most lines the game shows at once: learnt from what we see
    if (obs.length) this.cap = this.cap === 99 ? top + 1 : Math.max(this.cap, top + 1);
    const fresh = this.fresh(), events = [];
    let k = 0;
    const first = !this.stack.length && !this.started && obs.length > 0;
    if (obs.length) this.started = true;
    if (!this.stack.length) k = top + 1;
    else {
      let best = Infinity;
      for (let kk = 0; kk <= Math.min(10, top + 1); kk++) {
        let cost = 0.4 * kk;
        for (let j = 0; j < kk; j++) {
          const o = bySlot.get(j);
          if (!o) cost += 2; else if (o.strength < fresh) cost += 1;
        }
        this.stack.forEach((t, i) => {
          const o = bySlot.get(i + kk);
          if (o) {
            const sameValue = o.value !== null && t.value !== null && o.value === t.value;
            // a faded line's type is less certain; the same number is a good sign
            if (o.type !== "other" && t.type !== "other" && o.type !== t.type) cost += sameValue ? 0.5 : o.strength >= fresh ? 3 : 1.5;
            if (o.value !== null && t.value !== null && o.value !== t.value) cost += o.sure && o.strength >= fresh ? 2 : 0.7;
            // lines only fade: one that got brighter is a new line
            const up = (o.strength - t.last) / (this.ref || 150);
            if (up > 0.1) cost += 3; else if (up > 0.065) cost += 1.5;
          } else if (i + kk < this.cap) {
            cost += t.last >= fresh && now - t.seen < 700 ? 1 : 0.2;
          }
        });
        // Lines above everything we know about: an old faded line is fine,
        // but new lines only ever appear at the bottom.
        for (const o of obs) if (o.slot >= kk + this.stack.length) cost += o.strength >= fresh ? 3 : 1;
        if (this.debug) this.debug.push(`k${kk}=${cost.toFixed(1)}`);
        if (cost < best - 1e-9) { best = cost; k = kk; }
      }
    }
    // new lines (slot k-1 is the oldest of them)
    const added = [];
    for (let j = k - 1; j >= 0; j--) added.push({ id: this.nextId++, type: "other", value: null, sureValue: false,
      reads: [], typeVotes: {}, valueVotes: {}, last: Infinity, seen: now, born: now, miss: 0, counted: false,
      before: first });    // on screen when tracking began: picked up before it
    this.stack = added.reverse().concat(this.stack);
    // update every line with what's in its slot now: its type and value
    // are a vote over all its readings (bright, sure ones count more)
    this.stack.forEach((t, i) => {
      const o = bySlot.get(i);
      if (!o) { t.miss++; return; }
      t.miss = 0; t.seen = now; t.last = o.strength;
      if (o.strength >= fresh) t.bright = true;
      const w = (o.sure ? 2 : 1) * (o.strength >= fresh ? 1 : 0.5);
      if (o.type !== "other") {
        t.typeVotes[o.type] = (t.typeVotes[o.type] || 0) + w;
        if (o.value !== null) { const key = `${o.type}|${o.value}`; t.valueVotes[key] = (t.valueVotes[key] || 0) + w; }
        if (o.value !== null && o.strength >= 0.95 * fresh) t.brightRead = true;
      }
      t.reads.push(o.value);
      const type = Object.entries(t.typeVotes).sort((a, b) => b[1] - a[1])[0]?.[0] || "other";
      const vals = Object.entries(t.valueVotes).filter(([k]) => k.startsWith(type + "|")).sort((a, b) => b[1] - a[1]);
      t.type = type;
      t.value = vals.length ? Number(vals[0][0].split("|")[1]) : null;
      t.sureValue = vals.length > 0 && vals[0][1] >= 2.5;
      if (t.before) return;
      if (t.counted) { const ev = this.recount(t); if (ev) events.push(ev); }
      else if (t.type === "item" ? (t.typeVotes.item || 0) >= 1.5 : (t.sureValue && t.type !== "other")) events.push(this.count(t, false));
    });
    // lines that have faded away: drop from the top
    while (this.stack.length) {
      const t = this.stack[this.stack.length - 1];
      if (t.miss >= 2 || now - t.seen > 3000) {
        this.stack.pop();
        if (!t.counted && !t.before) {
          // Count a doubtful line only if it was seen bright (new lines are);
          // a line only ever seen faded is an old one seen again.
          // ...and only if its number had real support: one sure, bright
          // reading or two that agree. A one-off blurry reading is dropped.
          const support = t.value === null ? 0 : (t.valueVotes[`${t.type}|${t.value}`] || 0);
          if (t.type !== "other" && (t.type === "item" || (support >= 2 && t.brightRead))) events.push(this.count(t, true));
          else if (t.bright && t.type !== "other") this.missed++;
        }
      } else break;
    }
    return events.filter(Boolean);
  }
  /** Add a line to the totals (remembering what was added). */
  count(t, unsure) {
    t.counted = { type: t.type, value: t.value };
    if (unsure) this.unsure++;
    this.apply(t.type, t.value, +1);
    return { id: t.id, type: t.type, value: t.value, unsure };
  }
  /** A counted line whose vote changed: take back the old, add the new. */
  recount(t) {
    const c = t.counted;
    if (c.type === t.type && c.value === t.value) return null;
    if (t.type !== "item" && !t.sureValue) return null;
    this.apply(c.type, c.value, -1); this.apply(t.type, t.value, +1);
    t.counted = { type: t.type, value: t.value };
    return { id: t.id, type: t.type, value: t.value, corrected: c };
  }
  apply(type, value, sign) {
    if (type === "meso" && value !== null) this.mesos += sign * value;
    if (type === "exp") this.kills += sign;
    if (type === "item") this.items += sign;
  }
}

/** Every character of a line (for item names): the whole line scaled so
 *  the text is NORM_H tall, cut into character boxes, plus the gaps
 *  between them in NORM_H units. -> {seg, boxes, gaps} */
export function lineGlyphs(f, line, th) {
  const { w, ink } = f;
  const ya = Math.max(0, Math.round((line.y0 + line.y1) / 2 - 0.62 * th)), yb = Math.min(f.h, Math.round(ya + 1.24 * th));
  const sh = yb - ya, xa = Math.max(0, line.x0 - 2), sw = Math.min(w, line.x1 + 1) - xa;
  if (sw < 2 || sh < 4) return null;
  const src = new Float32Array(sw * sh);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) src[y * sw + x] = ink[(ya + y) * w + xa + x];
  const scale = NORM_H / th, bw = Math.max(1, Math.round(sw * scale)), bh = Math.round(sh * scale);
  const band = resize(src, sw, sh, bw, bh);
  const T = 0.35, col = new Int32Array(bw);
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) if (band[y * bw + x] > T) col[x]++;
  const boxes = [];
  for (let x = 0; x < bw;) {
    if (col[x] === 0) { x++; continue; }
    const s = x; while (x < bw && col[x] > 0) x++;
    let top = -1, bot = -1;
    for (let y = 0; y < bh; y++) {
      let any = false;
      for (let k = s; k < x; k++) if (band[y * bw + k] > T) { any = true; break; }
      if (any) { if (top < 0) top = y; bot = y; }
    }
    if (top >= 0 && (bot - top + 1) * (x - s) >= 4) boxes.push([s, top, x - s, bot - top + 1]);
  }
  const gaps = boxes.slice(1).map((b, i) => b[0] - (boxes[i][0] + boxes[i][2]));
  return { seg: { band, bw, bh }, boxes, gaps, scale };
}
