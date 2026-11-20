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
export function locateReadout(img, run, reader, diagonal = false, thicken = 0, cut = 0.35, all = false) {
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
  for (let i = 0; i < n; i++) mask[i] = (g[i] - lo) / Math.max(8, hi - lo) > cut ? 1 : 0;
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
  // is the EXP readout (HP and MP end in ']' instead). With `all`, give
  // every candidate, so a look-alike (the character name) can be skipped.
  const found = [];
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
    const box = [Math.round(x0 + left - pl), Math.round(y0 + top - py),
                 Math.round(wd.x1 - left + pl + pr), Math.round(bot - top + 2 * py)];
    if (!all) return box;
    found.push(box);
  }
  return all ? found : null;
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
    // Big, smoothly stretched HUDs (a Mac in full screen) have dim, soft
    // grey text: a lower cut keeps the strokes of '%' together.
    const passes = [[false, 0], [true, 0], [false, 1], ...(run[3] >= 20 ? [[false, 2], [false, 1, 0.22], [false, 0, 0.22], [false, 2, 0.22]] : [])];
    for (const [diagonal, thicken, cut = 0.35] of passes) {
      const boxes = locateReadout(img, run, reader, diagonal, thicken, cut, true);
      if (!boxes.length) why.tried.push({ tiles: run, box: null, text: null });
      for (const box of boxes.slice(0, 3)) {
        // Only accept a spot whose numbers actually read as an EXP readout,
        // so look-alikes elsewhere on screen are skipped.
        const { rd, parsed: p } = readHud(reader, crop(img, ...box)), text = rd.text;
        why.tried.push({ tiles: run, box, text });
        if (!p) continue;
        if (p[0] !== null) return { tiles: run, exp: box };
        // Only the %: fine for a HUD that shows only the %, but keep looking
        // for a reading with the EXP amount first.
        pctOnly ||= { tiles: run, exp: box };
      }
    }
  }
  return pctOnly;
}

/** How much wider than tall the game is drawn (1 = unstretched), from the
 *  level tiles: each digit tile is 0.885 times as wide as it is tall. */
export function hudAspect([, , w, h]) {
  const digits = w / h > 1.3 ? 2 : 1, a = w / digits / h / 0.885;
  return a > 0.7 && a < 1.45 ? a : 1;
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
export function segment(img, cut = 0.45) {
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
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) if (band[y * bw + x] > cut) col[x]++;
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
      for (let xx = s; xx < e; xx++) if (band[y * bw + xx] > cut) { any = true; break; }
      if (any) { if (top < 0) top = y; bot = y; }
    }
    if (top >= 0 && (e - s) * (bot - top + 1) >= 4) boxes.push([s, top, e - s, bot - top + 1]);
  }
  return { band, sat: satb, bw, bh, boxes, cut };
}

