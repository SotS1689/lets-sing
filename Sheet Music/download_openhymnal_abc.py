"""Downloads the Open Hymnal score (.abc) behind every OpenHymnal MIDI file.

Every hymn whose midi_url is http://openhymnal.org/Midi/<name>.mid has its
source score at http://openhymnal.org/Abc/<name>.abc (no "www" - that host
answers 404). Saved as Sheet Music/abc/<name>.abc, the name the web app's
build step (web/scripts/build-scores.mjs) looks for.

Skips files already downloaded, so it can be re-run safely; a file is only
kept if it really is ABC (has an X: line), not an error page.

    python "Sheet Music/download_openhymnal_abc.py"
"""

import json
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "Sheet Music" / "abc"
PAUSE = 0.5  # seconds between requests, to go easy on a volunteer-run site


def main() -> None:
    hymns = json.loads((ROOT / "hymns_data.json").read_text(encoding="utf-8"))
    OUT.mkdir(parents=True, exist_ok=True)
    names = sorted({
        urllib.parse.unquote(h["midi_url"].rsplit("/", 1)[1])[:-4]
        for h in hymns
        if "openhymnal.org/Midi/" in (h.get("midi_url") or "") and h["midi_url"].endswith(".mid")
    })
    got = skipped = 0
    failed = []
    for name in names:
        target = OUT / f"{name}.abc"
        if target.exists():
            skipped += 1
            continue
        url = "http://openhymnal.org/Abc/" + urllib.parse.quote(name) + ".abc"
        try:
            with urllib.request.urlopen(url, timeout=30) as res:
                data = res.read()
        except Exception as e:  # noqa: BLE001 - report and carry on
            failed.append(f"{name}: {e}")
            continue
        text = data.decode("utf-8", errors="replace")
        if not any(line.startswith("X:") for line in text.splitlines()):
            failed.append(f"{name}: not an ABC file")
            continue
        target.write_bytes(data)
        got += 1
        time.sleep(PAUSE)
    print(f"{len(names)} OpenHymnal hymns: {got} downloaded, {skipped} already here, {len(failed)} failed")
    for f in failed:
        print("  " + f)


if __name__ == "__main__":
    main()
