#!/usr/bin/env python3
"""Enforce the dynamic-SQL justification rule (#646).

docs/architecture/tooling.md claims: "Runtime `sqlx::query()` (no macro)
is restricted to genuinely-dynamic SQL ... Every such site has a comment
justifying the runtime form." Until #646 that claim was aspirational —
unlike every sibling invariant in this repo (check-raw-tx,
unsafe-allowlist, migrations-immutable), it carried no enforcing hook.

This hook converts the claim into the same enforced-contract class. It
counts every runtime `sqlx::query(` / `query_as(` / `query_scalar(` call
in production Rust (the macro forms `query!`/`query_as!`/`query_scalar!`
are compile-checked and exempt) and compares the per-file count against a
checked-in baseline (`src-tauri/dynamic-sql-baseline.txt`). The codebase
already carries many such sites; retrofitting a justifying comment onto
every one is out of scope for the hook. Instead the hook applies
back-pressure to NEW sites:

  * A file whose count EXCEEDS its baseline must carry, at every dynamic
    site, a `// dynamic-sql: <reason>` marker attached to the STATEMENT
    the call belongs to — on the call line, on any earlier physical line
    of the same statement, or anywhere in the contiguous comment run
    directly above it (#3653) — otherwise the hook fails and points the
    author at the macro forms.
  * A file whose count is at or below baseline passes unchanged (existing
    sites are grandfathered; no mass retrofit required).
  * When a file's site count drops, regenerate the baseline:
        python3 scripts/check-dynamic-sql.py --update-baseline
    (also run this when you add a new site WITH its marker, to re-anchor
    the baseline so future additions are measured against the new floor).

The scan reuses the comment/string-stripping and `#[cfg(test)]`-module
logic from check-raw-tx.py (imported), so a `sqlx::query(` mention inside
a comment or string never fires, a call split across lines is still
caught, and test fixtures are excluded. A file carrying an INNER
`#![cfg(test)]` attribute is skipped outright (#3653): such a module
cannot be compiled into a release binary at all, so none of its queries
can reach production and the guard has no remit over them.

Invocation: prek passes the set of changed files as argv (hook id
`check-dynamic-sql`). Run manually over the whole tree with:

    python3 scripts/check-dynamic-sql.py $(git ls-files \
        'src-tauri/src/*.rs' 'src-tauri/agaric-store/src/*.rs' \
        'src-tauri/agaric-engine/src/*.rs' 'src-tauri/agaric-sync/src/*.rs' \
        'src-tauri/diagnostics/src/*.rs')

Since #3107 the scan follows the four crate roots the table-ownership guard
(#2895) polices (app / agaric-store / agaric-engine / agaric-sync) plus the
diagnostics crate — the #2621 crate split relocated much dynamic-SQL surface
into the subcrates, which this guard previously never followed.

Stdlib only — no third-party deps.
"""

from __future__ import annotations

import importlib.util
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
BASELINE_PATH = REPO_ROOT / "src-tauri" / "dynamic-sql-baseline.txt"

# Reuse the battle-tested comment-stripper, raw-string handling,
# test-file detection, and #[cfg(test)] line-set tracker from the
# raw-tx guard rather than re-deriving them (and their #818 fixes).
_spec = importlib.util.spec_from_file_location(
    "_check_raw_tx", REPO_ROOT / "scripts" / "check-raw-tx.py"
)
assert _spec and _spec.loader
_crt = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_crt)

strip_rust_comments = _crt.strip_rust_comments
cfg_test_line_set = _crt.cfg_test_line_set
is_test_file = _crt.is_test_file
_glob_match = _crt._glob_match

