#!/usr/bin/env python3
"""Guard against NEW raw write-transaction sites in production Rust.

Issue #110 replaced ad-hoc `pool.begin_with("BEGIN IMMEDIATE")`
write transactions in user-edit paths with the `CommandTx` convention
(open via `crate::db::begin_immediate_logged` + couple the commit with
post-commit materializer dispatch). This hook stops the convention from
silently regressing: it flags any *new* raw write-tx opened outside an
audited allowlist or per-site escape hatch.

Invocation: prek passes the set of changed files as argv (see prek.toml,
hook id `check-raw-tx`). Run manually over the whole tree with:

    python3 scripts/check-raw-tx.py $(git ls-files 'src-tauri/src/*.rs')

Rules (per .rs file under src-tauri/src/):
  * Any call to `begin_with(...)` (regardless of argument — a const-
    hoisted `"BEGIN IMMEDIATE"` must not evade the guard, #818) or
    `begin_immediate_logged(` is a raw write-tx site, EXCEPT:
      - the `pub async fn begin_immediate_logged` definition and the
        `begin_with("BEGIN IMMEDIATE")` inside it (the primitive itself —
        but db.rs is allowlisted anyway), and the `CommandTx` internal
        call to `begin_immediate_logged`.
  * #653 (DEFERRED-tx guard): a bare `.begin(` call (the sqlx default,
    which opens a `BEGIN DEFERRED` transaction — NOT `begin_with` /
    `begin_immediate_logged`) is flagged ONLY in a file that also
    references `append_local_op_in_tx` / `append_local_undo_op_in_tx`.
    That pairing is the danger #653 makes enforceable: those functions do
    a `SELECT MAX(seq)+1` read then an `INSERT`, which races to
    `SQLITE_BUSY_SNAPSHOT` under a DEFERRED tx but is safe under
    `BEGIN IMMEDIATE` (the lock is taken eagerly). Today every caller
    threads a `CommandTx`-opened (IMMEDIATE) transaction in, so the
    contract holds — but a future caller wiring a plain `pool.begin()`
    into the append would compile clean and only fail under contention.
    The proximity scope keeps this false-positive-free: bare `.begin()`
    is legitimate for read-only / rollback-only paths elsewhere (e.g.
    `cache/page_id.rs`, `snapshot/create.rs`), and none of those files
    call the append helpers. Same `// allow-raw-tx:` escape hatch.
  * The scan runs over COMMENT-STRIPPED whole-file text (#818): a call
    split across lines (`begin_with(\n  "BEGIN IMMEDIATE")`) is caught,
    and a mention inside a `//` or `/* */` comment never fires. Match
    offsets map back to 1-based line numbers for reporting.
  * Lines inside a `#[cfg(test)]` module (or a whole test file) are
    skipped — test fixtures legitimately open raw transactions.
  * Files matching the ALLOWLIST globs are skipped wholesale (raw tx is
    architecturally correct there — see the #110 audit table).
  * A site is exempt if the offending line, or the line immediately
    above it, carries the `// allow-raw-tx:` per-site escape hatch.

Anything left over is printed as `file:line: <code>` with a pointer to
#110 and the script exits non-zero. Stdlib only — no third-party deps.
"""

from __future__ import annotations

import fnmatch
import re
import sys
from pathlib import Path

ISSUE_HINT = (
    "    -> #110: route user-edit write txs through the "
    "CommandTx convention\n"
    "       (`crate::db::begin_immediate_logged` + coupled post-commit "
    "dispatch).\n"
    "       If raw tx is genuinely correct here (no op_log writes / "
    "derived-cache / system-level),\n"
    "       add `// allow-raw-tx: <reason>` on the line or the line above, "
    "or extend the\n"
    "       allowlist in scripts/check-raw-tx.py."
)

