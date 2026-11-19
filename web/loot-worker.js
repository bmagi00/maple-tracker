// Names picked-up items away from the page, so that reading the screen
// never waits on it (naming one line takes a tenth of a second or so).
// The page sends the item list once, then one line at a time.
import { LootMatcher, atlasRenderer } from "./engine.js?v=__VERSION__";
import { GLYPHS } from "./glyphs.js?v=__VERSION__";

const matcher = new LootMatcher(atlasRenderer(GLYPHS));
onmessage = ({ data: m }) => {
  if (m.items) { matcher.setItems(m.items); return; }
  try {
    postMessage({ id: m.id, r: matcher.identify(m.looks, m.known, m.kRef) });
  } catch (e) {
    postMessage({ id: m.id, error: String(e) });
  }
};
