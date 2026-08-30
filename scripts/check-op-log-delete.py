#!/usr/bin/env python3
"""Confine production `DELETE FROM op_log` to the store's bypass module (#4018).

Why this guard exists
---------------------
`op_log` is append-only *by trigger*: BEFORE UPDATE / BEFORE DELETE triggers
abort any mutation unless a sentinel row in `_op_log_mutation_allowed` is
present in the same transaction. `agaric-store/src/op_log/bypass.rs` owns that
sentinel — and, crucially, owns the SECOND obligation a wholesale delete
carries.

That second obligation is the durable per-device seq high-water mark
(#3310 / #3998). The local-append allocator picks the next `seq` as
`COALESCE(MAX(seq), 0) + 1` floored at the recorded high-water. Wipe `op_log`
without recording the pre-delete `MAX(seq)` per device and the floor is gone,
so the allocator restarts at `seq = 1` and re-mints `(device_id, seq)`
addresses a paired peer still holds. That peer's `INSERT OR IGNORE` then
silently swallows this device's entire post-wipe history. `truncate` and
`prune` in `bypass.rs` capture the frontier before deleting; the raw
`enable_op_log_mutation_bypass` / `disable_op_log_mutation_bypass` pair does
not, and it is `pub` with a doc that invites callers to "drive their own
multi-statement bypass window".

Nothing in the trigger, the type system, or the sibling hooks would catch a
production caller that took that invitation, and the symptom is invisible on
the device that causes it. #4016 added the obligation to the doc, which is the
weakest possible enforcement; this guard is the stronger one the #4018 review
asked for. Making the raw pair private is not an option — cross-crate tests
legitimately drive their own bypass windows — so the guard constrains the
DANGEROUS STATEMENT rather than the API that permits it.

What it enforces
----------------
A production (non-test) `DELETE FROM op_log` may appear only in
`src-tauri/agaric-store/src/op_log/bypass.rs`. Test code is exempt: the seven
existing open-coded delete sites are all `#[cfg(test)]` and they are how the
immutability triggers themselves get tested. A new production site must either
call `truncate` / `prune` (which is almost always the right answer) or move
its statement into `bypass.rs` next to the frontier capture, where the pairing
is reviewable in one place.

This is an ALLOWLIST, not a ratchet: there is no baseline to re-anchor,
because the correct production count outside `bypass.rs` is zero and has
always been zero. If that ever needs to change, the allowlist below is the
one line to edit, and editing it is the review conversation.

Scanning notes
--------------
The statement lives INSIDE `sqlx::query!("…")` / `sqlx::query("…")` strings,
so — like check-table-ownership.py and unlike the code-token guards — this
scans string CONTENTS. It blanks only `//` and `/* */` comments (so the
several doc comments that quote `DELETE FROM op_log` never trip it) and
reuses `cfg_test_line_set` from check-raw-tx.py to skip `#[cfg(test)]` regions
and `is_excluded_file` from check-table-ownership.py (which itself ORs
check-raw-tx.py's `is_test_file` with that guard's extra fixture globs) to skip
test files. Stdlib only — no third-party deps.

Usage:
    python3 scripts/check-op-log-delete.py [FILE ...]   # scan (args ignored)
    python3 scripts/check-op-log-delete.py --self-test  # fixture suite
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

# Reuse the battle-tested test-file detection, #[cfg(test)] line-set tracker
# and comment-only stripper rather than re-deriving them. The stripper must be
# the one that PRESERVES string literals (`strip_comments_keep_strings` in the
# ownership guard) — `strip_rust_comments` in check-raw-tx.py blanks string
# contents, which is exactly the text this guard has to read.
_rt_spec = importlib.util.spec_from_file_location(
    "_check_raw_tx", REPO_ROOT / "scripts" / "check-raw-tx.py"
)
assert _rt_spec and _rt_spec.loader
_rt = importlib.util.module_from_spec(_rt_spec)
_rt_spec.loader.exec_module(_rt)

_to_spec = importlib.util.spec_from_file_location(
    "_check_table_ownership", REPO_ROOT / "scripts" / "check-table-ownership.py"
)
assert _to_spec and _to_spec.loader
_to = importlib.util.module_from_spec(_to_spec)
_to_spec.loader.exec_module(_to)

cfg_test_line_set = _rt.cfg_test_line_set
strip_comments_keep_strings = _to.strip_comments_keep_strings
# `is_excluded_file` already ORs check-raw-tx.py's `is_test_file` with the
# ownership guard's own extra fixture globs, so it is the ONLY file-level
# test predicate this guard needs — binding `is_test_file` here as well would
# read as if `scan()` applied two independent skips when it applies one.
is_excluded_file = _to.is_excluded_file

# The ONE module allowed to delete `op_log` rows in production: it owns both
# halves of the obligation (the mutation-bypass sentinel bracket AND the
# pre-delete seq high-water capture) in `truncate` / `prune`.
ALLOWED_FILES: frozenset[str] = frozenset(
    {"src-tauri/agaric-store/src/op_log/bypass.rs"}
)

# Roots scanned, mirroring check-table-ownership.py's crate roots. Longer
# paths are irrelevant here (we only need the file set), but keeping the same
# roots means the two guards agree on what "production Rust" is.
SCAN_ROOTS: list[Path] = [
    REPO_ROOT / "src-tauri" / "agaric-store" / "src",
    REPO_ROOT / "src-tauri" / "agaric-engine" / "src",
    REPO_ROOT / "src-tauri" / "agaric-sync" / "src",
    REPO_ROOT / "src-tauri" / "diagnostics" / "src",
    REPO_ROOT / "src-tauri" / "src",
]

# `DELETE FROM op_log`, with `\s+` so the statement may wrap inside a macro
# string and a trailing `\b` so a future `op_log_archive` table is not caught
# by this guard's message.
DELETE_RE = re.compile(r"DELETE\s+FROM\s+op_log\b", re.IGNORECASE)

HINT = (
    "    -> #4018 / #3310: a production `DELETE FROM op_log` outside\n"
    "       agaric-store/src/op_log/bypass.rs. A wholesale op_log delete must\n"
    "       ALSO capture the pre-delete per-device MAX(seq) into the durable\n"
    "       high-water mark, or the local-append allocator restarts at seq = 1\n"
    "       over the emptied log and re-mints (device_id, seq) addresses a\n"
    "       paired peer still holds — whose INSERT OR IGNORE then silently\n"
    "       swallows this device's post-wipe history.\n"
    "       Call `agaric_store::op_log::truncate` (RESET) or `prune`\n"
    "       (compaction) instead: they bracket the mutation bypass AND capture\n"
    "       the frontier. If you genuinely need a new bespoke delete, put it in\n"
    "       bypass.rs next to `capture_all_frontiers` so the pairing is\n"
    "       reviewable in one place."
)


def find_deletes_in_text(text: str) -> list[int]:
    """0-based line indices of production `DELETE FROM op_log` in `text`.

    Comments are blanked (string literals preserved) and `#[cfg(test)]`
    module lines are excluded. Pure — no file I/O — so `--self-test` can
    drive it directly.
    """
    stripped = strip_comments_keep_strings(text)
    test_lines = cfg_test_line_set(stripped.splitlines())
    hits: list[int] = []
    for m in DELETE_RE.finditer(stripped):
        idx = stripped.count("\n", 0, m.start())
        if idx in test_lines:
            continue
        hits.append(idx)
    return hits


def missing_scan_roots() -> list[str]:
    """Declared SCAN_ROOTS that are not directories in this checkout.

    #4501: `scan()` used to `continue` past a missing root, so a renamed or
    misspelled crate segment narrowed the walk with no signal at all — the
    guard reporting success over a tree it had stopped reading. Byte-identical
    to the construct removed from `check-space-filter-drift` in #4508 and from
    `check-table-ownership` in #4540; this guard was the fourth carrier, and
    the one the original sweep missed because the issue body named only three.

    Reported rather than filtered: a root that vanished is a BROKEN
    declaration, not an absent one.

    No `--synthetic-tree` opt-out here, unlike `check-table-ownership`, and
    deliberately: this guard is not in `pr-merge-result-check.sh`'s
    RATCHET_GUARDS and is not seeded into any fixture repository, so it has no
    caller that runs it against a deliberately-foreign tree. A suppression
    flag with no call site is a fail-open nothing polices — the shape #4540's
    review found three times in one PR — so it is not added on speculation.
    Add it, and its unreachability assertion, when a synthetic caller appears.
    """
    return [
        str(root.relative_to(REPO_ROOT))
        for root in SCAN_ROOTS
        if not root.is_dir()
    ]


ROOT_MISSING_HINT = (
    "    -> #4501: a SCAN_ROOTS entry in scripts/check-op-log-delete.py names a\n"
    "       directory that does not exist. Fix the LIST: the walk skips a\n"
    "       missing root, so this guard would otherwise report zero violations\n"
    "       over a tree it never read. If the crate was genuinely retired,\n"
    "       remove its root from SCAN_ROOTS in the same commit — and check the\n"
    "       sibling guards, which mirror this list by hand."
)


def scan() -> list[tuple[str, int]]:
    """(repo-relative path, 1-based line) of every disallowed delete site."""
    violations: list[tuple[str, int]] = []
    for root in SCAN_ROOTS:
        if not root.is_dir():
            # Skipped here only so the walk does not raise; the run is failed
            # by `missing_scan_roots()` in `main()`, which names the root.
            continue
        for path in sorted(root.rglob("*.rs")):
            rel = str(path.relative_to(REPO_ROOT))
            if rel in ALLOWED_FILES or is_excluded_file(rel):
                continue
            try:
                text = path.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                continue
            for idx in find_deletes_in_text(text):
                violations.append((rel, idx + 1))
    return violations


def run_self_test() -> int:
    """Lock in the match contract: what counts, and what deliberately does not."""
    failures: list[str] = []

    # (fixture, expected number of production hits, label)
    cases: list[tuple[str, int, str]] = [
        # The real spellings must be caught.
        ('sqlx::query!("DELETE FROM op_log").execute(&mut *tx).await?;', 1,
         "bare macro delete"),
        ('sqlx::query("DELETE FROM op_log WHERE device_id = ?")', 1,
         "runtime query with predicate"),
        # Wrapped across lines inside a macro string.
        ('sqlx::query!(\n    "DELETE\n     FROM op_log WHERE seq <= ?",\n)', 1,
         "statement wrapped across lines"),
        # Lowercase SQL.
        ('sqlx::query("delete from op_log")', 1, "lowercase"),
        # Doc comments and prose quoting the statement must NOT count — the
        # bypass docs, the restore path's explanation and this guard's own
        # rationale all spell it out in comments.
        ("/// A bare `DELETE FROM op_log` would abort on the trigger.\n", 0,
         "doc comment prose"),
        ("// ... UPDATE / DELETE FROM op_log ...\n", 0, "line comment prose"),
        ("/* DELETE FROM op_log */\n", 0, "block comment prose"),
        # Word boundary: a differently-named table is not this table.
        ('sqlx::query!("DELETE FROM op_log_archive")', 0, "op_log_archive"),
        # `#[cfg(test)]` regions are exempt — the immutability tests must be
        # able to attempt exactly this statement.
        (
            'fn prod() {}\n'
            '#[cfg(test)]\n'
            'mod tests {\n'
            '    fn t() {\n'
            '        sqlx::query("DELETE FROM op_log WHERE seq = 1");\n'
            '    }\n'
            '}\n',
            0,
            "#[cfg(test)] module",
        ),
        # ... but a production statement in the SAME file still counts.
        (
            'fn prod() {\n'
            '    sqlx::query("DELETE FROM op_log");\n'
            '}\n'
            '#[cfg(test)]\n'
            'mod tests {\n'
            '    fn t() {\n'
            '        sqlx::query("DELETE FROM op_log");\n'
            '    }\n'
            '}\n',
            1,
            "production + test in one file",
        ),
    ]
    for fixture, expected, label in cases:
        got = len(find_deletes_in_text(fixture))
        if got != expected:
            failures.append(
                f"{label}: expected {expected} hit(s), got {got}: {fixture!r}"
            )

    # The allowlisted file must actually exist and must actually contain the
    # statements — otherwise the allowlist is a stale path silently exempting
    # nothing (or, worse, exempting a file someone later creates there).
    for rel in sorted(ALLOWED_FILES):
        path = REPO_ROOT / rel
        if not path.is_file():
            failures.append(f"allowlisted file does not exist: {rel}")
            continue
        if not find_deletes_in_text(path.read_text(encoding="utf-8")):
            failures.append(
                f"allowlisted file {rel} contains no production "
                "`DELETE FROM op_log`; the exemption is stale"
            )

    # #4501 assertion 3, pinned in BOTH directions. A one-sided "a misspelled
    # root is reported" would pass just as well against a guard that reports
    # every root as missing, and the second half is also the live assertion
    # that this checkout's own declaration is intact.
    root_cases = 0
    _saved_roots = SCAN_ROOTS[:]
    try:
        globals()["SCAN_ROOTS"] = [
            REPO_ROOT / "src-tauri" / "agaric-stores" / "src",  # misspelled
            REPO_ROOT / "src-tauri" / "src",  # present sibling
        ]
        root_cases += 1
        if missing_scan_roots() != ["src-tauri/agaric-stores/src"]:
            failures.append(
                "a misspelled crate root alongside a present sibling was not "
                f"reported: {missing_scan_roots()!r}"
            )
        # Through `main()`, not the helper: a helper-level assertion would not
        # notice the WIRING being dropped, which is how the assertion goes dead
        # while still passing its own test.
        root_cases += 1
        with contextlib.redirect_stderr(io.StringIO()):
            if main([]) == 0:
                failures.append(
                    "main() exited 0 over a missing SCAN_ROOTS entry — the walk "
                    "was narrowed and the run still reported success"
                )
        globals()["SCAN_ROOTS"] = _saved_roots
        root_cases += 1
        if missing_scan_roots():
            failures.append(
                f"the real SCAN_ROOTS reported a missing root: {missing_scan_roots()!r}"
            )
    finally:
        globals()["SCAN_ROOTS"] = _saved_roots

    if failures:
        print("check-op-log-delete self-test FAILED:", file=sys.stderr)
        for f in failures:
            print(f"  - {f}", file=sys.stderr)
        return 1
    print(
        f"check-op-log-delete self-test OK ({len(cases)} fixtures, "
        f"{root_cases} root cases)"
    )
    return 0


def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        return run_self_test()
    # #4501, before the scan: a narrowed walk answers "no violations" for a
    # reason that has nothing to do with the tree being clean, and this guard's
    # entire output is a negative claim.
    missing = missing_scan_roots()
    if missing:
        print(
            "check-op-log-delete: a declared SCAN_ROOTS directory does not "
            "exist:\n",
            file=sys.stderr,
        )
        for rel in missing:
            print(f"  {rel}", file=sys.stderr)
        print("", file=sys.stderr)
        print(ROOT_MISSING_HINT, file=sys.stderr)
        return 1
    # File arguments from prek are ignored: the invariant is repo-wide, and a
    # diff-scoped scan would miss a delete added to a file the same commit did
    # not otherwise touch.
    violations = scan()
    if not violations:
        return 0
    print(
        "check-op-log-delete: production `DELETE FROM op_log` outside "
        "the store's bypass module:",
        file=sys.stderr,
    )
    for rel, line in violations:
        print(f"  {rel}:{line}", file=sys.stderr)
    print(HINT, file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
