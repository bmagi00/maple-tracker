# Glyph pictures of Liberation Sans (Arial's metric twin) at 12px, regular
# and bold, as the game's text is drawn. Composing names from these gives the
# same picture on every computer.
import json, base64, numpy as np, sys
from PIL import Image, ImageDraw, ImageFont
out = {}
for key, fn in [("regular", "Regular"), ("bold", "Bold")]:
    font = ImageFont.truetype(f"/usr/share/fonts/truetype/liberation/LiberationSans-{fn}.ttf", 12)
    H, BASE = 24, 16
    glyphs = {}
    for o in range(32, 127):
        ch = chr(o)
        adv = font.getlength(ch)
        W = 24
        im = Image.new("L", (W, H), 0)
        ImageDraw.Draw(im).text((4, BASE), ch, fill=255, font=font, anchor="ls")
        a = np.asarray(im)
        cols = np.where(a.max(0) > 0)[0]
        if len(cols):
            x0, x1 = int(cols[0]), int(cols[-1]) + 1
            data = a[:, x0:x1].astype(np.uint8)
            glyphs[ch] = [round(adv, 4), x0 - 4, x1 - x0, base64.b64encode(data.tobytes()).decode()]
        else:
            glyphs[ch] = [round(adv, 4), 0, 0, ""]
    # kerning pairs that matter (fractional px)
    kern = {}
    for a_ in range(33, 127):
        for b_ in range(33, 127):
            p = chr(a_) + chr(b_)
            k = font.getlength(p) - font.getlength(chr(a_)) - font.getlength(chr(b_))
            if abs(k) >= 0.25: kern[p] = round(k, 3)
    out[key] = {"h": H, "base": BASE, "glyphs": glyphs, "kern": kern}
json.dump(out, open(sys.argv[1], "w"), separators=(",", ":"))
