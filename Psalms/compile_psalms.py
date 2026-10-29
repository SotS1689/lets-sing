#!/usr/bin/env python3
"""
compile_psalms.py

Merges finished rows from Psalms_To_Add.xlsx into hymns_data.json, the same
way `Missing Hymns/compile_hymns.py` merges new hymns. Psalms are added into
the same hymns_data.json list (the one list the app builds from)
with an extra "psalm_number" field so the app can offer psalm-order browsing
alongside the existing alphabetical/search views. Pure local script - no AI
calls, no internet access.

Usage:
    python3 compile_psalms.py
    python3 compile_psalms.py --dry-run      # preview without writing anything
    python3 compile_psalms.py --xlsx path/to/file.xlsx --json path/to/data.json
"""

import argparse
import difflib
import json
import re
import sys
from datetime import date
from pathlib import Path

import openpyxl

HEADERS = [
    "psalm_number", "title", "tune", "meter", "text_source",
    "verses", "composer_arranger", "midi_url", "mp3_url", "credits", "notes",
]
REQUIRED_FOR_MERGE = ["psalm_number", "title", "verses"]
EXAMPLE_MARKER = "EXAMPLE"

# Psalm numbers covered by a hymn already in hymns_data.json whose text is
# word-for-word identical to that psalm - these hymns were retitled with
# "(Psalm N)" rather than duplicated (see Psalms/README.md), so they don't
# carry a psalm_number field and won't trip the hard "already has a
# dedicated entry" block above. This dict is just an informational nudge:
# merging one of these numbers doesn't overwrite anything, it adds a
# second, textually-distinct entry - worth a heads-up in case that's not
# what you want. (Psalm 23 already has such a second entry; the others
# don't yet.)
KNOWN_EXISTING_COVERAGE = {
    23: "The Lord's My Shepherd",
    72: "Jesus Shall Reign (Psalm 72)",
    90: "Our God, Our Help In Ages Past (Psalm 90)",
    98: "Joy to the World (Psalm 98)",
    100: "All People That On Earth Do Dwell (Psalm 100)",
    146: "Hallelujah, Praise Jehovah, O My Soul (Psalm 146)",
}

# Text sources that are NOT safe to use - the compile script blocks these
# outright rather than just warning, since accidentally shipping copyrighted
# Trinity Psalter (or similar recent, still-copyrighted psalter) text in a
# distributed app is a real legal problem, not just a data-quality nit.
BLOCKED_TEXT_SOURCE_PATTERNS = [
    r"trinity\s*psalter",
    r"book of psalms for (worship|singing)",
    r"psalter\s*hymnal.*(?:1987|2013)",  # later CRC editions are copyrighted; 1912/1927 are fine
]


def load_json(json_path: Path) -> list[dict]:
    raw = json_path.read_text(encoding="utf-8")
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        fixed = re.sub(r",(\s*\r?\n\s*[\]\}])", r"\1", raw)
        return json.loads(fixed)


def split_verses(cell_text: str) -> list[str]:
    if not cell_text:
        return []
    normalized = cell_text.replace("\r\n", "\n").strip()
    parts = re.split(r"\n\s*\n", normalized)
    return [p.strip() for p in parts if p.strip()]


def row_to_dict(row_values: tuple) -> dict:
    return {h: (v.strip() if isinstance(v, str) else v) for h, v in zip(HEADERS, row_values)}


def is_example_row(record: dict) -> bool:
    title = record.get("title") or ""
    return str(title).strip().upper().startswith(EXAMPLE_MARKER)


def is_ready(record: dict) -> bool:
    return all(record.get(f) not in (None, "") for f in REQUIRED_FOR_MERGE)


def find_near_duplicates(title: str, existing_titles: list[str], cutoff: float = 0.82) -> list[str]:
    return difflib.get_close_matches(title.lower().strip(), existing_titles, n=2, cutoff=cutoff)


def check_blocked_source(text_source: str) -> str | None:
    if not text_source:
        return None
    for pattern in BLOCKED_TEXT_SOURCE_PATTERNS:
        if re.search(pattern, text_source, re.IGNORECASE):
            return pattern
    return None


