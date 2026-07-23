#!/usr/bin/env python3
"""Enforce per-(crate, table) raw-write table-ownership baseline (#2895).

Agaric's SQLite store is written from four crates — the Tauri app
(`src-tauri/src`, "app"), `agaric-store`, `agaric-engine`, and
`agaric-sync`. Each core table has ONE architecturally-authoritative
owner crate; other crates are meant to call an owner/store function
rather than open-code a raw `sqlx` write against a table they do not own.
Cross-crate raw writes are how a table's invariants (cache coherence,
op-log append ordering, soft-delete rules) silently drift out of one
place.

This guard is the first safe slice of #2895: pure additive tooling, no
production Rust / .sqlx / migration changes. It counts raw write
statements (`INSERT [OR ...] INTO <t>`, `UPDATE <t>`, `DELETE FROM <t>`)
per (crate, table) across all four crate roots and compares every
NON-owner (crate, table) pair to a checked-in baseline
(`src-tauri/table-ownership-baseline.txt`). Owner-crate writes are
unconstrained and never recorded. The codebase already carries many
cross-crate write sites; those are grandfathered by the baseline, so the
OWNER map is non-load-bearing today (nothing fails on first landing).
The ratchet only applies back-pressure to NEW cross-crate writes:

  * A non-owner (crate, table) count that EXCEEDS its baseline fails the
    hook, naming the pair and the offending files, and points the author
    at the owning crate + `--update-baseline`.
  * A count at-or-below baseline passes unchanged (existing sites
    grandfathered; no mass refactor required). When a cross-crate site is
    removed, regenerate the baseline to re-anchor future additions
    against the new, lower floor:
        python3 scripts/check-table-ownership.py --update-baseline

OWNER choices (see src-tauri/migrations/AGENTS.md "Table ownership"):
`peer_refs` and all derived caches are store-owned; `blocks` is owned by
`agaric-engine` (the authoritative Loro→SQLite projection writer) and
`op_log` by `agaric-store` (the canonical append primitive in
`agaric-store/src/op_log/append.rs`). `blocks` and `op_log` are known
multi-writer debt frozen by this ratchet, not clean single-writer tables.

The SQL lives INSIDE `sqlx::query!("…")` macro strings, so — unlike the
sibling check-dynamic-sql / check-raw-tx guards, which match Rust CODE
tokens — this guard must scan the string CONTENTS. It therefore blanks
only `//` and `/* */` COMMENTS (so `// UPDATE blocks …` prose never
counts) while PRESERVING string/char-literal contents. It reuses
`cfg_test_line_set` / `is_test_file` from check-raw-tx.py to skip test
fixtures and `#[cfg(test)]` regions. Stdlib only — no third-party deps.
"""

from __future__ import annotations

import importlib.util
import re
import sys
from collections import defaultdict
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
BASELINE_PATH = REPO_ROOT / "src-tauri" / "table-ownership-baseline.txt"

# Reuse the battle-tested test-file detection and #[cfg(test)] line-set
# tracker from the raw-tx guard rather than re-deriving them (#818 fixes).
# NOTE: `strip_rust_comments` from that module is deliberately NOT reused
# for the scan — it blanks STRING literal contents, but the SQL we must
# match lives inside `sqlx::query!("…")` strings. A local comment-only
# stripper (`strip_comments_keep_strings`) is used instead.
_spec = importlib.util.spec_from_file_location(
    "_check_raw_tx", REPO_ROOT / "scripts" / "check-raw-tx.py"
)
assert _spec and _spec.loader
_crt = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_crt)

cfg_test_line_set = _crt.cfg_test_line_set
is_test_file = _crt.is_test_file

