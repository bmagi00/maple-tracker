// Quick checks run before each publish: node web/selftest.mjs
import * as E from "./engine.js";
import { SEEDS } from "./seeds.js";
import { MESO_SEEDS } from "./seeds-meso.js";
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
console.log(fail ? `RESULT: FAIL (${fail})` : "RESULT: PASS");
process.exit(fail ? 1 : 0);
