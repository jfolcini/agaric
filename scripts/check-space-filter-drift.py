#!/usr/bin/env python3
"""Guard the inlined space-filter SQL fragment against drift (#139).

Space membership is a first-class `blocks.space_id` column (migration
0086, #533), so every paginated read that honours the active space inlines
the canonical guard fragment

    (?N IS NULL OR b.space_id = ?N)

(the same bind index `?N` on BOTH sides — once for the NULL short-circuit,
once for the equality). The fragment is copy-pasted at ~30 production call
sites across `pagination/`, `backlink/`, `tag_query/`, and `commands/`
(see `grep -rn "IS NULL OR b.space_id" src-tauri`). The maintainer
deferred the `build.rs` / `include_str!` consolidation that would let the
fragment live in one place (blocked on sqlx#3388 — `sqlx::query!` rejects
non-`LitStr` first arguments), so the copies stay inlined. This hook is the
cheap drift-guard adopted in their place: it catches the exact
inlined-fragment foot-gun (a hand-edit that mangles one copy) at low cost.

The companion `src-tauri/agaric-store/src/space_filter_canonical.rs` parity *test*
pins the same canonical string and walks BOTH that crate's `src/` and the
app crate's (`../src`) at test time; this hook is the pre-commit-stage mirror
so a drift is caught before the commit lands (and without needing a Rust
rebuild). Both enforce the same SHAPE — but only this hook's per-file
baseline can catch a guard that is REMOVED outright, which is why its scope
is load-bearing and not merely a faster copy of the test.

Two complementary rules over each `.rs` file under any scanned crate
root (see CRATE_ROOTS — the app crate plus the #2621 member crates that
carry `b.space_id` reads):

  RULE A — shape conformance. Every occurrence of the *guarded* shape
    `( ?A IS NULL OR b.space_id = ?B )` must be canonical: `A == B`
    (same bind index — or both the bare `?` placeholder used by the
    `tag_query` / `backlink` dynamic builders) and the column must be
    exactly `b.space_id`. A mismatched index (`?2 … ?3`), a different
    column, or a malformed guard fails.

  RULE B — guard removal. A per-file baseline records how many canonical
    guarded fragments each file currently inlines
    (`src-tauri/space-filter-baseline.txt`). If a file's count DROPS below
    its baseline, a guarded fragment was deleted or had its
    `?N IS NULL OR` stripped (degrading the canonical guard to a bare
    `b.space_id = ?N`) — which Rule A can't see, because a bare
    `b.space_id = ?` is *legitimate* at the many single-space query sites
    (`commands/blocks/crud.rs`, `journal.rs`, `pages/listing.rs`,
    `fts/filter_builder.rs`'s dynamic append, …) where the active space is
    always known and no NULL short-circuit is wanted. The baseline lets the
    guard fire on a removed canonical fragment without false-positiving on
    those intentional bare sites. When you legitimately add/remove a
    canonical site, re-anchor:
        python3 scripts/check-space-filter-drift.py --update-baseline

Explicit exceptions (NOT canonical-fragment sites, by design):

  * `pagination/history.rs` — the op-log filter intersects on the op-log
    payload's block id via a sub-select `... ol.block_id IN (SELECT id
    FROM blocks WHERE space_id = ?7)`. The inner `space_id = ?7` carries
    NO `b.` alias, so the `b.space_id` regex never matches it; it
    contributes 0 to the canonical count and needs no allowlisting.
  * `space_filter_canonical.rs` — holds `SPACE_FILTER_CANONICAL` itself
    plus the hand-written single-line `alternate` in its parity test;
    policing it here would be circular. Excluded via DENY_FILES.

Invocation: prek passes the changed files as argv (hook id
`check-space-filter-drift`). Run manually over the whole tree with:

    python3 scripts/check-space-filter-drift.py

(no args = scan every `*.rs` under CRATE_ROOTS). Stdlib only — no
third-party deps.
"""

from __future__ import annotations

import importlib.util
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
BASELINE_PATH = REPO_ROOT / "src-tauri" / "space-filter-baseline.txt"

