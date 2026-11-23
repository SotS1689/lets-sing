// Shape notes: each notehead drawn in the shape of its syllable, so a singer
// can read the tune by its shapes (the Settings page turns it on).
//
// - "4": the four shapes of the Sacred Harp. Do fa, re sol, mi la, fa fa, sol sol,
//   la la, ti mi: fa a right triangle, sol the usual oval, la a square, mi a diamond.
// - "7": Aikin's seven shapes (The Christian Minstrel, 1846): do a triangle, re a
//   bowl, mi a diamond, fa a right triangle, sol an oval, la a square, ti a cone.
//
// The syllable comes from the key signature, as shape-note books do it: the
// signature's major key is do, so a minor tune ends on la. Sharps and flats on
// a note don't change its shape.
//
// The noteheads abcjs has drawn keep their place, classes and colours; only the
// outline of each one (its path's "d") is swapped for the shape's.

/** Shape of each degree of the scale (0 do .. 6 ti). */
const SYSTEMS = {
    4: ["fa", "sol", "la", "fa", "sol", "la", "mi"],
    7: ["do", "re", "mi", "fa", "sol", "la", "ti"],
};

/** abcjs note-letter numbers (C 0, D 1 .. B 6) of do for each count of sharps or flats. */
const doOf = (key) => {
    const accs = key?.accidentals ?? [];
    const sharps = accs.filter((a) => a.acc === "sharp").length;
    const flats = accs.filter((a) => a.acc === "flat").length;
    // Each sharp moves do up a fifth (4 letters), each flat up a fourth (3 letters)
    return sharps ? (4 * sharps) % 7 : (3 * flats) % 7;
};

const f = (n) => n.toFixed(2);

/** The outline of `shape` filling the box x, y, w, h; `up` is the stem's side for fa. */
function outline(shape, x, y, w, h, up) {
    const r = x + w, b = y + h, cx = x + w / 2, cy = y + h / 2;
    const poly = (...pts) => `M${pts.map(([px, py]) => `${f(px)} ${f(py)}`).join("L")}Z`;
    switch (shape) {
        case "do": return poly([x, b], [cx, y], [r, b]);
        case "re": return `M${f(x)} ${f(y)}L${f(r)} ${f(y)}A${f(w / 2)} ${f(h)} 0 0 1 ${f(x)} ${f(y)}Z`;
        case "mi": return poly([cx, y], [r, cy], [cx, b], [x, cy]);
        // The upright edge on the stem's side: the stem rises from the upper right
        // corner, or falls from the lower left
        case "fa": return up ? poly([x, y], [r, y], [r, b]) : poly([x, y], [x, b], [r, b]);
        case "la": return poly([x, y], [r, y], [r, b], [x, b]);
        case "ti": {
            const top = y + h * 0.45;
            return `M${f(x)} ${f(top)}A${f(w / 2)} ${f(h * 0.45)} 0 0 1 ${f(r)} ${f(top)}L${f(cx)} ${f(b)}Z`;
        }
    }
    return null;
}

/** The point a hollow shape's hole shrinks towards (its middle, by eye). */
function middle(shape, x, y, w, h, up) {
    if (shape === "do") return [x + w / 2, y + h * 0.66];
    if (shape === "re") return [x + w / 2, y + h * 0.3];
    if (shape === "ti") return [x + w / 2, y + h * 0.45];
    if (shape === "fa") return up ? [x + w * 0.67, y + h * 0.33] : [x + w * 0.33, y + h * 0.67];
    return [x + w / 2, y + h / 2];
}

/** The path for one notehead: filled, or with a hole for half and whole notes. */
function headPath(shape, box, hollow, up) {
    // A little taller than the oval (one staff space), as shape-note books print
    // them; the pointed shapes wider too, or they look lighter than the rest. The
    // extra width goes away from the stem, so the stem still meets the head's edge
    const pointed = shape === "do" || shape === "fa" || shape === "mi" || shape === "ti";
    const h = box.height * (pointed ? 1.2 : 1.1), w = box.width * (pointed ? 1.15 : 1);
    const x = up ? box.x + box.width - w : box.x, y = box.y + (box.height - h) / 2;
    const outer = outline(shape, x, y, w, h, up);
    if (!hollow || !outer) return outer;
    const k = 0.5, [mx, my] = middle(shape, x, y, w, h, up);
    return outer + outline(shape, mx + (x - mx) * k, my + (y - my) * k, w * k, h * k, up);
}

/**
 * Redraws the noteheads of a tune abcjs has just drawn as shape notes: `system`
 * is "4" or "7" (anything else leaves them round).
 */
export function applyShapes(tune, system) {
    const shapes = SYSTEMS[system];
    if (!shapes) return;
    for (const line of tune.lines) {
        for (const staff of line.staff ?? []) {
            const tonic = doOf(staff.key);
            for (const elements of staff.voices ?? []) {
                for (const el of elements) {
                    if (el.el_type !== "note" || el.rest || !el.pitches?.length) continue;
                    // abcjs keeps one head per pitch, in the same order
                    el.pitches.forEach((p, i) => {
                        const head = el.abselem?.heads?.[i];
                        const path = head?.graphelem;
                        if (!path?.getBBox || typeof p.pitch !== "number") return;
                        const shape = shapes[(((p.pitch - tonic) % 7) + 7) % 7];
                        if (shape === "sol") return; // the oval it already is
                        const hollow = !/quarter/.test(head.c ?? "");
                        const d = headPath(shape, path.getBBox(), hollow, head.stemDir !== "down");
                        if (!d) return;
                        path.setAttribute("d", d);
                        if (hollow) path.setAttribute("fill-rule", "evenodd");
                    });
                }
            }
        }
    }
}
