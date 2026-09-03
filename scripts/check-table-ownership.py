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
  * A declared CRATE_ROOTS directory that does not exist FAILS (#4501). A
    renamed or misspelled segment used to narrow the walk to nothing in
    silence — the guard exited 0 over a tree it had stopped reading. Under
    `--update-baseline` this REFUSES rather than warning: re-anchoring against
    a narrowed walk deletes every count under the vanished root and reports
    success, so the command that fixes the finding would have destroyed it.
        python3 scripts/check-table-ownership.py --synthetic-tree
    says "this tree is deliberately not this repository" and is the ONLY way
    to suppress that check. `pr-merge-result-check.sh` passes it for the
    synthetic fixture repos its self-test builds, and only for those — never
    on a real merge, where the assertion is the point. It is rejected
    alongside `--update-baseline`, which would re-anchor from the surviving
    roots only.

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

Baseline annotation format (#2895 carve-outs)
---------------------------------------------
The baseline file is an annotated, diffable text list. Each data line is
``<count> <crate> <table>`` and MAY carry a trailing inline comment
(``26 app blocks  # migrating: slice 2``) documenting WHY a cross-crate
write is a sanctioned carve-out or WHEN it migrates. Blank lines and
full-line ``#`` comments are ignored when parsing counts; full-line
comment blocks document a whole group (e.g. the engine/store split
contract). A data line whose first three whitespace fields are not
``<int> <str> <str>`` (e.g. ``10 store # blocks``) is a hard error, not
silently skipped.

``--update-baseline`` recomputes only the COUNTS and PRESERVES annotations
by this rule: the file parses into (1) a *header* — every line before the
first data pair, kept verbatim; (2) per data pair, its *preceding block* —
the run of comment/blank lines directly above it — and its *inline
comment*, both keyed by ``(crate, table)``; (3) a *footer* — any lines
after the last data pair, kept verbatim. On regenerate the header/footer
are re-emitted verbatim and each SURVIVING pair (emitted in sorted order)
carries its preceding block + inline comment; a pair that vanished loses
its annotations and a newly-appearing pair is emitted bare. Running
``--update-baseline`` on an unchanged tree is therefore byte-identical.
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
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
_glob_match = _crt._glob_match

# Guard-LOCAL test-file glob extension. The shared TEST_FILE_GLOBS in
# check-raw-tx.py (tests.rs / tests/** / *_tests.rs) is deliberately NOT
# mutated here — instead we widen the exclusion set only for THIS guard.
# These cover whole-file modules that are `#[cfg(test)]`/test-feature gated
# at their `mod` declaration but whose FILENAMES don't match the shared
# globs (so their fixture-seed writes would otherwise be miscounted as
# production cross-crate writes), plus standalone audit/diagnostic bins:
#   * **/*proptest*.rs       — property-test modules (all `#[cfg(test)]`):
#       apply_reproject_proptest.rs, dag/proptest_b2.rs,
#       soft_delete/proptest_b3.rs, reverse/proptest_b1.rs,
#       proptest_db_harness.rs, loro/engine_proptest.rs.
#   * **/test_support.rs     — `#[cfg(any(test, feature="test-util"))]`
#       test-pool helper in agaric-store.
#   * **/src/bin/**          — standalone bins (e.g. diagnostics audit tools)
#       whose fixture seeds are not production store writes.
#   * **/bulk_equivalence/**  — the #3346 batch-vs-fold oracle. `mod.rs` is
#       `#![cfg(test)]` and its submodules inherit that from the `mod`
#       declaration, so their filenames match none of the shared globs. The
#       raw `blocks` writes there are fixture SEEDS seeding SQL and the Loro
#       engine together; the operations under test are driven through the
#       real commands.
EXTRA_TEST_FILE_GLOBS = [
    "**/*proptest*.rs",
    "**/test_support.rs",
    "**/src/bin/**",
    "**/bulk_equivalence/**",
]


def is_excluded_file(rel_path: str) -> bool:
    """Test/fixture files skipped by the scan.

    The shared `is_test_file` (tests.rs / tests/** / *_tests.rs) OR this
    guard's local `EXTRA_TEST_FILE_GLOBS` extension.
    """
    return is_test_file(rel_path) or any(
        _glob_match(rel_path, g) for g in EXTRA_TEST_FILE_GLOBS
    )

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
    # The diagnostics crate is scanned so a FUTURE non-bin production write
    # to an owned table there is caught; today it holds only standalone
    # audit bins under src/bin, which `EXTRA_TEST_FILE_GLOBS` (**/src/bin/**)
    # excludes as fixture-seed code.
    ("diagnostics", REPO_ROOT / "src-tauri" / "diagnostics" / "src"),
    ("app", REPO_ROOT / "src-tauri" / "src"),
]


def _write_re(table: str) -> re.Pattern[str]:
    """Regex matching a raw write statement targeting `table`.

    Covers `INSERT [OR ...] INTO t`, SQLite's bare `REPLACE INTO t`
    synonym, `UPDATE t`, `DELETE FROM t`. `\\s+` lets the statement span
    lines inside a macro string, and the trailing `\\b` word boundary keeps
    `blocks` from matching `block_links`, `_new_blocks`, or `blocks_fts`.
    Case-insensitive for lowercase SQL. Note `REPLACE\\s+INTO` is a separate
    alternative from `INSERT ... INTO` so the bare-`REPLACE` form is caught
    on its own (`INSERT OR REPLACE INTO` is still matched by the INSERT arm).
    """
    t = re.escape(table)
    return re.compile(
        r"(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM)"
        r"\s+" + t + r"\b",
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


def missing_crate_roots() -> list[str]:
    """Declared CRATE_ROOTS that are not directories in this checkout.

    #4501: `_crate_files()` used to `continue` past a missing root, so a
    renamed or misspelled crate segment narrowed the walk to nothing with no
    signal at all — the guard reporting success over a tree it had stopped
    reading. That is the class this repo has now hit seven times, and it is
    the same construct removed from `check-space-filter-drift` in #4508.

    Reported rather than filtered: a root that vanished is a broken
    declaration, not an absent one, and the whole point is that it must be
    loud.
    """
    return [
        str(root.relative_to(REPO_ROOT))
        for _crate, root in CRATE_ROOTS
        if not root.is_dir()
    ]


def _crate_files() -> list[tuple[str, Path]]:
    """(crate, path) for every non-test production .rs under a crate root."""
    result: list[tuple[str, Path]] = []
    for crate, root in CRATE_ROOTS:
        if not root.is_dir():
            # Skipped here only so the walk does not raise; the run is failed
            # by `missing_crate_roots()` in `main()`, which names the root.
            continue
        for p in sorted(root.rglob("*.rs")):
            rel = str(p.relative_to(REPO_ROOT))
            if is_excluded_file(rel):
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


class BaselineFormatError(ValueError):
    """A baseline data line is not `<count> <crate> <table> [# comment]`."""


class _Entry:
    """One parsed baseline pair: its count, inline suffix and comment block.

    `suffix` is the raw text from the end of the `<table>` token to end of
    line (leading whitespace + optional `# comment`, or "") — preserved
    verbatim so a round-trip is byte-identical. `preceding` is the run of
    comment/blank lines that appeared directly above the data line.
    """

    __slots__ = ("count", "suffix", "preceding")

    def __init__(self, count: int, suffix: str, preceding: list[str]) -> None:
        self.count = count
        self.suffix = suffix
        self.preceding = preceding


# Header used only when regenerating from scratch (no existing file to
# preserve). A committed baseline's own header is kept verbatim instead.
DEFAULT_HEADER: list[str] = [
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
    "#",
    "# Format: <count> <crate> <table>  [# annotation]",
    "# Blank lines and full-line `#` comments are ignored when parsing "
    "counts; an",
    "# inline `# …` after the three fields documents WHY a cross-crate "
    "write is a",
    "# sanctioned carve-out or WHEN it migrates. `--update-baseline` "
    "recomputes the",
    "# counts but PRESERVES this header, every surviving pair's inline "
    "comment and",
    "# the comment block directly above it (keyed by crate+table), and "
    "any footer.",
    "",
]


def parse_baseline_text(
    text: str,
) -> tuple[list[str], dict[tuple[str, str], _Entry], list[str]]:
    """Split an annotated baseline into (header, entries, footer).

    `header` = verbatim lines before the first data pair; `entries` maps
    each `(crate, table)` to its parsed `_Entry` (count + inline suffix +
    preceding comment/blank block); `footer` = verbatim lines after the
    last data pair. Raises `BaselineFormatError` on a malformed data line.
    """
    header: list[str] = []
    entries: dict[tuple[str, str], _Entry] = {}
    footer: list[str] = []
    pending: list[str] = []  # comment/blank lines awaiting the next pair
    seen_data = False
    for raw in text.splitlines():
        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            pending.append(raw)
            continue
        # A data line: must be exactly `<count> <crate> <table>` before any
        # inline `#`, with an integer count. Anything else is a hard error.
        code = raw.split("#", 1)[0]
        tokens = code.split()
        if len(tokens) != 3 or not tokens[0].isdigit():
            raise BaselineFormatError(
                "malformed baseline line (expected "
                "'<count> <crate> <table>  [# comment]'): " + repr(raw)
            )
        count, crate, table = int(tokens[0]), tokens[1], tokens[2]
        suffix = raw[len(code.rstrip()):]  # ws + optional '# comment' or ''
        if not seen_data:
            # Lines before the FIRST pair are the header, not that pair's
            # preceding block (else render would emit them twice).
            header = pending
            seen_data = True
            preceding: list[str] = []
        else:
            preceding = pending
        pending = []
        entries[(crate, table)] = _Entry(count, suffix, preceding)
    if seen_data:
        footer = pending
    else:
        header = pending
    return header, entries, footer


def render_baseline(
    header: list[str],
    entries: dict[tuple[str, str], _Entry],
    footer: list[str],
    counts: dict[tuple[str, str], int],
) -> str:
    """Serialize `counts` (sorted) with preserved header/footer + per-pair
    preceding blocks and inline comments from `entries`. New pairs emit bare.
    """
    out: list[str] = list(header)
    for pair in sorted(counts):
        ent = entries.get(pair)
        if ent is not None:
            out.extend(ent.preceding)
        crate, table = pair
        suffix = ent.suffix if ent is not None else ""
        out.append(f"{counts[pair]} {crate} {table}{suffix}")
    out.extend(footer)
    return "\n".join(out) + "\n"


def write_baseline(baseline: dict[tuple[str, str], int]) -> None:
    """Regenerate the baseline COUNTS while preserving all annotations."""
    if BASELINE_PATH.exists():
        header, entries, footer = parse_baseline_text(
            BASELINE_PATH.read_text(encoding="utf-8")
        )
    else:
        header, entries, footer = list(DEFAULT_HEADER), {}, []
    BASELINE_PATH.write_text(
        render_baseline(header, entries, footer, baseline), encoding="utf-8"
    )


def read_baseline() -> dict[tuple[str, str], int]:
    if not BASELINE_PATH.exists():
        return {}
    _header, entries, _footer = parse_baseline_text(
        BASELINE_PATH.read_text(encoding="utf-8")
    )
    return {pair: ent.count for pair, ent in entries.items()}


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
        # Bare SQLite `REPLACE INTO` synonym (no `INSERT OR`) must match.
        ('sqlx::query!("REPLACE INTO blocks (id) VALUES (?)")',
         "blocks", True),
        # MUST NOT match — word-boundary / prefix hazards.
        ("UPDATE block_links SET target_id = ?", "blocks", False),
        ("INSERT INTO _new_blocks SELECT * FROM blocks_old", "blocks", False),
        ("UPDATE blocks_fts SET c0 = ?", "blocks", False),
        # Bare `REPLACE INTO block_links` must NOT match the `blocks` table
        # (word boundary holds for the REPLACE arm too).
        ("REPLACE INTO block_links (source_id) VALUES (?)", "blocks", False),
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

    # --- Exclusion contract: guard-local EXTRA_TEST_FILE_GLOBS ---
    # Whole-file test modules whose filenames escape the shared globs, plus
    # standalone bins, must be excluded from the scan; ordinary production
    # files must NOT be. (fixture rel-path, expect_excluded)
    exclusion_cases: list[tuple[str, bool]] = [
        ("src-tauri/src/materializer_app_tests/apply_reproject_proptest.rs",
         True),
        ("src-tauri/agaric-sync/src/dag_tests/proptest_b2.rs", True),
        ("src-tauri/src/soft_delete/proptest_b3.rs", True),
        ("src-tauri/agaric-store/src/test_support.rs", True),
        ("src-tauri/diagnostics/src/bin/audit_cross_space_refs.rs", True),
        # Ordinary production files must stay in scope.
        ("src-tauri/agaric-engine/src/materializer/handlers/mod.rs", False),
        ("src-tauri/agaric-store/src/op_log/append.rs", False),
    ]
    for rel, expect_excluded in exclusion_cases:
        got = is_excluded_file(rel)
        if got != expect_excluded:
            failures.append(
                f"is_excluded_file({rel!r}) expected {expect_excluded}, "
                f"got {got}"
            )

    # --- Annotation contract: parse/round-trip/malformed ---
    annotation_cases = 0

    # (i) An annotated baseline parses to the SAME counts as its plain twin.
    plain_text = (
        "# header\n"
        "\n"
        "26 app blocks\n"
        "2 engine agenda_cache\n"
        "10 store blocks\n"
    )
    annotated_text = (
        "# header line one\n"
        "# header line two\n"
        "\n"
        "# --- app crate ---\n"
        "26 app blocks  # migrating: slice 2\n"
        "\n"
        "# engine caches are legitimate projection co-writers (#891)\n"
        "2 engine agenda_cache  # projection co-writer\n"
        "# === split contract ===\n"
        "10 store blocks  # owner-adjacent: physical primitives\n"
    )
    _h_p, plain_entries, _f_p = parse_baseline_text(plain_text)
    _h_a, annotated_entries, _f_a = parse_baseline_text(annotated_text)
    plain_counts = {k: e.count for k, e in plain_entries.items()}
    annotated_counts = {k: e.count for k, e in annotated_entries.items()}
    annotation_cases += 1
    if plain_counts != annotated_counts:
        failures.append(
            "annotated baseline parsed to different counts than plain twin: "
            f"{annotated_counts} != {plain_counts}"
        )

    # (ii) render(parse(x)) with the parsed counts round-trips BYTE-identical
    #      (header, preceding comment blocks and inline comments all intact).
    header, entries, footer = parse_baseline_text(annotated_text)
    rendered = render_baseline(
        header, entries, footer, {k: e.count for k, e in entries.items()}
    )
    annotation_cases += 1
    if rendered != annotated_text:
        failures.append(
            "annotation round-trip was not byte-identical:\n"
            f"--- expected ---\n{annotated_text}\n--- got ---\n{rendered}"
        )

    # (iii) A malformed inline comment (fewer than 3 fields before `#`)
    #       errors clearly rather than being silently skipped.
    annotation_cases += 1
    try:
        parse_baseline_text("10 store # blocks\n")
    except BaselineFormatError:
        pass
    else:
        failures.append(
            "malformed data line '10 store # blocks' did not raise "
            "BaselineFormatError"
        )

    # --- #4501: a declared crate root that vanished must be LOUD ----------
    # `_crate_files()` used to `continue` past a missing root, so a renamed or
    # misspelled segment narrowed the walk to nothing and the guard exited 0
    # over a tree it had stopped reading. Reproduced before fixing: with
    # `agaric-store` misspelled the whole run passed silently.
    #
    # Asserted by swapping the module-level list rather than the filesystem —
    # the constant is what a careless edit actually breaks, and a temp
    # directory could not reproduce a MISSPELLING.
    # Counted, not declared. This was `root_cases = 5`, and adding the
    # mutual-exclusion assertion below left the literal untouched — the suite
    # kept printing the old total while testing one thing more. A count
    # maintained by hand beside the assertions it counts is the same
    # hand-synchronised-pair problem #4501 is about, in miniature.
    root_cases = 0
    _saved_roots = CRATE_ROOTS[:]
    try:
        # A misspelled segment ALONGSIDE present siblings — the realistic
        # shape, and the one the exemption below must not swallow. An earlier
        # version of this case used the misspelled root ALONE, which the
        # exemption correctly treats as "not this repo"; the suite caught it.
        globals()["CRATE_ROOTS"] = [
            ("store", REPO_ROOT / "src-tauri" / "agaric-stores" / "src"),
            ("app", REPO_ROOT / "src-tauri" / "src"),
        ]
        missing = missing_crate_roots()
        root_cases += 1
        if missing != ["src-tauri/agaric-stores/src"]:
            failures.append(
                f"a misspelled crate root was not reported: {missing!r}"
            )
        # `--synthetic-tree` suppresses the assertion, and ONLY it does.
        # Asserted through `main()` rather than the helper, because the flag is
        # handled there and a helper-level test would not notice the WIRING
        # being dropped.
        #
        # Everything downstream of the roots check is stubbed out, and that is
        # load-bearing rather than tidiness. An earlier revision let `main()`
        # run on past the check into `compute_counts()` + `read_baseline()` +
        # the violation comparison, against the real tree and the real
        # baseline. The outcome then depended on repository state, not on the
        # code under test: a commit leaving `table-ownership-baseline.txt`
        # malformed does not match this hook's `files` regex, so the real guard
        # is deselected and never reports — but this self-test hook is
        # `always_run`, so `read_baseline()` raises, `main()` returns 1, and the
        # suite blames "--synthetic-tree did not suppress the roots assertion".
        # A test that names the wrong subsystem is worse than no test. It also
        # made every commit pay two extra whole-tree scans.
        # `write_baseline` is stubbed alongside the readers, and that is the
        # load-bearing part rather than symmetry. The mutual-exclusion call
        # below runs with the MISSPELLED roots installed, so it is safe only
        # because the arm it is testing returns 2 first. If that arm ever
        # regresses, this hook — which is `always_run` — would rewrite the
        # tracked `src-tauri/table-ownership-baseline.txt` from the narrowed
        # walk on every commit, with stderr captured: the destruction this
        # change exists to prevent, performed by the assertion that tests for
        # it, silently. A test must not depend on the code under test to avoid
        # doing damage.
        _saved_counts = globals()["compute_counts"]
        _saved_read = globals()["read_baseline"]
        _saved_write = globals()["write_baseline"]
        _wrote: list[object] = []
        globals()["compute_counts"] = lambda: ({}, {})
        globals()["read_baseline"] = lambda: {}
        globals()["write_baseline"] = lambda *a, **k: _wrote.append(a)
        try:
            with contextlib.redirect_stderr(io.StringIO()):
                globals()["CRATE_ROOTS"] = _saved_roots
                real_roots_flagged = main(["--synthetic-tree"])
                globals()["CRATE_ROOTS"] = [
                    ("store", REPO_ROOT / "src-tauri" / "agaric-stores" / "src"),
                    ("app", REPO_ROOT / "src-tauri" / "src"),
                ]
                missing_root_flagged = main(["--synthetic-tree"])
                both_rc = main(["--synthetic-tree", "--update-baseline"])
        finally:
            globals()["compute_counts"] = _saved_counts
            globals()["read_baseline"] = _saved_read
            globals()["write_baseline"] = _saved_write
        root_cases += 1
        if real_roots_flagged != 0:
            failures.append(
                "--synthetic-tree changed the verdict on intact roots"
            )
        root_cases += 1
        if missing_root_flagged != 0:
            failures.append(
                "--synthetic-tree did not suppress a MISSING root"
            )
        # The two flags together must REFUSE, not re-anchor. Suppressing the
        # roots check and then rebuilding the baseline from the surviving
        # roots is how the finding gets destroyed by the flag that exists to
        # say it does not apply. Asserted on the exit code AND on the writer
        # never being reached, because only the second notices a future
        # revision that refuses after writing.
        root_cases += 1
        if _wrote:
            failures.append(
                "--synthetic-tree --update-baseline reached write_baseline "
                f"({len(_wrote)} call(s)) — it must refuse BEFORE writing"
            )
        root_cases += 1
        if both_rc != 2:
            failures.append(
                "--synthetic-tree --update-baseline was not refused "
                f"(exit {both_rc})"
            )
        # stderr captured: this call is SUPPOSED to fail, and its diagnostic
        # in the middle of a passing suite reads like a real failure.
        with contextlib.redirect_stderr(io.StringIO()):
            unflagged = main([])
        root_cases += 1
        if unflagged == 0:
            failures.append(
                "without --synthetic-tree a missing root did not fail the run"
            )
        globals()["CRATE_ROOTS"] = _saved_roots
        root_cases += 1
        if missing_crate_roots():
            failures.append(
                "the real CRATE_ROOTS reported a missing root: "
                f"{missing_crate_roots()!r}"
            )
    finally:
        globals()["CRATE_ROOTS"] = _saved_roots

    if failures:
        print("check-table-ownership self-test FAILED:", file=sys.stderr)
        for f in failures:
            print(f"  {f}", file=sys.stderr)
        return 1
    total = (
        len(regex_cases)
        + 2
        + len(exclusion_cases)
        + annotation_cases
        + root_cases
    )
    print(f"check-table-ownership self-test passed ({total} cases).")
    return 0


ROOT_MISSING_HINT = (
    "    -> #4501: a CRATE_ROOTS entry in scripts/check-table-ownership.py\n"
    "       names a directory that does not exist. Fix the LIST, not the\n"
    "       baseline: the walk skips a missing root, so re-anchoring here\n"
    "       would drop every count under it and report success. If the crate\n"
    "       was genuinely retired, remove its root from CRATE_ROOTS in the\n"
    "       same commit, then re-anchor."
)


def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        return run_self_test()
    # #4501: before anything reads or writes the baseline. A missing root is
    # checked on BOTH paths, and refuses the re-anchor rather than warning,
    # for the reason the hint gives: `compute_baseline()` walks the surviving
    # roots only, so re-anchoring against a narrowed walk deletes every count
    # under the vanished root and exits 0 — the finding destroyed by the
    # command prescribed to fix it.
    # `--synthetic-tree` is how a caller says "this tree is deliberately not
    # this repository". `pr-merge-result-check.sh` builds synthetic fixture
    # repos with roots like `src-tauri/source` and runs the ratchet guards
    # against them; asserting our roots there fails every fixture merge and
    # says nothing true about the merge under test.
    #
    # An explicit FLAG, not an env var and not an inferred condition:
    #   * inference does not work. I tried "report only when at least one
    #     declared root exists", on the theory that a misspelling leaves the
    #     siblings present while a foreign tree has none of them. The fixtures
    #     create `src-tauri/src`, so they have exactly one — indistinguishable
    #     from four crates genuinely being deleted. Nineteen assertions still
    #     failed.
    #   * an env var can arrive from anywhere, including a CI runner that
    #     inherited it by accident; a flag is visible at the call site and has
    #     to be typed by whoever meant it.
    synthetic = "--synthetic-tree" in argv
    # The two flags together are a hard error, not a quiet re-anchor.
    # `--synthetic-tree` suppresses the roots check; `--update-baseline` then
    # rebuilds from `compute_counts()`, which walks the SURVIVING roots only —
    # so the combination writes a baseline with every count under the vanished
    # root deleted and exits 0. That is precisely the destruction
    # ROOT_MISSING_HINT exists to prevent, reached by way of the flag that
    # exists to say "these roots do not apply here". No call site passes both
    # today; refusing keeps it that way.
    if synthetic and "--update-baseline" in argv:
        print(
            "--synthetic-tree and --update-baseline are mutually exclusive: "
            "the first says\nthis tree's crate roots do not apply, the second "
            "rewrites the baseline FROM those\nroots. Together they would "
            "silently drop every count under a root that is missing.",
            file=sys.stderr,
        )
        return 2
    missing = [] if synthetic else missing_crate_roots()
    if missing:
        if "--update-baseline" in argv:
            print(
                "Refusing to re-anchor: a declared CRATE_ROOTS entry is "
                "missing.\n",
                file=sys.stderr,
            )
        else:
            print(
                "Table-ownership guard (#2895) — a declared CRATE_ROOTS "
                "directory does not exist:\n",
                file=sys.stderr,
            )
        for rel in missing:
            print(f"  {rel}", file=sys.stderr)
        print("", file=sys.stderr)
        print(ROOT_MISSING_HINT, file=sys.stderr)
        return 1
    if "--update-baseline" in argv:
        write_baseline(compute_baseline())
        print(f"Wrote {BASELINE_PATH.relative_to(REPO_ROOT)}")
        return 0

    # Ownership is an AGGREGATE per-(crate, table) invariant, so we always
    # rescan the whole tree regardless of which changed files prek passed.
    counts, files = compute_counts()
    try:
        baseline = read_baseline()
    except BaselineFormatError as exc:
        print(
            f"Table-ownership guard (#2895): {exc}\n"
            f"      Fix {BASELINE_PATH.relative_to(REPO_ROOT)} or regenerate "
            f"it with --update-baseline.",
            file=sys.stderr,
        )
        return 1

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