# #3255: this guard used to scan only `src-tauri/src/`. The #2621 workspace
# split moved `backlink/`, `pagination/` and `tag_query/` — 21 of the 31
# canonical sites, and 11 of the 15 files the baseline names — down into
# `agaric-store`, where nothing scanned them and nothing noticed: the guard
# matched what was left, reported success, and the removal net it exists to
# provide was silently gone for two thirds of its subjects. The re-anchor
# that came with this fix shows the drift concretely: `backlink/grouped.rs`
# went 3 -> 5, i.e. two canonical guards were added while unwatched, and a
# later removal of either would have restored the stale baseline's 3 and
# passed.
#
# Ported for the same reason as `check-raw-tx.py`'s CRATE_ROOTS (#3110) and
# `check-table-ownership.py`'s, but NOT a copy of either: this list is a
# superset, adding `agaric-core/src` and (unlike check-raw-tx) keeping
# `diagnostics/src`. It is also not the whole workspace — `agaric-observability`
# is a #2621 member and is deliberately absent, as it holds telemetry only and
# has never carried a `b.space_id` read; add it here AND to the hook's `files:`
# regex in prek.toml if that ever changes. Order is presentational only:
# membership is tested with `any(... startswith ...)` / `any(_is_under(...))`
# and `all_source_files()` re-`sorted()`s its result, so nothing here depends
# on it — and no prefix collision is possible anyway, since
# `src-tauri/<member>/src/` is never prefixed by `src-tauri/src/`.
#
# Note the DIVISION OF LABOUR with the sibling Rust parity test in
# `agaric-store/src/space_filter_canonical.rs`: that test walks both trees and
# catches a DRIFTED fragment (mismatched bind index), because a drifted
# fragment still matches the canonical regex. It structurally cannot catch a
# REMOVED one — a deleted guard matches nothing and there is nothing left to
# assert on. The per-file count baseline below is the only net for removal and
# for degradation to a bare `b.space_id = ?N`, which is why its scope going
# stale mattered even though the parity test stayed green throughout.
CRATE_ROOTS = [
    "src-tauri/agaric-store/src/",
    "src-tauri/agaric-engine/src/",
    "src-tauri/agaric-sync/src/",
    "src-tauri/agaric-core/src/",
    "src-tauri/diagnostics/src/",
    "src-tauri/src/",
]

# Reuse the battle-tested comment-stripper from the raw-tx guard so a
# `(?N IS NULL OR b.space_id = ?N)` mention inside a `//` or `/* */`
# prose comment can never be counted as a production site. (We deliberately
# do NOT reuse its string-blanking behaviour: the fragment we police lives
# *inside* SQL string literals, so we keep literals intact — see
# `strip_comments_keep_strings` below.)
_spec = importlib.util.spec_from_file_location(
    "_check_raw_tx", REPO_ROOT / "scripts" / "check-raw-tx.py"
)
assert _spec and _spec.loader
_crt = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_crt)

# Files excluded from the scan entirely. Paths are REPO-ROOT-relative (#3255):
# they used to be relative to `src-tauri/src/`, which silently stopped
# resolving when the only entry moved crates in #2621 — a dangling deny entry
# that excluded nothing, against a walk that no longer reached the file
# anyway. Repo-root-relative paths are checkable, and `_assert_paths_exist`
# below now checks them.
DENY_FILES = {
    # Holds SPACE_FILTER_CANONICAL + the hand-written `alternate` parity
    # string; canonical by construction, policing it here is circular.
    "src-tauri/agaric-store/src/space_filter_canonical.rs",
}

# The canonical guarded space-filter shape, dot-all so multi-line raw-string
# SQL (with `\`-continuations) is captured. Captures BOTH bind indices so
# Rule A can assert they match. `\?\d*` accepts numbered (`?2`) and bare
# (`?`, used by the tag_query / backlink dynamic builders) placeholders.
GUARD_RE = re.compile(
    r"\(\s*\?(\d*)[\s\\]+IS[\s\\]+NULL[\s\\]+OR[\s\\]+"
    r"b\.space_id[\s\\]*=[\s\\]*\?(\d*)[\s\\]*\)",
    re.S,
)

CANONICAL = "(?N IS NULL OR b.space_id = ?N)"

HINT = (
    "    -> #139: the space-filter fragment must be inlined as exactly\n"
    f"       `{CANONICAL}` (the SAME bind index on both sides). A site\n"
    "       drifted (mismatched `?N`, wrong column, or the\n"
    "       `?N IS NULL OR` guard was dropped, degrading it to a bare\n"
    "       `b.space_id = ?N`). Restore the canonical form, or — if this\n"
    "       site is intentionally a *different* shape (e.g. a bare\n"
    "       single-space query) and you removed a real canonical copy —\n"
    "       re-anchor the baseline:\n"
    "         python3 scripts/check-space-filter-drift.py --update-baseline\n"
    "       Keep `src-tauri/agaric-store/src/space_filter_canonical.rs"
    "::SPACE_FILTER_CANONICAL`\n"
    "       in sync."
)