/** Characters: ['tall', box] digits/% , ['dot', box], ['gap', null]. */
export function characters(img, ink = 0.45) {
  const seg = segment(img, ink);
  if (!seg) return null;
  const { band, sat, bw, boxes } = seg;
  const isBracket = ([x, y, w, h]) => {
    if (w < 0.22 * NORM_H) return true;
    let s = 0, c = 0;
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
      if (band[yy * bw + xx] > seg.cut) { s += sat[yy * bw + xx]; c++; }
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
      const a = r.chars[i];
      let joined = false;
      // Two or three neighbouring pieces (slash, circles, a circle taken
      // for a dot) that together look like '%'.
      if (a[0] === "tall") for (const n of [2, 3]) {
        const parts = r.chars.slice(i, i + n);
        if (parts.length < n || parts.some(p => p[0] === "gap") || parts[n - 1][0] !== "tall") continue;
        let ok = true;
        for (let k = 1; k < n; k++) {
          const [px, , pw] = parts[k - 1][1];
          if (parts[k][1][0] - (px + pw) > 0.35 * NORM_H) ok = false;
        }
        const ax = a[1][0], x1 = Math.max(...parts.map(p => p[1][0] + p[1][2])), w = x1 - ax;
        if (!ok || w < 0.6 * NORM_H || w > 1.2 * NORM_H) continue;
        const y = Math.min(...parts.map(p => p[1][1])), box = [ax, y, w, Math.max(...parts.map(p => p[1][1] + p[1][3])) - y];
        const sp = this.scoreFor(glyphVec(r.seg, box), "%");
        if (sp >= 0.7 && parts.every(p => p[0] !== "tall" || sp > this.classify(glyphVec(r.seg, p[1]))[1])) {
          out.push(["tall", box]); i += n - 1; joined = true; break;
        }
      }
      if (!joined) out.push(a);
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
  read(img, ink = 0.45) {
    const r = characters(img, ink);
    if (!r || !r.chars.length) return { text: null, glyphs: [], sure: false };
    this.joinPercent(r);
    let text = "", alt = ""; const glyphs = [];
    for (const [kind, b] of r.chars) {
      if (kind === "gap") text += " ";
      else if (kind === "dot") text += ".";
      else {
        const vec = glyphVec(r.seg, b), [c, score] = this.classify(vec);
        text += c; glyphs.push({ c, score, vec });
        // A best guess for doubtful characters (soft, stretched pictures
        // make 6, 8 and 9 look alike); only used where the numbers check out.
        if (c === "?") { const [g, gs] = this.rank(vec)[0]; alt += gs >= 0.65 ? g : "?"; } else alt += c;
        continue;
      }
      alt += text.slice(-1);
    }
    const sure = glyphs.length > 0 && glyphs.every(g => g.c !== "?" && g.score >= this.SURE);
    return { text: text.trim(), glyphs, sure, alt: alt.trim() };
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
    // A faint comma can drop out and leave a gap: "2 162" is 2,162.
    const grouped = rest.trimEnd().match(/(?:^|[^\d.])(\d{1,3}(?: \d{3})+)$/);
    // A stray '1' in front can be the edge of the 'EXP.' label; the EXP
    // table decides which reading is real.
    const g = grouped ? grouped[1].replace(/ /g, "") : null;
    for (const t of [g, g?.startsWith("1") ? g.slice(1) : null, amountTxt, amountTxt.startsWith("1") ? amountTxt.slice(1).replace(/^\./, "") : null]) {
      if (!t || !/^\d[\d.]*$/.test(t)) continue;
      const amount = parseInt(t.replace(/\./g, ""), 10);
      if (levelFromAmount(amount, pct)) return [amount, pct];
    }
  }
  return null;
}

/** Parse a reading; where doubtful characters stop it, try the reader's
 *  best guesses (the EXP table still has to agree with the amount). */
export function bestParse(rd) {
  const p = parseHudText(rd.text);
  if (p && p[0] !== null) return p;
  if (rd.alt && rd.alt !== rd.text) {
    const q = parseHudText(rd.alt);
    if (q && (!p || q[0] !== null)) return q;
  }
  return p;
}

/** Read the EXP readout. Soft, stretched text (a Mac in full screen) has
 *  faint strokes that a lower ink cut keeps whole, so when the first
 *  reading doesn't give the amount, try lower cuts. -> {rd, parsed} */
export function readHud(reader, img) {
  let first = null, pctOnly = null;
  for (const cut of [0.45, 0.35, 0.25]) {
    const rd = reader.read(img, cut), parsed = bestParse(rd);
    first ||= { rd, parsed };
    if (parsed && parsed[0] !== null) return { rd, parsed };
    if (parsed) pctOnly ||= { rd, parsed };
  }
  return pctOnly || first;
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

/** Was line b (born later) the line a, found again? a was lost young (lines
 *  stay about 5 s), just as b turned up: a line still on screen would have
 *  kept its own track. */
function sameLine(a, b) {
  return b.born >= a.born && a.seen <= b.born + 1000 && b.born - a.seen < 2000 && a.seen - a.born < 6000;
}
/** Two lines of the same length in the same picture are two lines (the
 *  same item twice). A track briefly following a neighbouring line of
 *  another length proves nothing. */
const TOGETHER_ANY = true;
/** A track's readings until it first jumped to another line (it dimmed all
 *  at once: the line it jumped to is older). */
function beforeHop(t) {
  const fr = t.frames || [];
  const hop = fr.findIndex((f, i) => i && f[2] !== undefined && fr[i - 1][2] !== undefined && f[0] - fr[i - 1][0] <= 250 && fr[i - 1][2] - f[2] > 15);
  return hop > 0 ? fr.slice(0, hop) : fr;
}
function together(a, b) {
  // (only while each was being read: a track can drift onto a neighbour
  // of about the same length later on)
  const span = x => { const ts = (x.looks || []).map(l => l.at).filter(v => v !== undefined); return ts.length ? [Math.min(...ts) - 150, Math.max(...ts) + 150] : [-Infinity, Infinity]; };
  const [a0, a1] = span(a), [b0, b1] = span(b);
  // (and only readings as long as the line itself: another message can be
  // within a few percent of it)
  const own = (x, x0, x1) => { const ws = (x.frames || []).filter(f => f[0] >= x0 && f[0] <= x1).map(f => f[1]).sort((p, q) => p - q); return ws.length ? ws[ws.length >> 1] : 0; };
  const wa = own(a, a0, a1), wb = own(b, b0, b1);
  if (!wa || Math.abs(wa - wb) > 0.015 * wb) return false;
  // (the older line anywhere in its life; the newer one while being read)
  // A track that just jumped to another line dims all at once (the line it
  // jumped to is older): such readings don't count.
  // (and from then on it may be anywhere)
  const fr = beforeHop(a);
  // (both read as item lines then: a meso line can be as long)
  const fa = new Map(fr.filter(f => (TOGETHER_ANY || (f[0] >= a0 && f[0] <= a1)) && Math.abs(f[1] - wa) <= 0.015 * wa && f[3] !== "meso" && f[3] !== "exp").map(f => [f[0], f[1]]));
  return (b.frames || []).some(([t, w, , ty]) => t >= b0 && t <= b1 && Math.abs(w - wb) <= 0.015 * wb && ty !== "meso" && ty !== "exp" && fa.has(t));
}
/** Is line b brighter at its start than the line a was when last seen?
 *  Lines only fade, so then b is a new line, not a found again. */
function fresher(as, b, ref) {
  // b's first readings, around its usual length (one can be a misread)
  const f3 = (b.frames || []).slice(0, 3).filter(f => f[2] !== undefined);
  if (!f3.length) return false;
  const w = [...f3.map(f => f[1])].sort((p, q) => p - q)[f3.length >> 1];
  const fb = f3.filter(f => Math.abs(f[1] - w) <= 0.06 * w);
  let last = null, at = -Infinity;
  for (const a of as) for (const f of a.frames || []) {
    if (f[0] > b.born || f[2] === undefined || Math.abs(f[1] - w) > 0.05 * w) continue;
    if (f[0] > at) { at = f[0]; last = f; }
  }
  if (!last) return false;
  // (the brightest of the old line's last few readings)
  let s = 0;
  for (const a of as) for (const f of a.frames || []) if (f[2] !== undefined && f[0] <= at && f[0] >= at - 300 && Math.abs(f[1] - w) <= 0.05 * w) s = Math.max(s, f[2]);
  // (b must stay that bright: a track that started on a neighbouring line
  // proves nothing)
  if (fb.length < 2) return false;
  // (if the old line was already fading, it has faded further since)
  if (FRESH_PROJECT) {
    const fs = [];
    for (const a of as) for (const f of a.frames || []) if (f[2] !== undefined && f[0] <= at && f[0] >= at - 600 && Math.abs(f[1] - w) <= 0.05 * w) fs.push(f);
    fs.sort((p, q) => p[0] - q[0]);
    if (fs.length >= 3 && fs[fs.length - 1][0] > fs[0][0]) {
      const slope = Math.min(0, (fs[fs.length - 1][2] - fs[0][2]) / (fs[fs.length - 1][0] - fs[0][0]));   // per ms
      s = Math.min(s, fs[fs.length - 1][2] + slope * Math.min(2000, b.born - at));
    }
  }
  // (and b must be bright like a line that just arrived)
  const sb = Math.min(fb[0][2], fb[1][2]);   // (the first two of them)
  // (and brighter than the old line's very last reading, whatever its trend)
  return sb >= 0.8 * ref && sb - s > 0.05 * ref && sb - last[2] > 0.03 * ref;
}
const FRESH_PROJECT = true;

/** How alike two names are: 1 the same, 0 nothing in common (edit distance). */
function nameLikeness(a, b) {
  a = a.toLowerCase(); b = b.toLowerCase();
  if (!a.length || !b.length) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}

/** Ties it together: finds the HUD in frames, reads it, feeds a tracker.
 *  The page calls tick(now, getFrame) on a timer. */
export class Session {
  static RATE_START = 15;   // seconds before the first per-hour estimate
  static LOOT_LOG = 300;    // item lines kept for troubleshooting (oldest dropped)
  /** Track and name picked-up items (and read the map for them). */
  lootOn = true;
  constructor(reader, { level = null, onLevel = () => {}, mesoReader = null, feedReader = null } = {}) {
    this.reader = reader; this.onLevel = onLevel; this.startLevel = level;
    this.mesoReader = mesoReader;
    // The pickup messages (bottom right): mesos without the inventory open.
    this.feedReader = feedReader ? new FeedReader(feedReader) : null;
    this.feedOk = 0; this.feedObs = [];
    this.hud = null; this.status = "idle"; this.lastOk = 0; this.lastSearch = 0;
    this.mesoBox = null; this.mesoOk = 0; this.mesoReadAt = 0; this.feedAtRead = 0; this.mesoSearch = 0; this.mesoSeen = false;
    this.prevUnsure = null; this.log = [];
    // The map, from the minimap title; read again after the screen goes
    // dark (changing maps). mapMemory: what has dropped on each map.
    this.map = null; this.mapStale = true; this.mapDark = false; this.mapNext = 0; this.mapTries = 0;
    this.frameSize = null; this.mapMemory = {}; this.mapMemoryDirty = false;
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
    this.mesoGained = 0; this.mesoFromFeed = 0; this.mesoFromInv = 0; this.feedSeen = false; this.mesoRecent = [];
    // Inventory rises waiting for their pickup message; when a meso pickup
    // line was last on screen; what came in without one (shop sales).
    this.invHeld = []; this.mesoLineAt = -Infinity; this.mesoSold = 0; this.soldEvent = null;
    this.pickups = new FeedTracker();
    // Items picked up this session: name -> {name, id, type, count}
    this.loot = new Map(); this.lootPending = []; this.lootRecent = []; this.lootKs = []; this.itemsSeen = 0; this.lootLog = [];
    this.mapsVisited = new Set(this.map ? [this.map.name] : []);
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
      mesos: this.mesoSeen || this.feedSeen ? this.mesoGained : null, mesoSpent: this.meso.spent || 0, mesoSold: this.mesoSold || 0,
      levelUps: this.mode === "amount" ? this.exp.levels : this.pct.levels,
      expLost: Math.round((this.mode === "amount" ? this.exp.lost : this.pct.lost) || 0),
      loot: this.lootList().map(e => [e.name, e.count, e.id]),
      maps: [...this.mapsVisited],
    };
  }
  lootList() { return [...this.loot.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)); }
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
    this.tickMap(now, getFrame);
    const lost = now - this.lastOk > 6000;
    if (lost && this.hud && !this.lostAnnounced) {
      this.lostAnnounced = true;
      this.event(now, "lost", "Can't see the EXP numbers; looking for the HUD");
    }
    if (!this.hud || (lost && now - this.lastSearch > 5000)) {
      this.status = "searching"; this.lastSearch = now;
      const full = getFrame(null);
      if (!full) { this.miss = "No picture from the shared window yet."; return null; }
      this.frameSize = [full.w, full.h];
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
      if (this.feedReader) this.feedReader.aspect = hudAspect(hud.tiles);
    }
    const img = getFrame(this.hud.exp);
    if (!img) return null;
    const hr = readHud(this.reader, img), { text, glyphs, sure } = hr.rd;
    let parsed = hr.parsed;
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
    this.settleInv(now);
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
      // (Timed from the last number actually read: the field can stay in
      // view with its digits hidden, and finding it again isn't reading it.)
      if (this.mesoReadAt && now - this.mesoReadAt > 3000 && this.mesoFromFeed !== this.feedAtRead) { this.meso.last = null; this.meso.pending = []; }
      this.mesoOk = now; this.mesoReadAt = now; this.feedAtRead = this.mesoFromFeed; this.mesoSeen = true;
    }
    const before = { gained: this.meso.gained, spent: this.meso.spent };
    const decision = this.meso.update(value, r.sure);
    if (value !== null && r.sure && ACCEPTED.has(decision)) this.mesoReader.confirm(r.glyphs);
    const fmtN = n => Math.round(n).toLocaleString("en-US");
    if (decision === "spent") this.event(now, "meso", `Spent ${fmtN(this.meso.spent - before.spent)} mesos`);
    const got = this.meso.gained - before.gained;
    if (got > 0) this.invHeld.push({ at: now, d: got });
    this.settleInv(now);
    return { text: r.text || "", value: value ?? "", decision };
  }
  /** A rise in the inventory total counts only if a meso pickup message
   *  showed around then. Selling to a shop (or a trade) raises the total
   *  with no pickup message: that's not earnings, so it's left out. Without
   *  the pickup messages to check against, every rise counts. */
  static INV_WAIT = 3000;     // how long a rise waits for its pickup message
  static INV_BEFORE = 8000;   // a message this long before the rise backs it too
  settleInv(now) {
    const fmtN = n => Math.round(n).toLocaleString("en-US");
    const keep = [];
    for (const h of this.invHeld) {
      const backed = !this.feedReader || this.mesoLineAt >= h.at - Session.INV_BEFORE;
      if (!backed && now - h.at < Session.INV_WAIT) { keep.push(h); continue; }
      if (backed) {
        this.mesoGained += h.d; this.mesoFromInv += h.d;
        if (h.d >= 1000) this.event(h.at, "meso", `+${fmtN(h.d)} mesos`);
        continue;
      }
      this.mesoSold += h.d;
      // One log line per spell of selling, kept up to date.
      const last = this.events[this.events.length - 1];
      if (this.soldEvent && last === this.soldEvent && h.at - this.soldEvent.t < 60000) {
        this.soldEvent.amount += h.d;
      } else {
        this.soldEvent = { t: h.at, kind: "meso", amount: h.d };
        this.events.push(this.soldEvent); if (this.events.length > 500) this.events.shift();
      }
      this.soldEvent.text = `Left out +${fmtN(this.soldEvent.amount)} mesos with no pickup message (selling to a shop or a trade)`;
    }
    this.invHeld = keep;
  }
  /** Pickup messages: called often (about 10 times a second). */
  inventoryVisible(now) { return !!this.mesoBox && now - (this.mesoReadAt || 0) < 2500; }
  tickFeed(now, getFrame) {
    if (!this.running || !this.feedReader) return null;
    const fr = this.feedReader;
    const full = () => getFrame(null);
    if (!fr.anchor) {
      // about 0.15 s of work each try: once a second (tried twice a second
      // at first: the lines found early were read too poorly to help)
      if (now - fr.lastSearch < 1000) return null;
      fr.lastSearch = now;
      const img = full();
      if (!img || !fr.locate(img)) return null;
      this.event(now, "hud", "Found the pickup messages");
      // Found a while after starting (scenery behind the text can hide it
      // for some seconds): the brightest lines arrived since, so they count.
      this.pickups.lateStart = false;   // (tried counting lines still bright when found late: it counted lines from before too)
    } else if (now - this.feedOk > 30000 && now - fr.lastSearch > 10000) {
      // Nothing for a while: maybe the window moved. Look again (keep the
      // old spot unless a new one turns up).
      fr.lastSearch = now;
      const keep = fr.anchor, img = full();
      if (!img || !fr.locate(img)) fr.anchor = keep;
    }
    else if (now - (fr.lastCheck || 0) > 3000 && now - this.feedOk < 1000) {
      // Every few seconds while lines are showing: is the spacing right?
      fr.lastCheck = now;
      const img = full();
      if (img && fr.recheck(img)) this.event(now, "hud", "Corrected the spacing of the pickup messages");
    }
    const box = fr.box(), img = box && getFrame(box);
    if (!img) return null;
    const obs = fr.read(img);
    if (obs.length) this.feedOk = now;
    if (obs.some(o => o.type === "meso")) this.mesoLineAt = now;
    // Loot tracking off: item lines are still tracked (so their lines aren't
    // mistaken for mesos), but never looked at closely or named.
    if (!this.lootOn) for (const o of obs) delete o.lookFn;
    this.feedObs = obs;
    const inv = this.inventoryVisible(now), fmtN = n => Math.round(n).toLocaleString("en-US");
    for (const ev of this.pickups.update(now, obs)) {
      if (ev.type === "item" && !ev.corrected && this.lootOn) this.lootPending.push({ t: ev.track, at: now });
      if (ev.corrected?.type === "item" && ev.type !== "item") this.unloot(ev.track);
      let d = 0;
      const wasLeftOut = !!ev.track?.ignored;
      if (ev.track) ev.track.ignored = false;
      if (ev.type === "meso" && ev.value !== null) {
        // A pickup many times bigger than this session's usual ones, read
        // only a time or two, is a misread ("(+85)" with a speck after it),
        // not a jackpot: leave it out. Read steadily, it counts.
        const v = ev.value, usual = this.usualMeso(), votes = ev.track?.valueVotes?.[`meso|${v}`] || 0;
        if (usual && v >= 1000 && v > 20 * usual && votes < 4) {
          ev.track.ignored = true;
          this.event(now, "meso", `Left out an unlikely +${fmtN(v)} mesos reading`);
        } else {
          d += v;
          if (v > 0) { (this.mesoRecent ||= []).push(v); if (this.mesoRecent.length > 25) this.mesoRecent.shift(); }
        }
      }
      if (ev.corrected?.type === "meso" && ev.corrected.value !== null && !wasLeftOut) d -= ev.corrected.value;
      if (!d) continue;
      this.feedSeen = true;
      if (inv) continue;                 // the inventory total counts it
      this.mesoGained += d; this.mesoFromFeed += d;
      if (d >= 1000) this.event(now, "meso", `+${fmtN(d)} mesos`);
    }
    this.nameLoot(now);
    return obs;
  }
  /** The usual meso pickup this session (once there have been a few). */
  usualMeso() {
    const r = [...(this.mesoRecent || [])].sort((p, q) => p - q);
    return r.length >= 5 ? r[r.length >> 1] : null;
  }
  /** Is the picture dark all over (the fade between maps)? */
  isDark(getFrame) {
    if (!this.frameSize) return false;
    const [W, H] = this.frameSize, S = Math.max(8, Math.round(W / 40));
    for (const fx of [0.3, 0.5, 0.7]) for (const fy of [0.3, 0.6]) {
      const img = getFrame([Math.round(W * fx - S / 2), Math.round(H * fy - S / 2), S, S]);
      if (!img) return false;
      let sum = 0;
      for (let i = 0; i < img.data.length; i += 4) sum += img.data[i] + img.data[i + 1] + img.data[i + 2];
      if (sum / (img.data.length / 4) / 3 > 24) return false;
    }
    return true;
  }
  /** Read the map's name once; again after a map change. */
  tickMap(now, getFrame) {
    if (!this.mapMatcher || !this.lootOn) return;
    if (this.isDark(getFrame)) { this.mapDark = true; return; }
    if (this.mapDark) {                 // the fade is over: a new map, most likely
      this.mapDark = false; this.mapStale = true; this.mapTries = 0; this.mapNext = now + 1200;
    }
    if (!this.mapStale || !this.mapMatcher.ready || now < this.mapNext) return;
    const full = getFrame(null);
    const mm = full && findMinimap(full), looks = mm && minimapTitle(full, mm);
    const r = looks && this.mapMatcher.identify(looks);
    this.mapLast = { found: !!mm, looks: looks ? looks.map(l => l.n) : null, r: r && { name: r.name, cost: r.cost, margin: r.margin } };
    if (r && r.cost < MapMatcher.COST_MAX) {
      this.mapStale = false;
      const changed = !this.map || this.map.name !== r.name || this.map.street !== r.street;
      this.map = r; this.mapsVisited.add(r.name);
      if (changed) this.event(now, "map", `On ${r.name}`);
    } else {
      // no minimap in view (or unreadable): try a few more times, then rarely
      this.mapTries++;
      this.mapNext = now + (this.mapTries < 4 ? 3000 : 30000);
    }
  }
  mapKey() { return this.map ? `${this.map.street}|${this.map.name}` : null; }
  /** Items this session, and ones seen on this map before: likelier. */
  /** The size item lines are drawn at, once a few clear readings agree. */
  lootScale() {
    const ks = [...(this.lootKs || [])].sort((a, b) => a - b);
    if (ks.length >= 3) return ks[ks.length >> 1];
    // Before that: lines are measured in text heights, so item text comes
    // out at about the same size everywhere (wider if the screen stretches it)
    return LOOT_K * (this.feedReader?.aspect || 1);
  }
  likelyLoot() {
    // name -> how much likelier (in naming cost per look)
    const known = new Map(), add = (name, n) => known.set(name, Math.max(known.get(name) || 0, n >= 3 ? 0.04 : n >= 2 ? 0.03 : 0.02));
    for (const [name, e] of this.loot) add(name, e.count || 1);
    for (const [name, n] of Object.entries(this.mapMemory[this.mapKey()] || {})) add(name, typeof n === "number" ? n : 1);
    known.delete("Unknown item");
    return known;
  }
  /** For troubleshooting (in the readings CSV): what each item line was
   *  named, how sure, what became of it, and a small picture of the line.
   *  Only the latest few hundred are kept. */
  noteLoot(now, t, looks, r, verdict) {
    const l = looks[0], log = (this.lootLog ||= []);
    log.push({ time: new Date(now).toISOString(), born: new Date(t.born).toISOString(), verdict,
               name: r?.name ?? "", count: r?.count ?? "", second: r?.second ?? "", cost: r ? +r.cost.toFixed(3) : "",
               margin: r ? +r.margin.toFixed(3) : "", looks: looks.length, pic: l?.look?.pic ? l.look.pic() : "" });
    if (log.length > Session.LOOT_LOG) log.shift();
  }
  /** Name picked-up items once their line has been seen a few times (or
   *  has gone). Lines that can't be named count as "Unknown item". */
  nameLoot(now, all = false) {
    let budget = all ? Infinity : 1;          // naming takes a while: one per tick
    // ...and not while new lines are arriving: keep up with those first
    // (unless the naming happens elsewhere: see lootAsk)
    const ask = !all && this.lootAsk;
    const busy = !all && !ask && this.pickups.stack.some(t => now - t.born < 700);
    this.lootPending = this.lootPending.filter(p => {
      if (budget <= 0 || (busy && now - p.at < 5000)) return true;
      let looks = p.t.looks || [];
      const gone = !this.pickups.stack.includes(p.t);
      if (!all && !gone && looks.length < 3 && now - p.at < 1500) return true;
      if (p.t.type !== "item") return false;    // turned out to be EXP or mesos
      budget--;
      let r;
      if (ask && this.lootMatcher?.ready && looks.length && !p.failed) {
        // Named in the background (a worker), so reading the screen never
        // waits for it: ask once, one line at a time, and carry on when the
        // answer is in.
        if (!p.asked) {
          if (this.lootAsking) return true;
          p.asked = looks.slice(0, 3); this.lootAsking = true;
          ask(p.asked.map(l => l.look), this.likelyLoot(), this.lootScale())
            .then(a => { p.answer = a ?? null; }, () => { p.failed = true; })
            .finally(() => { this.lootAsking = false; });
          return true;
        }
        if (p.answer === undefined) return true;
        looks = p.asked; r = p.answer;
      } else {
        r = this.lootMatcher?.ready && looks.length ? this.lootMatcher.identify(looks.slice(0, 3).map(l => l.look), this.likelyLoot(), this.lootScale()) : null;
      }
      if (globalThis.LOOT_DEBUG) globalThis.LOOT_DEBUG.push({ now, looks, r, t: p.t });
      if ((this.lootTrail ||= []).length > 200) this.lootTrail.shift();
      this.lootTrail.push([Math.round((p.t.born - (this.startedAt || 0)) / 100) / 10, r ? `${r.item ? (r.ok ? r.name : "?") : "-"} ${r.cost.toFixed(2)} k${r.ks.join("/")}` : "none"]);
      const verdict = (() => {
        // Not an item line after all ("You received EXP"), or no item looks
        // like it: leave it out rather than guess.
        if (!r || !r.item) return "not an item line";
        if (!r.ok) return "no name fits";
        // New pickup lines arrive bright; one only ever seen faded is an old
        // line found again. And a faded look can't tell close names apart.
        const ref = this.pickups.ref || 0;
        // (on a pale background new lines read dimmer: one that arrived at
        // the bottom, reads clearly, and isn't a recent item seen again is
        // let through)
        if (!p.t.bright && !(p.t.bornSlot === 0 && looks[0] && looks[0].s >= 0.7 * ref && r.cost < 0.6 && r.margin >= 0.02 &&
                             !this.lootRecent.some(q => q.name === r.name && q.ts.some(m => Math.abs(m.born - p.t.born) < 8000)))) return "only seen faded";
        if (r.margin < 0.01 && looks[0] && looks[0].s < 0.8 * ref) return "too faint to tell";
        // one glimpse that only just picks a name: too little to go on
        if (looks.length === 1 && r.margin < 0.03) return "seen once, unsure";
        // a poor fit that barely picks one name over another: a guess
        if (r.cost > 0.87 && r.margin < 0.05) return "poor fit, unsure";
      // A so-so fit whose runner-up is a quite different name: nothing
      // really fits (often an item newer than the list). Look-alike names
      // ("Mushroom Spore" / "Mushmom Spore") are just hard to tell apart.
      if (r.cost > 0.72 && r.margin < 0.06 && nameLikeness(r.name, r.second || "") < 0.5) return "poor fit, unsure";
      // Most looks prefer some quite different name: the track followed two
      // lines (say "Jr. Boogie Horn" and "Decayed Charm").
      if (r.split && 2 * (r.favs || []).filter(f => f && f !== r.name && nameLikeness(f, r.name) < 0.5).length > (r.favs || []).length) return "looks disagree";
        if (looks.length === 1 && r.cost > 0.75 && r.margin < 0.05) return "seen once, unsure";
        // The same line seen again: the pickup tracker sometimes loses a line
        // and finds it once more. Same name, the old one gone young just as
        // this one appeared: one pickup, not two.
        // Each line counted so far keeps the tracks that followed it; a line
        // is never in two places in one picture.
        // (a different stack size is a different line: "x4" then "x3")
        const t = p.t, qty = r.count || 1, dup = this.lootRecent.find(q => q.name === r.name && (q.qty || 1) === qty &&
          q.ts.some(m => sameLine(m, t) || sameLine(t, m)) && !q.ts.some(m => together(m, t)) && !fresher(q.ts, t, ref));
        if (globalThis.LOOT_DEBUG) t.why = this.lootRecent.filter(q => q.name === r.name).map(q => [q.ts[0].born, q.ts.some(m => sameLine(m, t) || sameLine(t, m)), q.ts.some(m => together(m, t)), fresher(q.ts, t, ref)]);
        if (dup) {
          if (globalThis.LOOT_DEBUG) t.dupOf = dup.ts[0].born;
          dup.ts.push(t); if (dup.ts.length > 12) dup.ts.shift();
          return "same line as before";
        }
        this.lootRecent.push({ ts: [t], name: r.name, qty });
        if (this.lootRecent.length > 30) this.lootRecent.shift();
        // a clear reading teaches the size item lines are drawn at here
        if (r.cost < 0.62 && r.margin > 0.04) { this.lootKs.push(r.k); if (this.lootKs.length > 9) this.lootKs.shift(); }
        const e = this.loot.get(r.name) || { name: r.name, id: r.id, type: r.type, count: 0 };
        // the count is how many came in ("Milk Jug x10" adds 10)
        e.count += qty; this.loot.set(r.name, e); this.itemsSeen += qty;
        t.lootName = r.name; t.lootQty = qty;
        if (this.map) {                           // remember what drops here
          const mem = (this.mapMemory[this.mapKey()] ||= {});
          mem[r.name] = (mem[r.name] || 0) + 1; this.mapMemoryDirty = true;
        }
        return "counted";
      })();
      this.noteLoot(now, p.t, looks, r, verdict);
      return false;
    });
  }
  unloot(t) {
    this.lootPending = this.lootPending.filter(p => p.t !== t);
    const e = t.lootName && this.loot.get(t.lootName);
    if (e) {
      const qty = t.lootQty || 1;
      e.count -= qty; this.itemsSeen -= qty; if (e.count <= 0) this.loot.delete(t.lootName);
      const mem = this.mapMemory[this.mapKey()];
      if (mem?.[t.lootName]) { if (--mem[t.lootName] <= 0) delete mem[t.lootName]; this.mapMemoryDirty = true; }
      t.lootName = null;
    }
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
    const mesoVisible = !!this.mesoBox && now - (this.mesoReadAt || 0) < 6000;
    const feedActive = !!this.feedReader?.anchor && now - this.feedOk < 60000;
    return {
      mesos, mesoHr, mesoTotal: this.meso.last,
      mesoSpent: this.meso.spent, mesoSold: this.mesoSold || 0, mesoVisible, mesoTracking: !!this.mesoReader,
      feedActive, mesoFromFeed: this.mesoFromFeed, mesoFromInv: this.mesoFromInv,
      running: !!this.running, status: this.status, elapsed: el, mode: this.mode,
      exp: g, expHr, nowHr, pctHr, level, pct, eta,
      needsLevel: this.mode === "pct" && !this.pct.startLevel,
      levels: this.mode === "amount" ? this.exp.levels : this.pct.levels,
      lost: (this.mode === "amount" ? this.exp.lost : this.pct.lost) || 0,
      stale: this.running && now - this.lastOk > 15000,
      loot: this.lootList(), itemsSeen: this.itemsSeen, map: this.map ? this.map.name : null,
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
export function feedLineAt(f, y0, y1, xr, extend = false) {
  const { w, h, ink, raw } = f, T = 0.4;
  y0 = Math.max(0, Math.round(y0)); y1 = Math.min(h, Math.round(y1));
  const bh = y1 - y0;
  if (bh < 4) return null;
  const col = new Int32Array(w), xmax = Math.min(w - 1, Math.round(xr + 2 * bh));
  for (let y = y0; y < y1; y++) for (let x = 0; x <= xmax; x++) if (ink[y * w + x] > T) col[x]++;
  let c = 0;
  for (let x = Math.max(0, xr - 6); x <= Math.min(w - 1, xr + 3); x++) c += col[x];
  if (c < Math.max(3, 0.25 * bh)) return null;          // nothing ends here
  let x1 = Math.min(w - 1, xr + 3);
  while (x1 >= 0 && col[x1] < 1) x1--;
  // The right edge can be found a few pixels short: let a line run on
  // past it while its letters continue (else "(Etc)" loses its end).
  for (let x = x1 + 1, gap = 0; x <= xmax; x++) { if (col[x] >= 1) { x1 = x; gap = 0; } else if (++gap > 0.35 * bh) break; }
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
export function feedPitch(f, xr, th, top = 0, bot = f.h, rows = null) {
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
  // Text lines whose rows we know (they end in brackets) must sit whole
  // spacings apart: a patterned wall behind the text can fake a spacing.
  if (rows && rows.length >= 2) {
    const fits = P => {
      let sc = 0;
      for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
        const d = Math.abs(rows[i] - rows[j]) / P, k = Math.round(d);
        if (d < 0.5) continue;
        sc += k >= 1 && Math.abs(d - k) < 0.15 ? 1 : -1;
      }
      return sc;
    };
    const peaks = acs.filter(([, v], i) => i > 0 && i < acs.length - 1 && v >= 0.3 * best && v >= acs[i - 1][1] && v >= acs[i + 1][1]);
    let bestP = null;
    for (const [L, v] of peaks) { const sc = fits(L); if (!bestP || sc > bestP.sc || (sc === bestP.sc && v > bestP.v)) bestP = { L, v, sc }; }
    if (bestP && bestP.L !== lag && bestP.sc > fits(lag)) { lag = bestP.L; best = bestP.v; }
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
export function readFeedLine(f, line, th, reader, aspect = 1) {
  const e = feedEnd(f, line, th);
  if (!e) {
    // No "(+123)" found at the end. A long line can still be an item
    // ("Steel Sylvia x1 earned. (Equip)"): let the item reader judge it.
    const long = (line.x1 - line.x0) / th / aspect >= 13;
    return { type: long ? "item" : "other", weak: long, value: null, sure: false, text: "", prefix: undefined };
  }
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
  // A stretched picture (a 4:3 game on a wide screen) makes text wider or
  // narrower than its height says: measure in unstretched units.
  let type = letters ? "item" : feedType(e.prefix / aspect, line.sat ?? null);
  const plus = small.length >= 1 && (!tall.length || small[0][0] < tall[0][0]);
  let value = type !== "item" && plus && /^[0-9]{1,7}$/.test(text) ? Number(text) : null;
  // Longer before the bracket than any EXP or meso message, and no number
  // in it: an item ("Green Napoleon x1 earned. (Equip)"). The item reader
  // checks the line's end itself.
  if (type === "other" && value === null && e.prefix / aspect > 14.2) type = "item";
  // No "+" before the first digit-sized letter: the brackets hold a word,
  // not a number ("Stirge Wing x1 earned. (Etc)" is as long as a meso
  // line). Most likely an item; a weak guess.
  let weak = false;
  if ((type === "meso" || type === "party" || type === "exp") && (!plus || !tall.length)) { type = "item"; weak = true; }
  if (type === "other" && value === null) sure = false;
  return { type, value, weak, sure: sure && value !== null, text: (plus ? "+" : "") + text, prefix: e.prefix, bottom: e.bottom, vecs };
}

/** Finds the pickup feed and reads its lines. Keeps where it is
 *  (right edge, text height, line spacing, bottom line) once found. */
/** Text height (bracket height) as a share of the line spacing. */
export const FEED_TH = 0.76;

export class FeedReader {
  constructor(reader) { this.reader = reader; this.anchor = null; this.samples = []; this.lastSearch = 0; this.lastSeen = 0; this.aspect = 1; }
  /** Search the lower right of the picture for the feed. */
  locate(full) {
    const rx = Math.floor(full.w * 0.5), ry = Math.floor(full.h * 0.35);
    const img = crop(full, rx, ry, full.w - rx, full.h - ry);
    const f = feedInk(img);
    const r = feedLines(f);
    if (!r.xr || !r.lines.length) return null;
    const th0 = feedTextHeight(r.lines);
    if (!th0) return null;
    // Scenery behind the text can make lines look taller than they are, so
    // try a few text heights near the measured one: the one that reads the
    // most lines as messages ("(+82)" after the right words) wins.
    let read = null, good = [], kb = 1;
    for (const k of [1, 0.9, 0.82, 1.1, 0.75]) {
      const th = th0 * k;
      const rd = r.lines.map(l => ({ l, r: readFeedLine(f, l, th, this.reader, this.aspect) }));
      const gd = rd.filter(x => x.r.value !== null && x.r.type !== "other");
      // (another height must read two lines at least: one could be luck)
      if (gd.length > good.length && (k === 1 || gd.length >= 2)) { read = rd; good = gd; kb = k; }
      if (good.length) break;                      // (the measured height, if it reads at all)
    }
    if (!good.length) return null;
    const th = th0 * kb;
    const real = read.filter(x => x.r.prefix !== undefined);       // lines ending in brackets
    if (!real.length) return null;
    // Line spacing: the period of the text rows ending at the right edge
    // (which doesn't need every line to be readable).
    const xr = r.xr;
    const top = Math.max(0, Math.min(...r.lines.map(l => l.y0)) - th), bot = Math.min(f.h, Math.max(...r.lines.map(l => l.y1)) + 2 * th);
    const pitch = feedPitch(f, xr, th, top, bot, real.map(x => x.r.bottom)) || 1.25 * th;
    // The bottom line: the lowest readable one, then further down while
    // there's text one spacing lower.
    let yb = Math.max(...real.map(x => x.r.bottom));
    for (let n = 0; n < 3; n++) {
      const l = feedLineAt(f, yb + pitch - 1.08 * FEED_TH * pitch, yb + pitch + 0.12 * FEED_TH * pitch, xr);
      if (!l || readFeedLine(f, l, FEED_TH * pitch, this.reader, this.aspect).prefix === undefined) break;
      yb += pitch;
    }
    const xr2 = xr;
    const ys = [yb];
    this.anchor = { xr: rx + xr2, th: FEED_TH * pitch, pitch, yb: ry + ys[ys.length - 1], w: full.w, h: full.h };
    this.samples = [];
    return this.anchor;
  }
  /** Locate again from scratch without changing anything; if a few such
   *  looks in a row agree on a different line spacing, the one in use was
   *  wrong (a patterned wall can fake a spacing when locating): switch.
   *  -> true if it switched. */
  recheck(full) {
    const keep = this.anchor, keepS = this.samples;
    const got = this.locate(full);
    this.anchor = keep; this.samples = keepS;
    if (!got || !keep) return false;
    if (Math.abs(got.pitch / keep.pitch - 1) < 0.12) { this.votes = []; return false; }
    const v = (this.votes ||= []);
    if (v.length && Math.abs(got.pitch / v[0].pitch - 1) > 0.05) v.length = 0;
    v.push(got);
    if (v.length < 3) return false;
    this.anchor = got; this.samples = []; this.votes = [];
    return true;
  }
  /** The box the feed lives in (frame coordinates). */
  box() {
    const a = this.anchor; if (!a) return null;
    // wide enough for the longest lines ("Blue Sauna Ro... x1 earned. (Equip)")
    const x0 = Math.max(0, Math.round(a.xr - 32 * a.th)), y0 = Math.max(0, Math.round(a.yb - 8.4 * a.pitch));
    // a little below the bottom line too, in case the real bottom is lower
    return [x0, y0, Math.min(a.w, Math.round(a.xr + 3 * a.th)) - x0, Math.min(a.h, Math.round(a.yb + 1.6 * a.pitch)) - y0];
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
      l.yb = yb;                                   // (where the line should sit)
      const o = { slot: k, strength: l.strength, width: (l.x1 - l.x0) / a.th, ...readFeedLine(f, l, a.th, this.reader, this.aspect) };
      // item lines: their look, to name the item (worked out only if the
      // pickup tracker wants it: it's slow)
      if (o.type === "item") o.lookFn = () => itemLineLook(f, l, a.th);
      out.push(o);
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
  static WIDTH = true;      // use line lengths to tell lines apart
  static DROP = 0.25;       // the most a line fades between two readings
  static YOUNG = false;     // a line read only once or twice proves less (tried: worse for mesos)
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
            // (a line read only once or twice may simply have been misread)
            const sureT = FeedTracker.YOUNG ? Math.min(1, 0.35 + 0.325 * ((t.reads?.length || 1) - 1)) : 1;
            if (o.type !== "other" && t.type !== "other" && o.type !== t.type) cost += (sameValue ? 0.5 : o.strength >= fresh ? 3 : 1.5) * sureT;
            if (o.value !== null && t.value !== null && o.value !== t.value) cost += o.sure && o.strength >= fresh ? 2 : 0.7;
            // a line keeps its length: a clearly longer or shorter one is
            // another line (only judged while both are bright and whole)
            if (FeedTracker.WIDTH && t.width && o.width && o.strength >= fresh && t.last >= fresh) {
              const rel = Math.abs(o.width - t.width) / t.width;
              if (rel > 0.08) cost += 2 * sureT; else if (rel > 0.05) cost += 0.7 * sureT;
            }
            // lines only fade: one that got brighter is a new line
            const up = (o.strength - t.last) / (this.ref || 150);
            if (up > 0.1) cost += 3; else if (up > 0.065) cost += 1.5;
            // ...and fade slowly: a bright line that went dim at once is
            // another line
            else if (FeedTracker.DROP && -up > FeedTracker.DROP && t.last >= fresh && now - t.seen < 400) cost += 1.5;
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
    // lines just arrived are the brightest (they fade after a second)
    const maxS = obs.length ? Math.max(...obs.map(o => o.strength)) : 0;
    for (let j = k - 1; j >= 0; j--) added.push({ id: this.nextId++, bornSlot: j, type: "other", value: null, sureValue: false,
      reads: [], typeVotes: {}, valueVotes: {}, last: Infinity, seen: now, born: now, miss: 0, counted: false,
      // on screen when tracking began: picked up before it (unless tracking
      // began a while ago and this line is still at its brightest)
      before: first && !(this.lateStart && maxS >= 165 && (bySlot.get(j)?.strength ?? 0) >= 0.93 * maxS) });
    this.stack = added.reverse().concat(this.stack);
    // update every line with what's in its slot now: its type and value
    // are a vote over all its readings (bright, sure ones count more)
    this.stack.forEach((t, i) => {
      const o = bySlot.get(i);
      if (!o) { t.miss++; return; }
      t.miss = 0; t.seen = now; t.last = o.strength; t.lastSlot = i;
      if (o.width) { (t.frames ||= []).push([now, o.width, o.strength, o.type]); if (t.frames.length > 80) t.frames.shift(); }
      if (o.width && o.strength >= fresh) t.width = t.width ? 0.7 * t.width + 0.3 * o.width : o.width;
      if (o.strength >= fresh) t.bright = true;
      // (a guess from the line's length alone counts for less)
      const w = (o.sure ? 2 : 1) * (o.strength >= fresh ? 1 : 0.5) * (o.weak ? 0.5 : 1);
      if (o.type !== "other") {
        t.typeVotes[o.type] = (t.typeVotes[o.type] || 0) + w;
        if (o.value !== null) { const key = `${o.type}|${o.value}`; t.valueVotes[key] = (t.valueVotes[key] || 0) + w; }
        if (o.value !== null && o.strength >= 0.95 * fresh) t.brightRead = true;
      }
      t.reads.push(o.value);
      const iv = t.typeVotes.item || 0, ov = Math.max(t.typeVotes.exp || 0, t.typeVotes.meso || 0, t.typeVotes.party || 0);
      if (o.lookFn && iv >= ov) {
        // the brightest few looks of an item line, to name it
        const L = (t.looks ||= []);
        if (L.length < 3 || o.strength > L[L.length - 1].s + 2) {
          const look = o.lookFn();
          if (look) {
            L.push({ look, s: o.strength, at: now });
            L.sort((p, q) => q.s - p.s); if (L.length > 3) L.length = 3;
          }
        }
      }
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
    return { id: t.id, type: t.type, value: t.value, unsure, track: t };
  }
  /** A counted line whose vote changed: take back the old, add the new. */
  recount(t) {
    const c = t.counted;
    if (c.type === t.type && c.value === t.value) return null;
    if (t.type !== "item" && !t.sureValue) return null;
    this.apply(c.type, c.value, -1); this.apply(t.type, t.value, +1);
    t.counted = { type: t.type, value: t.value };
    return { id: t.id, type: t.type, value: t.value, corrected: c, track: t };
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

// ------------------------------------------------------------- item names
//
// "Mushroom Spore x1 earned. (Etc)": the game writes item pickups in a plain
// Arial-like font. To name the item, draw each candidate name in that font
// and compare it, column by column, with the line on screen. The fixed end
// (" x1 earned. (Etc)") tells the scale and where the name stops.

export const LOOT_ROWS = 12;
const LOOT_K = 2.03;           // usual drawn size of item text in a look (see lootScale)
export const LOOT_TYPES = ["Etc", "Use", "Equip", "Setup", "Cash"];

/** Rows of the x-height (top, baseline) of a line of text. */
function xBand(a, w, h, thr) {
  const rp = new Int32Array(h); let m = 0;
  for (let y = 0; y < h; y++) { let c = 0; for (let x = 0; x < w; x++) if (a[y * w + x] > thr) c++; rp[y] = c; if (c > m) m = c; }
  let top = -1, base = -1;
  for (let y = 0; y < h; y++) if (rp[y] > 0.55 * m) { if (top < 0) top = y; base = y; }
  return [top, base];
}

/** Each column's ink in LOOT_ROWS rows, from above the capitals to below the
 *  descenders, measured in x-heights. -> Float32Array(w * LOOT_ROWS) */
function columnLook(a, w, h, top, base, x0 = 0, x1 = w) {
  const xh = base - top + 1, r0 = top - 0.6 * xh, r1 = base + 0.5 * xh, n = LOOT_ROWS * 3, cw = x1 - x0;
  const out = new Float32Array(cw * LOOT_ROWS);
  for (let i = 0; i < n; i++) {
    const y = r0 + (r1 - r0) * i / (n - 1), y0 = Math.floor(y), fr = y - y0, r = Math.floor(i / 3);
    for (const [yy, ww] of [[y0, 1 - fr], [y0 + 1, fr]]) {
      if (yy < 0 || yy >= h || ww <= 0) continue;
      for (let x = x0; x < x1; x++) out[(x - x0) * LOOT_ROWS + r] += ww * a[yy * w + x] / 3;
    }
  }
  return out;
}

/** Columns that have ink: [first, last + 1]. */
function inkSpan(a, w, h, thr) {
  let x0 = w, x1 = 0;
  for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) if (a[y * w + x] > thr) { if (x < x0) x0 = x; x1 = x + 1; break; }
  return x0 < x1 ? [x0, x1] : null;
}

/** The look of an item line on screen (from the feed's ink picture). */
export function itemLineLook(f, line, th) {
  const g = lineGlyphs(f, line, th), l = g && bandLook(g.seg, true);
  if (l && globalThis.LOOT_DEBUG) l.seg = g.seg;
  if (l) l.pic = () => bandPicture(g.seg);
  return l;
}

/** A line's picture as text, small enough to keep a few hundred:
 *  "w x h:" then one hex digit (0-f, dark to bright) per pixel, row by row,
 *  scaled to 14 rows. */
export function bandPicture({ band, bw, bh }) {
  const H = 14, W = Math.max(1, Math.round(bw * H / bh));
  let out = `${W}x${H}:`;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    // average of the pixels this one covers
    const y0 = Math.floor(y * bh / H), y1 = Math.max(y0 + 1, Math.floor((y + 1) * bh / H));
    const x0 = Math.floor(x * bw / W), x1 = Math.max(x0 + 1, Math.floor((x + 1) * bw / W));
    let s = 0, n = 0;
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { s += band[yy * bw + xx]; n++; }
    out += Math.min(15, Math.round(15 * s / n)).toString(16);
  }
  return out;
}
export function bandLook({ band, bw, bh }, feed = false) {
  const span = inkSpan(band, bw, bh, 0.3);
  if (!span) return null;
  const [top, base] = xBand(band, bw, bh, 0.5);
  if (top < 0 || base - top < 4) return null;
  // A bar at either end that runs the full height of the band (a window
  // edge beside the text) isn't text: leave it out.
  const full = x => { let a = 0, b = 0; for (let y = 0; y < 2; y++) { a += band[y * bw + x]; b += band[(bh - 1 - y) * bw + x]; } return a > 0.5 && b > 0.5; };
  for (let k = 0; k < 2; k++) {
    let x = span[1] - 1; while (x > span[0] && x > span[1] - 0.6 * (base - top + 1) && !full(x)) x--;
    if (x > span[0] + 4 && full(x)) { let z = x; while (z > span[0] && full(z)) z--; while (z > span[0]) { let c = 0; for (let y = 0; y < bh; y++) c += band[y * bw + z]; if (c > 0.3) break; z--; } span[1] = z + 1; }
  }
  // ...or one that reaches the bottom of the band (no letter does) and
  // stands apart from the text: also an edge, not a letter.
  if (feed) {
    const low = x => { let b = 0, n = 0; for (let y = 0; y < bh; y++) { const v = band[y * bw + x]; if (v > 0.4) n++; if (y >= bh - 2) b += v; } return b > 0.5 && n >= 0.4 * bh; };
    const ink = x => { let c = 0; for (let y = 0; y < bh; y++) c += band[y * bw + x]; return c; };
    const faint = 0.06 * bh;                                              // (haze between letters)
    let x = span[1] - 1; while (x > span[0] && ink(x) < faint) x--;
    let z = x; while (z > span[0] && ink(z - 1) >= faint) z--;        // the last blob: z..x
    let lows = 0; for (let c = z; c <= x; c++) if (low(c)) lows++;
    if (x - z + 1 <= 0.5 * (base - top + 1) && 2 * lows >= x - z + 1) {
      let g = z - 1; while (g > span[0] && ink(g) < faint) g--;
      if (z - g >= 3 && g > span[0] + 4) span[1] = g + 1;
    }
  }
  // Specks of the map just past either end of the text: leave them out.
  const xh = base - top + 1, m = [];
  for (let x = span[0]; x < span[1]; x++) { let c = 0; for (let y = 0; y < bh; y++) c += band[y * bw + x]; m.push(c); }
  const blobs = [];
  for (let i = 0; i < m.length;) {
    if (m[i] < 0.3) { i++; continue; }
    const s0 = i; let mass = 0; while (i < m.length && m[i] >= 0.3) mass += m[i++];
    blobs.push([s0, i, mass]);
  }
  if (blobs.length >= 4) {
    const med = blobs.map(b => b[2]).sort((p, q) => p - q)[blobs.length >> 1];
    let a = 0, z = blobs.length - 1;
    while (a < 2 && blobs[a][2] < 0.3 * med && blobs[a + 1][0] - blobs[a][1] >= 0.25 * xh) a++;
    while (z > blobs.length - 3 && blobs[z][2] < 0.3 * med && blobs[z][0] - blobs[z - 1][1] >= 0.25 * xh) z--;
    span[1] = span[0] + blobs[z][1]; span[0] += blobs[a][0];
  }
  return { n: span[1] - span[0], cols: columnLook(band, bw, bh, top, base, span[0], span[1]) };
}

function colInk(L, x) { let s = 0; for (let r = 0; r < LOOT_ROWS; r++) s += L[x * LOOT_ROWS + r]; return s; }
function lookResample(L, n) {
  const m = L.length / LOOT_ROWS, out = new Float32Array(n * LOOT_ROWS);
  for (let i = 0; i < n; i++) {
    const p = n > 1 ? i * (m - 1) / (n - 1) : 0, i0 = Math.floor(p), i1 = Math.min(i0 + 1, m - 1), w = p - i0;
    for (let r = 0; r < LOOT_ROWS; r++) out[i * LOOT_ROWS + r] = L[i0 * LOOT_ROWS + r] * (1 - w) + L[i1 * LOOT_ROWS + r] * w;
  }
  return out;
}
/** Soften by a column each way (keeping every `every`th column). */
function lookSoft(L, every = 1) {
  const m = L.length / LOOT_ROWS, n = Math.ceil(m / every), out = new Float32Array(n * LOOT_ROWS);
  for (let i = 0; i < n; i++) {
    const c = every * i;
    for (let r = 0; r < LOOT_ROWS; r++) {
      let s = L[c * LOOT_ROWS + r], wsum = 1;
      if (c > 0) { s += 0.5 * L[(c - 1) * LOOT_ROWS + r]; wsum += 0.5; }
      if (c < m - 1) { s += 0.5 * L[(c + 1) * LOOT_ROWS + r]; wsum += 0.5; }
      out[i * LOOT_ROWS + r] = s / 2;
    }
  }
  return out;
}
function lookDtw(A, B, band = 4, step = 0.3) {
  const n = A.length / LOOT_ROWS, m = B.length / LOOT_ROWS;
  let prev = new Float64Array(m + 1).fill(Infinity), cur = new Float64Array(m + 1);
  prev[0] = 0;
  for (let i = 1; i <= n; i++) {
    cur.fill(Infinity);
    const c = i * m / n, lo = Math.max(1, Math.floor(c - band)), hi = Math.min(m, Math.floor(c + band));
    for (let j = lo; j <= hi; j++) {
      let d = 0;
      for (let r = 0; r < LOOT_ROWS; r++) d += Math.abs(A[(i - 1) * LOOT_ROWS + r] - B[(j - 1) * LOOT_ROWS + r]);
      d *= 12 / LOOT_ROWS;
      cur[j] = d + Math.min(prev[j - 1], prev[j] + step, cur[j - 1] + step);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[m] / (n + m);
}

/** Names item lines by comparing them with candidate names drawn by
 *  `render(text) -> {w, h, a}` (a: 0-1 coverage, same baseline for all). */
export class LootMatcher {
  static COUNT_TAIL_MAX = 1.5;   // " earned. (Etc)" drawn worse than this: too unclear, call it x1
  static COUNT_BETTER = 0.92;     // a number other than 1 must fit this much better
  static KIND_RETRY = 0.55;    // a name fitting worse than this: try the other kinds too
  static SUFFIX_MAX = 1.86;    // fixed end "x1 earned. (Etc)" this close, or it's another line
  static COST_MAX = 0.95;      // a name this close, or it is left out
  static NAME_MAX = 95;        // names wider than this (pixels) are cut short
  static CLOSE = 30;           // names compared closely, of those about as wide
  static ENDS2 = false;        // also try the second likeliest end of the name (tried: wrong names)
  // the other messages in the same corner, to tell them from item lines
  static OTHER_ENDS = ["EXP (+63)", "EXP (+192)", "mesos (+70)", "mesos (+132)", "EXP (+7)", "mesos (+9)"];
  static OTHER = ["You received EXP (+63)", "You received EXP (+192)", "You have gained mesos (+70)",
                  "You have gained mesos (+132)", "Bonus EXP for PARTY (+10)", "Bonus EXP for PARTY (+7)"];

  constructor(render) {
    this.render = render; this.byType = {}; this.looks = new Map(); this.shown = new Map();
    const x = render("xo");
    [this.top, this.base] = xBand(x.a, x.w, x.h, 0.4);
  }
  /** items: [{id, name, type}] with type one of LOOT_TYPES. */
  setItems(items) {
    this.byType = {};
    for (const it of items) {
      const m = (this.byType[it.type] ||= new Map());
      if (!m.has(it.name)) m.set(it.name, it.id);
    }
  }
  get ready() { return Object.keys(this.byType).length > 0; }
  /** How the game writes a name: one wider than about 93 pixels is cut
   *  short with "..." ("Dark Stone Golem Rubble" -> "Dark Stone Gol...",
   *  "Blue Sauna Robe" -> "Blue Sauna Ro..."). Near the limit, try both. */
  shownAs(name) {
    let v = this.shown.get(name);
    if (!v) {
      const m = this.render.measure || (t => this.render(t).w - 8), W = LootMatcher.NAME_MAX;
      if (m(name) <= W - 3) v = [name];
      else {
        let k = name.length - 1;
        while (k > 1 && m(name.slice(0, k).trimEnd() + "...") > W) k--;
        const cut = name.slice(0, k).trimEnd() + "...";
        v = m(name) <= W + 4 ? [name, cut] : [cut];
      }
      this.shown.set(name, v);
    }
    return v;
  }
  textLook(text) {
    let l = this.looks.get(text);
    if (!l) {
      const r = this.render(text), span = inkSpan(r.a, r.w, r.h, 0.2);
      l = span ? columnLook(r.a, r.w, r.h, this.top, this.base, span[0], span[1]) : new Float32Array(0);
      this.looks.set(text, l);
    }
    return l;
  }
  /** Where the fixed end starts, its type and the scale. */
  /** Where the fixed end starts, its type and the scale: the best few
   *  readings (a scale can fit almost as well as the right one). */
  /** How well a template drawn n columns wide fits the line's end. */
  /** A drawn text stretched to n columns (kept: the same few are asked for
   *  again and again). */
  stretched(S, n) {
    let m = (this.stretch ||= new WeakMap()).get(S);
    if (!m) this.stretch.set(S, m = new Map());
    let r = m.get(n);
    if (!r) { r = lookResample(S, n); if (m.size > 300) m.clear(); m.set(n, r); }
    return r;
  }
  fitEnd(look, S, sn, n, type = null, count = "x1") {
    const O = look.cols, n0 = look.n;
    if (n + 6 >= n0 || n < 8) return null;
    const Sr = this.stretched(S, n);
    let best = null;
    for (let sh = 0; sh < 6; sh++) {
      const s0 = n0 - n - sh;
      let d = 0;
      for (let i = 0; i < n * LOOT_ROWS; i++) d += Math.abs(O[s0 * LOOT_ROWS + i] - Sr[i]);
      d /= n;
      if (!best || d < best.d) best = { d, k: n / sn, start: s0, type, wide: count !== "x1" };
    }
    return best;
  }
  /** How well the line's start fits an EXP or meso message ("You have
   *  gained mesos"), at any scale. */
  startsLikeOther(look) {
    const O = look.cols, n0 = look.n;
    let best = Infinity;
    for (const t of ["You have gained mesos", "You received EXP"]) {
      const S = this.textLook(t), sn = S.length / LOOT_ROWS, [lo, hi, step] = this.scales();
      for (let n = Math.round(lo * sn); n <= Math.round(hi * sn); n += step) {
        if (n + 4 >= n0) break;
        const Sr = this.stretched(S, n);
        for (let sh = 0; sh < 6; sh++) {
          let d = 0;
          for (let i = 0; i < n * LOOT_ROWS; i++) d += Math.abs(O[sh * LOOT_ROWS + i] - Sr[i]);
          d /= n;
          if (d < best) best = d;
        }
      }
    }
    return best;
  }
  /** How well the line's end fits an EXP or meso message, at any scale. */
  endsLikeOther(look) {
    let best = Infinity;
    for (const t of LootMatcher.OTHER_ENDS) {
      const S = this.textLook(t), sn = S.length / LOOT_ROWS, [lo, hi, step] = this.scales();
      for (let n = Math.round(lo * sn); n <= Math.round(hi * sn); n += step) {
        const f = this.fitEnd(look, S, sn, n);
        if (f && f.d < best) best = f.d;
      }
    }
    return best;
  }
  /** The sizes to try text at: any, or near the size item lines have had
   *  this session. -> [lowest, highest, step] (in drawn widths) */
  scales() {
    return this.kRef ? [0.92 * this.kRef, 1.08 * this.kRef, 1] : [1.3, 3.0, 2];
  }
  suffix(look, slack = 1.15) {
    const fit = (S, sn, n, type, count) => this.fitEnd(look, S, sn, n, type, count);
    const all = [];
    if (this.kRef) {
      // the size is known: every width near it
      for (const type of LOOT_TYPES) for (const count of ["x1", "x14"]) {
        const S = this.textLook(`${count} earned. (${type})`), sn = S.length / LOOT_ROWS;
        for (let n = Math.round(0.93 * this.kRef * sn); n <= Math.round(1.07 * this.kRef * sn); n++) { const f = fit(S, sn, n, type, count); if (f) all.push(f); }
      }
    } else {
    // coarse widths first, then every width near the best ones
    const coarse = [];
    for (const type of LOOT_TYPES) for (const count of ["x1", "x14"]) {
      const S = this.textLook(`${count} earned. (${type})`), sn = S.length / LOOT_ROWS;
      for (let n = Math.round(1.3 * sn); n <= Math.round(3.0 * sn); n += 3) {
        const h = fit(S, sn, n, type, count);
        if (h) coarse.push([h, S, sn, count]);
      }
    }
    coarse.sort((p, q) => p[0].d - q[0].d);
    for (const [h, S, sn, count] of coarse.slice(0, 8)) {
      const n = Math.round(h.k * sn);
      for (let m = n - 2; m <= n + 2; m++) { const f = fit(S, sn, m, h.type, count); if (f) all.push(f); }
    }
    }
    all.sort((p, q) => p.d - q.d);
    const picks = [];
    for (const h of all) {
      if (h.d > all[0].d * slack) break;
      const sameType = picks.filter(p => p.type === h.type);
      if (sameType.length >= 2 || picks.length >= 5) continue;
      if (sameType.every(p => Math.abs(Math.log(p.k / h.k)) > 0.04)) picks.push(h);
    }
    return picks;
  }
  /** Where the name ends: at the space before "x1". The drawn suffix
   *  only places it roughly (the game spaces "x1 earned." a little
   *  differently), so look for the gap itself near there. */
  static nameEnd(look, h, space) { return LootMatcher.nameEnds(look, h, space)[0][0]; }
  /** -> [[end, extra cost], ...]: the likeliest space, and the next one if
   *  it is nearly as likely (within a few letters). */
  static nameEnds(look, h, space) {
    const guess = Math.round(h.start - h.k * space), L = look.cols;
    const lo = Math.max(1, Math.round(guess - 6 * h.k)), hi = Math.min(look.n - 1, Math.round(h.start + 8 * h.k));
    const found = [];
    for (let x = lo; x < hi;) {
      if (colInk(L, x) >= 0.05) { x++; continue; }
      const g0 = x; while (x < hi && colInk(L, x) < 0.05) x++;
      if (x - g0 >= 1.2 * h.k) {                         // a space, not just the gap between letters
        found.push({ d: Math.abs(x - (h.start)) + 0.5 * Math.abs(g0 - guess), e: g0 });
      }
    }
    // A speck of the map can sit in the space: also the faintest stretch a
    // space wide (a little less likely).
    if (LootMatcher.ENDS2) {
      const wd = Math.max(2, Math.round(1.2 * h.k));
      let soft = null;
      for (let x = lo; x + wd <= hi; x++) {
        let m = 0; for (let c = x; c < x + wd; c++) m += colInk(L, c);
        m /= wd;
        if (m < 0.6 && (!soft || m < soft.m)) soft = { m, x };
      }
      if (soft && !found.some(f => Math.abs(f.e - soft.x) <= wd))
        found.push({ d: Math.abs(soft.x + wd - h.start) + 0.5 * Math.abs(soft.x - guess) + 2, e: soft.x });
    }
    if (!found.length) return [[guess, 0]];
    found.sort((p, q) => p.d - q.d);
    const out = [[found[0].e, 0]];
    if (LootMatcher.ENDS2 && found[1] && found[1].d - found[0].d < 6 * h.k) out.push([found[1].e, 0.04]);
    return out;
  }
  /** Name an item from one or more looks of its line.
   *  -> {name, id, type, cost, margin} or null */
  identify(looks, known = null, kRef = null) {
    if (!this.ready || !looks.length) return null;
    this.kRef = kRef;
    try {
      const r = this.identify1(looks, known, kRef);
      if (!kRef || (r && r.item)) return r;
      // Not an item line at the usual size. If it reads clearly at another
      // size, the size has changed (or was learned wrong): trust the line.
      this.kRef = null;
      const r2 = this.identify1(looks, known, null);
      return r2 && r2.ok && r2.cost < 0.62 && r2.margin > 0.04 ? r2 : r;
    } finally { this.kRef = null; }
  }
  identify1(looks, known, kRef) {
    // the space before "x1", in drawn columns
    const space = (this.textLook("a x1 earned. (Etc)").length - this.textLook("x1 earned. (Etc)").length - this.textLook("a").length) / LOOT_ROWS;
    const parts = [];
    for (const look of looks) {
      let hs = this.suffix(look);
      // Every item line in a session is drawn at the same size: a reading
      // at some other size is the wrong reading (or not an item line).
      if (kRef) hs = hs.filter(h => Math.abs(Math.log(h.k / kRef)) < 0.07);
      if (hs.length) parts.push([look, hs]);
    }
    if (!parts.length) return null;
    // A track can slip onto a neighbouring line for a frame or two: a look
    // that reads as another message ("You have gained mesos (+17)") is
    // left out, as long as most of the looks are item lines.
    const isOther = ([look, hs]) => this.endsLikeOther(look) < hs[0].d || this.startsLikeOther(look) < 1.5;
    const mine = parts.filter(p => !isOther(p));
    const mixed = mine.length && 2 * mine.length >= parts.length && mine.length < parts.length;
    if (mixed) parts.splice(0, parts.length, ...mine);
    // The kind in brackets ("(Etc)" or "(Use)") can be a near thing on a
    // blurry line: try each kind that fits about as well, keep the best.
    const kinds = new Set();
    for (const [, hs] of parts) for (const h of hs) if (h.d <= hs[0].d * 1.12) kinds.add(h.type);
    let res = null;
    for (const type of kinds) {
      const r = this.identifyAs(type, parts, known, space);
      if (r && (!res || r.cost < res.cost)) res = r;
    }
    // Something over the end of the line (a mob, a speck) can hide the kind
    // in brackets, so the wrong kind fits best there. The rest of the line
    // ("x1 earned. (") is the same for every kind: if the name reads poorly,
    // try the other kinds' names at the same spot, and keep a much better fit.
    if (res && res.cost > LootMatcher.KIND_RETRY) {
      for (const type of LOOT_TYPES) {
        if (kinds.has(type)) continue;
        const r = this.identifyAs(type, parts.map(([look, hs]) => [look, hs.map(h => ({ ...h, type }))]), known, space);
        if (r && r.cost < LootMatcher.KIND_RETRY && r.cost < res.cost - 0.12) res = r;
      }
    }
    // A track that wandered between lines must read clearly to count.
    if (res && mixed && (res.cost > 0.7 || res.margin < 0.05)) res.ok = false;
    if (res && res.type && res.k) res.count = this.countOf(parts.map(p => p[0]), res.type, res.k);
    return res;
  }
  /** How many came in the stack: the number in "x10 earned. (Etc)". The
   *  fixed " earned. (Etc)" places the line; then the part before it ("x10")
   *  is drawn with each digit in turn and compared on its own, at the
   *  line's size. "x1" is by far the commonest: another number must fit
   *  clearly better. The looks vote. */
  countOf(looks, type, k) {
    const votes = new Map();
    for (const look of looks.slice(0, 3)) {
      const T = this.textLook(`earned. (${type})`), tn = T.length / LOOT_ROWS;
      let tail = null;
      for (let n = Math.round(k * tn) - 1; n <= Math.round(k * tn) + 1; n++) { const f = this.fitEnd(look, T, tn, n); if (f && (!tail || f.d < tail.d)) tail = f; }
      if (!tail || tail.d > LootMatcher.COUNT_TAIL_MAX) { votes.set("1", (votes.get("1") || 0) + 1); continue; }
      const end = tail.start + Math.round(tail.k * tn), kk = tail.k;
      const fit = digits => {
        const S = this.textLook(`x${digits} earned. (${type})`), sn = S.length / LOOT_ROWS;
        let best = null;
        for (let n = Math.round(kk * sn) - 1; n <= Math.round(kk * sn) + 1; n++) {
          const w = n - Math.round(kk * tn), Sr = this.stretched(S, n);
          for (let sh = -1; sh <= 1; sh++) {
            const s0 = end - n + sh;
            if (s0 < 0 || w < 4) continue;
            let d = 0;
            for (let i = 0; i < w * LOOT_ROWS; i++) d += Math.abs(look.cols[s0 * LOOT_ROWS + i] - Sr[i]);
            d /= w;
            if (best === null || d < best) best = d;
          }
        }
        return best;
      };
      const one = fit("1");
      let best = { d: one, s: "1" };
      for (let D = 1; D <= 3; D++) {
        const ds = ["1", ...Array(D - 1).fill("0")];
        let cur = null;
        for (let pass = 0; pass < (D === 1 ? 1 : 2); pass++) for (let j = 0; j < D; j++) {
          for (const c of j === 0 ? "123456789" : "0123456789") {
            const t = [...ds]; t[j] = c;
            const d = fit(t.join(""));
            if (d !== null && (!cur || d < cur.d)) cur = { d, s: t.join("") };
          }
          if (cur) ds.splice(0, D, ...cur.s);
        }
        if (cur && cur.d < best.d) best = cur;
      }
      if (best.s !== "1" && !(best.d < one * LootMatcher.COUNT_BETTER)) best = { d: one, s: "1" };
      if (globalThis.COUNT_DEBUG) globalThis.COUNT_DEBUG.push({ tail: tail.d, one, best });
      votes.set(best.s, (votes.get(best.s) || 0) + 1);
    }
    let n = 1, v = 0;
    for (const [s, w] of votes) if (w > v) { v = w; n = Number(s); }
    return n;
  }
  /** How well a text drawn at size k (give or take a column) fits the line's end. */
  fitText(look, text, k) {
    const S = this.textLook(text), sn = S.length / LOOT_ROWS, n0 = Math.round(k * sn);
    let best = null;
    for (let n = n0 - 1; n <= n0 + 1; n++) { const f = this.fitEnd(look, S, sn, n); if (f && (best === null || f.d < best)) best = f.d; }
    return best;
  }
  identifyAs(type, parts, known, space) {
    const names = this.byType[type];
    if (!names) return null;
    const totals = new Map(), wfits = new Map(), favs = []; let used = 0;
    for (const [look, hs] of parts) {
      const best = new Map();                         // per name, over the scale readings
      let any = false;
      for (const h of hs) {
        if (h.type !== type) continue;
        // the name ends a space before the "x1" (or "x14"); if specks of
        // the map blur that space, the next likeliest space is tried too
        for (const [e, ep] of LootMatcher.nameEnds(look, h, space)) {
        if (e < 8) continue;
        any = true;
        // A speck of the map left of the name can join the line: also try
        // starting after it.
        const starts = [0];
        {
          const blobs = [];
          for (let x = 0; x < e; x++) {
            const v = colInk(look.cols, x);
            if (v < 0.05) continue;
            const last = blobs[blobs.length - 1];
            if (last && last.x1 === x) { last.x1 = x + 1; last.m += v; } else blobs.push({ x0: x, x1: x + 1, m: v });
          }
          const ms = blobs.slice(0, 8).map(b => b.m).sort((p, q) => p - q), med = ms[ms.length >> 1] || 0;
          for (let i = 0; i < 2 && i + 1 < blobs.length; i++) {
            if (blobs[i].m >= 0.35 * med || blobs[i + 1].x0 > 0.2 * e) break;
            starts.push(blobs[i + 1].x0);
          }
        }
        const obs = starts.map(x0 => lookSoft(look.cols.subarray(x0 * LOOT_ROWS, e * LOOT_ROWS)));
        // a reading of the end that fits less well costs a little
        const hp = 0.5 * (h.d - hs[0].d) + ep;
        // Every name about as wide as the line: a rough comparison at half
        // the detail first, then a close one for the likeliest few.
        const cands = [];
        for (const name of names.keys()) {
          if (!best.has(name)) best.set(name, 1.2);   // too wide or narrow: a fixed cost
          for (const shown of this.shownAs(name)) {
            const R = this.textLook(shown), rn = R.length / LOOT_ROWS;
            if (!rn) continue;
            starts.forEach((x0, i) => {
              const wpen = Math.abs(Math.log((e - x0) / (h.k * rn)));
              if (wpen <= 0.12) cands.push({ name, R, x0, i, wpen, extra: 2 * wpen + (i ? 0.02 : 0) + hp });
            });
          }
        }
        const half = starts.map(x0 => lookSoft(look.cols.subarray(x0 * LOOT_ROWS, e * LOOT_ROWS), 2));
        for (const c of cands) c.d = lookDtw(half[c.i], lookSoft(lookResample(c.R, c.x0 === undefined ? e : e - c.x0), 2), 2) + c.extra;
        cands.sort((p, q) => p.d - q.d);
        for (const c of cands.slice(0, LootMatcher.CLOSE)) {
          const d = lookDtw(obs[c.i], lookSoft(lookResample(c.R, e - c.x0))) + c.extra;
          if (d < best.get(c.name)) { best.set(c.name, d); wfits.set(c.name, c.wpen); }
        }
        }
      }
      if (!any) continue;
      used++;
      for (const [name, c] of best) totals.set(name, (totals.get(name) || 0) + c);
      // (each look's own favourite, to notice a track that mixed two lines)
      let fav = null; for (const [name, c] of best) if (!fav || c < fav[1]) fav = [name, c];
      favs.push(fav && fav[0]);
    }
    if (!used) return null;
    // Items already picked up this session or on this map are likelier.
    // Items already picked up are likelier, the more often the likelier.
    if (known) for (const [name, c] of totals) if (known.has(name)) totals.set(name, c - (known.get?.(name) ?? 0.02) * used);
    // Quest items (403xxxx) look the same as monster drops when cut short
    // ("Glowing Mushr..."): the drop is the likelier one.
    for (const [name, c] of totals) { const id = names.get(name); if (id >= 4030000 && id < 4040000) totals.set(name, c + 0.005 * used); }
    const ranked = [...totals.entries()].sort((a, b) => a[1] - b[1]);
    const [name, cost] = ranked[0], second = ranked[1] ? ranked[1][1] : Infinity;
    const sd = parts.reduce((a, [, hs]) => a + hs[0].d, 0) / parts.length;
    // Doesn't end in "earned. (Etc)" after all, or reads better as one of
    // the other messages ("You received EXP (+63)"): not an item.
    // (on a busy or pale background the end reads worse: one name standing
    // well clear of the rest, closely matched, makes up for that)
    const c1 = cost / used, m1 = (second - cost) / used;
    let item = sd < LootMatcher.SUFFIX_MAX || (sd < 1.95 && (c1 <= 0.8 && m1 >= 0.04 || c1 <= 0.9 && m1 >= 0.15)) || (sd < 2.2 && c1 <= 0.65 && m1 >= 0.15);
    // ...and its end must look more like "earned. (Etc)" than "EXP (+63)"
    if (item) {
      let other = 0;
      for (const [look, hs] of parts) if (this.endsLikeOther(look) < hs[0].d || this.startsLikeOther(look) < 1.5) other++;
      if (2 * other > parts.length) item = false;
    }
    if (item) {
      const whole = (look, text) => { const R = this.textLook(text); return R.length ? lookDtw(lookSoft(look.cols), lookSoft(lookResample(R, look.n))) : 9; };
      const shown = this.shownAs(name);
      let asItem = 0, asOther = 0;
      for (const [look] of parts) {
        asItem += Math.min(...shown.map(t => whole(look, `${t} x1 earned. (${type})`)));
        asOther += Math.min(...LootMatcher.OTHER.map(t => whole(look, t)));
      }
      if (asOther < asItem) item = false;
    }
    const wfit = wfits.get(name) ?? 1;
    // Looks that each prefer another name: the track followed two lines.
    const agree = favs.filter(f => f === name).length, split = favs.length >= 2 && 2 * agree < favs.length;
    return { name, id: names.get(name), type, cost: cost / used, margin: (second - cost) / used, second: ranked[1]?.[0], sd, item, wfit, split, favs,
             ok: item && cost / used < LootMatcher.COST_MAX, ks: parts.map(([, hs]) => +hs[0].k.toFixed(2)),
             k: parts.reduce((a, [, hs]) => a + hs[0].k, 0) / parts.length };
  }

}

// ---------------------------------------------------------------- the map
//
// The minimap window (usually top left) has the street and map name under
// its title bar: "Victoria Road" / "East Rocky Mountain III", in white
// bold letters. Its orange WORLD button and the white title field beside
// it are easy to find.

/** Find the minimap's WORLD button and title field.
 *  -> {button: [x, y, w, h], fieldLeft} or null */
export function findMinimap(img) {
  const { w, data } = img, h = Math.floor(img.h * 0.6);
  // the WORLD button's gold
  const m = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    const r = data[j], g = data[j + 1], b = data[j + 2];
    if (r < 150 || r - b < 70 || g > r) continue;
    const [H, S] = hsv(r, g, b);
    m[i] = H >= 13 && H <= 24 && S >= 100 ? 1 : 0;      // (hue in half degrees)
  }
  const closed = morph(morph(m, w, h, true), w, h, false);
  let best = null;
  for (const c of components(closed, w, h)) {
    const bw = c.w, bh = c.h, x = c.x, y = c.y;
    if (bh < 7 || bh > 70 || bw / bh < 1.8 || bw / bh > 4.8 || c.area < 0.3 * bw * bh) continue;
    // the title field: white with dark letters, left of the -/+ buttons
    const fy = Math.round(y + bh / 2);
    let fx = -1, white = 0, n = 0, miss = 0;
    for (let xx = x - Math.round(1.2 * bw); xx > Math.max(0, x - 14 * bw); xx--) {
      const i = (fy * w + xx) * 4, mn = Math.min(data[i], data[i + 1], data[i + 2]), mx = Math.max(data[i], data[i + 1], data[i + 2]);
      const ok = mx - mn < 30 && mn > 70;     // white, or the grey "MINI MAP" letters
      if (ok) { n++; if (mn > 200) white++; fx = xx; miss = 0; }
      else if (n > 0 && ++miss > 0.3 * bh) break;
    }
    if (n < 1.5 * bw || white / n < 0.6) continue;
    // under the title bar: the window's steel blue
    let blue = 0, tot = 0;
    for (let yy = Math.round(y + 2 * bh); yy < Math.min(h, y + 5 * bh); yy += 2) for (let xx = fx; xx < x; xx += 3) {
      const i = (yy * w + xx) * 4, r = data[i], g = data[i + 1], bl = data[i + 2];
      tot++; if (bl - r >= 25 && bl - r <= 90 && g > 130 && g < 225) blue++;
    }
    if (!tot || blue / tot < 0.3) continue;
    if (!best || n > best.n) best = { button: [x, y, bw, bh], fieldLeft: fx, n };
  }
  return best;
}

/** The two title lines (street, then map) as looks: [street, map] or null. */
export function minimapTitle(img, mm) {
  const [bx, by, bw, bh] = mm.button;
  const x0 = Math.max(0, Math.round(mm.fieldLeft - 6 * bh)), y0 = Math.round(by + 1.4 * bh);
  const y1 = Math.min(img.h, Math.round(by + 5.6 * bh));
  // the window is as wide as its title: look a little right of the button too
  const x1 = Math.min(img.w, Math.round(bx + bw + 1.5 * bh));
  const W = x1 - x0, H = y1 - y0;
  if (W < 10 || H < 10) return null;
  // white, unsaturated letters on the steel blue
  const ink = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = ((y0 + y) * img.w + x0 + x) * 4, r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
    const mn = Math.min(r, g, b), mx = Math.max(r, g, b);
    ink[y * W + x] = mx - mn < 45 ? Math.min(1, Math.max(0, (mn - 190) / 45)) : 0;
  }
  // window edges: columns lit from top to bottom
  for (let x = 0; x < W; x++) {
    let lit = 0; for (let y = 0; y < H; y++) if (ink[y * W + x] > 0.3) lit++;
    if (lit > 0.7 * H) for (let y = 0; y < H; y++) ink[y * W + x] = 0;
  }
  // the two text lines: runs of rows with ink
  const rowInk = new Float32Array(H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) rowInk[y] += ink[y * W + x];
  const thr = Math.max(1.5, 0.08 * Math.max(...rowInk)), bands = [];
  for (let y = 0; y < H;) {
    if (rowInk[y] < thr) { y++; continue; }
    const s0 = y; let mass = 0; while (y < H && rowInk[y] >= thr) mass += rowInk[y++];
    if (y - s0 >= 0.35 * bh) bands.push({ y0: s0, y1: y, mass });
  }
  if (bands.length < 2) return null;
  const two = bands.sort((p, q) => q.mass - p.mass).slice(0, 2).sort((p, q) => p.y0 - q.y0);
  // The emblem sits in a dark frame: text starts right of it.
  let frame = -1;
  {
    const ty0 = two[0].y0, ty1 = two[1].y1;
    for (let x = Math.floor(0.6 * W); x >= 0; x--) {
      let dark = 0;
      for (let y = ty0; y < ty1; y++) {
        const i = ((y0 + y) * img.w + x0 + x) * 4;
        if (Math.max(img.data[i], img.data[i + 1], img.data[i + 2]) < 110) dark++;
      }
      if (dark >= 0.4 * (ty1 - ty0)) { frame = x; break; }
    }
  }
  // per line: its pieces of ink
  const lines = two.map(bd => {
    const lh = bd.y1 - bd.y0, col = new Float32Array(W);
    for (let y = bd.y0; y < bd.y1; y++) for (let x = 0; x < W; x++) col[x] += ink[y * W + x];
    const blobs = [];
    for (let x = frame + 1; x < W;) {
      if (col[x] < 0.3) { x++; continue; }
      const s0 = x; let m = 0; while (x < W && col[x] >= 0.3) m += col[x++];
      if (m >= 0.6 * lh) blobs.push([s0, x]);          // (not a stray speck)
    }
    if (!blobs.length) return null;
    let a = 0, e = blobs.length - 1;
    if (frame >= 0) {
      // words left to right from the emblem; a wide gap ends the line
      let k = 0; while (k + 1 < blobs.length && blobs[k + 1][0] - blobs[k][1] <= 1.6 * lh) k++;
      e = k;
    } else {
      // no emblem frame seen: words right to left, up to a wide gap
      a = e; while (a > 0 && blobs[a][0] - blobs[a - 1][1] <= 0.8 * lh) a--;
    }
    return { bd, lh, blobs, xa: blobs[a][0], xe: blobs[e][1] };
  });
  if (lines.includes(null)) return null;
  // Both lines start at the same spot: an emblem sticking out into one
  // line makes that one start early.
  const start = Math.max(lines[0].xa, lines[1].xa);
  const looks = [];
  for (const ln of lines) {
    const first = ln.blobs.find(b => b[1] > start + 1);
    const xa = first ? Math.max(first[0], start) : start, xe = ln.xe;
    const pad = Math.round(0.35 * ln.lh), ya = Math.max(0, ln.bd.y0 - pad), yb = Math.min(H, ln.bd.y1 + pad), sh = yb - ya;
    if (xe - xa < 4) return null;
    const band = new Float32Array((xe - xa) * sh);
    for (let y = 0; y < sh; y++) for (let x = xa; x < xe; x++) band[y * (xe - xa) + x - xa] = ink[(ya + y) * W + x];
    const l = bandLook({ band, bw: xe - xa, bh: sh });
    if (!l) return null;
    looks.push(l);
  }
  return looks;
}

/** Names the map from its minimap title by drawing every street and map
 *  name (bold) and comparing, like item names. maps: [{id, street, name}] */
export class MapMatcher {
  static COST_MAX = 1.1;       // a name this close, or the map stays unknown
  constructor(render, measure = null) {
    this.render = render; this.measure = measure || (t => render(t, true).w);
    this.maps = []; this.looks = new Map(); this.widths = new Map();
    const x = render("xo", true);
    [this.top, this.base] = xBand(x.a, x.w, x.h, 0.4);
  }
  setMaps(maps) {
    const seen = new Set();
    this.maps = maps.filter(m => { const k = m.street + "|" + m.name; if (!m.name || seen.has(k)) return false; seen.add(k); return true; });
  }
  get ready() { return this.maps.length > 0; }
  width(t) { let w = this.widths.get(t); if (w === undefined) { w = this.measure(t); this.widths.set(t, w); } return w; }
  textLook(t) {
    let l = this.looks.get(t);
    if (!l) {
      const r = this.render(t, true), span = inkSpan(r.a, r.w, r.h, 0.2);
      l = span ? columnLook(r.a, r.w, r.h, this.top, this.base, span[0], span[1]) : new Float32Array(0);
      this.looks.set(t, l);
    }
    return l;
  }
  /** How well a line matches a name drawn at scale k (or stretched to fit). */
  cost(look, text, k = null) {
    const R = this.textLook(text), rn = R.length / LOOT_ROWS;
    if (!rn) return 1.5;
    const n = k ? Math.max(4, Math.round(k * rn)) : look.n;
    const Rn = lookResample(R, n);
    let c = lookDtw(lookSoft(look.cols), lookSoft(Rn), Math.max(4, Math.abs(n - look.n) + 3));
    if (k) {
      // Names often differ only at the end ("Sleepy Dungeon I" / "V"): look
      // at the last few letters on their own as well.
      const ta = Math.max(3, Math.round(0.22 * look.n)), tb = Math.max(3, Math.round(0.22 * n));
      c += 0.5 * lookDtw(lookSoft(look.cols.subarray((look.n - ta) * LOOT_ROWS)), lookSoft(Rn.subarray((n - tb) * LOOT_ROWS)), Math.max(3, Math.abs(ta - tb) + 2));
    }
    return c;
  }
  /** [streetLook, mapLook] -> {id, street, name, cost, margin} or null */
  identify([sl, nl]) {
    if (!this.ready) return null;
    // Both lines share one scale (even on a stretched screen), so the
    // ratio of their widths has to match the drawn names'.
    const ratio = nl.n / sl.n, sc = new Map(), nc = new Map();
    const ranked = [];
    for (const m of this.maps) {
      const ws = this.width(m.street || " "), wn = this.width(m.name);
      if (!ws || !wn) continue;
      const rp = Math.abs(Math.log(ratio / (wn / ws)));
      if (rp > 0.14) continue;
      if (!sc.has(m.street)) sc.set(m.street, this.cost(sl, m.street));
      // the map name drawn at the street name's scale
      const ls = this.textLook(m.street).length / LOOT_ROWS, k = ls ? sl.n / ls : null;
      const key = m.name + "|" + (k ? k.toFixed(2) : "");
      if (!nc.has(key)) nc.set(key, this.cost(nl, m.name, k));
      ranked.push([sc.get(m.street) + nc.get(key), m]);
    }
    if (!ranked.length) return null;
    ranked.sort((p, q) => p[0] - q[0]);
    const [cost, m] = ranked[0];
    const other = ranked.find(r => r[1].name !== m.name);
    return { ...m, cost: cost / 2, margin: other ? (other[0] - cost) / 2 : 1 };
  }
}

// ------------------------------------------------------------ text pictures
/** Draws text from a glyph atlas (pictures of each letter of Liberation
 *  Sans 12px, Arial's twin): the same picture on every computer, unlike a
 *  browser's own font drawing. -> render(text, bold) -> {w, h, a} */
export function atlasRenderer(atlas) {
  const cache = { regular: {}, bold: {} };
  const glyph = (set, ch) => {
    const c = cache[set];
    if (!(ch in c)) {
      const g = atlas[set].glyphs[ch] || atlas[set].glyphs["?"];
      const [adv, x0, w, b64] = g, bin = b64 ? atob(b64) : "";
      const data = new Float32Array(bin.length);
      for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i) / 255;
      c[ch] = { adv, x0, w, data };
    }
    return c[ch];
  };
  // The game draws with whole-pixel letter widths and no kerning (like
  // Windows' own Arial at 12px), which makes words a little wider.
  const layout = (text, set) => {
    const xs = [];
    let pen = 0;
    for (let i = 0; i < text.length; i++) { xs.push(pen); pen += Math.round(glyph(set, text[i]).adv); }
    return { xs, width: pen };
  };
  const render = (text, bold = false) => {
    const set = bold ? "bold" : "regular", H = atlas[set].h;
    const { xs, width } = layout(text, set);
    const W = Math.ceil(width) + 8, a = new Float32Array(W * H);
    for (let i = 0; i < text.length; i++) {
      const g = glyph(set, text[i]);
      const ox = Math.round(4 + xs[i]) + g.x0;
      for (let y = 0; y < H; y++) for (let x = 0; x < g.w; x++) {
        const X = ox + x;
        if (X >= 0 && X < W) a[y * W + X] = Math.min(1, a[y * W + X] + g.data[y * g.w + x]);
      }
    }
    return { w: W, h: H, a };
  };
  render.measure = (text, bold = false) => layout(text, bold ? "bold" : "regular").width;
  return render;
}