# --- Scan roots -----------------------------------------------------------
# The #2621 crate split moved substantial dynamic-SQL surface out of
# `src-tauri/src` into `agaric-store` / `agaric-engine` / `agaric-sync`, but
# this guard kept scanning only `src-tauri/src` — a NEW runtime `sqlx::query(`
# in a subcrate was invisible to the ratchet (#3107). Scan the SAME four crate
# roots the table-ownership guard (#2895) polices, plus the diagnostics crate.
#
# These MIRROR `check-table-ownership.py`'s `CRATE_ROOTS` /
# `EXTRA_TEST_FILE_GLOBS` / `is_excluded_file` deliberately by REPLICATION
# rather than import: the two guards stay decoupled (no dynamic-sql →
# table-ownership dependency edge). Keep this list in sync with that guard —
# when a crate root is added there (e.g. a future `agaric-core`), add it here
# too so the scan never silently goes stale again.
#
# Longer paths must be probed before `src-tauri/src` so a subcrate file is not
# misattributed to the "app" prefix (only matters for the startswith check in
# `main`).
CRATE_ROOTS: list[Path] = [
    REPO_ROOT / "src-tauri" / "agaric-store" / "src",
    REPO_ROOT / "src-tauri" / "agaric-engine" / "src",
    REPO_ROOT / "src-tauri" / "agaric-sync" / "src",
    REPO_ROOT / "src-tauri" / "diagnostics" / "src",
    REPO_ROOT / "src-tauri" / "src",
]

# Guard-local test/fixture exclusions layered on top of the shared
# `is_test_file` (tests.rs / tests/** / *_tests.rs). Mirrors
# check-table-ownership.py: whole-file property-test modules that are
# `#[cfg(test)]`-gated at their `mod` declaration but whose FILENAMES escape
# the shared globs, the `test-util` pool helper, and standalone audit/bin
# binaries (their fixture-seed queries are not production dynamic SQL).
EXTRA_TEST_FILE_GLOBS = [
    "**/*proptest*.rs",
    "**/test_support.rs",
    "**/src/bin/**",
]


def is_excluded_file(rel_path: str) -> bool:
    """Test/fixture/bin files skipped by the scan.

    The shared `is_test_file` OR this guard's `EXTRA_TEST_FILE_GLOBS`.
    """
    return is_test_file(rel_path) or any(
        _glob_match(rel_path, g) for g in EXTRA_TEST_FILE_GLOBS
    )

# Runtime (non-macro) query constructors. The trailing `(` (with optional
# whitespace) distinguishes them from the compile-checked macro forms
# `sqlx::query!(` / `query_as!(` / `query_scalar!(`, whose `!` means the
# next char is `!`, not `(`.
#
# An optional turbofish between the method name and the call parens must be
# tolerated — the turbofish form (`sqlx::query_scalar::<_, String>(`) is in
# fact the DOMINANT runtime-query style in this codebase, and a bare
# `sqlx::query(?:_as|_scalar)?\s*\(` silently skips every one of them (the
# #646 blind spot fixed in #1188; such a site slipped the #667 review). The
# turbofish body is matched lazily (`.*?>`) rather than `[^>]*>` so nested
# generics close at the OUTER `>` — `::<_, Option<i64>>(`, `::<_, Vec<u8>>(`
# — instead of stopping at the inner one. `.` excludes newlines, so the call
# parens must sit on the same line as the turbofish close; the bare-form
# multi-line-call behavior is unchanged (still caught by the no-turbofish
# branch).
DYN_SQL_RE = re.compile(r"sqlx::query(?:_as|_scalar)?\s*(?:::<.*?>)?\s*\(")

MARKER = "// dynamic-sql:"

# An INNER attribute — `#![cfg(test)]` at the top of a file, before any item.
# Rust only accepts inner attributes there, so a match found while scanning
# down from line 1 past blanks, comments and other inner attributes gates the
# WHOLE file: it is compiled only under `cfg(test)` and cannot reach a release
# binary (#3653). `#[cfg(test)]` (outer, no `!`) does not match — that gates a
# single item and is already handled per-line by `cfg_test_line_set`.
INNER_CFG_TEST_RE = re.compile(r"^\s*#!\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]")
_INNER_ATTR_RE = re.compile(r"^\s*#!\s*\[")

HINT = (
    "    -> #646: a runtime `sqlx::query(`/`query_as(`/`query_scalar(` is a\n"
    "       NEW dynamic-SQL site. Prefer the compile-checked macro form\n"
    "       (`sqlx::query!` / `query_as!`) so the query is validated against\n"
    "       the schema at build time (the .sqlx offline cache).\n"
    "       If the query is genuinely dynamic (recursive CTE built at\n"
    "       runtime, FTS5 query builder, snapshot/sync fan-out), add a\n"
    "       `// dynamic-sql: <reason>` comment on the call line, on an\n"
    "       earlier line of the same statement, or in the comment block\n"
    "       directly above it, then re-anchor the baseline:\n"
    "         python3 scripts/check-dynamic-sql.py --update-baseline"
)