# Files where a raw write-tx is architecturally legitimate (from the #110
# audit). Globs are matched against the path relative to the repo root,
# using fnmatch semantics where `**` is normalised to span path segments.
ALLOWLIST_GLOBS = [
    # The begin_immediate_logged / CommandTx primitive itself
    # (db.rs was split into the db/ directory in #644).
    "src-tauri/src/db.rs",
    "src-tauri/src/db/**",
    # The materializer was split into materializer/handlers/ in #644.
    "src-tauri/src/materializer/handlers/**",
    # Cache rebuilds — pure consumers of op_log, never producers.
    "src-tauri/src/cache/**",
    # FTS index — derived data, no op_log.
    "src-tauri/src/fts/index.rs",
    # Tag-inheritance rebuild — derived cache (verified: no op_log writes).
    "src-tauri/src/tag_inheritance/rebuild.rs",
    # The materializer itself — dispatching here would self-recurse.
    # (handlers.rs was split into the handlers/ directory in #644.)
    "src-tauri/src/materializer/handlers/**",
    # System-level snapshot / compaction — must not dispatch edit tasks.
    "src-tauri/src/snapshot/create.rs",
    "src-tauri/src/snapshot/restore.rs",
    # Startup recovery, before any user edit.
    "src-tauri/src/recovery/draft_recovery.rs",
    # Transport layer.
    "src-tauri/src/sync_daemon/snapshot_transfer.rs",
    # apply_remote — remote ops; dispatching would double-fire.
    "src-tauri/src/sync_protocol/loro_sync.rs",
    # Post-session bookkeeping.
    "src-tauri/src/sync_protocol/orchestrator.rs",
    # External-integration internals, no op_log.
    "src-tauri/src/gcal_push/connector.rs",
    "src-tauri/src/gcal_push/lease.rs",
    # NOTE (#224 resolved): op_log.rs `append_local_op[_at]` and
    # dag.rs `append_merge_op` are test/bench-only convenience wrappers that
    # open their own tx — production appends via the `*_in_tx` variants on an
    # outer CommandTx. They carry per-line `// allow-raw-tx:` markers (no file
    # allowlist needed); their other raw sites live in `#[cfg(test)]` modules,
    # which this hook already skips.
]

# Whole-file test modules. Files named `tests.rs`, anything under a
# `tests/` directory, and `*_tests.rs` are declared `#[cfg(test)] mod ...`
# by their parent module, so they carry no inner `#[cfg(test)]` to track.
# Treat the entire file as test code.
TEST_FILE_GLOBS = [
    "**/tests.rs",
    "**/tests/**",
    "**/*_tests.rs",
]

# Whole-file scan over comment-stripped text (#818): `\s*` tolerates a
# call split across lines, and flagging EVERY `begin_with(` call —
# regardless of argument — closes the const-hoisted-SQL evasion
# (`begin_with(WRITE_SQL)`). The only production write-tx primitives
# are these two; a legitimately-raw site uses the allowlist or the
# `// allow-raw-tx:` marker.
RAW_TX_RE = re.compile(r"begin_with\s*\(|begin_immediate_logged\s*\(")

# Lines that are the primitive's own definition / internal plumbing, not a
# caller. Matched anywhere (db.rs is allowlisted, but be defensive).
DEFINITION_RE = re.compile(r"pub async fn begin_immediate_logged")

# #653: a bare `.begin(` call — the sqlx default that opens a
# `BEGIN DEFERRED` transaction. `\bbegin\s*\(` matches `pool.begin()` but
# NOT `begin_with(` / `begin_immediate_logged(` (those have `_…` between
# `begin` and `(`, so `\s*\(` fails to reach the paren) — i.e. the
# IMMEDIATE primitives stay governed by RAW_TX_RE above, and only the
# truly-deferred default is caught here. The leading `\b` keeps it from
# firing on identifiers such as `rebegin(`.
DEFERRED_BEGIN_RE = re.compile(r"\bbegin\s*\(")

# #653: the op-log append helpers whose `SELECT MAX(seq)+1` + `INSERT`
# requires the enclosing tx to be `BEGIN IMMEDIATE`. A bare deferred
# `.begin(` is only a #653 violation when it shares a file with one of
# these — the "near the function" proximity rule from the issue, which
# keeps the guard false-positive-free against read-only `.begin()` paths
# elsewhere in the tree.
APPEND_HELPER_RE = re.compile(
    r"\bappend_local_(?:undo_)?op_in_tx\b"
)