# --- Ownership map ---------------------------------------------------------
# Crate that OWNS each core table (its authoritative raw writer). Writes to
# a table from ITS owner crate are unconstrained and never recorded in the
# baseline; writes from any OTHER crate are ratcheted. See the module
# docstring / migrations/AGENTS.md for the rationale behind blocks/op_log.
OWNER: dict[str, str] = {
    "blocks": "engine",
    "op_log": "store",
    "peer_refs": "store",
    "pages_cache": "store",
    "tags_cache": "store",
    "agenda_cache": "store",
    "block_links": "store",
    "page_link_cache": "store",
    "projected_agenda_cache": "store",
    "block_tag_refs": "store",
    "block_tag_inherited": "store",
}

# Crate roots, mapped to their short crate label. Longer paths must be
# probed before shorter ones so a file under agaric-*/src is classified as
# that crate and not as the "app" src-tauri/src prefix.
CRATE_ROOTS: list[tuple[str, Path]] = [
    ("store", REPO_ROOT / "src-tauri" / "agaric-store" / "src"),
    ("engine", REPO_ROOT / "src-tauri" / "agaric-engine" / "src"),
    ("sync", REPO_ROOT / "src-tauri" / "agaric-sync" / "src"),
    ("app", REPO_ROOT / "src-tauri" / "src"),
]


def _write_re(table: str) -> re.Pattern[str]:
    """Regex matching a raw write statement targeting `table`.

    Covers `INSERT [OR ...] INTO t`, `UPDATE t`, `DELETE FROM t`. `\\s+`
    lets the statement span lines inside a macro string, and the trailing
    `\\b` word boundary keeps `blocks` from matching `block_links`,
    `_new_blocks`, or `blocks_fts`. Case-insensitive for lowercase SQL.
    """
    t = re.escape(table)
    return re.compile(
        r"(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM)\s+" + t + r"\b",
        re.IGNORECASE,
    )


WRITE_RES: dict[str, re.Pattern[str]] = {t: _write_re(t) for t in OWNER}

HINT = (
    "    -> #2895 table ownership: a NEW cross-crate raw write to a table\n"
    "       you do not own. Prefer calling the owning crate's store/owner\n"
    "       function instead of open-coding a raw `sqlx` write here. If the\n"
    "       cross-crate write is genuinely required, re-anchor the baseline:\n"
    "         python3 scripts/check-table-ownership.py --update-baseline\n"
    "       (regenerate after REMOVING a cross-crate site too, to lower the\n"
    "       floor). Ownership map: src-tauri/migrations/AGENTS.md."
)


def strip_comments_keep_strings(text: str) -> str:
    """Blank `//` and `/* */` comments; PRESERVE string/char literals.

    Mirrors the comment-parsing structure of check-raw-tx's
    `strip_rust_comments`, but string and char literals are only PARSED
    (to skip over them, so a `//` inside a string is never mistaken for a
    comment) and left intact — the SQL to match lives inside those
    strings. Newlines are preserved so byte offsets and line numbers in
    the result map 1:1 onto the original.
    """
    out = list(text)
    n = len(text)

    def blank(start: int, end: int) -> None:
        for k in range(start, min(end, n)):
            if out[k] != "\n":
                out[k] = " "

    i = 0
    while i < n:
        ch = text[i]
        nxt = text[i + 1] if i + 1 < n else ""

        if ch == "/" and nxt == "/":
            j = i
            while j < n and text[j] != "\n":
                j += 1
            blank(i, j)
            i = j
            continue

        if ch == "/" and nxt == "*":
            depth = 0
            j = i
            while j < n:
                if text[j] == "/" and j + 1 < n and text[j + 1] == "*":
                    depth += 1
                    j += 2
                elif text[j] == "*" and j + 1 < n and text[j + 1] == "/":
                    depth -= 1
                    j += 2
                    if depth == 0:
                        break
                else:
                    j += 1
            blank(i, j)
            i = j
            continue

        if ch == "r" and (nxt == '"' or nxt == "#"):
            m = re.match(r'r(#*)"', text[i:])
            if m:
                closing = '"' + m.group(1)
                end = text.find(closing, i + len(m.group(0)))
                j = n if end == -1 else end + len(closing)
                i = j  # preserve raw-string contents, just skip past
                continue

        if ch == '"':
            j = i + 1
            while j < n:
                if text[j] == "\\":
                    j += 2
                elif text[j] == '"':
                    j += 1
                    break
                else:
                    j += 1
            i = j  # preserve string contents, just skip past
            continue

        if ch == "'":
            m = re.match(r"'(\\.|[^'\\\n])'", text[i:])
            if m:
                i += len(m.group(0))  # preserve char literal, skip past
                continue

        i += 1
    return "".join(out)