def is_test_only_module(text: str) -> bool:
    """True iff the file carries a file-level inner `#![cfg(test)]` (#3653).

    Scans down from line 1 through blank lines, comments and other inner
    attributes — the only things Rust allows before one. The first line that
    is none of those ends the inner-attribute region, so an `#![cfg(test)]`
    written inside an inline `mod foo { … }` further down is never mistaken
    for a whole-file gate.

    Such a file is compiled only under `cfg(test)`; no query in it can reach
    a release binary, which is the entire population this guard polices. It
    is skipped rather than required to justify itself.
    """
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("//") or line.startswith("/*"):
            continue
        if INNER_CFG_TEST_RE.match(raw):
            return True
        if _INNER_ATTR_RE.match(raw):
            continue
        return False
    return False


def scan_text(text: str) -> list[int]:
    """0-based line indices of production dynamic-SQL sites in `text`.

    Comment-/string-stripped, `#[cfg(test)]`-module lines excluded.
    """
    stripped = strip_rust_comments(text)
    stripped_lines = stripped.splitlines()
    test_lines = cfg_test_line_set(stripped_lines)
    indices: list[int] = []
    for m in DYN_SQL_RE.finditer(stripped):
        idx = stripped.count("\n", 0, m.start())
        if idx in test_lines:
            continue
        indices.append(idx)
    return indices


def _marker_scope(raw: list[str], code: list[str], idx: int) -> list[int]:
    """Line indices a marker for the site at `idx` may legitimately live on.

    The original rule was "the call line or the ONE line above", which is a
    physical-offset rule masquerading as a semantic one — and `cargo fmt`
    owns the physical offsets. Reflowing `let rows = sqlx::query_as(…)` into
    `let rows =` / `sqlx::query_as(…)` pushes a perfectly valid marker two
    lines up and turns a passing file red at PRE-COMMIT, with no way to fix
    it except contorting the code (hoisting the SQL into a `const`) so the
    call fits back onto one line (#3653).

    So the marker attaches to the STATEMENT instead. Walking up from the
    call line, the scope covers:
      * earlier physical lines of the same statement — a line that does not
        close one (no trailing `;` / `{` / `}` in its CODE, comments and
        string literals already blanked out in `code`); and
      * the contiguous run of comment lines directly above that statement,
        so a multi-line justification block reads top-down as written.

    It stops at the first blank line or completed statement/block boundary,
    so a marker belonging to a PREVIOUS statement — including a trailing
    `// dynamic-sql:` comment on one — never covers this site.
    """
    scope = [idx]
    j = min(idx, len(raw)) - 1
    while j >= 0:
        code_line = code[j].strip() if j < len(code) else ""
        raw_line = raw[j].strip()
        if not code_line:
            # No code on this line: either a comment-only line (comments are
            # blanked in `code`) or a genuinely blank one.
            if raw_line.startswith(("//", "/*", "*")):
                scope.append(j)
                j -= 1
                continue
            break
        if code_line.endswith((";", "{", "}")):
            break
        scope.append(j)
        j -= 1
    return scope


def unmarked_sites(text: str, indices: list[int]) -> list[int]:
    """Return the 0-based indices of dynamic sites WITHOUT a marker."""
    raw = text.splitlines()
    code = strip_rust_comments(text).splitlines()
    missing: list[int] = []
    for idx in indices:
        if any(
            MARKER in raw[j]
            for j in _marker_scope(raw, code, idx)
            if j < len(raw)
        ):
            continue
        missing.append(idx)
    return missing


