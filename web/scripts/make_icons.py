"""Renders the PWA icons (public/icons/*.png and icon.svg) from the same
artwork as the Android launcher icon (res/drawable/ic_launcher_*.xml):
white calligraphic eighth note on #B71C1C, foreground scaled 0.75 about the
centre of a 108x108 viewport.

Run once from web/: python scripts/make_icons.py
"""
from pathlib import Path
from PIL import Image, ImageDraw

RED = "#B71C1C"
SCALE = 0.75  # the Android foreground group's scaleX/scaleY

# Cubic paths copied from ic_launcher_foreground.xml: start point, then
# (c1, c2, end) triples.
PATHS = [
    ((53.0, 18.5), [
        ((53.1, 27.6), (55.3, 33.1), (60.9, 38.1)),
        ((66.2, 42.8), (70.9, 46.8), (72.9, 52.2)),
        ((75.1, 58.1), (72.9, 63.8), (68.9, 68.3)),
        ((66.6, 70.9), (63.9, 72.9), (61.2, 74.7)),
        ((64.7, 70.7), (67.3, 66.3), (68.4, 61.7)),
        ((69.6, 56.3), (68.3, 51.5), (64.5, 47.2)),
        ((61.7, 44.0), (58.1, 41.0), (55.5, 37.4)),
        ((53.1, 34.0), (52.1, 29.4), (53.0, 18.5)),
    ]),
    ((51.75, 19.0), [
        ((51.82, 31.2), (51.88, 43.5), (51.85, 55.7)),
        ((51.83, 61.8), (51.80, 66.2), (51.70, 69.8)),
        ((51.62, 72.7), (49.35, 75.2), (47.45, 77.2)),
        ((50.10, 75.2), (53.32, 72.5), (53.48, 69.6)),
        ((53.78, 58.3), (53.83, 46.0), (53.80, 33.7)),
        ((53.78, 27.9), (53.73, 22.5), (53.73, 19.0)),
    ]),
    ((52.48, 69.5), [
        ((50.18, 67.1), (46.75, 66.2), (42.88, 67.1)),
        ((38.31, 68.2), (33.91, 71.1), (31.45, 74.6)),
        ((29.12, 77.9), (29.34, 81.2), (32.07, 82.9)),
        ((35.06, 84.9), (40.09, 84.5), (44.71, 82.4)),
        ((49.20, 80.4), (52.55, 77.3), (53.34, 74.0)),
        ((53.78, 72.2), (53.52, 70.7), (52.48, 69.5)),
    ]),
]


def transform(p, size):
    x, y = p
    x = 54 + (x - 54) * SCALE
    y = 54 + (y - 54) * SCALE
    return x * size / 108, y * size / 108


def polygon(start, curves, size, steps=24):
    pts = [transform(start, size)]
    p0 = start
    for c1, c2, p3 in curves:
        for i in range(1, steps + 1):
            t = i / steps
            mt = 1 - t
            x = mt**3 * p0[0] + 3 * mt**2 * t * c1[0] + 3 * mt * t**2 * c2[0] + t**3 * p3[0]
            y = mt**3 * p0[1] + 3 * mt**2 * t * c1[1] + 3 * mt * t**2 * c2[1] + t**3 * p3[1]
            pts.append(transform((x, y), size))
        p0 = p3
    return pts


def render(size, rounded):
    big = size * 4  # supersample for smooth edges
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if rounded:
        d.rounded_rectangle([0, 0, big - 1, big - 1], radius=big * 0.22, fill=RED)
    else:
        d.rectangle([0, 0, big, big], fill=RED)
    for start, curves in PATHS:
        d.polygon(polygon(start, curves, big), fill="white")
    return img.resize((size, size), Image.LANCZOS)


def svg():
    def path_d(start, curves):
        f = lambda p: "%.2f,%.2f" % transform(p, 108)
        return "M" + f(start) + "".join(" C" + " ".join(f(p) for p in c) for c in curves) + "Z"
    paths = "".join('<path fill="#fff" d="%s"/>' % path_d(s, c) for s, c in PATHS)
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108">'
            '<rect width="108" height="108" rx="24" fill="%s"/>%s</svg>' % (RED, paths))


out = Path("public/icons")
out.mkdir(parents=True, exist_ok=True)
render(192, True).save(out / "icon-192.png")
render(512, True).save(out / "icon-512.png")
render(512, False).save(out / "maskable-512.png")
render(180, False).save(out / "apple-touch-icon.png")
(out / "icon.svg").write_text(svg(), encoding="utf-8")
print("icons written to", out)