def count_writes_in_text(text: str) -> dict[str, list[int]]:
    """Return {table: [0-based line indices]} of raw writes in `text`.

    Comment-stripped (strings preserved), `#[cfg(test)]`-module lines
    excluded. Pure — no file I/O — so `--self-test` can drive it directly.
    """
    stripped = strip_comments_keep_strings(text)
    stripped_lines = stripped.splitlines()
    test_lines = cfg_test_line_set(stripped_lines)
    hits: dict[str, list[int]] = defaultdict(list)
    for table, rx in WRITE_RES.items():
        for m in rx.finditer(stripped):
            idx = stripped.count("\n", 0, m.start())
            if idx in test_lines:
                continue
            hits[table].append(idx)
    return hits


def _crate_files() -> list[tuple[str, Path]]:
    """(crate, path) for every non-test production .rs under a crate root."""
    result: list[tuple[str, Path]] = []
    for crate, root in CRATE_ROOTS:
        if not root.is_dir():
            continue
        for p in sorted(root.rglob("*.rs")):
            rel = str(p.relative_to(REPO_ROOT))
            if is_test_file(rel):
                continue
            result.append((crate, p))
    return result


def compute_counts() -> tuple[
    dict[tuple[str, str], int], dict[tuple[str, str], set[str]]
]:
    """Full aggregate scan. Returns (counts, files) keyed by (crate, table).

    `counts[(crate, table)]` = number of raw write statements;
    `files[(crate, table)]` = set of repo-relative paths carrying them.
    """
    counts: dict[tuple[str, str], int] = defaultdict(int)
    files: dict[tuple[str, str], set[str]] = defaultdict(set)
    for crate, p in _crate_files():
        try:
            text = p.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        rel = str(p.relative_to(REPO_ROOT))
        hits = count_writes_in_text(text)
        for table, indices in hits.items():
            if not indices:
                continue
            counts[(crate, table)] += len(indices)
            files[(crate, table)].add(rel)
    return counts, files


def compute_baseline() -> dict[tuple[str, str], int]:
    """Baseline = NON-owner (crate, table) pairs with a non-zero count.

    Owner-crate writes are unconstrained and deliberately omitted, so the
    baseline can never fail an owner and stays minimal.
    """
    counts, _ = compute_counts()
    baseline: dict[tuple[str, str], int] = {}
    for (crate, table), cnt in counts.items():
        if cnt and OWNER.get(table) != crate:
            baseline[(crate, table)] = cnt
    return baseline


def write_baseline(baseline: dict[tuple[str, str], int]) -> None:
    lines = [
        "# Table-ownership baseline (#2895) — per-(crate, table) count of "
        "NON-owner raw",
        "# write sites (`INSERT [OR ...] INTO t` / `UPDATE t` / "
        "`DELETE FROM t`).",
        "# Generated by: python3 scripts/check-table-ownership.py "
        "--update-baseline",
        "# The check-table-ownership prek hook fails when a non-owner "
        "(crate, table)",
        "# pair's count EXCEEDS its baseline. Owner-crate writes are "
        "unconstrained and",
        "# never listed here. Ownership map: src-tauri/migrations/AGENTS.md.",
        "# Format: <count> <crate> <table>",
        "",
    ]
    for crate, table in sorted(baseline):
        lines.append(f"{baseline[(crate, table)]} {crate} {table}")
    BASELINE_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")


def read_baseline() -> dict[tuple[str, str], int]:
    baseline: dict[tuple[str, str], int] = {}
    if not BASELINE_PATH.exists():
        return baseline
    for raw in BASELINE_PATH.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) != 3:
            continue
        try:
            baseline[(parts[1], parts[2])] = int(parts[0])
        except ValueError:
            continue
    return baseline


