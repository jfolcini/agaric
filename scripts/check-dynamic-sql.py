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
  * When a file's site count changes, re-anchor ITS entry:
        python3 scripts/check-dynamic-sql.py --update-baseline <path>...
    With no paths it re-anchors the files in your current diff. Either
    way it is SCOPED: every other entry stays byte-identical.

Why scoped (#3659). `--update-baseline` used to regenerate the WHOLE file
from the tree. The baseline had drifted — eight entries disagreed with the
code, in both directions, `block_ops.rs` by nine sites — so the
safest-looking command in the guard's own interface silently laundered
eight unrelated changes into any diff that legitimately needed to touch
one. The observed workarounds were to not re-anchor at all (a file left
above its baseline stays in the stricter every-site-must-be-marked mode,
which passes), and — in #3717 — to hand-edit a single line into this
generated file. Both are the interface's fault.

Drift is now an error rather than something that accumulates: a file whose
count is BELOW its baseline is slack the ratchet is not reclaiming, and an
entry naming a file that no longer holds any dynamic SQL is dead weight.
Both fail, and both are fixed by the scoped command above.
`--update-baseline --all` still regenerates everything, for when that is
genuinely what you mean.

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
import os
import re
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent

# Reuse the battle-tested comment-stripper, raw-string handling,
# test-file detection, and #[cfg(test)] line-set tracker from the
# raw-tx guard rather than re-deriving them (and their #818 fixes).
#
# Both loads are resolved from SCRIPT_DIR, not REPO_ROOT: the libraries live
# beside this file wherever it is run from, while REPO_ROOT below is the
# repository being JUDGED, which during a self-test is a throwaway fixture.
_spec = importlib.util.spec_from_file_location("_check_raw_tx", SCRIPT_DIR / "check-raw-tx.py")
assert _spec and _spec.loader
_crt = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_crt)

strip_rust_comments = _crt.strip_rust_comments
cfg_test_line_set = _crt.cfg_test_line_set
is_test_file = _crt.is_test_file
_glob_match = _crt._glob_match

# Which COPY of each file this guard judges — the staged index during a
# commit, the working tree otherwise (#3962, swept here by #4017). The
# baseline machinery is the part that makes this guard different from its two
# siblings: the ratchet compares a RECORDED count against a count read from a
# file, and the orphan sweep asks whether a baselined file still exists. Both
# questions have to be asked of the same copy, or the guard reports a file
# grew past its baseline while judging content nobody is committing.
_gfs_spec = importlib.util.spec_from_file_location(
    "_guard_file_source", SCRIPT_DIR / "lib" / "guard_file_source.py"
)
assert _gfs_spec and _gfs_spec.loader
guard_file_source = importlib.util.module_from_spec(_gfs_spec)
_gfs_spec.loader.exec_module(guard_file_source)

# The tree this guard JUDGES is the tree that CONTAINS it — never one
# derived from the process cwd. See scripts/lib/guard_file_source.py
# ("Which TREE is judged"): pr-merge-result-check.sh runs the MERGED
# worktree's own copy of this script so that the copy's location is the
# statement of which tree to judge, and check-table-ownership.py has
# always spelled it this way.
REPO_ROOT = SCRIPT_DIR.parent
BASELINE_PATH = REPO_ROOT / "src-tauri" / "dynamic-sql-baseline.txt"

# The source every disk-reading helper below consults. Module-level because
# `read_source` / `in_scan_scope` / `orphan_entries` are called from a dozen
# places, several of them deep inside the baseline machinery, and threading a
# parameter through all of them is how two of them end up disagreeing about
# which copy they are judging — the defect this is fixing. `main` replaces it
# once, up front; it defaults to the working tree so `--update-baseline` and
# the self-test keep their existing behaviour.
SOURCE = guard_file_source.FileSource(
    REPO_ROOT, guard_file_source.SOURCE_WORKTREE, "default: working tree"
)

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
    "**/bulk_equivalence/**",
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


