#!/usr/bin/env python3
from __future__ import annotations

import csv
import sys
from pathlib import Path
from typing import Dict, List, Set

DOCS_DIR = Path("docs")

# Expected schemas (column headers) per file.
# Adjust these ONLY when you intentionally change your schema.
EXPECTED_HEADERS: Dict[str, List[str]] = {
    "accessories.csv": ["name", "type", "max_actions", "effect_text", "points"],

    # Your actual schemas:
    "commands.csv": ["name", "cp_cost", "effect_text", "limits"],
    "leader_traits.csv": ["name", "effect_text"],
    "mutations.csv": ["name", "type", "effect_text", "points"],
    "psychic_powers.csv": ["name", "power_type", "max_actions", "range", "effect", "horror_generated", "points"],
    "rules.csv": ["name", "step", "effect_text"],
    "warband_traits.csv": ["name", "effect_text"],

    # These already matched:
    "shoot.csv": ["name", "max_actions", "effect_text", "damage", "ap", "points"],
    "fight.csv": ["name", "max_actions", "effect_text", "damage", "ap", "points"],
}


# Per-file columns that should parse as ints when non-empty.
INT_COLUMNS: Dict[str, Set[str]] = {
    "accessories.csv": {"max_actions", "points"},
    "shoot.csv": {"max_actions", "damage", "ap", "points"},  # allow numeric AP,  # 'ap' may be '*' sometimes
    "fight.csv": {"max_actions", "damage", "ap", "points"},
    "commands.csv": {"max_actions", "points"},
    "mutations.csv": {"max_actions", "points"},
    "psychic_powers.csv": {"max_actions", "points"},
    "leader_traits.csv": {"max_actions", "points"},
    "warband_traits.csv": {"max_actions", "points"},
}

# Allowed special tokens (per column) for non-int fields like AP.
ALLOWED_TOKENS: Dict[str, Dict[str, Set[str]]] = {
    "shoot.csv": {"ap": {"*"}},  # allow '*' as a special case; numbers handled by INT_COLUMNS
}


def fail(msg: str) -> None:
    print(f"ERROR: {msg}", file=sys.stderr)

def warn(msg: str) -> None:
    print(f"WARNING: {msg}", file=sys.stderr)

def main() -> int:
    if not DOCS_DIR.exists():
        fail("docs/ folder not found.")
        return 2

    csv_files = sorted(DOCS_DIR.glob("*.csv"))
    if not csv_files:
        fail("No CSV files found in docs/.")
        return 2

    ok = True

    for path in csv_files:
        fname = path.name
        with path.open(newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)

            if reader.fieldnames is None:
                fail(f"{fname}: missing header row.")
                ok = False
                continue

            headers = [h.strip() for h in reader.fieldnames]
            expected = EXPECTED_HEADERS.get(fname)

            if expected is None:
                warn(f"{fname}: no expected schema registered; skipping header enforcement.")
            else:
                if headers != expected:
                    fail(f"{fname}: header mismatch.\n  expected: {expected}\n  got:      {headers}")
                    ok = False

            # Basic row validation
            seen_names: Set[str] = set()
            row_num = 1  # DictReader counts data rows; header is row 0 logically
            for row in reader:
                row_num += 1

                # Normalize keys/values
                row = { (k or "").strip(): (v or "").strip() for k, v in row.items() }

                # Common: require 'name' unless rules.csv
                if fname != "rules.csv":
                    name = row.get("name", "")
                    if not name:
                        fail(f"{fname}:{row_num}: missing name.")
                        ok = False
                    else:
                        key = name.lower()
                        if key in seen_names:
                            fail(f"{fname}:{row_num}: duplicate name '{name}'.")
                            ok = False
                        seen_names.add(key)

                                # Int parsing checks
                for col in INT_COLUMNS.get(fname, set()):
                    if col not in row:
                        continue
                    val = row[col]
                    if val == "":
                        continue

                    # Allow special tokens (like '*') even in numeric columns
                    allowed = ALLOWED_TOKENS.get(fname, {}).get(col, set())
                    if val in allowed:
                        continue

                    try:
                        int(val)
                    except ValueError:
                        fail(f"{fname}:{row_num}: column '{col}' should be an integer, got '{val}'.")
                        ok = False

                # Allowed token checks for non-numeric columns
                for col, allowed in ALLOWED_TOKENS.get(fname, {}).items():
                    if col in row and row[col] != "" and row[col] not in allowed and col not in INT_COLUMNS.get(fname, set()):
                        fail(
                            f"{fname}:{row_num}: column '{col}' has '{row[col]}' but allowed: {sorted(allowed)}"
                        )
                        ok = False



                # Allowed token checks (e.g., shoot.csv ap can be '*' or blank)
                for col, allowed in ALLOWED_TOKENS.get(fname, {}).items():
                    if col in row and row[col] not in allowed:
                        fail(
                            f"{fname}:{row_num}: column '{col}' has '{row[col]}' but allowed: {sorted(allowed)}"
                        )
                        ok = False

        print(f"OK: {fname}")

    return 0 if ok else 1

if __name__ == "__main__":
    raise SystemExit(main())