def run_self_test() -> int:
    """Lock in the write-regex contract and the scan-level exclusions."""
    failures: list[str] = []

    # --- Regex contract: (fixture, table, expect_match) ---
    regex_cases: list[tuple[str, str, bool]] = [
        # MUST match — the real spellings, incl. multi-line inside a string.
        ('sqlx::query!("INSERT OR IGNORE INTO blocks (id) VALUES (?)")',
         "blocks", True),
        ("UPDATE blocks\n            SET position = ? WHERE id = ?",
         "blocks", True),
        ('sqlx::query!("DELETE FROM op_log WHERE seq > ?")', "op_log", True),
        ("INSERT OR REPLACE INTO peer_refs (peer_id) VALUES (?)",
         "peer_refs", True),
        # MUST NOT match — word-boundary / prefix hazards.
        ("UPDATE block_links SET target_id = ?", "blocks", False),
        ("INSERT INTO _new_blocks SELECT * FROM blocks_old", "blocks", False),
        ("UPDATE blocks_fts SET c0 = ?", "blocks", False),
    ]
    for fixture, table, expect in regex_cases:
        got = WRITE_RES[table].search(fixture) is not None
        if got != expect:
            failures.append(
                f"regex[{table}] expected match={expect}, got {got}: "
                f"{fixture!r}"
            )

    # --- Scan contract: comment prose and #[cfg(test)] are excluded ---
    prose = "// update peer_refs when the lease expires\nlet x = 1;\n"
    if count_writes_in_text(prose).get("peer_refs"):
        failures.append("comment prose '// update peer_refs' counted a write")

    cfg_test_fixture = (
        "fn real() {\n"
        '    sqlx::query!("DELETE FROM op_log WHERE seq > ?");\n'
        "}\n"
        "#[cfg(test)]\n"
        "mod tests {\n"
        "    fn t() {\n"
        '        sqlx::query!("DELETE FROM op_log WHERE seq > 0");\n'
        "    }\n"
        "}\n"
    )
    op_log_hits = count_writes_in_text(cfg_test_fixture).get("op_log", [])
    if len(op_log_hits) != 1:
        failures.append(
            f"expected exactly 1 op_log write outside #[cfg(test)], "
            f"got {len(op_log_hits)} (test-module write not excluded)"
        )

    if failures:
        print("check-table-ownership self-test FAILED:", file=sys.stderr)
        for f in failures:
            print(f"  {f}", file=sys.stderr)
        return 1
    print(
        f"check-table-ownership self-test passed "
        f"({len(regex_cases) + 2} cases)."
    )
    return 0


def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        return run_self_test()
    if "--update-baseline" in argv:
        write_baseline(compute_baseline())
        print(f"Wrote {BASELINE_PATH.relative_to(REPO_ROOT)}")
        return 0

    # Ownership is an AGGREGATE per-(crate, table) invariant, so we always
    # rescan the whole tree regardless of which changed files prek passed.
    counts, files = compute_counts()
    baseline = read_baseline()

    violations: list[str] = []
    for (crate, table), cnt in sorted(counts.items()):
        if OWNER.get(table) == crate:
            continue  # owner writes are unconstrained
        base = baseline.get((crate, table), 0)
        if cnt <= base:
            continue  # grandfathered (or decreased — re-anchor via flag)
        offenders = ", ".join(sorted(files[(crate, table)]))
        violations.append(
            f"{crate} crate has {cnt} raw write(s) to '{table}' "
            f"(baseline {base}; owner = {OWNER[table]} crate)\n"
            f"      files: {offenders}"
        )

    if violations:
        print(
            "Table-ownership guard (#2895) — new cross-crate raw write(s) "
            "past baseline:\n",
            file=sys.stderr,
        )
        for v in violations:
            print(f"  {v}", file=sys.stderr)
        print("", file=sys.stderr)
        print(HINT, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