def _rel(path: Path) -> str:
    """`path` as a repo-relative posix string, the spelling `SOURCE` speaks."""
    try:
        return str(path.resolve().relative_to(REPO_ROOT))
    except ValueError:
        return str(path)


def read_source(path: Path) -> str:
    """`path`'s contents from the source being judged, "" if unreadable.

    THE SINGLE FUNNEL. `count_sites`, `site_has_marker`, `in_scan_scope`,
    `orphan_entries`, `all_production_files` and `main`'s violation-line
    lookup all come through here, so there is exactly one place that can
    be wrong about which copy the guard is reading.
    """
    text = SOURCE.read(_rel(path))
    return "" if text is None else text


def exists_in_source(path: Path) -> bool:
    """Is `path` present in the source being judged?

    Under the index that means "will be in the commit", which is what makes
    a `git rm --cached` (staged deletion, file still on disk) visible to the
    orphan sweep. `Path.is_file()` said yes to that, so the baseline entry it
    should have reclaimed survived the commit that deleted its file.
    """
    return SOURCE.exists(_rel(path))


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


def merge_baseline(
    existing: dict[str, int], scope: list[str], counts: dict[str, int]
) -> dict[str, int]:
    """Existing baseline with ONLY `scope`'s entries re-anchored (#3659).

    Every key outside `scope` is carried through untouched — including one
    that disagrees with the tree. That is the point: a whole-file
    regeneration is what dragged eight unrelated drifted entries into a
    diff that meant to touch one. Reconciling the rest is its own commit,
    with its own review.

    A scoped path whose count is zero (file deleted, its last runtime
    query converted to a macro, or the file became test-only) drops out of
    the baseline rather than being recorded as `0`.
    """
    merged = dict(existing)
    for rel in scope:
        cnt = counts.get(rel, 0)
        if cnt:
            merged[rel] = cnt
        else:
            merged.pop(rel, None)
    return merged


def drifted_entries(baseline: dict[str, int], counts: dict[str, int]) -> list[str]:
    """Entries whose recorded count sits ABOVE the tree's actual count.

    Downward drift is invisible to the ratchet — the guard only fires when
    a file EXCEEDS its baseline — so it accumulates silently, and every
    stale entry is headroom for a future unjustified site to be added
    without anyone noticing. `counts` holds the actual counts for the
    files being checked; entries not in it are not judged here.
    """
    return [
        f"{rel}: baseline records {baseline[rel]} site(s), the tree has "
        f"{counts[rel]}"
        for rel in sorted(counts)
        if rel in baseline and counts[rel] < baseline[rel]
    ]


def in_scan_scope(rel: str) -> bool:
    """True iff the scan actually covers `rel` right now.

    The single definition of "covered", so the three places that need it —
    `orphan_entries` (which flags an entry the scan no longer covers),
    `baseline_count` (which must record ZERO for exactly those), and
    `compute_baseline` via `all_production_files` — cannot disagree. They
    did: an entry whose file had become a whole-file `#![cfg(test)]`
    module, or had moved under a test/fixture glob, was flagged as an
    orphan but then RE-WRITTEN by the scoped `--update-baseline` the
    guard's own message told you to run, because that path only asked
    `is_file()`. The guard stayed red pointing at a remedy that could not
    clear it, leaving `--all` (what #3659 exists to avoid) or a hand-edit
    of a generated file (the #3717 anti-pattern) as the only ways out.
    """
    path = REPO_ROOT / rel
    return (
        exists_in_source(path)
        and not is_excluded_file(rel)
        and not is_test_only_module(read_source(path))
    )


def baseline_count(rel: str) -> int:
    """The count a baseline entry for `rel` should record — 0 if uncovered."""
    return count_sites(REPO_ROOT / rel)[0] if in_scan_scope(rel) else 0