def main():
    parser = argparse.ArgumentParser(description="Merge new Psalms from spreadsheet into hymns_data.json")
    parser.add_argument("--xlsx", default="Psalms_To_Add.xlsx", help="Path to the intake spreadsheet")
    parser.add_argument("--json", default="../hymns_data.json", help="Path to hymns_data.json")
    parser.add_argument("--dry-run", action="store_true", help="Show what would happen, write nothing")
    args = parser.parse_args()

    xlsx_path = Path(args.xlsx)
    json_path = Path(args.json)

    if not xlsx_path.exists():
        sys.exit(f"Spreadsheet not found: {xlsx_path}")
    if not json_path.exists():
        sys.exit(f"JSON file not found: {json_path}")

    data = load_json(json_path)
    existing_titles_lower = [d["title"].lower().strip() for d in data]
    existing_psalm_numbers = {d["psalm_number"] for d in data if d.get("psalm_number")}
    next_id = max((d["id"] for d in data), default=0) + 1

    wb = openpyxl.load_workbook(xlsx_path)
    ws = wb["To Add"]
    done_ws = wb["Already Added"] if "Already Added" in wb.sheetnames else wb.create_sheet("Already Added")

    header_row_idx = 2
    first_data_row = header_row_idx + 1  # example row lives here, skipped by is_example_row

    ready_rows = []
    pending_count = 0
    skipped_examples = 0
    blocked = []

    for r in range(first_data_row, ws.max_row + 1):
        values = tuple(ws.cell(row=r, column=c).value for c in range(1, len(HEADERS) + 1))
        if all(v in (None, "") for v in values):
            continue
        record = row_to_dict(values)
        if is_example_row(record):
            skipped_examples += 1
            continue
        if not is_ready(record):
            pending_count += 1
            continue

        bad_pattern = check_blocked_source(record.get("text_source") or "")
        if bad_pattern:
            blocked.append((r, record.get("title"), f'text_source "{record.get("text_source")}" looks copyrighted'))
            continue

        ready_rows.append((r, record))

    new_records = []
    warnings = []
    seen_numbers_this_batch = set()

    for row_idx, record in ready_rows:
        title = record["title"]
        psalm_number = int(record["psalm_number"])

        if psalm_number in existing_psalm_numbers:
            blocked.append((row_idx, title, f"Psalm {psalm_number} already has a dedicated entry in hymns_data.json"))
            continue
        if psalm_number in seen_numbers_this_batch:
            blocked.append((row_idx, title, f"Psalm {psalm_number} is duplicated within this same spreadsheet batch"))
            continue

        dupes = find_near_duplicates(title, existing_titles_lower)
        if dupes:
            warnings.append(f'  "{title}" (Psalm {psalm_number}) looks similar to existing: {dupes} - check before assuming it is new.')

        if psalm_number in KNOWN_EXISTING_COVERAGE:
            warnings.append(
                f'  Psalm {psalm_number} ("{title}") already has a related hymn in the library: '
                f'"{KNOWN_EXISTING_COVERAGE[psalm_number]}" - this will add a second, separate entry, which may be exactly what you want.'
            )

        psalm = {
            "id": next_id,
            "psalm_number": psalm_number,
            "title": title,
            "tune": record.get("tune") or "",
            "meter": record.get("meter") or "",
            "text_source": record.get("text_source") or "",
            "verses": split_verses(record.get("verses") or ""),
            "composer_arranger": record.get("composer_arranger") or "",
            "midi_url": record.get("midi_url") or "",
            "mp3_url": record.get("mp3_url") or "",
            "credits": record.get("credits") or "",
        }
        new_records.append((row_idx, psalm))
        existing_titles_lower.append(title.lower().strip())
        seen_numbers_this_batch.add(psalm_number)
        next_id += 1

    if blocked:
        print("BLOCKED - these rows were NOT merged:")
        for r, title, reason in blocked:
            print(f'  Row {r}: "{title}" - {reason}')
        print("  Fix the underlying issue before re-running.\n")

    if not new_records:
        print(f"No rows are ready to merge yet ({pending_count} pending, need at least psalm_number + title + verses).")
        return

    print(f"Ready to merge {len(new_records)} psalm(s):")
    for _, p in new_records:
        print(f'  [{p["id"]}] Psalm {p["psalm_number"]}: {p["title"]}')
    if warnings:
        print("\nWarnings (not blocked, just flagged):")
        print("\n".join(warnings))
    if pending_count:
        print(f"\n{pending_count} row(s) still pending (missing psalm_number/title/verses) - left untouched.")

    if args.dry_run:
        print("\n--dry-run: nothing was written.")
        return

    # Keep the same alphabetical-by-title sort compile_hymns.py already uses for
    # this file, so both scripts stay compatible with the same convention. Psalm
    # order for a "browse by Psalm number" feature is a query-time sort
    # (ORDER BY psalm_number) in the app, not a property of file order.
    all_records = data + [p for _, p in new_records]
    all_records.sort(key=lambda d: d["title"].lower())
    json_path.write_text(json.dumps(all_records, indent=2, ensure_ascii=False), encoding="utf-8")

    log_row = done_ws.max_row + 1
    today = date.today().isoformat()
    for _, p in sorted(new_records, key=lambda t: t[0]):
        done_ws.cell(row=log_row, column=1, value=p["title"])
        done_ws.cell(row=log_row, column=2, value=p["psalm_number"])
        done_ws.cell(row=log_row, column=3, value=p["id"])
        done_ws.cell(row=log_row, column=4, value=today)
        log_row += 1

    for row_idx, _ in sorted(new_records, key=lambda t: t[0], reverse=True):
        ws.delete_rows(row_idx, 1)

    wb.save(xlsx_path)

    print(f"\nDone. {json_path} now has {len(all_records)} entries.")
    print(f"{len(new_records)} row(s) moved from 'To Add' to 'Already Added' in {xlsx_path}.")


if __name__ == "__main__":
    main()