def read_source(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return ""


def count_sites(path: Path) -> tuple[int, list[int]]:
    """Return (count, 0-based-line-indices) of dynamic-SQL sites."""
    indices = scan_text(read_source(path))
    return len(indices), indices


def site_has_marker(path: Path, indices: list[int]) -> list[int]:
    """Return the 0-based indices of dynamic sites WITHOUT a marker."""
    return unmarked_sites(read_source(path), indices)


def all_production_files() -> list[Path]:
    files: list[Path] = []
    for root in CRATE_ROOTS:
        if not root.is_dir():
            continue
        for p in sorted(root.rglob("*.rs")):
            rel = str(p.relative_to(REPO_ROOT))
            if is_excluded_file(rel):
                continue
            if is_test_only_module(read_source(p)):
                continue
            files.append(p)
    return files


def compute_baseline() -> dict[str, int]:
    baseline: dict[str, int] = {}
    for p in all_production_files():
        cnt, _ = count_sites(p)
        if cnt:
            rel = str(p.relative_to(REPO_ROOT))
            baseline[rel] = cnt
    return baseline


def write_baseline(baseline: dict[str, int]) -> None:
    lines = [
        "# Dynamic-SQL baseline (#646) — per-file count of runtime "
        "`sqlx::query(`/`query_as(`/`query_scalar(` sites.",
        "# Generated by: python3 scripts/check-dynamic-sql.py "
        "--update-baseline",
        "# The check-dynamic-sql prek hook fails when a file's site count "
        "EXCEEDS its baseline",
        "# unless every dynamic site in that file carries an adjacent "
        "`// dynamic-sql: <reason>` marker.",
        "# Format: <count> <path-relative-to-repo-root>",
        "",
    ]
    for rel in sorted(baseline):
        lines.append(f"{baseline[rel]} {rel}")
    BASELINE_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")


def read_baseline() -> dict[str, int]:
    baseline: dict[str, int] = {}
    if not BASELINE_PATH.exists():
        return baseline
    for raw in BASELINE_PATH.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split(None, 1)
        if len(parts) != 2:
            continue
        try:
            baseline[parts[1]] = int(parts[0])
        except ValueError:
            continue
    return baseline


def run_self_test() -> int:
    """Lock in DYN_SQL_RE's match contract (the #1188 turbofish fix).

    Asserts the regex catches every runtime-query spelling — including the
    turbofish form that the pre-#1188 regex silently skipped — while still
    exempting the compile-checked macro forms.
    """
    should_match = [
        # Bare forms (already caught before #1188).
        'sqlx::query("SELECT 1")',
        "sqlx::query_as::<_, BlockRow>(sql)",
        "sqlx::query_scalar::<_, String>(",
        # The #1188 blind spot: turbofish before the call parens.
        'sqlx::query_scalar::<_, i64>("SELECT COUNT(*)")',
        "sqlx::query_as::<_, (String, i64)>(sql)",  # tuple type
        # Nested generics — must close at the OUTER `>` (`.*?`, not `[^>]*`).
        'sqlx::query_scalar::<_, Option<i64>>("SELECT position")',
        "sqlx::query_scalar::<_, Vec<u8>>(blob_sql)",
        "sqlx::query_scalar::<_, Option<String>>(q)",
    ]
    should_not_match = [
        # Compile-checked macros are exempt (the `!` is not `(`).
        'sqlx::query!("SELECT 1")',
        "sqlx::query_as!(BlockRow, sql)",
        "sqlx::query_scalar!(",
        # Unrelated tokens.
        "let query = build_query();",
        "// sqlx::query_scalar mentioned in prose",
    ]
    failures: list[str] = []
    for s in should_match:
        if not DYN_SQL_RE.search(s):
            failures.append(f"expected MATCH, got none: {s!r}")
    for s in should_not_match:
        if DYN_SQL_RE.search(s):
            failures.append(f"expected NO match, but matched: {s!r}")

    # --- Scan-scope contract (#3107) ---
    # The scan must reach the subcrate roots the #2621 split moved dynamic SQL
    # into, and must exclude proptest / bin / test-support fixture files that
    # legitimately open ad-hoc queries. (rel-path, expect_excluded).
    scope_cases: list[tuple[str, bool]] = [
        # Subcrate production files MUST be scanned (not excluded).
        ("src-tauri/agaric-store/src/op_log/append.rs", False),
        ("src-tauri/agaric-engine/src/loro/projection.rs", False),
        ("src-tauri/agaric-sync/src/lib.rs", False),
        ("src-tauri/src/commands/blocks/crud.rs", False),
        # Property-test modules whose filenames escape the shared globs, the
        # test-util pool helper, and standalone bins MUST be excluded.
        ("src-tauri/src/dag/proptest_b2.rs", True),
        ("src-tauri/agaric-store/src/test_support.rs", True),
        ("src-tauri/diagnostics/src/bin/audit_cross_space_refs.rs", True),
        # The shared test-file globs still apply across all roots.
        ("src-tauri/agaric-store/src/op_log/tests.rs", True),
    ]
    scoped_roots = tuple(
        str(root.relative_to(REPO_ROOT)) + "/" for root in CRATE_ROOTS
    )
    for rel, expect_excluded in scope_cases:
        if not rel.startswith(scoped_roots):
            failures.append(f"scope: {rel!r} not under any scanned crate root")
        got = is_excluded_file(rel)
        if got != expect_excluded:
            failures.append(
                f"is_excluded_file({rel!r}) expected {expect_excluded}, "
                f"got {got}"
            )

    # --- Test-only-module contract (#3653, part 1) ---
    # A file whose FIRST item-level thing is an inner `#![cfg(test)]` is
    # compiled only under cfg(test) and cannot reach a release binary, so it
    # is out of the guard's remit however it is named. Before #3653 such a
    # file was scanned like production code and its every runtime query had
    # to carry a justification marker.
    test_only_cases: list[tuple[str, bool, str]] = [
        (
            "#![cfg(test)]\n\nuse sqlx::SqlitePool;\n"
            'async fn f(p: &SqlitePool) { sqlx::query("SELECT 1"); }\n',
            True,
            "bare inner attribute on line 1",
        ),
        (
            "//! Oracle module, test-only.\n\n// leading comment\n"
            "#![allow(clippy::pedantic)]\n#![cfg(test)]\n\nfn f() {}\n",
            True,
            "inner attribute after doc comments and another inner attribute",
        ),
        (
            "  #! [ cfg ( test ) ]\nfn f() {}\n",
            True,
            "whitespace-tolerant spelling",
        ),
        (
            'use sqlx::SqlitePool;\nfn f() { sqlx::query("SELECT 1"); }\n',
            False,
            "ordinary production file",
        ),
        (
            "#[cfg(test)]\nmod tests {\n    fn f() {}\n}\n",
            False,
            "OUTER #[cfg(test)] gates one item, not the file",
        ),
        (
            "fn real() {}\nmod inline {\n    #![cfg(test)]\n    fn f() {}\n}\n",
            False,
            "inner attribute inside an inline mod is not a file-level gate",
        ),
    ]
    for text, expect_skip, label in test_only_cases:
        got_skip = is_test_only_module(text)
        if got_skip != expect_skip:
            failures.append(
                f"is_test_only_module ({label}): expected {expect_skip}, "
                f"got {got_skip}"
            )

    # --- Marker-scope contract (#3653, part 2) ---
    # The marker attaches to the STATEMENT, not to a physical line offset.
    # `cargo fmt` owns the offsets: reflowing a call across two lines used to
    # orphan a valid marker and redden a passing file at pre-commit. Each
    # case is (source, expected count of UNMARKED sites, label).
    marker_cases: list[tuple[str, int, str]] = [
        (
            'let rows = sqlx::query("SELECT 1"); // dynamic-sql: on the call\n',
            0,
            "marker on the call line",
        ),
        (
            "// dynamic-sql: reason\n"
            'let rows = sqlx::query("SELECT 1");\n',
            0,
            "marker on the line immediately above (the pre-#3653 rule)",
        ),
        (
            "// The schema is chosen at runtime from the caller's space set,\n"
            "// so the column list cannot be known at compile time.\n"
            "// dynamic-sql: runtime-built column list\n"
            "// (see the module header for the full derivation)\n"
            'let rows = sqlx::query("SELECT 1");\n',
            0,
            "marker anywhere in the contiguous comment run above",
        ),
        (
            # Verbatim `rustfmt --edition 2021` output for a one-line call
            # that no longer fits: it hoists `let … =` onto its own line and
            # the marker, valid before the reformat, is now TWO lines above
            # the call. This exact shape reddens under the pre-#3653 rule.
            "    // dynamic-sql: runtime-built column list\n"
            "    let rows_for_the_current_space =\n"
            "        sqlx::query_as::<_, (String, i64, String)>(sql)\n"
            "            .fetch_all(pool)\n"
            "            .await;\n",
            0,
            "marker survives a cargo fmt reflow of the same statement",
        ),
        (
            'let rows = sqlx::query("SELECT 1");\n',
            1,
            "no marker at all still fails",
        ),
        (
            "// dynamic-sql: this one is justified\n"
            'let a = sqlx::query("SELECT 1");\n'
            'let b = sqlx::query("SELECT 2");\n',
            1,
            "a previous statement's marker does not cover the next site",
        ),
        (
            'let a = sqlx::query("SELECT 1"); // dynamic-sql: justified\n'
            'let b = sqlx::query("SELECT 2");\n',
            1,
            "a previous statement's TRAILING marker does not leak downward",
        ),
        (
            "// dynamic-sql: justified\n"
            "\n"
            'let rows = sqlx::query("SELECT 1");\n',
            1,
            "a blank line ends the comment run",
        ),
    ]
    for text, expect_missing, label in marker_cases:
        indices = scan_text(text)
        if not indices:
            failures.append(f"marker scope ({label}): no site detected at all")
            continue
        got_missing = len(unmarked_sites(text, indices))
        if got_missing != expect_missing:
            failures.append(
                f"marker scope ({label}): expected {expect_missing} unmarked "
                f"site(s), got {got_missing}"
            )

    if failures:
        print("check-dynamic-sql self-test FAILED:", file=sys.stderr)
        for f in failures:
            print(f"  {f}", file=sys.stderr)
        return 1
    total = (
        len(should_match)
        + len(should_not_match)
        + len(scope_cases)
        + len(test_only_cases)
        + len(marker_cases)
    )
    print(f"check-dynamic-sql self-test passed ({total} cases).")
    return 0


def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        return run_self_test()
    if "--update-baseline" in argv:
        write_baseline(compute_baseline())
        print(f"Wrote {BASELINE_PATH.relative_to(REPO_ROOT)}")
        return 0

    baseline = read_baseline()

    # Determine which files to check. prek passes changed files; a manual
    # whole-tree run passes the full glob. Either way, only police production
    # .rs under one of the scanned crate roots (#3107).
    root_prefixes = tuple(
        str(root.relative_to(REPO_ROOT)) + "/" for root in CRATE_ROOTS
    )
    targets: list[Path] = []
    for arg in argv:
        p = Path(arg)
        if p.suffix != ".rs":
            continue
        try:
            rel = str(p.resolve().relative_to(REPO_ROOT))
        except ValueError:
            continue
        if not rel.startswith(root_prefixes):
            continue
        if is_excluded_file(rel):
            continue
        if not p.is_file():
            continue
        # A whole-file `#![cfg(test)]` module cannot reach a release binary
        # (#3653) — outside this guard's remit, whatever its filename.
        if is_test_only_module(read_source(p)):
            continue
        targets.append(p)

    violations: list[str] = []
    for p in targets:
        rel = str(p.resolve().relative_to(REPO_ROOT))
        cnt, indices = count_sites(p)
        base = baseline.get(rel, 0)
        if cnt <= base:
            continue
        # File grew past its baseline. Every dynamic site in it must now
        # carry a justifying marker (the cheapest correct rule: we can't
        # know which physical site is "new" across edits, so require the
        # whole file to be clean once it grows).
        missing = site_has_marker(p, indices)
        if missing:
            for idx in missing:
                line_txt = ""
                try:
                    line_txt = (
                        p.read_text(encoding="utf-8").splitlines()[idx].strip()
                    )
                except (OSError, UnicodeDecodeError, IndexError):
                    pass
                violations.append(f"{rel}:{idx + 1}: {line_txt}")

    if violations:
        print(
            "Dynamic-SQL justification guard (#646) — new runtime "
            "`sqlx::query(` site(s) without a `// dynamic-sql:` marker:\n",
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