def orphan_entries(baseline: dict[str, int]) -> list[str]:
    """Entries naming a file the scan no longer covers.

    Deleted, renamed, moved under a test/fixture glob, or turned into a
    whole-file `#![cfg(test)]` module. Cheap (a stat plus, at most, one
    read per entry) and global, so an orphan cannot hide in a file nobody
    happens to be touching.
    """
    orphans: list[str] = []
    for rel in sorted(baseline):
        path = REPO_ROOT / rel
        if not exists_in_source(path):
            orphans.append(f"{rel}: no such file (deleted or renamed)")
        elif is_excluded_file(rel):
            orphans.append(f"{rel}: now a test/fixture path, outside the scan")
        elif is_test_only_module(read_source(path)):
            orphans.append(f"{rel}: now a whole-file `#![cfg(test)]` module")
    return orphans


def changed_production_files() -> list[str]:
    """Repo-relative production .rs paths in the current diff.

    The default scope for a bare `--update-baseline`: what you are
    actually working on. Uses the working tree + index against HEAD, plus
    untracked files, so a brand-new module counts.
    """
    import subprocess  # local: only the update path shells out

    out: list[str] = []
    for cmd in (
        ["git", "diff", "--name-only", "HEAD"],
        ["git", "ls-files", "--others", "--exclude-standard"],
    ):
        try:
            res = subprocess.run(
                cmd, cwd=REPO_ROOT, capture_output=True, text=True, check=False
            )
        except OSError:
            continue
        out.extend(line.strip() for line in res.stdout.splitlines())

    root_prefixes = tuple(
        str(root.relative_to(REPO_ROOT)) + "/" for root in CRATE_ROOTS
    )
    scope: list[str] = []
    for rel in out:
        if not rel.endswith(".rs") or not rel.startswith(root_prefixes):
            continue
        if is_excluded_file(rel) or rel in scope:
            continue
        scope.append(rel)
    return sorted(scope)


