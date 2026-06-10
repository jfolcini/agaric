#!/usr/bin/env python3
"""Guard against NEW raw write-transaction sites in production Rust.

Issue #110 (MAINT-112) replaced ad-hoc `pool.begin_with("BEGIN IMMEDIATE")`
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
    "    -> #110 (MAINT-112): route user-edit write txs through the "
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
    # The begin_immediate_logged / CommandTx primitive itself.
    "src-tauri/src/db.rs",
    # Cache rebuilds — pure consumers of op_log, never producers.
    "src-tauri/src/cache/**",
    # FTS index — derived data, no op_log.
    "src-tauri/src/fts/index.rs",
    # Tag-inheritance rebuild — derived cache (verified: no op_log writes).
    "src-tauri/src/tag_inheritance/rebuild.rs",
    # The materializer itself — dispatching here would self-recurse.
    "src-tauri/src/materializer/handlers.rs",
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

    for m in RAW_TX_RE.finditer(stripped):
        idx = stripped.count("\n", 0, m.start())  # 0-based line index
        line = lines[idx] if idx < len(lines) else ""
        if idx in test_lines:
            continue
        # The definition is real CODE, so match it against the STRIPPED
        # line — checking the original would let a trailing comment
        # (`begin_with(W); // pub async fn begin_immediate_logged`)
        # exempt a real call site.
        stripped_line = stripped_lines[idx] if idx < len(stripped_lines) else ""
        if DEFINITION_RE.search(stripped_line):
            continue
        # Per-site escape hatch on the line itself or the line above.
        # Checked against the ORIGINAL text — the marker is a comment.
        if ALLOW_MARKER in line:
            continue
        if idx > 0 and ALLOW_MARKER in lines[idx - 1]:
            continue
        violations.append(f"{rel_path}:{idx + 1}: {line.strip()}")

    return violations


def main(argv: list[str]) -> int:
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
        print("Raw write-transaction guard (#110 / MAINT-112) found "
              "new unmanaged site(s):\n", file=sys.stderr)
        for v in all_violations:
            print(f"  {v}", file=sys.stderr)
        print("", file=sys.stderr)
        print(ISSUE_HINT, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
