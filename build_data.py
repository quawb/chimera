#!/usr/bin/env python3
from __future__ import annotations

import csv
import json
from pathlib import Path

DOCS = Path("docs")
OUT = Path("site") / "data"   # we’ll build a tiny site folder later
OUT.mkdir(parents=True, exist_ok=True)

def read_csv(path: Path) -> list[dict]:
    with path.open("r", newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        if reader.fieldnames is None:
            raise ValueError(f"{path.name} missing headers")
        rows = []
        for r in reader:
            # normalize keys/values as strings
            row = { (k or "").strip(): (v or "").strip() for k, v in r.items() }
            rows.append(row)
        return rows

def write_json(path: Path, data) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

def main() -> None:
    csv_files = sorted(DOCS.glob("*.csv"))
    if not csv_files:
        raise SystemExit("No CSV files found in docs/")

    manifest = {}

    for csv_path in csv_files:
        rows = read_csv(csv_path)

        # basic derived metadata (useful later)
        manifest[csv_path.name] = {
            "rows": len(rows),
            "out": f"{csv_path.stem}.json",
        }

        out_path = OUT / f"{csv_path.stem}.json"
        write_json(out_path, rows)
        print(f"Wrote {out_path} ({len(rows)} rows)")

    write_json(OUT / "manifest.json", manifest)
    print("Wrote manifest.json")

if __name__ == "__main__":
    main()