def write_baseline(baseline: dict[str, int]) -> None:
    lines = [
        "# Dynamic-SQL baseline (#646) — per-file count of runtime "
        "`sqlx::query(`/`query_as(`/`query_scalar(` sites.",
        "# Generated by: python3 scripts/check-dynamic-sql.py "
        "--update-baseline <path>...  (SCOPED — #3659)",
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
    """The ratchet's recorded counts, from the source being judged.

    Through `read_source` like everything else (#4017): a commit that stages
    a re-anchored baseline alongside the file it re-anchors must be judged
    against the STAGED baseline, or the ratchet compares tomorrow's counts
    against yesterday's ceiling and reports a violation nobody is committing.
    An absent file reads as "" and yields an empty baseline, exactly as the
    old `BASELINE_PATH.exists()` early return did.
    """
    baseline: dict[str, int] = {}
    for raw in read_source(BASELINE_PATH).splitlines():
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

    # --- Scoped-re-anchor contract (#3659) ---
    # `--update-baseline` regenerated the WHOLE file, so an update that
    # legitimately needed one entry rewrote every drifted one alongside it —
    # into a diff where a reviewer reading a focused change has no reason to
    # question them. The scoped merge must leave every out-of-scope entry
    # exactly as it found it, drift and all.
    fixture = {
        "src-tauri/src/a.rs": 3,
        "src-tauri/src/b.rs": 8,
        "src-tauri/src/drifted.rs": 2,  # tree really has 11 — must NOT move
        "src-tauri/src/gone.rs": 1,
    }
    merged = merge_baseline(
        fixture,
        ["src-tauri/src/a.rs"],
        {"src-tauri/src/a.rs": 5, "src-tauri/src/drifted.rs": 11},
    )
    if merged.get("src-tauri/src/a.rs") != 5:
        failures.append("scoped update: the in-scope entry was not re-anchored")
    untouched = {k: v for k, v in merged.items() if k != "src-tauri/src/a.rs"}
    expected_untouched = {k: v for k, v in fixture.items() if k != "src-tauri/src/a.rs"}
    if untouched != expected_untouched:
        failures.append(
            f"scoped update: out-of-scope entries changed — {untouched} != "
            f"{expected_untouched}"
        )
    if len(merged) != len(fixture):
        failures.append(
            f"scoped update: entry count not preserved ({len(merged)} vs "
            f"{len(fixture)})"
        )

    # A scoped path that no longer has any site drops out — and still only
    # that one.
    dropped = merge_baseline(fixture, ["src-tauri/src/gone.rs"], {})
    if "src-tauri/src/gone.rs" in dropped:
        failures.append("scoped update: a zero-count scoped entry was not removed")
    if {k: v for k, v in dropped.items() if k != "src-tauri/src/gone.rs"} != {
        k: v for k, v in fixture.items() if k != "src-tauri/src/gone.rs"
    }:
        failures.append("scoped update: removing one entry disturbed the others")

    # Re-anchoring nothing must be a no-op, byte for byte.
    if merge_baseline(fixture, [], {}) != fixture:
        failures.append("scoped update: an empty scope changed the baseline")

    # --- Downward-drift / orphan contract (#3659) ---
    # A file BELOW its recorded count never trips the ratchet (the guard
    # only fires above it), which is how eight entries drifted unnoticed.
    drift = drifted_entries(
        {"src-tauri/src/a.rs": 8, "src-tauri/src/b.rs": 2},
        {"src-tauri/src/a.rs": 5, "src-tauri/src/b.rs": 2},
    )
    if len(drift) != 1 or "src-tauri/src/a.rs" not in drift[0]:
        failures.append(f"downward drift not reported exactly once: {drift}")
    if drifted_entries({"src-tauri/src/a.rs": 5}, {"src-tauri/src/a.rs": 9}):
        failures.append(
            "a file ABOVE its baseline was reported as drift (that is the "
            "marker rule's job, not this one)"
        )
    orphans = orphan_entries({"src-tauri/src/definitely-not-here-3659.rs": 2})
    if len(orphans) != 1:
        failures.append(f"orphan baseline entry not reported: {orphans}")
    if orphan_entries({}):
        failures.append("orphan check fired on an empty baseline")

    # --- The printed remedy must actually clear the orphan (#3724 review) ---
    # `orphan_entries` flags three kinds; the scoped re-anchor used to ask
    # only `is_file()`, so for two of them `count_sites` still returned a
    # positive number and the entry was RE-WRITTEN instead of dropped. The
    # guard then stayed red pointing at a command that could not fix it.
    # Real files, chosen because each has runtime sites the old code would
    # have recorded — a fixture with zero sites could not tell the two
    # implementations apart.
    remedy_fixtures = [
        ("src-tauri/src/reconciliation_oracle.rs", "whole-file #![cfg(test)] module"),
        ("src-tauri/agaric-store/src/test_support.rs", "test/fixture glob"),
        ("src-tauri/src/definitely-not-here-3659.rs", "deleted file"),
    ]
    for rel, kind in remedy_fixtures:
        path = REPO_ROOT / rel
        if path.is_file() and count_sites(path)[0] == 0:
            failures.append(
                f"remedy fixture stale: {rel} ({kind}) no longer has any "
                "runtime site, so it cannot distinguish the two "
                "implementations — pick another file"
            )
        if in_scan_scope(rel):
            failures.append(
                f"remedy fixture stale: {rel} is now IN scan scope ({kind} no "
                "longer holds)"
            )
        if baseline_count(rel) != 0:
            failures.append(
                f"scoped re-anchor cannot clear the {kind} orphan: "
                f"baseline_count({rel!r}) = {baseline_count(rel)}, expected 0"
            )

    # End to end: an operator who runs exactly the command the guard prints,
    # over exactly the entries it flagged, ends up green.
    healthy = "src-tauri/agaric-engine/src/block_ops.rs"
    orphaned_baseline = {
        healthy: 1,  # deliberately stale, and IN scope: must be re-anchored
        **{rel: 7 for rel, _ in remedy_fixtures},
    }
    flagged = orphan_entries(orphaned_baseline)
    if len(flagged) != len(remedy_fixtures):
        failures.append(
            f"expected {len(remedy_fixtures)} orphans flagged, got {flagged}"
        )
    remedy_scope = [rel for rel, _ in remedy_fixtures] + [healthy]
    after = merge_baseline(
        orphaned_baseline,
        remedy_scope,
        {rel: baseline_count(rel) for rel in remedy_scope},
    )
    if orphan_entries(after):
        failures.append(
            "running the printed remedy left orphans behind: "
            f"{orphan_entries(after)}"
        )
    if after.get(healthy) != count_sites(REPO_ROOT / healthy)[0]:
        failures.append(
            "the printed remedy did not re-anchor the in-scope entry: "
            f"{after.get(healthy)}"
        )

    # --- The baseline agrees with the tree, right now ---
    # The property that silently stopped holding. Asserted against the live
    # checkout, not a fixture: after a re-anchor, a second `--update-baseline`
    # must be a no-op, and the number of baselined entries must equal the
    # number of files that really carry dynamic SQL.
    live_actual = compute_baseline()
    live_recorded = read_baseline()
    if live_actual != live_recorded:
        only_tree = {
            k: v for k, v in live_actual.items() if live_recorded.get(k) != v
        }
        only_base = {
            k: v for k, v in live_recorded.items() if live_actual.get(k) != v
        }
        failures.append(
            "the checked-in baseline disagrees with the tree "
            f"({len(live_recorded)} entries recorded, {len(live_actual)} real): "
            f"tree says {only_tree}; baseline says {only_base}. "
            "Re-anchor with: python3 scripts/check-dynamic-sql.py "
            "--update-baseline <path>..."
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
        + 14  # scoped-update / drift / orphan / remedy / live-agreement
    )
    print(f"check-dynamic-sql self-test passed ({total} cases).")
    return 0


def _to_rel(arg: str) -> str | None:
    """Normalize a CLI path to a repo-relative production .rs path."""
    try:
        rel = str(Path(arg).resolve().relative_to(REPO_ROOT))
    except (ValueError, OSError):
        return None
    root_prefixes = tuple(
        str(root.relative_to(REPO_ROOT)) + "/" for root in CRATE_ROOTS
    )
    if not rel.endswith(".rs") or not rel.startswith(root_prefixes):
        return None
    return rel


def update_baseline(argv: list[str]) -> int:
    """Scoped re-anchor (#3659). Only the named entries may change."""
    existing = read_baseline()

    if "--all" in argv:
        new = compute_baseline()
        scope_label = "the whole tree (--all)"
    else:
        scope: list[str] = []
        for arg in argv:
            if arg.startswith("--"):
                continue
            rel = _to_rel(arg)
            if rel is None:
                print(
                    f"check-dynamic-sql: not a scanned production .rs path: {arg}",
                    file=sys.stderr,
                )
                return 1
            if rel not in scope:
                scope.append(rel)
        if not scope:
            scope = changed_production_files()
            scope_label = f"{len(scope)} file(s) from the current diff"
            if not scope:
                print(
                    "check-dynamic-sql: nothing to re-anchor — no production .rs "
                    "files in the current diff.\n"
                    "  Name the files explicitly, or pass --all to regenerate the "
                    "whole baseline\n"
                    "  (which rewrites EVERY entry — see #3659).",
                    file=sys.stderr,
                )
                return 1
        else:
            scope_label = f"{len(scope)} file(s) given on the command line"

        # `baseline_count`, not a bare `count_sites`: a file the scan no
        # longer covers must record ZERO (i.e. drop out), or the remedy
        # this command exists to be cannot clear the orphan it is run for.
        counts = {rel: baseline_count(rel) for rel in scope}
        new = merge_baseline(existing, scope, counts)

    changed = sorted(
        rel
        for rel in set(existing) | set(new)
        if existing.get(rel) != new.get(rel)
    )
    write_baseline(new)
    print(f"Re-anchored {BASELINE_PATH.relative_to(REPO_ROOT)} — scope: {scope_label}")
    if not changed:
        print("  (no entry changed — the baseline already agreed with the tree)")
    for rel in changed:
        before = existing.get(rel)
        after = new.get(rel)
        print(
            f"  {rel}: {'-' if before is None else before} -> "
            f"{'removed' if after is None else after}"
        )
    print(f"  {len(new)} entries (was {len(existing)})")
    return 0


def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        return run_self_test()
    if "--update-baseline" in argv:
        return update_baseline([a for a in argv if a != "--update-baseline"])

    global SOURCE
    try:
        SOURCE = guard_file_source.build(
            argv,
            os.environ,
            REPO_ROOT,
            extra_flags=("--self-test", "--update-baseline", "--all", "--print-source"),
        )
    except (guard_file_source.UsageError, guard_file_source.AmbiguousSourceError) as err:
        print(f"check-dynamic-sql: invocation error: {err}", file=sys.stderr)
        return 2
    if "--print-source" in argv:
        print(
            f"check-dynamic-sql: "
            f"{guard_file_source.describe_source(SOURCE.source)} ({SOURCE.why})"
        )
        return 0

    try:
        return _check(argv, read_baseline())
    except guard_file_source.GitError as err:
        # Fail CLOSED — see the same branch in check-raw-tx.py. Here the
        # empty-index answer is doubly wrong: it would also report every
        # baseline entry as an orphan, so the guard is loudly wrong about
        # 60 files instead of silently wrong about all of them.
        print(f"check-dynamic-sql: invocation error: {err}", file=sys.stderr)
        return 2


def _check(argv: list[str], baseline: dict[str, int]) -> int:
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
        # Presence is asked of the SOURCE BEING JUDGED, not of the disk:
        # `p.is_file()` skipped a path that was `git add`ed and then removed
        # from the working tree — a file that IS being committed.
        if not exists_in_source(p):
            continue
        # A whole-file `#![cfg(test)]` module cannot reach a release binary
        # (#3653) — outside this guard's remit, whatever its filename.
        if is_test_only_module(read_source(p)):
            continue
        targets.append(p)

    violations: list[str] = []
    actual_counts: dict[str, int] = {}
    for p in targets:
        rel = str(p.resolve().relative_to(REPO_ROOT))
        cnt, indices = count_sites(p)
        actual_counts[rel] = cnt
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
                # Through `read_source`, like every other read here: quoting
                # the working tree's line under a verdict about the index
                # would print a line the author cannot find in what is
                # actually being committed.
                lines = read_source(p).splitlines()
                line_txt = lines[idx].strip() if idx < len(lines) else ""
                violations.append(f"{rel}:{idx + 1}: {line_txt}")

    if violations:
        print(
            "Dynamic-SQL justification guard (#646) — new runtime "
            "`sqlx::query(` site(s) without a `// dynamic-sql:` marker:\n",
            file=sys.stderr,
        )
        print(
            f"  (judged the {guard_file_source.describe_source(SOURCE.source)} "
            f"— {SOURCE.why})",
            file=sys.stderr,
        )
        for v in violations:
            print(f"  {v}", file=sys.stderr)
        print("", file=sys.stderr)
        print(HINT, file=sys.stderr)
        return 1

    # Baseline-vs-tree agreement (#3659). Checked AFTER the marker rule so a
    # genuine violation is never buried under bookkeeping. Downward drift is
    # judged only for the files being checked (the whole tree, under prek's
    # --all-files); orphaned entries are judged globally, since an entry
    # naming a file nobody is touching is exactly how drift survives.
    stale = drifted_entries(baseline, actual_counts) + orphan_entries(baseline)
    if stale:
        print(
            "Dynamic-SQL baseline is out of step with the tree (#3659) — the "
            "ratchet is holding\nslack it should have reclaimed:\n",
            file=sys.stderr,
        )
        for s in stale:
            print(f"  {s}", file=sys.stderr)
        print(
            "\n    -> Re-anchor just these entries (every other line stays "
            "byte-identical):\n"
            "         python3 scripts/check-dynamic-sql.py --update-baseline "
            "<path>...\n"
            "       or, for the files in your current diff:\n"
            "         python3 scripts/check-dynamic-sql.py --update-baseline",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
