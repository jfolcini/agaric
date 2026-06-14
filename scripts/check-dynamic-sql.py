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
    site, an adjacent `// dynamic-sql: <reason>` marker (on the call line
    or the line immediately above) — otherwise the hook fails and points
    the author at the macro forms.
  * A file whose count is at or below baseline passes unchanged (existing
    sites are grandfathered; no mass retrofit required).
  * When a file's site count drops, regenerate the baseline:
        python3 scripts/check-dynamic-sql.py --update-baseline
    (also run this when you add a new site WITH its marker, to re-anchor
    the baseline so future additions are measured against the new floor).

The scan reuses the comment/string-stripping and `#[cfg(test)]`-module
logic from check-raw-tx.py (imported), so a `sqlx::query(` mention inside
a comment or string never fires, a call split across lines is still
caught, and test fixtures are excluded.

Invocation: prek passes the set of changed files as argv (hook id
`check-dynamic-sql`). Run manually over the whole tree with:

    python3 scripts/check-dynamic-sql.py $(git ls-files 'src-tauri/src/*.rs')

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

HINT = (
    "    -> #646: a runtime `sqlx::query(`/`query_as(`/`query_scalar(` is a\n"
    "       NEW dynamic-SQL site. Prefer the compile-checked macro form\n"
    "       (`sqlx::query!` / `query_as!`) so the query is validated against\n"
    "       the schema at build time (the .sqlx offline cache).\n"
    "       If the query is genuinely dynamic (recursive CTE built at\n"
    "       runtime, FTS5 query builder, snapshot/sync fan-out), add a\n"
    "       `// dynamic-sql: <reason>` comment on the call line or the line\n"
    "       above, then re-anchor the baseline:\n"
    "         python3 scripts/check-dynamic-sql.py --update-baseline"
)


def count_sites(path: Path) -> tuple[int, list[int]]:
    """Return (count, 0-based-line-indices) of dynamic-SQL sites.

    Comment-/string-stripped, `#[cfg(test)]`-module lines excluded.
    """
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return 0, []
    stripped = strip_rust_comments(text)
    stripped_lines = stripped.splitlines()
    test_lines = cfg_test_line_set(stripped_lines)
    indices: list[int] = []
    for m in DYN_SQL_RE.finditer(stripped):
        idx = stripped.count("\n", 0, m.start())
        if idx in test_lines:
            continue
        indices.append(idx)
    return len(indices), indices


def site_has_marker(path: Path, indices: list[int]) -> list[int]:
    """Return the 0-based indices of dynamic sites WITHOUT a marker."""
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeDecodeError):
        return indices
    missing: list[int] = []
    for idx in indices:
        line = lines[idx] if idx < len(lines) else ""
        above = lines[idx - 1] if idx > 0 else ""
        if MARKER in line or MARKER in above:
            continue
        missing.append(idx)
    return missing


def all_production_files() -> list[Path]:
    files: list[Path] = []
    for p in sorted((REPO_ROOT / "src-tauri" / "src").rglob("*.rs")):
        rel = str(p.relative_to(REPO_ROOT))
        if is_test_file(rel):
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
    if failures:
        print("check-dynamic-sql self-test FAILED:", file=sys.stderr)
        for f in failures:
            print(f"  {f}", file=sys.stderr)
        return 1
    print(f"check-dynamic-sql self-test passed "
          f"({len(should_match) + len(should_not_match)} cases).")
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
    # whole-tree run passes the full glob. Either way, only police
    # production .rs under src-tauri/src/.
    targets: list[Path] = []
    for arg in argv:
        p = Path(arg)
        if p.suffix != ".rs":
            continue
        try:
            rel = str(p.resolve().relative_to(REPO_ROOT))
        except ValueError:
            continue
        if not rel.startswith("src-tauri/src/"):
            continue
        if is_test_file(rel):
            continue
        if not p.is_file():
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