ALLOW_MARKER = "// allow-raw-tx:"

CFG_TEST_RE = re.compile(r"#\[\s*cfg\s*\(\s*test\s*\)\s*\]")
MOD_RE = re.compile(r"\bmod\b")


def strip_rust_comments(text: str) -> str:
    """Blank out comments AND literal contents for scanning purposes.

    `//` line comments, (nested) `/* */` block comments, string literals
    (incl. raw strings `r#"…"#`), and char literals are all replaced
    with spaces (newlines preserved), so byte offsets and line numbers
    in the result map 1:1 onto the original text. Blanking literal
    contents means a string that merely MENTIONS `begin_with(` can never
    fire the scan, and a `//` inside a string never truncates it.
    Lifetimes (`'a`) are not confused with char literals because the
    char-literal fast-path requires a closing quote.
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
            # Possible raw string r"…" / r#"…"#.
            m = re.match(r'r(#*)"', text[i:])
            if m:
                closing = '"' + m.group(1)
                end = text.find(closing, i + len(m.group(0)))
                j = n if end == -1 else end + len(closing)
                blank(i, j)
                i = j
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
            blank(i, j)
            i = j
            continue

        if ch == "'":
            # Char literal ('x', '\n', '"') — but NOT a lifetime ('a).
            m = re.match(r"'(\\.|[^'\\\n])'", text[i:])
            if m:
                blank(i, i + len(m.group(0)))
                i += len(m.group(0))
                continue

        i += 1
    return "".join(out)


def _glob_match(path: str, pattern: str) -> bool:
    """fnmatch with `**` allowed to span `/` boundaries."""
    if "**" in pattern:
        regex = re.escape(pattern)
        regex = regex.replace(r"\*\*/", ".*").replace(r"\*\*", ".*")
        regex = regex.replace(r"\*", "[^/]*")
        return re.fullmatch(regex, path) is not None
    return fnmatch.fnmatch(path, pattern)


def is_allowlisted_file(rel_path: str) -> bool:
    return any(_glob_match(rel_path, g) for g in ALLOWLIST_GLOBS)


def is_test_file(rel_path: str) -> bool:
    return any(_glob_match(rel_path, g) for g in TEST_FILE_GLOBS)


def cfg_test_line_set(lines: list[str]) -> set[int]:
    """Return the 0-based indices of lines inside `#[cfg(test)] mod {...}`.

    Tracks brace depth from the opening `{` of a test module to its
    matching close. Handles braces appearing on the same line as `mod`
    and on a later line. String/char-literal braces are not parsed (Rust
    test modules don't legitimately put unbalanced braces in literals on
    the lines that matter here; the convention is `mod tests {`).
    """
    inside: set[int] = set()
    n = len(lines)
    i = 0
    while i < n:
        if CFG_TEST_RE.search(lines[i]):
            # Find the `mod` token on this or a following line, then its
            # opening brace.
            j = i
            found_mod = False
            while j < n:
                if MOD_RE.search(lines[j]):
                    found_mod = True
                    break
                # Bail if another attribute/item intervenes without `mod`
                # (e.g. `#[cfg(test)]` on a function, not a module).
                stripped = lines[j].strip()
                if stripped and not stripped.startswith("#["):
                    break
                j += 1
            if not found_mod:
                i += 1
                continue
            # Locate the opening brace at/after the `mod` line.
            k = j
            brace_line = -1
            brace_col = -1
            while k < n:
                col = lines[k].find("{")
                if col != -1:
                    brace_line = k
                    brace_col = col
                    break
                k += 1
            if brace_line == -1:
                i = j + 1
                continue
            # Walk braces from here to the matching close.
            depth = 0
            m = brace_line
            start_col = brace_col
            closed_at = -1
            while m < n:
                line = lines[m]
                start = start_col if m == brace_line else 0
                for c in range(start, len(line)):
                    ch = line[c]
                    if ch == "{":
                        depth += 1
                    elif ch == "}":
                        depth -= 1
                        if depth == 0:
                            closed_at = m
                            break
                if closed_at != -1:
                    break
                m += 1
            end = closed_at if closed_at != -1 else n - 1
            for idx in range(brace_line, end + 1):
                inside.add(idx)
            i = end + 1
            continue
        i += 1
    return inside


def scan_text(rel_path: str, text: str) -> list[str]:
    """Run both guards over a file's text. Pure (no I/O) so the
    `--self-test` fixtures can exercise it directly. Allowlist / test-file
    skips are applied by `check_file` before calling this — `scan_text`
    itself always scans."""
    # Whole-file scan over comment-stripped text (#818). The stripper
    # replaces comments with spaces (newlines kept), so offsets in
    # `stripped` map 1:1 onto `text` — a match's line number is the
    # newline count before its start. Comments can no longer fire the
    # regex, and a call split across lines can no longer evade it.
    stripped = strip_rust_comments(text)
    lines = text.splitlines()
    stripped_lines = stripped.splitlines()

    test_lines = cfg_test_line_set(stripped_lines)
    violations: list[str] = []

    def exempt(idx: int, line: str) -> bool:
        """Shared skip rules: inside a test module, or per-site escape
        hatch on the line itself or the line immediately above (the marker
        is a comment, so it is checked against the ORIGINAL text)."""
        if idx in test_lines:
            return True
        if ALLOW_MARKER in line:
            return True
        if idx > 0 and ALLOW_MARKER in lines[idx - 1]:
            return True
        return False

    for m in RAW_TX_RE.finditer(stripped):
        idx = stripped.count("\n", 0, m.start())  # 0-based line index
        line = lines[idx] if idx < len(lines) else ""
        # The definition is real CODE, so match it against the STRIPPED
        # line — checking the original would let a trailing comment
        # (`begin_with(W); // pub async fn begin_immediate_logged`)
        # exempt a real call site.
        stripped_line = stripped_lines[idx] if idx < len(stripped_lines) else ""
        if DEFINITION_RE.search(stripped_line):
            continue
        if exempt(idx, line):
            continue
        violations.append(f"{rel_path}:{idx + 1}: {line.strip()}")

    # #653: deferred-tx guard. Only files that actually call the op-log
    # append helpers can violate the BEGIN IMMEDIATE contract, so the bare
    # `.begin(` scan is gated on the file referencing one of them
    # (proximity rule). Without this gate, the many legitimate read-only /
    # rollback-only `pool.begin()` sites elsewhere would all false-positive.
    # The reference is sought in the comment-stripped text so a mention of
    # the helper in a doc comment does not arm the scan.
    if APPEND_HELPER_RE.search(stripped):
        for m in DEFERRED_BEGIN_RE.finditer(stripped):
            idx = stripped.count("\n", 0, m.start())
            line = lines[idx] if idx < len(lines) else ""
            if exempt(idx, line):
                continue
            violations.append(
                f"{rel_path}:{idx + 1}: {line.strip()}  "
                f"[#653: deferred .begin() near append_local_op_in_tx — "
                f"must be BEGIN IMMEDIATE]"
            )

    return violations


def check_file(path: Path, repo_root: Path) -> list[str]:
    try:
        rel_path = str(path.resolve().relative_to(repo_root))
    except ValueError:
        rel_path = str(path)

    if is_allowlisted_file(rel_path):
        return []
    if is_test_file(rel_path):
        return []

    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return []

    return scan_text(rel_path, text)


# --- #653 self-test fixtures ------------------------------------------------
# Run with `python3 scripts/check-raw-tx.py --self-test`. Proves the
# deferred-tx guard flags a bare `.begin()` near `append_local_op_in_tx`
# and stays silent on the legitimate `CommandTx` / `begin_immediate_logged`
# path, the read-only-`.begin()`-without-the-helper case, and the per-site
# escape hatch. Stdlib only — no test framework, no temp files.
_SELFTEST_CASES: list[tuple[str, str, bool]] = [
    (
        "raw deferred begin() in a file that calls the append helper -> FLAG",
        """
        async fn bad(pool: &SqlitePool) -> Result<(), AppError> {
            let mut tx = pool.begin().await?;
            op_log::append_local_op_in_tx(&mut tx, dev, payload, now).await?;
            tx.commit().await?;
            Ok(())
        }
        """,
        True,
    ),
    (
        "CommandTx / begin_immediate_logged path with the append helper -> clean",
        """
        async fn good(pool: &SqlitePool) -> Result<(), AppError> {
            let mut tx = CommandTx::begin_immediate(pool, "good").await?;
            op_log::append_local_op_in_tx(&mut tx, dev, payload, now).await?;
            tx.commit_and_dispatch(mat).await?;
            Ok(())
        }
        """,
        False,
    ),
    (
        "bare begin() but NO append helper in the file -> clean (read-only path)",
        """
        async fn read_only(pool: &SqlitePool) -> Result<(), AppError> {
            let mut read_tx = pool.begin().await?;
            let _ = sqlx::query("SELECT 1").fetch_one(&mut *read_tx).await?;
            Ok(())
        }
        """,
        False,
    ),
    (
        "bare begin() near the helper but carrying the // allow-raw-tx escape hatch -> clean",
        """
        async fn justified(pool: &SqlitePool) -> Result<(), AppError> {
            // allow-raw-tx: single-writer migration path, no contention
            let mut tx = pool.begin().await?;
            op_log::append_local_op_in_tx(&mut tx, dev, payload, now).await?;
            Ok(())
        }
        """,
        False,
    ),
    (
        "bare begin() + append helper, but both inside a #[cfg(test)] module -> clean",
        """
        #[cfg(test)]
        mod tests {
            async fn t(pool: &SqlitePool) {
                let mut tx = pool.begin().await.unwrap();
                op_log::append_local_op_in_tx(&mut tx, dev, payload, now).await.unwrap();
            }
        }
        """,
        False,
    ),
    (
        "append helper mentioned only in a doc comment, real begin() below -> clean (scan not armed)",
        """
        /// See append_local_op_in_tx for the BEGIN IMMEDIATE contract.
        async fn read_only(pool: &SqlitePool) -> Result<(), AppError> {
            let mut read_tx = pool.begin().await?;
            Ok(())
        }
        """,
        False,
    ),
]


def run_self_test() -> int:
    failures = 0
    for name, body, expect_flag in _SELFTEST_CASES:
        # A neutral non-allowlisted, non-test production path so only the
        # scan logic (not the file-level skips) decides the outcome.
        violations = scan_text("src-tauri/src/__fixture__.rs", body)
        got_flag = any("#653" in v for v in violations)
        ok = got_flag == expect_flag
        status = "PASS" if ok else "FAIL"
        print(f"  [{status}] {name}")
        if not ok:
            failures += 1
            print(f"         expected flag={expect_flag}, got {violations}")
    if failures:
        print(f"\n{failures} self-test case(s) FAILED", file=sys.stderr)
        return 1
    print("\nAll #653 deferred-tx guard self-tests passed.")
    return 0


def main(argv: list[str]) -> int:
    if argv and argv[0] == "--self-test":
        return run_self_test()

    repo_root = Path(__file__).resolve().parent.parent

    all_violations: list[str] = []
    for arg in argv:
        p = Path(arg)
        if p.suffix != ".rs":
            continue
        try:
            rel = str(p.resolve().relative_to(repo_root))
        except ValueError:
            rel = str(p)
        # Only police production source under src-tauri/src/.
        if not rel.startswith("src-tauri/src/"):
            continue
        if not p.is_file():
            continue
        all_violations.extend(check_file(p, repo_root))

    if all_violations:
        print("Raw write-transaction guard (#110) found "
              "new unmanaged site(s):\n", file=sys.stderr)
        for v in all_violations:
            print(f"  {v}", file=sys.stderr)
        print("", file=sys.stderr)
        print(ISSUE_HINT, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
