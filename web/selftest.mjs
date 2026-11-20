// Quick checks run before each publish: node web/selftest.mjs
import * as E from "./engine.js";
import { SEEDS } from "./seeds.js";
import { MESO_SEEDS } from "./seeds-meso.js";
import { FEED_SEEDS } from "./seeds-feed.js";
let fail = 0;
const check = (name, ok) => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}`); if (!ok) fail++; };
const table = { 1: 15, 5: 135, 6: 372, 10: 1716, 20: 20216, 30: 95700, 49: 655200, 50: 709716, 51: 748608, 60: 1209994, 70: 2062925, 89: 5684790 };
check("EXP table matches MeowDB", Object.entries(table).every(([l, v]) => E.expToNext(Number(l)) === v));
check("level from EXP amount", E.levelFromAmount(108229, 16.52) === 49);
const parse = { "65.99%": [null, 65.99], "152.2257.00%": [152225, 7], "1218.629 33 37%": [218629, 33.37],
  "74.60714.98%": [74607, 4.98], "?5.99%": null, "152.225 9.00%": null };
for (const [t, want] of Object.entries(parse)) check(`parse ${JSON.stringify(t)}`, JSON.stringify(E.parseHudText(t)) === JSON.stringify(want));
check("parse meso", E.parseMeso("2.668.039") === 2668039 && E.parseMeso("2 668 039") === 2668039 && E.parseMeso("2.6?8.039") === null);
const r = new E.DigitReader(SEEDS);
let hits = 0, total = 0;
for (const [c, list] of Object.entries(SEEDS)) for (const v of list) { total++; if (r.classify(Float32Array.from(v))[0] === c) hits++; }
check(`HUD digit examples recognise themselves (${hits}/${total})`, hits === total);
check("meso examples present", Object.keys(MESO_SEEDS).length >= 6);
// A noisy percentage-only session: ~1% error at most.
const t = new E.PctTracker(30); let pct = 40, rnd = 7;
const rand = () => (rnd = (rnd * 16807) % 2147483647) / 2147483647;
for (let i = 0; i < 3000; i++) {
  pct += 0.01 + rand() * 0.02;
  if (pct >= 100) pct -= 100;
  const shown = Math.floor(pct * 100) / 100;
  t.update(rand() < 0.05 ? null : rand() < 0.03 ? shown + 5 : shown);
}
const truth = (100 - 40) / 100 * E.expToNext(30) + (pct) / 100 * E.expToNext(31);
check(`percentage tracker within 2% (${(t.gained / truth * 100 - 100).toFixed(2)}%)`, Math.abs(t.gained / truth - 1) < 0.02 && t.levels === 1);
// Pickup messages: a simulated feed (newest at the bottom, 6 lines shown,
// bright for a second then fading, bursts of several lines between looks,
// repeated values), read 10 times a second. Every meso must count once.
{
  const ft = new E.FeedTracker();
  let feed = [], truthMesos = 0, rnd2 = 11, now = 0;
  const rand2 = () => (rnd2 = (rnd2 * 16807) % 2147483647) / 2147483647;
  const kinds = ["exp", "party", "meso", "meso", "item"];
  for (let step = 0; step < 3000; step++) {
    now += 100;
    const burst = rand2() < 0.12 ? 1 + Math.floor(rand2() * 4) : 0;
    for (let b = 0; b < burst; b++) {
      const type = kinds[Math.floor(rand2() * kinds.length)];
      const value = type === "item" ? null : [10, 11, 12, 25, 3, 8][Math.floor(rand2() * 6)];
      if (type === "meso") truthMesos += value;
      feed.unshift({ type, value, born: now });
    }
    feed = feed.filter(l => now - l.born < 1500).slice(0, 6);
    const obs = feed.map((l, slot) => {
      const age = now - l.born, fade = age < 900 ? 1 : 1 - (age - 900) / 700;
      const strength = 140 * fade * (slot > 3 ? 0.85 : 1);
      if (strength < 85) return null;
      return { slot, strength, type: l.type, value: l.value, sure: strength > 120 };
    }).filter(Boolean);
    ft.update(now, obs);
  }
  for (let k = 0; k < 30; k++) { now += 100; ft.update(now, []); }
  check(`pickup tracker counts every meso once (${ft.mesos} of ${truthMesos})`, ft.mesos === truthMesos);
}
check("feed digit examples present", Object.keys(FEED_SEEDS).length >= 10);
// Level-up from 98% of level 49 to 0.3% of level 50: the new level is 50
// (from 0.3%, the amount alone would fit several levels).
{
  const t = new E.ExpTracker(), r49 = E.expToNext(49), r50 = E.expToNext(50);
  const rd = (lv, p) => [Math.round(E.expToNext(lv) * p / 100), p];
  for (const p of [98.19, 98.19, 98.19, 98.5, 99.2]) t.update(rd(49, p));
  for (let i = 0; i < 4; i++) t.update(rd(50, 0.3));
  check(`level after a level-up is known (${t.level})`, t.level === 50 && t.levels === 1);
}
// Item names: drawn from the glyph pictures, a line of text matches its own
// drawing better than a look-alike name.
{
  const { GLYPHS } = await import("./glyphs.js");
  const render = E.atlasRenderer(GLYPHS), w = render.measure("Mushroom Spore");
  const M = new E.LootMatcher(render);
  M.setItems([["Mushroom Spore"], ["Red Snail Shell"], ["Squishy Liquid"], ["Tree Branch"]].map(([name], i) => ({ id: i, name, type: "Etc" })));
  // the drawing itself, doubled in size like a screen picture, as the line
  const r = render("Squishy Liquid x1 earned. (Etc)"), bw = r.w * 2, bh = r.h * 2, band = new Float32Array(bw * bh);
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) band[y * bw + x] = r.a[(y >> 1) * r.w + (x >> 1)];
  const got = M.identify([E.bandLook({ band, bw, bh })]);
  check(`item names from glyph pictures (${Math.round(w)}px, read "${got?.name}")`, Math.abs(w - 94) < 2 && got?.name === "Squishy Liquid" && got.item);
  // stack sizes: "x10" adds 10
  const counts = ["x1", "x10", "x6", "x23", "x3"].map(q => {
    const r = render(`Tree Branch ${q} earned. (Etc)`), bw = r.w * 2, bh = r.h * 2, band = new Float32Array(bw * bh);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) band[y * bw + x] = r.a[(y >> 1) * r.w + (x >> 1)];
    return M.identify([E.bandLook({ band, bw, bh })])?.count;
  });
  check(`stack sizes from glyph pictures (${counts.join(" ")})`, counts.join(" ") === "1 10 6 23 3");
}
// Shop sales: an inventory rise with no meso pickup message isn't earnings.
{
  const s = new E.Session(null, { feedReader: {} });
  s.mesoLineAt = 1000; s.invHeld.push({ at: 2000, d: 37 }); s.settleInv(2000);          // a pickup
  s.invHeld.push({ at: 60000, d: 5200 }); s.settleInv(61000);                           // waiting
  const waiting = s.invHeld.length === 1 && s.mesoGained === 37;
  s.settleInv(63500);                                                                   // a sale
  s.invHeld.push({ at: 64000, d: 800 }); s.settleInv(67500);                            // another
  s.invHeld.push({ at: 90000, d: 25 }); s.mesoLineAt = 91000; s.settleInv(91000);       // message after
  const noFeed = new E.Session(null); noFeed.invHeld.push({ at: 0, d: 500 }); noFeed.settleInv(0);
  check(`shop sales left out of mesos (gained ${s.mesoGained}, sold ${s.mesoSold})`,
    waiting && s.mesoGained === 62 && s.mesoSold === 6000 && s.events.filter(e => /no pickup/.test(e.text)).length === 1
    && noFeed.mesoGained === 500);
}
console.log(fail ? `RESULT: FAIL (${fail})` : "RESULT: PASS");
process.exit(fail ? 1 : 0);
