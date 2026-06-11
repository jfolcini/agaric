#!/usr/bin/env python3
"""Guard the inlined space-filter SQL fragment against drift (#139).

Space membership is a first-class `blocks.space_id` column (migration
0086, #533), so every paginated read that honours the active space inlines
the canonical guard fragment

    (?N IS NULL OR b.space_id = ?N)

(the same bind index `?N` on BOTH sides — once for the NULL short-circuit,
once for the equality). The fragment is copy-pasted at ~30 production call
sites across `pagination/`, `backlink/`, `tag_query/`, and `commands/`
(see `grep -rn "IS NULL OR b.space_id" src-tauri/src`). The maintainer
deferred the `build.rs` / `include_str!` consolidation that would let the
fragment live in one place (blocked on sqlx#3388 — `sqlx::query!` rejects
non-`LitStr` first arguments), so the copies stay inlined. This hook is the
cheap drift-guard adopted in their place: it catches the exact
inlined-fragment foot-gun (a hand-edit that mangles one copy) at low cost.

The companion `src-tauri/src/space_filter_canonical.rs` parity *test*
pins the same canonical string and walks `src/**/*.rs` at test time; this
hook is the pre-commit-stage mirror so a drift is caught before the commit
lands (and without needing a Rust rebuild). Both enforce the same shape.

Two complementary rules over each `.rs` file under `src-tauri/src/`:

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

(no args = scan every `src-tauri/src/**/*.rs`). Stdlib only — no
third-party deps.
"""

from __future__ import annotations

import importlib.util
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SRC_ROOT = REPO_ROOT / "src-tauri" / "src"
BASELINE_PATH = REPO_ROOT / "src-tauri" / "space-filter-baseline.txt"

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

# Files excluded from the scan entirely. Paths relative to src-tauri/src/.
DENY_FILES = {
    # Holds SPACE_FILTER_CANONICAL + the hand-written `alternate` parity
    # string; canonical by construction, policing it here is circular.
    "space_filter_canonical.rs",
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
    "       Keep `src-tauri/src/space_filter_canonical.rs::SPACE_FILTER_CANONICAL`\n"
    "       in sync."
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


def scan_file(path: Path) -> tuple[int, list[str]]:
    """Return (canonical_count, rule_A_violations) for one file.

    `canonical_count` counts only well-formed canonical guarded fragments
    (matching bind indices, `b.space_id` column). A drifted guard match is
    NOT counted toward the baseline (it is a Rule-A violation instead), so a
    param-mismatch edit can't keep the baseline count satisfied.
    """
    try:
        raw = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return 0, []
    text = strip_comments_keep_strings(raw)
    rel = path.relative_to(SRC_ROOT).as_posix()
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
                f"src-tauri/src/{rel}:{ln}: mismatched bind index "
                f"(?{a or '?'} … ?{b or '?'}) in `{frag}`"
            )
    return count, violations


def all_source_files() -> list[Path]:
    out: list[Path] = []
    for p in sorted(SRC_ROOT.rglob("*.rs")):
        if p.relative_to(SRC_ROOT).as_posix() in DENY_FILES:
            continue
        out.append(p)
    return out


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


def main(argv: list[str]) -> int:
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
        for arg in file_args:
            p = Path(arg)
            if p.suffix != ".rs":
                continue
            try:
                rp = p.resolve()
                rp.relative_to(SRC_ROOT)
            except ValueError:
                continue
            if rp.relative_to(SRC_ROOT).as_posix() in DENY_FILES:
                continue
            if rp.is_file():
                targets.append(rp)
    else:
        targets = all_source_files()

    shape_violations: list[str] = []
    removal_violations: list[str] = []

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

    if not shape_violations and not removal_violations:
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
    print("", file=sys.stderr)
    print(HINT, file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
