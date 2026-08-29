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

`--update-baseline` re-anchors. It REFUSES (exit 1, writing nothing) when a
canonical guard would leave the baseline — either a net loss across the tree,
or a drop in a file that still exists. A WHOLE-file move (the old file gone or
emptied, an equal gain elsewhere) nets to zero and is allowed without a flag.
A PARTIAL move — relocating one query out of a file that keeps the rest — is
refused, because by counts alone it is indistinguishable from deleting one in
place; `--allow-reductions` records it, and note that the flag is run-wide, so
it also suppresses any unintended deletion in the same invocation.
"""

from __future__ import annotations

import importlib.util
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path, PurePosixPath

REPO_ROOT = Path(__file__).resolve().parent.parent
# `.resolve()`: `baseline_touched` in `main()` compares this against a
# resolved argv path, and an unresolved constant makes that comparison fail
# silently the moment any component is a symlink — disabling the
# force-whole-tree-walk exactly when the baseline is being edited. #3255.
BASELINE_PATH = (REPO_ROOT / "src-tauri" / "space-filter-baseline.txt").resolve()

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
# argv membership is tested with `any(_is_under(...))`, deny membership with
# set containment, and `all_source_files()` re-`sorted()`s its result, so
# nothing here depends on it — and no prefix collision is possible anyway, since
# `src-tauri/<member>/src/` is never prefixed by `src-tauri/src/`.
#
# KEEP IN STEP with the sibling Rust parity test's own walk roots in
# `agaric-store/src/space_filter_canonical.rs` (it walks two: that crate's
# `src/` and the app's `../src`). This list is a superset, so nothing is
# unguarded — but the two can drift apart independently, which is this
# guard's own subject. Widening one without the other is a silent gap.
#
# Note the DIVISION OF LABOUR with that same test: that test walks both trees and
# catches a DRIFTED fragment (mismatched bind index), because a drifted
# fragment still matches the canonical regex. It structurally cannot catch a
# REMOVED one — a deleted guard matches nothing and there is nothing left to
# assert on. The per-file count baseline below is the only net for removal and
# for degradation to a bare `b.space_id = ?N`, which is why its scope going
# stale mattered even though the parity test stayed green throughout.
# Each entry is a crate's `src/` and DELIBERATELY nothing else: `src-tauri/
# tests/`, `src-tauri/benches/` and `src-tauri/fuzz/` are outside the walk.
# No canonical fragment lives in them today (the one `benches/` mention is a
# `?N` doc comment that cannot match GUARD_RE), and they are excluded because
# they are not production read paths — not because fragments cannot appear
# there. Read as "the production crate sources", not "everywhere a fragment
# could live"; the latter is the reading that lets this list rot, which is the
# whole subject of #3255.
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

ROOT_MISSING_HINT = (
    "    -> #3255: a CRATE_ROOTS entry in scripts/check-space-filter-drift.py\n"
    "       names a directory that does not exist. Fix the LIST, not the\n"
    "       baseline: `--update-baseline` walks the surviving roots only, so\n"
    "       re-anchoring here would delete every baseline entry under the\n"
    "       missing root and report success. If the crate was genuinely\n"
    "       retired, remove its root from CRATE_ROOTS and from the\n"
    "       check-space-filter-drift hook's `files:` regex in prek.toml in the\n"
    "       same commit, then re-anchor."
)

DANGLING_HINT = (
    "    -> #3255: the baseline, DENY_FILES, or CRATE_ROOTS names a path that\n"
    "       no longer exists.\n"
    "       A CRATE_ROOTS entry is fixed by editing the list in this script\n"
    "       (see the refusal message from --update-baseline for why\n"
    "       re-anchoring is the wrong remedy there).\n"
    "       A DENY_FILES entry is fixed by EDITING THIS SCRIPT's DENY_FILES\n"
    "       set — `--update-baseline` rebuilds only the baseline and will\n"
    "       not touch it, so re-running it on a dangling deny entry changes\n"
    "       nothing and reports the same message again.\n"
    "       For a BASELINE entry: if the code MOVED, re-anchor — a move nets\n"
    "       to zero across the tree and is allowed. If a guard was genuinely\n"
    "       DELETED the re-anchor refuses, and recording that needs an\n"
    "       explicit `--allow-reductions`:\n"
    "         python3 scripts/check-space-filter-drift.py --update-baseline\n"
    "         git diff src-tauri/space-filter-baseline.txt\n"
    "       Read the per-file deltas it prints either way: a count that\n"
    "       vanishes without a corresponding deletion in the source is the\n"
    "       removal this guard exists to catch, and re-anchoring past it is\n"
    "       how the finding gets lost."
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


def _assert_paths_exist(baseline: dict[str, int]) -> list[tuple[str, str]]:
    """Return `(kind, message)` per stale path (#3255).

    `kind` is one of `baseline`, `deny`, `root` — see the note on the return
    shape below for why the caller needs it typed rather than inferred.

    Also checks DENY_FILES: a deny entry that stops resolving silently
    un-excludes nothing and is the exact bug this guard shipped — the single
    entry named `space_filter_canonical.rs` relative to `src-tauri/src/` for
    two years after the file moved to `agaric-store`.

    And CRATE_ROOTS, which is the half with the asymmetric handling worth
    knowing about: `crate_root_paths()` `is_dir()`-filters a missing root
    away, so the walk narrows silently. `main()` treats a root finding
    differently from the other two under `--update-baseline` — it REFUSES
    rather than warning, because re-anchoring against a narrowed walk deletes
    every baseline entry under the missing root. See the refusal branch.
    """
    # (kind, message) rather than bare strings: `main()` routes the ROOT kind
    # into `--update-baseline`'s refusal branch and the other two into a
    # warning, and selecting that by substring-matching "CRATE_ROOTS" against
    # the rendered text couples control flow to diagnosis wording — a baseline
    # path containing the literal would be misrouted. Unlikely, and free to
    # remove.
    out: list[tuple[str, str]] = [
        (
            "baseline",
            f"{rel}: baseline names a file that does not exist "
            f"(expected {cnt} canonical fragment(s))",
        )
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
        ("deny", f"{rel}: DENY_FILES names a file that does not exist")
        for rel in sorted(DENY_FILES)
        if not (REPO_ROOT / rel).is_file()
    )
    # And the roots themselves. `crate_root_paths()` filters CRATE_ROOTS
    # through `is_dir()` and silently drops what is missing, so a renamed or
    # misspelled crate segment narrows the walk with no signal at all — this
    # guard's own subject, one level up. Four of the six roots carry no
    # baseline entries, so a dangling-baseline finding would not catch it for
    # them indirectly. The sandbox materialises every root for the same reason
    # it materialises DENY_FILES.
    out.extend(
        ("root", f"{rel}: CRATE_ROOTS names a directory that does not exist")
        for rel in CRATE_ROOTS
        if not (REPO_ROOT / rel).is_dir()
    )
    return out


def crate_root_paths() -> list[Path]:
    """The CRATE_ROOTS that exist in this checkout."""
    return [REPO_ROOT / r for r in CRATE_ROOTS if (REPO_ROOT / r).is_dir()]


def all_source_files() -> list[Path]:
    out: list[Path] = []
    for root in crate_root_paths():
        for p in root.rglob("*.rs"):
            if p.relative_to(REPO_ROOT).as_posix() in DENY_FILES:
                continue
            out.append(p)
    # `sorted` is load-bearing: without it the walk emits files grouped by
    # CRATE_ROOTS declaration order, which is presentational order, not path
    # order. No dedup is needed — no root is a prefix of another (see the
    # CRATE_ROOTS comment), so a file cannot be reached twice.
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
    `main()` only ever scans files under `<REPO_ROOT>`'s CRATE_ROOTS — so the
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
    # Materialise every CRATE_ROOTS directory. The roots half of
    # `_assert_paths_exist` is unconditional, so a sandbox missing them would
    # report every root dangling on EVERY case below — satisfying each case's
    # "exits non-zero" half for the wrong reason. (`src-tauri/src` needs no
    # separate mkdir: it is itself a CRATE_ROOTS entry.)
    for rel in CRATE_ROOTS:
        # Same precondition as the DENY_FILES loop below, for the same
        # `Path.__truediv__` reason: an absolute entry would create these
        # directories outside the TemporaryDirectory.
        assert not PurePosixPath(rel).is_absolute(), rel
        (root / rel).mkdir(parents=True, exist_ok=True)
    # Same reason, for the deny half: a sandbox missing these would report a
    # dangling deny entry on every case and drown out what each is asserting.
    for rel in DENY_FILES:
        # `Path.__truediv__` DISCARDS the left operand when the right is
        # absolute, so an absolute DENY_FILES entry would place — and later
        # `unlink` — a real file outside this TemporaryDirectory. The constant
        # is relative today; this makes that a precondition rather than a
        # coincidence, because the operations here are destructive.
        assert not PurePosixPath(rel).is_absolute(), rel
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

        # The banner must not claim a DRIFT when the only finding is a
        # dangling entry — nothing drifted, and saying so sends the reader
        # hunting for a mangled fragment that does not exist. Same run as
        # above; a separate assertion because the exit code and the diagnosis
        # are different things and a regression can spoil either alone.
        if "fragment drifted" not in out and "no longer describes this tree" in out:
            record("CLI: a dangling-only run does not claim a drift", True, True)
        else:
            record(
                "CLI: a dangling-only run does not claim a drift",
                out.strip(),
                "the baseline-describes banner, and no 'fragment drifted' claim",
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
        # Every entry, not `sorted(DENY_FILES)[0]`: indexing crashes with an
        # opaque IndexError if DENY_FILES is ever emptied (a legitimate config
        # change — the sole entry exists only because `space_filter_canonical.rs`
        # holds the canonical const), and testing just the first would ship a
        # second entry untested.
        deny_rels = sorted(DENY_FILES)
        baseline_path.write_text("1 src-tauri/src/clean.rs\n", encoding="utf-8")
        try:
            for rel in deny_rels:
                (root / rel).unlink()
            code, out = _run_cli(guard, [str(clean)]) if deny_rels else (1, "")
        finally:
            # `finally`, not the next statement: the restore exists to stop a
            # later case inheriting a standing dangling-deny finding, and an
            # exception in `_run_cli` would hand that protection away exactly
            # when the suite is already in trouble.
            for rel in deny_rels:
                (root / rel).write_text(
                    "// sandbox stand-in for a DENY_FILES entry\n",
                    encoding="utf-8",
                )
        # RESTORE before recording. This case is the only one that removes a
        # sandbox fixture, and leaving it removed would hand every case
        # appended after it a standing dangling-deny finding — satisfying the
        # `code != 0` half unconditionally, which is precisely the pollution
        # `_build_cli_sandbox` materialises these files to prevent. Being last
        # today is not a defence; the next case appended is the one that pays.
        missing_named = all(
            f"{rel}: DENY_FILES names a file that does not exist" in out
            for rel in deny_rels
        )
        if not deny_rels:
            record(
                "CLI: a dangling DENY_FILES entry exits non-zero (#3255)",
                "skipped: DENY_FILES is empty",
                "skipped: DENY_FILES is empty",
            )
        elif code != 0 and missing_named:
            record("CLI: a dangling DENY_FILES entry exits non-zero (#3255)", True, True)
        else:
            record(
                "CLI: a dangling DENY_FILES entry exits non-zero (#3255)",
                (code, out.strip()),
                f"non-zero exit naming every dangling DENY_FILES entry ({deny_rels})",
            )

        # --- #3255 direction 7: a CRATE_ROOTS entry that is not a directory --
        # `crate_root_paths()` filters through `is_dir()`, so a renamed or
        # misspelled crate segment narrows the walk to nothing with no signal —
        # this PR's own failure mode, one level up, inside the guard written to
        # end it. Four of the six roots hold no baseline entries, so the
        # dangling-baseline check cannot catch it for them indirectly either.
        # `agaric-engine`, deliberately, NOT `agaric-store`: the only
        # DENY_FILES stand-in lives under the store root, so removing that one
        # would raise a dangling-deny finding too and the case would be
        # satisfiable by either. Removing a root that holds no deny entry
        # leaves exactly one thing that can make this run non-zero.
        missing_root = root / "src-tauri" / "agaric-engine" / "src"
        try:
            shutil.rmtree(missing_root)
            code, out = _run_cli(guard, [str(clean)])
        finally:
            missing_root.mkdir(parents=True, exist_ok=True)
        if code != 0 and "CRATE_ROOTS names a directory that does not exist" in out:
            record("CLI: a vanished CRATE_ROOTS entry exits non-zero (#3255)", True, True)
        else:
            record(
                "CLI: a vanished CRATE_ROOTS entry exits non-zero (#3255)",
                (code, out.strip()),
                "non-zero exit naming the missing agaric-engine root",
            )

        # --- #3255 direction 8: a BASELINE-ONLY invocation still re-verifies -
        # The hook's `files:` regex includes the baseline file so that editing
        # it re-runs the guard. But every non-`.rs` arg is dropped by the
        # suffix filter, so without a fallback the target set is empty and only
        # the dangling check runs — a hand-edit LOWERING a count would pass,
        # which is the one thing adding the baseline to `files:` was for.
        removed.write_text(
            'let sql = "SELECT id FROM blocks b WHERE b.space_id = ?1";\n',
            encoding="utf-8",
        )
        baseline_path.write_text("2 src-tauri/src/removed.rs\n", encoding="utf-8")
        code, out = _run_cli(guard, [str(baseline_path)])
        if code != 0 and "baseline expects 2" in out:
            record("CLI: a baseline-only invocation still scans (#3255)", True, True)
        else:
            record(
                "CLI: a baseline-only invocation still scans (#3255)",
                (code, out.strip()),
                "non-zero exit mentioning 'baseline expects 2' from a baseline-only argv",
            )

        # --- #3255 direction 9: baseline edited ALONGSIDE an unrelated .rs ---
        # Direction 8 pins the baseline-ONLY argv. The commoner shape is a
        # commit that edits the baseline and a source file together: the
        # target set is then non-empty, so an empty-set fallback would scan
        # only that source file and a hand-lowered count for some OTHER file
        # would pass — the entry still resolves, so the dangling check stays
        # silent. This pins that the baseline appearing in argv AT ALL forces
        # the whole-tree walk.
        unrelated = src / "unrelated.rs"
        unrelated.write_text("// no space filter here\n", encoding="utf-8")
        removed.write_text(
            'let sql = "SELECT id FROM blocks b WHERE b.space_id = ?1";\n',
            encoding="utf-8",
        )
        baseline_path.write_text("2 src-tauri/src/removed.rs\n", encoding="utf-8")
        code, out = _run_cli(guard, [str(unrelated), str(baseline_path)])
        if code != 0 and "baseline expects 2" in out:
            record("CLI: baseline + an unrelated .rs still scans all (#3255)", True, True)
        else:
            record(
                "CLI: baseline + an unrelated .rs still scans all (#3255)",
                (code, out.strip()),
                "non-zero exit mentioning 'baseline expects 2' despite a non-empty target set",
            )

        # --- #3255 direction 10: a DELETED baseline line is caught ----------
        # `baseline.get(rel, 0)` means an entry removed outright reads as 0, so
        # the removal check can never fire for it and the dangling check has
        # nothing left to find. Hand-editing a line out therefore retired the
        # net for that file, silently — the guard's own subject, applied to the
        # guard's own state file.
        orphan = src / "orphan.rs"
        orphan.write_text(
            'let sql = "SELECT id FROM blocks b WHERE (?1 IS NULL OR b.space_id = ?1)";\n',
            encoding="utf-8",
        )
        baseline_path.write_text("1 src-tauri/src/clean.rs\n", encoding="utf-8")
        code, out = _run_cli(guard, [str(orphan)])
        orphan.unlink()
        if code != 0 and "NO baseline entry" in out and "orphan.rs" in out:
            record("CLI: a fragment-bearing file with no baseline entry fails", True, True)
        else:
            record(
                "CLI: a fragment-bearing file with no baseline entry fails",
                (code, out.strip()),
                "non-zero exit naming orphan.rs as carrying fragments but unbaselined",
            )

        # --- #3255 direction 11: prek.toml's `files:` covers every root ------
        # The six roots are hand-duplicated between CRATE_ROOTS here and the
        # hook's `files:` regex in prek.toml, bound only by a comment in each.
        # Widening one without the other is the #3255 failure reintroduced one
        # level up — and the review called it the single most likely way this
        # regresses. Cheap to test rather than to promise: pull the regex out
        # of prek.toml and assert it accepts a probe path under every declared
        # root.
        # Guarded: an unguarded read aborts the WHOLE self-test with a
        # traceback if prek.toml is renamed or absent, discarding every case
        # already recorded. The `files_re is None` branch below already models
        # the clean failure, so route the missing-file case into it.
        try:
            prek = (REPO_ROOT / "prek.toml").read_text(encoding="utf-8")
        except OSError:
            prek = ""
        # Bound the search to THIS hook's own block. Scanning forward without
        # stopping at the next `[[repos.hooks]]` means that if this hook ever
        # loses its `files` line, the first one found belongs to a LATER hook
        # and the case validates that regex instead — reporting coverage this
        # guard does not have. A false pass inside the check added to prevent
        # false passes.
        block = prek.split('\nid = "check-space-filter-drift"', 1)
        files_re = None
        if len(block) > 1:
            for line in block[1].splitlines():
                if line.lstrip().startswith("[[repos.hooks]]"):
                    break
                if line.startswith("files = "):
                    files_re = line.split("=", 1)[1].strip().strip("'\"")
                    break
        uncovered = []
        if files_re:
            compiled = re.compile(files_re)
            for r in CRATE_ROOTS:
                if not compiled.search(f"{r}probe.rs"):
                    uncovered.append(r)
            # The baseline's own path, too. Directions 8 and 9 defend the
            # baseline-in-argv path, but nothing asserted the hook is SELECTED
            # when the baseline changes — delete that alternative from
            # prek.toml and this suite stayed byte-identical and passing,
            # which is the falsification standard this guard applies to
            # everything else.
            if not compiled.search("src-tauri/space-filter-baseline.txt"):
                uncovered.append("src-tauri/space-filter-baseline.txt")
        if files_re and not uncovered:
            record("prek.toml `files:` covers every CRATE_ROOTS entry", True, True)
        else:
            record(
                "prek.toml `files:` covers every CRATE_ROOTS entry",
                uncovered if files_re else "could not parse files: from prek.toml",
                "every CRATE_ROOTS entry matched by the hook's files: regex",
            )

        # --- #3255 direction 12: --update-baseline REFUSES a reduction -------
        # The re-anchor path rewrites the whole baseline, so its reduction
        # report is the only thing standing between an operator and silently
        # absorbing the removal this guard exists to catch. Printing it and
        # exiting 0 left that advisory. Pinned in both directions: refuse by
        # default, proceed under the explicit opt-in.
        shrink = src / "shrink.rs"
        shrink.write_text(
            'let sql = "SELECT id FROM blocks b WHERE b.space_id = ?1";\n',
            encoding="utf-8",
        )
        baseline_path.write_text("2 src-tauri/src/shrink.rs\n", encoding="utf-8")
        code, out = _run_cli(guard, ["--update-baseline"])
        refused = code != 0 and "REFUSING" in out and "2 -> 0" in out
        baseline_path.write_text("2 src-tauri/src/shrink.rs\n", encoding="utf-8")
        code2, _ = _run_cli(guard, ["--update-baseline", "--allow-reductions"])
        shrink.unlink()
        if refused and code2 == 0:
            record("CLI: --update-baseline refuses a reduction, opt-in allows", True, True)
        else:
            record(
                "CLI: --update-baseline refuses a reduction, opt-in allows",
                (code, code2, out.strip()),
                "non-zero + REFUSING without the flag, exit 0 with --allow-reductions",
            )

        # --- #3255 direction 13: the refusal survives repetition ------------
        # An earlier revision wrote the baseline BEFORE refusing, so a second
        # identical run saw `before == after`, found no drop and exited 0 —
        # the refusal was defeated by pressing up-arrow, which is the most
        # natural response to a failed command. Direction 12 cannot catch it:
        # it restores the pre-state between its two runs. This one does not.
        shrink.write_text(
            'let sql = "SELECT id FROM blocks b WHERE b.space_id = ?1";\n',
            encoding="utf-8",
        )
        baseline_path.write_text("2 src-tauri/src/shrink.rs\n", encoding="utf-8")
        first, _ = _run_cli(guard, ["--update-baseline"])
        second, _ = _run_cli(guard, ["--update-baseline"])
        untouched = baseline_path.read_text(encoding="utf-8").strip() == (
            "2 src-tauri/src/shrink.rs"
        )
        shrink.unlink()
        if first != 0 and second != 0 and untouched:
            record("CLI: the reduction refusal is idempotent (#3255)", True, True)
        else:
            record(
                "CLI: the reduction refusal is idempotent (#3255)",
                (first, second, untouched),
                "both runs non-zero and the baseline left unwritten",
            )

        # --- #3255 direction 14: delete-in-A + add-in-B nets to zero ---------
        # A whole-tree total alone lets a genuine in-place removal hide behind
        # an unrelated addition. The discriminator is whether the losing file
        # STILL EXISTS: a relocation empties its old file, an in-place deletion
        # leaves it present with a smaller count.
        keep = src / "keep.rs"
        keep.write_text(
            'let a = "WHERE (?1 IS NULL OR b.space_id = ?1)";\n'
            'let b = "WHERE (?2 IS NULL OR b.space_id = ?2)";\n',
            encoding="utf-8",
        )
        gain = src / "gain.rs"
        gain.write_text(
            'let sql = "WHERE (?1 IS NULL OR b.space_id = ?1)";\n',
            encoding="utf-8",
        )
        # Baseline claims 3 in keep.rs; the tree has 2 there and 1 in gain.rs,
        # so the TOTAL is unchanged while keep.rs lost one in place.
        baseline_path.write_text("3 src-tauri/src/keep.rs\n", encoding="utf-8")
        code, out = _run_cli(guard, ["--update-baseline"])
        keep.unlink()
        gain.unlink()
        if code != 0 and "IN PLACE" in out and "keep.rs" in out:
            record("CLI: an in-place removal that nets to zero is refused", True, True)
        else:
            record(
                "CLI: an in-place removal that nets to zero is refused",
                (code, out.strip()),
                "non-zero exit naming keep.rs as an in-place removal",
            )

        # --- #3255 direction 15: a count ABOVE its baseline is a finding -----
        # The other half of this guard's failure mode, and the one that
        # produced its own headline evidence: `backlink/grouped.rs` gained two
        # canonical guards while unwatched and kept a baseline of 3. Unfixed,
        # that recurs — the extra guards are unratcheted and a later removal
        # restores the old number and passes. The same rule catches a
        # hand-LOWERED baseline, which nothing else can see: the entry
        # resolves, it is present, and `cnt < base` is false by construction.
        gained = src / "gained.rs"
        gained.write_text(
            'let a = "WHERE (?1 IS NULL OR b.space_id = ?1)";\n'
            'let b = "WHERE (?2 IS NULL OR b.space_id = ?2)";\n'
            'let c = "WHERE (?3 IS NULL OR b.space_id = ?3)";\n',
            encoding="utf-8",
        )
        baseline_path.write_text("1 src-tauri/src/gained.rs\n", encoding="utf-8")
        code, out = _run_cli(guard, [str(gained)])
        gained.unlink()
        if code != 0 and "unratcheted" in out and "gained.rs" in out:
            record("CLI: a count above its baseline is a finding (#3255)", True, True)
        else:
            record(
                "CLI: a count above its baseline is a finding (#3255)",
                (code, out.strip()),
                "non-zero exit naming gained.rs as carrying unratcheted guards",
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
        # Run the existence checks FIRST, and treat their two halves
        # DIFFERENTLY, because only one of them describes a legitimate
        # re-anchor.
        #
        # A dangling BASELINE entry is often exactly why you are re-anchoring:
        # the file really moved or was deleted. Warn and proceed.
        #
        # A missing CRATE_ROOTS entry is never that. `compute_baseline()`
        # walks `crate_root_paths()`, which `is_dir()`-filters a vanished root
        # away — so re-anchoring against a misspelled or renamed root SILENTLY
        # DELETES every baseline entry under it, which is the "re-anchoring
        # past it is how the finding gets lost" failure DANGLING_HINT warns
        # about two lines further down. The remedy is to fix the root list, not
        # the baseline, so refuse rather than warn: there is no case where
        # rebuilding against a root the operator did not mean to remove is the
        # right move, and a warning printed above a completed rebuild is read
        # after the damage is written.
        pre = _assert_paths_exist(read_baseline())
        root_findings = [m for kind, m in pre if kind == "root"]
        if root_findings:
            print(
                "Refusing to re-anchor: a declared CRATE_ROOTS entry is "
                "missing.\n",
                file=sys.stderr,
            )
            for v in root_findings:
                print(f"  {v}", file=sys.stderr)
            print("", file=sys.stderr)
            print(ROOT_MISSING_HINT, file=sys.stderr)
            return 1
        for _kind, m in pre:
            print(f"  WARNING before re-anchor: {m}", file=sys.stderr)
        # Compute the new baseline, report the deltas, and decide BEFORE
        # writing anything.
        #
        # An earlier revision wrote first and refused after, so the operator
        # could read the diff. That made the refusal skippable by repetition:
        # re-running the identical command saw `before == after`, found no
        # drop, and exited 0 — absorbing the removal without
        # `--allow-reductions` ever being typed. Re-running a failed command is
        # the most natural response to it, so the "explicit act" the refusal
        # exists to force was defeated by pressing up-arrow. Refusing before
        # the write makes it idempotent, and the printed deltas give the
        # operator the same information the diff would have.
        #
        # The comparison is on the TOTAL, not per-file. A pure MOVE shows a
        # per-file reduction at the old path and an equal gain at the new one
        # — and a move is the headline reason to re-anchor at all (it is what
        # #2621 did to eleven of these entries). Refusing it would make the
        # command that DANGLING_HINT prescribes fail for its own primary case.
        # A total that drops is a fragment that left the tree.
        before = read_baseline()
        after = compute_baseline()
        for rel in sorted(set(before) | set(after)):
            old_n, new_n = before.get(rel, 0), after.get(rel, 0)
            if old_n != new_n:
                mark = "  <-- fewer" if new_n < old_n else ""
                print(f"  {rel}: {old_n} -> {new_n}{mark}", file=sys.stderr)
        lost = sum(before.values()) - sum(after.values())
        # A total alone is not sufficient, and the earlier revision said so
        # only implicitly. Deleting a guard in file A while adding an unrelated
        # one in file B nets to zero, and would have re-anchored without
        # `--allow-reductions` ever being typed. The discriminator is whether
        # the losing file STILL EXISTS: a relocation empties its old file (the
        # entry disappears because the file is gone or no longer carries the
        # fragment at all), whereas an in-place deletion leaves the file
        # present with a smaller count. So refuse on either signal.
        in_place = [
            rel
            for rel, old_n in before.items()
            if after.get(rel, 0) < old_n and (REPO_ROOT / rel).is_file()
        ]
        if (lost > 0 or in_place) and "--allow-reductions" not in argv:
            if in_place:
                why = (
                    f"a guard was removed IN PLACE from {', '.join(in_place)} "
                    "(the file is still there with fewer)"
                )
            else:
                why = (
                    f"{lost} canonical space-filter guard(s) would leave the "
                    "baseline entirely"
                )
            print(
                f"\n  REFUSING: {why}.\n"
                "  Per-file gains and losses are listed above. A pure MOVE — "
                "the old file gone or\n"
                "  emptied, an equal gain elsewhere — nets to zero and is "
                "allowed without a flag.\n"
                "  Nothing has been written. If the removal is intended, "
                "re-run with `--allow-reductions`.",
                file=sys.stderr,
            )
            return 1
        write_baseline(after)
        print(f"Wrote {BASELINE_PATH.relative_to(REPO_ROOT)}")
        return 0

    baseline = read_baseline()

    # Determine targets. prek passes changed files; a bare invocation scans
    # the whole tree. Either way only police `.rs` under a CRATE_ROOTS entry
    # (skip DENY_FILES, and skip anything outside those roots).
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
        baseline_touched = any(
            Path(a).resolve() == BASELINE_PATH for a in file_args
        )
        if baseline_touched or not targets:
            # Two triggers, and the first is the one that matters.
            #
            # (a) The BASELINE itself changed. Scanning only the other `.rs`
            #     files in the commit would let a hand-edit LOWERING some
            #     OTHER file's count pass — the entry still resolves, so the
            #     dangling check is silent, and that file is never scanned.
            #     An earlier revision only fell back when the target set came
            #     out empty, which missed exactly the common case of editing
            #     the baseline alongside a source file.
            #
            # (b) Nothing survived the filter. That happens for a guard script
            #     named in the hook's `files:` regex — and, contrary to what
            #     this comment said until the reviewer caught it, ALSO for an
            #     ordinary `.rs` commit touching only a DENY_FILES entry
            #     (`space_filter_canonical.rs`), which the deny filter drops.
            #     Harmless, but it does spend the walk, and the previous
            #     wording asserted it could not happen.
            #
            # The whole-tree walk is ~3.5s.
            targets = all_source_files()
    else:
        targets = all_source_files()

    shape_violations: list[str] = []
    removal_violations: list[str] = []
    unbaselined: list[str] = []
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
    dangling = [m for _kind, m in _assert_paths_exist(baseline)]

    for p in targets:
        rel = p.relative_to(REPO_ROOT).as_posix()
        cnt, viols = scan_file(p)
        shape_violations.extend(viols)
        base = baseline.get(rel, 0)
        if cnt > 0 and rel not in baseline:
            # #3255 review: `baseline.get(rel, 0)` means an entry DELETED
            # outright reads as 0, so `cnt < base` can never fire for it —
            # hand-editing a line out of the baseline silently retires the
            # removal net for that file, which is the very net this guard is.
            # The dangling check cannot see it either: there is no entry left
            # to dangle. A file carrying canonical fragments must therefore
            # carry a baseline entry. A genuinely NEW file trips this too,
            # which is correct ratchet behaviour — re-anchor and the entry
            # appears.
            unbaselined.append(
                f"{rel}: {cnt} canonical space-filter fragment(s) but NO "
                f"baseline entry — an entry was deleted (retiring the removal "
                f"net for this file), or the file is new and needs anchoring."
            )
        if cnt > base and rel in baseline:
            # #3255 review: a count that EXCEEDS its baseline was silent, and
            # that silence is the other half of this guard's own failure mode.
            # Two ways in, one rule out:
            #
            #   * a file GAINS a canonical guard and keeps its stale-low
            #     baseline — which is exactly the `backlink/grouped.rs` 3 -> 5
            #     rot this change was written to expose. Unfixed, that rot
            #     recurs unchanged: the added guards are unratcheted, and a
            #     later removal restores the old number and passes.
            #   * the baseline is HAND-LOWERED while the file is untouched
            #     (`5 foo.rs` edited to `3`). Nothing else sees it — the entry
            #     resolves so `dangling` is silent, it is present so
            #     `unbaselined` is silent, and `cnt < base` is false by
            #     construction.
            #
            # It is also what the `unbaselined` rule above already does for a
            # brand-new file, for the same reason. A file whose count exceeds
            # its record is a file whose record needs re-anchoring.
            unbaselined.append(
                f"{rel}: {cnt} canonical space-filter fragment(s) but the "
                f"baseline records {base} — guards were added without "
                f"re-anchoring, or the baseline was lowered by hand. Either "
                f"way the extra {cnt - base} are unratcheted."
            )
        if cnt < base:
            removal_violations.append(
                f"{rel}: {cnt} canonical space-filter fragment(s), "
                f"baseline expects {base} — a `(?N IS NULL OR b.space_id "
                f"= ?N)` guard was removed or degraded to a bare "
                f"`b.space_id = ?N`."
            )

    if (
        not shape_violations
        and not removal_violations
        and not dangling
        and not unbaselined
    ):
        return 0

    # Two headers, because a dangling-only run has nothing drifted in it and
    # saying so anyway sends the reader looking for a drift that is not there.
    # The hints below were already conditional; this line was the one that
    # was not.
    if shape_violations or removal_violations or unbaselined:
        print(
            "Space-filter drift guard (#139) — the inlined "
            f"`{CANONICAL}` fragment drifted:\n",
            file=sys.stderr,
        )
    else:
        print(
            "Space-filter drift guard (#139) — the baseline no longer "
            "describes this tree:\n",
            file=sys.stderr,
        )
    for v in shape_violations:
        print(f"  {v}", file=sys.stderr)
    for v in removal_violations:
        print(f"  {v}", file=sys.stderr)
    for v in unbaselined:
        print(f"  {v}", file=sys.stderr)
    for v in dangling:
        print(f"  {v}", file=sys.stderr)
    print("", file=sys.stderr)
    if dangling:
        print(DANGLING_HINT, file=sys.stderr)
    if shape_violations or removal_violations or unbaselined:
        print(HINT, file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