DANGLING_HINT = (
    "    -> #3255: the baseline (or DENY_FILES) names a path that no longer\n"
    "       exists. If the code MOVED, re-anchor and check the new counts\n"
    "       are preserved rather than silently dropped:\n"
    "         python3 scripts/check-space-filter-drift.py --update-baseline\n"
    "         git diff src-tauri/space-filter-baseline.txt\n"
    "       If the code was DELETED, the same command is correct — but read\n"
    "       the diff: a count that vanishes without a corresponding deletion\n"
    "       in the source is the removal this guard exists to catch, and\n"
    "       re-anchoring past it is how the finding gets lost."
)


def strip_comments_keep_strings(text: str) -> str:
    """Blank `//` and `/* */` comments to spaces; KEEP string literals.

    A char-for-char copy of `check-raw-tx.py::strip_rust_comments` minus
    the string/char-literal blanking arms — the space-filter fragment we
    police lives inside SQL string literals, so those must survive while
    prose comments (which may mention the canonical shape) are erased.
    Newlines are preserved so line numbers map 1:1 onto the original.
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

        # String / raw-string / char literals: SKIP OVER (keep) their
        # contents so the fragment inside them is scannable, but advance
        # past them so a `//` or `/*` inside a literal never starts a
        # comment.
        if ch == "r" and (nxt == '"' or nxt == "#"):
            m = re.match(r'r(#*)"', text[i:])
            if m:
                closing = '"' + m.group(1)
                end = text.find(closing, i + len(m.group(0)))
                i = n if end == -1 else end + len(closing)
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
            i = j
            continue

        if ch == "'":
            m = re.match(r"'(\\.|[^'\\\n])'", text[i:])
            if m:
                i += len(m.group(0))
                continue

        i += 1
    return "".join(out)


def line_of(text: str, offset: int) -> int:
    """1-based line number of a byte offset."""
    return text.count("\n", 0, offset) + 1


def scan_text(rel: str, raw: str) -> tuple[int, list[str]]:
    """Return (canonical_count, rule_A_violations) for `raw` source text.

    `rel` is the display path (repo-root-relative, #3255) used in violation
    messages. Pure function — no filesystem access — so the self-test can
    drive it directly against synthetic fixtures without writing real files
    under a crate root.

    `canonical_count` counts only well-formed canonical guarded fragments
    (matching bind indices, `b.space_id` column). A drifted guard match is
    NOT counted toward the baseline (it is a Rule-A violation instead), so a
    param-mismatch edit can't keep the baseline count satisfied.
    """
    text = strip_comments_keep_strings(raw)
    count = 0
    violations: list[str] = []
    for m in GUARD_RE.finditer(text):
        a, b = m.group(1), m.group(2)
        if a == b:
            count += 1
        else:
            ln = line_of(text, m.start())
            frag = re.sub(r"[\s\\]+", " ", m.group(0)).strip()
            violations.append(
                f"{rel}:{ln}: mismatched bind index "
                f"(?{a or '?'} … ?{b or '?'}) in `{frag}`"
            )
    return count, violations


def scan_file(path: Path) -> tuple[int, list[str]]:
    """Return (canonical_count, rule_A_violations) for one file on disk."""
    try:
        raw = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return 0, []
    rel = path.relative_to(REPO_ROOT).as_posix()
    return scan_text(rel, raw)


def _is_under(path: Path, root: Path) -> bool:
    """True when `path` lies inside `root` (no exception-as-control-flow)."""
    try:
        path.relative_to(root)
    except ValueError:
        return False
    return True


def _assert_paths_exist(baseline: dict[str, int]) -> list[str]:
    """Return one message per baseline entry whose file is gone (#3255).

    Also checks DENY_FILES: a deny entry that stops resolving silently
    un-excludes nothing and is the exact bug this guard shipped — the single
    entry named `space_filter_canonical.rs` relative to `src-tauri/src/` for
    two years after the file moved to `agaric-store`.
    """
    out = [
        f"{rel}: baseline names a file that does not exist "
        f"(expected {cnt} canonical fragment(s))"
        for rel, cnt in sorted(baseline.items())
        if not (REPO_ROOT / rel).is_file()
    ]
    # Unconditional, deliberately. An earlier revision gated this half on
    # "the crate root this entry names is present in THIS tree", to stop the
    # CLI self-test's synthetic repo root (which had no `agaric-store/`) from
    # tripping it. That gate made the check inapplicable to exactly the
    # mistakes most likely to be made — a misspelled crate segment, or a crate
    # renamed or retired wholesale — because a deny entry naming a crate root
    # that does not exist read as "not applicable" rather than "dangling", so
    # no run could ever flag it. The sandbox was the thing that was wrong, not
    # the check: `_build_cli_sandbox` now materialises every DENY_FILES path,
    # so the self-test models a real checkout and this half can be both
    # unconditional and directly tested (see `run_cli_self_test` direction 6).
    out.extend(
        f"{rel}: DENY_FILES names a file that does not exist"
        for rel in sorted(DENY_FILES)
        if not (REPO_ROOT / rel).is_file()
    )
    return out


def crate_root_paths() -> list[Path]:
    """The CRATE_ROOTS that exist in this checkout."""
    return [REPO_ROOT / r for r in CRATE_ROOTS if (REPO_ROOT / r).is_dir()]


def all_source_files() -> list[Path]:
    out: list[Path] = []
    seen: set[Path] = set()
    for root in crate_root_paths():
        for p in sorted(root.rglob("*.rs")):
            if p in seen:
                continue
            seen.add(p)
            if p.relative_to(REPO_ROOT).as_posix() in DENY_FILES:
                continue
            out.append(p)
    return sorted(out)


def compute_baseline() -> dict[str, int]:
    baseline: dict[str, int] = {}
    for p in all_source_files():
        cnt, _ = scan_file(p)
        if cnt:
            baseline[p.relative_to(REPO_ROOT).as_posix()] = cnt
    return baseline


def write_baseline(baseline: dict[str, int]) -> None:
    lines = [
        "# Space-filter canonical-fragment baseline (#139) — per-file count "
        "of the",
        "# inlined `(?N IS NULL OR b.space_id = ?N)` guard fragment.",
        "# Generated by: python3 scripts/check-space-filter-drift.py "
        "--update-baseline",
        "# The check-space-filter-drift prek hook fails when a file's count "
        "DROPS BELOW",
        "# its baseline (a canonical guard was removed / degraded to a bare "
        "`b.space_id = ?`),",
        "# or when any guarded fragment has mismatched bind indices.",
        "# Format: <count> <path-relative-to-repo-root>",
        "",
    ]
    for rel in sorted(baseline):
        lines.append(f"{baseline[rel]} {rel}")
    BASELINE_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")


def parse_baseline(text: str) -> dict[str, int]:
    """Parse the `<count> <path>` baseline format. Pure — no filesystem
    access — so the self-test can drive it directly against synthetic text."""
    baseline: dict[str, int] = {}
    for raw in text.splitlines():
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


def read_baseline() -> dict[str, int]:
    if not BASELINE_PATH.exists():
        return {}
    return parse_baseline(BASELINE_PATH.read_text(encoding="utf-8"))


def _build_cli_sandbox(root: Path) -> Path:
    """Lay out a throw-away repo `root` that this guard can be RUN inside.

    `REPO_ROOT` is derived from `Path(__file__).resolve().parent.parent`, and
    `main()` only ever scans files under `<REPO_ROOT>/src-tauri/src` — so the
    only way to drive the real CLI over a fixture is to give it a repo root of
    its own. `root/scripts/` gets a SYMLINK per entry of the real
    `scripts/` directory (so every sibling this guard imports now, or imports
    next year, resolves without this function having to enumerate them), and
    then the guard itself is overwritten with a real COPY — a symlink would
    make `.resolve()` walk back to the real checkout and point `REPO_ROOT` at
    the actual repo, which is precisely what must not happen.

    Copying the guard also means a DECOY edit to the checked-in file is
    carried into the sandbox: the subprocess under test is always the current
    bytes of this file, never a stale snapshot.

    Returns the path of the guard copy to invoke.
    """
    scripts_dir = root / "scripts"
    scripts_dir.mkdir(parents=True)
    real_scripts = REPO_ROOT / "scripts"
    for entry in os.scandir(real_scripts):
        os.symlink(entry.path, scripts_dir / entry.name)
    guard = scripts_dir / Path(__file__).name
    guard.unlink()
    shutil.copyfile(Path(__file__).resolve(), guard)
    (root / "src-tauri" / "src").mkdir(parents=True)
    # Materialise every DENY_FILES path. The deny half of
    # `_assert_paths_exist` is unconditional, so a sandbox missing these
    # would report a dangling deny entry on EVERY case below — turning each
    # case's "exits non-zero" half into an unconditional pass and drowning
    # out what that case is actually asserting.
    for rel in DENY_FILES:
        stand_in = root / rel
        stand_in.parent.mkdir(parents=True, exist_ok=True)
        stand_in.write_text(
            "// sandbox stand-in for a DENY_FILES entry\n", encoding="utf-8"
        )
    return guard


def _run_cli(guard: Path, args: list[str]) -> tuple[int, str]:
    """Spawn the guard as a REAL subprocess; return (exit code, stderr+stdout)."""
    proc = subprocess.run(  # noqa: S603 - fixed argv, no shell
        [sys.executable, str(guard), *args],
        capture_output=True,
        text=True,
        check=False,
    )
    return proc.returncode, proc.stderr + proc.stdout


def run_cli_self_test(record) -> None:
    """Drive `main()`'s EXIT WIRING through a real subprocess (#4447).

    Every case above drives `scan_text` / `parse_baseline` — the ANALYSIS.
    None of them ever ran `main()`, so the branch that turns a finding into a
    non-zero exit status was unpinned, and the guard's own suite could not
    tell a working guard from one rewired to never fail a commit. Confirmed by
    falsification rather than by reading: with `main()`'s findings `return 1`
    changed to `return 0`, this file's self-test output was BYTE-IDENTICAL to
    the control's. A self-test that exercises a guard's analysis but not its
    exit verifies the half that was never in doubt, and the failure mode being
    defended against is a guard that quietly stops failing.

    Mirrors what #4434 did for `check-hook-deps.mjs`'s `runGuard()` and
    `check-store-layering.mjs`: spawn the CLI with `sys.executable` and an
    argv array, and assert the exit code.

    BOTH directions are asserted, and that is not symmetry for its own sake:
    a suite that only checked "a finding exits non-zero" would pass just as
    happily against a guard that exits non-zero unconditionally — the
    mirror-image fail-closed bug, noisier but equally broken. So a clean tree
    is pinned to exit 0 as well, and it is a clean tree with a REAL canonical
    fragment in it rather than an empty one, so "exits 0" cannot be satisfied
    by a scan that sees nothing at all.
    """
    with tempfile.TemporaryDirectory(prefix="space-filter-drift-cli-") as tmp:
        root = Path(tmp)
        guard = _build_cli_sandbox(root)
        src = root / "src-tauri" / "src"
        baseline_path = root / "src-tauri" / "space-filter-baseline.txt"

        # --- direction 1: a clean tree exits 0 -----------------------------
        # A canonical fragment, and a baseline that expects exactly it. Not a
        # vacuous pass: the file really does carry a guarded fragment, and the
        # baseline really is satisfied.
        clean = src / "clean.rs"
        clean.write_text(
            'let sql = "SELECT id FROM blocks b WHERE (?1 IS NULL OR b.space_id = ?1)";\n',
            encoding="utf-8",
        )
        baseline_path.write_text("1 src-tauri/src/clean.rs\n", encoding="utf-8")
        code, out = _run_cli(guard, [str(clean)])
        # #4466 note 5: this used to assert `out.strip() == ""` -- byte-exact
        # emptiness of the WHOLE subprocess's combined stdout+stderr. `main()`
        # itself really is silent on a clean tree (see its own body: the
        # success path returns before any `print`), but the assertion did not
        # say that -- it said nothing this PROCESS runs may ever print
        # anything, which also covers a stray interpreter DeprecationWarning
        # or any output from `check-raw-tx.py` being `exec_module`-d at
        # import time (line ~95), neither of which has anything to do with
        # whether THIS guard found a violation. Asserting on the guard's own
        # violation banner instead — present in every non-clean exit (see
        # `main`'s failing branch below) — pins the actual contract under
        # test without turning unrelated process noise into a red self-test.
        if code == 0 and "Space-filter drift guard (#139)" not in out:
            record("CLI: a clean tree with a satisfied baseline exits 0", True, True)
        else:
            record(
                "CLI: a clean tree with a satisfied baseline exits 0",
                (code, out.strip()),
                "exit 0, no violation banner (stray interpreter/import noise is not a finding)",
            )

        # --- direction 2: a RULE A finding exits non-zero -------------------
        drifted = src / "drifted.rs"
        drifted.write_text(
            'let sql = "SELECT id FROM blocks b WHERE (?2 IS NULL OR b.space_id = ?3)";\n',
            encoding="utf-8",
        )
        code, out = _run_cli(guard, [str(drifted)])
        if code != 0 and "mismatched bind index" in out:
            record("CLI: a Rule-A shape drift exits non-zero and says why", True, True)
        else:
            record(
                "CLI: a Rule-A shape drift exits non-zero and says why",
                (code, out.strip()),
                "non-zero exit mentioning 'mismatched bind index'",
            )

        # --- direction 2b: a RULE B removal exits non-zero ------------------
        # A separate case, not a duplicate of the one above: Rule A and Rule B
        # reach `main()`'s failing return through two different lists, and a
        # regression can drop either one on its own.
        removed = src / "removed.rs"
        removed.write_text(
            'let sql = "SELECT id FROM blocks b WHERE b.space_id = ?1";\n',
            encoding="utf-8",
        )
        baseline_path.write_text("2 src-tauri/src/removed.rs\n", encoding="utf-8")
        code, out = _run_cli(guard, [str(removed)])
        if code != 0 and "baseline expects 2" in out:
            record("CLI: a Rule-B guard removal exits non-zero and says why", True, True)
        else:
            record(
                "CLI: a Rule-B guard removal exits non-zero and says why",
                (code, out.strip()),
                "non-zero exit mentioning 'baseline expects 2'",
            )

        # --- #3255 direction 3: a DANGLING baseline entry exits non-zero ----
        # The case that lets every other case pass while the guard protects
        # nothing. A baseline entry whose file is gone is never scanned, so
        # Rule B never asks about it and the run is green — which is exactly
        # how 11 of 15 entries survived the #2621 move unnoticed. Note the
        # invocation is TARGETED (a single unrelated file), because that is
        # how prek calls the hook: the check has to be a property of the
        # baseline, not of the files in the commit, or it stays invisible.
        baseline_path.write_text(
            "1 src-tauri/src/clean.rs\n1 src-tauri/src/gone.rs\n", encoding="utf-8"
        )
        code, out = _run_cli(guard, [str(clean)])
        if code != 0 and "does not exist" in out and "gone.rs" in out:
            record("CLI: a dangling baseline entry exits non-zero (#3255)", True, True)
        else:
            record(
                "CLI: a dangling baseline entry exits non-zero (#3255)",
                (code, out.strip()),
                "non-zero exit naming gone.rs as not existing",
            )

        # --- #3255 direction 4: a MEMBER-CRATE file is actually scanned -----
        # Falsifies the widening itself. Against the pre-#3255 guard this file
        # is outside SRC_ROOT, so the targeted invocation skips it silently and
        # the run exits 0 — the bug, reproduced.
        store_src = root / "src-tauri" / "agaric-store" / "src"
        store_src.mkdir(parents=True, exist_ok=True)
        sub = store_src / "sub_drift.rs"
        sub.write_text(
            'let sql = "SELECT id FROM blocks b WHERE (?2 IS NULL OR b.space_id = ?5)";\n',
            encoding="utf-8",
        )
        baseline_path.write_text("1 src-tauri/src/clean.rs\n", encoding="utf-8")
        code, out = _run_cli(guard, [str(sub)])
        if code != 0 and "mismatched bind index" in out and "agaric-store" in out:
            record("CLI: a member-crate file is scanned (#3255)", True, True)
        else:
            record(
                "CLI: a member-crate file is scanned (#3255)",
                (code, out.strip()),
                "non-zero exit naming the agaric-store path",
            )

        # --- #3255 direction 5: the bare (whole-tree) walk reaches members ---
        # Direction 4 pins the argv path; this pins `all_source_files()`. They
        # are different code paths and a regression can drop either alone.
        code, out = _run_cli(guard, [])
        if code != 0 and "sub_drift.rs" in out:
            record("CLI: the bare walk reaches member crates (#3255)", True, True)
        else:
            record(
                "CLI: the bare walk reaches member crates (#3255)",
                (code, out.strip()),
                "non-zero exit naming sub_drift.rs from a no-args run",
            )

        # --- #3255 direction 6: a DANGLING DENY_FILES entry exits non-zero --
        # The deny half of `_assert_paths_exist` had no case of its own:
        # deleting that half outright left this suite's output BYTE-IDENTICAL
        # to the control's — the same falsification this function's docstring
        # invokes to justify existing, reproduced inside the check #3255 adds.
        # Removing the sandbox stand-in makes the deny entry dangle without
        # touching any baseline, so the two halves of `_assert_paths_exist`
        # are pinned independently.
        deny_rel = sorted(DENY_FILES)[0]
        (root / deny_rel).unlink()
        baseline_path.write_text("1 src-tauri/src/clean.rs\n", encoding="utf-8")
        code, out = _run_cli(guard, [str(clean)])
        if code != 0 and "DENY_FILES names a file that does not exist" in out:
            record("CLI: a dangling DENY_FILES entry exits non-zero (#3255)", True, True)
        else:
            record(
                "CLI: a dangling DENY_FILES entry exits non-zero (#3255)",
                (code, out.strip()),
                f"non-zero exit naming {deny_rel} as a dangling DENY_FILES entry",
            )


def run_self_test() -> int:
    """Assert scan_text/parse_baseline's exit-relevant behavior.

    Added by #3997: this hook had no self-test of any kind before —
    structurally the same gap `wdio-driver-gate` had before #3996. Drives
    the pure text-processing core directly (no filesystem access needed),
    covering the properties a regression could silently break:
      - a canonical numbered fragment and the bare-`?` placeholder form are
        both counted;
      - a mismatched bind index is a Rule-A violation, not silently counted
        or silently dropped;
      - a mention inside a `//` or `/* */` comment is never counted (the
        comment-stripper must still run);
      - a fragment INSIDE a SQL string literal IS counted — the guard
        deliberately does NOT reuse check-raw-tx.py's string-blanking
        `strip_rust_comments` for exactly this reason (the real production
        sites live inside `sqlx::query!("…")` string literals), so a "helpful"
        refactor that swapped in the shared stripper would silently zero out
        every real site while still passing a naive smoke test;
      - the baseline text format round-trips through parse_baseline.

    …and then, since #4447, `main()`'s own EXIT WIRING through a real
    subprocess — see `run_cli_self_test`. Everything above is analysis; none
    of it can tell a working guard from one rewired never to fail a commit.
    """
    failures: list[str] = []
    cases = 0

    def expect(name: str, got, want) -> None:
        # Counted here rather than in a literal at the bottom: a hard-coded
        # case count is a number that drifts the moment someone adds a case
        # and forgets, and a suite that misreports its own size is the small
        # version of the defect this file's #4447 work is about.
        nonlocal cases
        cases += 1
        if got != want:
            failures.append(f"{name}: expected {want!r}, got {got!r}")

    # Canonical numbered fragment, matching indices -> counted, no violation.
    numbered = 'let sql = "SELECT * FROM blocks b WHERE (?2 IS NULL OR b.space_id = ?2)";'
    cnt, viols = scan_text("numbered.rs", numbered)
    expect("canonical numbered fragment is counted", (cnt, viols), (1, []))

    # Canonical bare-`?` fragment (tag_query/backlink dynamic builders).
    bare = 'let sql = "(? IS NULL OR b.space_id = ?)";'
    cnt, viols = scan_text("bare.rs", bare)
    expect("canonical bare-? fragment is counted", (cnt, viols), (1, []))

    # Mismatched bind index -> Rule-A violation, NOT counted toward the
    # baseline.
    mismatched = 'let sql = "(?2 IS NULL OR b.space_id = ?3)";'
    cnt, viols = scan_text("mismatched.rs", mismatched)
    expect(
        "mismatched bind index is a Rule-A violation, not a count",
        (cnt, len(viols), "mismatched bind index" in viols[0] if viols else False),
        (0, 1, True),
    )

    # A `//` comment mentioning the shape is never counted.
    line_comment = "// (?2 IS NULL OR b.space_id = ?2) is the canonical shape\nlet x = 1;"
    expect(
        "line-comment mention is not counted", scan_text("comment.rs", line_comment), (0, [])
    )

    # A `/* */` comment mentioning the shape is never counted.
    block_comment = "/* (?2 IS NULL OR b.space_id = ?2) */\nlet x = 1;"
    expect(
        "block-comment mention is not counted", scan_text("block.rs", block_comment), (0, [])
    )

    # The load-bearing design choice: a fragment INSIDE a string literal
    # (the real production shape, sqlx::query!("...")) IS counted — proving
    # this guard's local strip_comments_keep_strings (which keeps string
    # contents) is doing real work, not check-raw-tx.py's strip_rust_comments
    # (which would blank the string and silently zero this out).
    in_string = (
        'sqlx::query!("SELECT id FROM blocks b WHERE '
        '(?1 IS NULL OR b.space_id = ?1)")'
    )
    cnt, viols = scan_text("in_string.rs", in_string)
    expect("fragment inside a string literal is counted", (cnt, viols), (1, []))

    # Baseline round-trip: format, comments, and blank lines.
    baseline_text = (
        "# header comment\n"
        "\n"
        "3 src-tauri/src/pagination/mod.rs\n"
        "1 src-tauri/src/backlink/query.rs\n"
        "malformed line with no count\n"
    )
    parsed = parse_baseline(baseline_text)
    expect(
        "parse_baseline reads count/path pairs and skips comments/malformed lines",
        parsed,
        {
            "src-tauri/src/pagination/mod.rs": 3,
            "src-tauri/src/backlink/query.rs": 1,
        },
    )

    # …and the half that was missing until #4447: the real CLI, spawned as a
    # subprocess, asserted on its EXIT CODE in both directions.
    run_cli_self_test(expect)

    if failures:
        print("check-space-filter-drift self-test FAILED:", file=sys.stderr)
        for f in failures:
            print(f"  {f}", file=sys.stderr)
        return 1
    print(f"check-space-filter-drift self-test passed ({cases} cases).")
    return 0


def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        return run_self_test()
    if "--update-baseline" in argv:
        write_baseline(compute_baseline())
        print(f"Wrote {BASELINE_PATH.relative_to(REPO_ROOT)}")
        return 0

    baseline = read_baseline()

    # Determine targets. prek passes changed files; a bare invocation scans
    # the whole tree. Either way only police production .rs under
    # src-tauri/src/ (skip DENY_FILES).
    file_args = [a for a in argv if not a.startswith("-")]
    if file_args:
        targets: list[Path] = []
        roots = crate_root_paths()
        for arg in file_args:
            p = Path(arg)
            if p.suffix != ".rs":
                continue
            rp = p.resolve()
            if not any(_is_under(rp, root) for root in roots):
                continue
            if rp.relative_to(REPO_ROOT).as_posix() in DENY_FILES:
                continue
            if rp.is_file():
                targets.append(rp)
    else:
        targets = all_source_files()

    shape_violations: list[str] = []
    removal_violations: list[str] = []
    # #3255: a baseline entry naming a file that no longer exists protects
    # nothing, and — this is the part that let the rot survive two years — it
    # cannot fail. The scan asks "is this file's count still >= its baseline?"
    # of files it FINDS; an entry whose file is gone is never asked about, so
    # the guard reports success while 11 of its 15 subjects are unwatched.
    # Session 1299 caught the same shape in the unsafe-allowlist checker
    # ("it walked discovered files and asked 'is this one allowed?', never
    # 'does this entry still name a file?'") and named existence checks as the
    # cheap structural answer. This is that check, and it is deliberately
    # unconditional — it runs on a targeted prek invocation too, because the
    # rot is a property of the baseline, not of the files in any one commit.
    dangling = _assert_paths_exist(baseline)

    for p in targets:
        rel = p.relative_to(REPO_ROOT).as_posix()
        cnt, viols = scan_file(p)
        shape_violations.extend(viols)
        base = baseline.get(rel, 0)
        if cnt < base:
            removal_violations.append(
                f"{rel}: {cnt} canonical space-filter fragment(s), "
                f"baseline expects {base} — a `(?N IS NULL OR b.space_id "
                f"= ?N)` guard was removed or degraded to a bare "
                f"`b.space_id = ?N`."
            )

    if not shape_violations and not removal_violations and not dangling:
        return 0

    print(
        "Space-filter drift guard (#139) — the inlined "
        f"`{CANONICAL}` fragment drifted:\n",
        file=sys.stderr,
    )
    for v in shape_violations:
        print(f"  {v}", file=sys.stderr)
    for v in removal_violations:
        print(f"  {v}", file=sys.stderr)
    for v in dangling:
        print(f"  {v}", file=sys.stderr)
    print("", file=sys.stderr)
    if dangling:
        print(DANGLING_HINT, file=sys.stderr)
    if shape_violations or removal_violations:
        print(HINT, file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
