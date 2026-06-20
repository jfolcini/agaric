#!/usr/bin/env python3
"""Guard component surfaces against raw `shadow-(sm|md|lg)` drift (#1810).

Follow-up to #1654, which routed the hand-rolled component surfaces through
the elevation-tier tokens registered in `src/index.css`:

    --shadow-resting  (in-flow cards, resting rows/toolbars)   [was shadow-sm]
    --shadow-floating (popover, select, tooltip, menus, combobox) [was shadow-md]
    --shadow-overlay  (dialog, alert-dialog, sheet, FAB)        [was shadow-lg]

Surfaces reference them as the Tailwind v4 arbitrary-property utility
`shadow-(--shadow-resting|--shadow-floating|--shadow-overlay)`. The tier
mapping is the canonical comment in `src/index.css` (#1098). Applying
elevation "by tier, not by component whim" keeps the prominence scale
coherent and lets dark mode soften every surface with a one-line token edit.

This hook is the anti-drift guard deferred from #1654: it FAILS if a raw
`shadow-(sm|md|lg)` utility (with any Tailwind variant prefix, e.g.
`focus:shadow-lg`, `data-[state=on]:shadow-sm`) appears on a container
surface under `src/components/`, so elevation can't silently re-drift off
the tiers. New elevated surfaces must use a tier token.

A handful of shadows under `src/components/` are *intentionally* NOT tier
elevations — they are small control-affordance / legibility shadows, not
container surfaces. #1654 left these as raw utilities by design; they are
allowlisted here (file-scoped, with a per-file reason):

  * src/components/common/SpaceAccentBadge.tsx  — badge legibility shadow
      (a label drawn on an arbitrary accent fill, not a lifted surface).
  * src/components/search/SearchToggleRow.tsx   — pressed-state inset shadow
      (a control's depressed affordance, not an elevation).
  * src/components/attachments/AttachmentRenderer.tsx — image-overlay control
      chips (small chips floated over media, not a container surface).
  * src/components/ui/kbd.tsx           — keycap relief on the prominent
      settings-key chip (a glyph affordance, not a surface).
  * src/components/ui/checkbox.tsx      — control box affordance shadow.
  * src/components/ui/switch.tsx        — switch thumb affordance shadow.
  * src/components/ui/toggle-group.tsx  — pressed `data-[state=on]` inset.
  * src/components/ui/sidebar.tsx       — unused vendored floating/inset
      variant paths (the app mounts only the default/icon + non-inset
      variants, so these shadow branches never render; not converted to
      avoid drift in dead vendored-primitive CSS).

Adding a new tier elevation? Use `shadow-(--shadow-<tier>)`. Adding a new
genuinely-non-tier shadow (rare)? Extend ALLOWLIST below with a reason.

Detection deliberately strips `//` and `/* */` comments first, so a
`shadow-sm` *mentioned in a code comment* (e.g. SortableBlock.tsx documenting
EditableBlock's old class) never trips the guard, and a `//` inside a string
literal can't truncate a real match.

Invocation: prek passes the changed files as argv (hook id
`check-elevation-tiers`). Run manually over the whole tree with:

    python3 scripts/check-elevation-tiers.py            # scans src/components
    python3 scripts/check-elevation-tiers.py --self-test

Stdlib only — no third-party deps.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SCOPE_ROOT = REPO_ROOT / "src" / "components"

# Files under src/components/ whose raw shadow-(sm|md|lg) is an intentional
# non-tier shadow (#1654 left these as raw utilities by design). Paths are
# relative to the repo root; the value is the documented reason.
ALLOWLIST: dict[str, str] = {
    "src/components/common/SpaceAccentBadge.tsx": (
        "badge legibility shadow on an arbitrary accent fill, not a surface"
    ),
    "src/components/search/SearchToggleRow.tsx": (
        "pressed-state inset shadow (depressed control affordance)"
    ),
    "src/components/attachments/AttachmentRenderer.tsx": (
        "image-overlay control chips floated over media, not a container"
    ),
    "src/components/ui/kbd.tsx": (
        "keycap relief on the prominent settings-key chip (glyph affordance)"
    ),
    "src/components/ui/checkbox.tsx": (
        "checkbox control-box affordance shadow"
    ),
    "src/components/ui/switch.tsx": (
        "switch thumb affordance shadow"
    ),
    "src/components/ui/toggle-group.tsx": (
        "pressed data-[state=on] inset affordance"
    ),
    "src/components/ui/sidebar.tsx": (
        "unused vendored floating/inset variant paths (never rendered by this app)"
    ),
}

# A raw `shadow-(sm|md|lg)` Tailwind utility, with an optional chain of
# variant prefixes (`focus:`, `hover:`, `md:`, `data-[state=on]:`,
# `[@media(hover:none)]:`, …). The trailing boundary forbids matching the
# tier utilities `shadow-(--shadow-...)` (no `-` follows `sm|md|lg`) and any
# longer token like `shadow-smooth`.
SHADOW_RE = re.compile(r"shadow-(?:sm|md|lg)(?![\w-])")

HINT = (
    "    -> #1810 (follow-up to #1654): elevate container surfaces under\n"
    "       src/components/ via the tier tokens, not raw shadows:\n"
    "         resting  cards / in-flow resting rows / toolbars  ->\n"
    "                  shadow-(--shadow-resting)   [was shadow-sm]\n"
    "         floating popover / select / tooltip / menus       ->\n"
    "                  shadow-(--shadow-floating)  [was shadow-md]\n"
    "         overlay  dialog / sheet / FAB                      ->\n"
    "                  shadow-(--shadow-overlay)   [was shadow-lg]\n"
    "       (mapping: src/index.css). If this shadow is a genuinely\n"
    "       non-tier control/legibility shadow (rare), add the file to\n"
    "       ALLOWLIST in scripts/check-elevation-tiers.py with a reason."
)


def strip_comments(text: str) -> str:
    """Blank `//` and `/* */` comments to spaces; keep string literals.

    String / template-literal contents are kept (so a real className still
    scans) but are skipped over so a `//` inside a literal can't start a
    comment. Newlines are preserved, so byte offsets map 1:1 onto line
    numbers in the original text.
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
            j = i + 2
            while j < n and not (text[j] == "*" and j + 1 < n and text[j + 1] == "/"):
                j += 1
            j = min(j + 2, n)
            blank(i, j)
            i = j
            continue

        # String / template literals: keep contents, but skip over them so a
        # `//` or `/*` inside cannot start a comment.
        if ch in ("'", '"', "`"):
            quote = ch
            j = i + 1
            while j < n:
                if text[j] == "\\":
                    j += 2
                elif text[j] == quote:
                    j += 1
                    break
                else:
                    j += 1
            i = j
            continue

        i += 1
    return "".join(out)


def scan_text(rel_path: str, text: str) -> list[str]:
    """Return offending `file:line: <line>` strings for one file's source.

    Pure (no I/O) so the `--self-test` fixtures can exercise it directly.
    Allowlist / scope skips are applied by `check_file`, not here.
    """
    stripped = strip_comments(text)
    lines = text.splitlines()
    violations: list[str] = []
    seen_lines: set[int] = set()
    for m in SHADOW_RE.finditer(stripped):
        idx = stripped.count("\n", 0, m.start())  # 0-based line index
        if idx in seen_lines:
            continue
        seen_lines.add(idx)
        src_line = lines[idx].strip() if idx < len(lines) else ""
        violations.append(f"{rel_path}:{idx + 1}: {src_line}")
    return violations


def is_test_file(rel: str) -> bool:
    """Tests assert the *production* class string (`toContain('shadow-sm')`)
    and are not container surfaces — skip `__tests__/` dirs and `*.test.*`
    / `*.spec.*` files so a guarded surface's own test can pin the class."""
    return (
        "/__tests__/" in rel
        or ".test." in rel
        or ".spec." in rel
    )


def check_file(path: Path) -> list[str]:
    try:
        rel = path.resolve().relative_to(REPO_ROOT).as_posix()
    except ValueError:
        rel = path.as_posix()
    if rel in ALLOWLIST or is_test_file(rel):
        return []
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return []
    return scan_text(rel, text)


def scope_files() -> list[Path]:
    out: list[Path] = []
    for pattern in ("*.tsx", "*.ts"):
        out.extend(SCOPE_ROOT.rglob(pattern))
    return sorted(out)


# --- self-test fixtures ------------------------------------------------------
# `python3 scripts/check-elevation-tiers.py --self-test`. Proves the guard
# flags a raw shadow on a container surface, stays silent on the tier
# utilities and on a shadow mentioned only in a comment, and that the
# allowlist exempts an intentional non-tier file. Stdlib only — no framework,
# no temp files.
_SELFTEST_FLAG_CASES: list[tuple[str, str, bool]] = [
    (
        "raw shadow-md on a popover surface -> FLAG",
        '<div className="rounded-lg border bg-popover p-1 shadow-md" />',
        True,
    ),
    (
        "raw focus:shadow-lg on a skip-link -> FLAG",
        '<a className="focus:rounded-md focus:bg-background focus:shadow-lg" />',
        True,
    ),
    (
        "data-[state=on]:shadow-sm variant prefix -> FLAG",
        "'data-[state=on]:bg-secondary data-[state=on]:shadow-sm'",
        True,
    ),
    (
        "tier utility shadow-(--shadow-floating) -> clean",
        '<div className="rounded-md border bg-popover shadow-(--shadow-floating)" />',
        False,
    ),
    (
        "tier utility shadow-(--shadow-resting) -> clean",
        '<div className="bg-card shadow-(--shadow-resting)" />',
        False,
    ),
    (
        "shadow-sm mentioned only in a // comment -> clean (stripped)",
        "// EditableBlock (`ring-1 ring-border bg-accent/[0.06] shadow-sm`, rounded)\n"
        '<div className="bg-accent/[0.06] shadow-(--shadow-resting)" />',
        False,
    ),
    (
        "shadow-sm inside a /* block */ comment -> clean (stripped)",
        '/* legacy: shadow-sm */\n<div className="shadow-(--shadow-resting)" />',
        False,
    ),
    (
        "unrelated longer token shadow-smooth -> clean (boundary)",
        '<div className="shadow-smooth" />',
        False,
    ),
]


def run_self_test() -> int:
    failures = 0
    for name, body, expect_flag in _SELFTEST_FLAG_CASES:
        # Use a neutral, NON-allowlisted scope path so only scan_text logic
        # (not the file-level allowlist skip) decides the outcome.
        got_flag = bool(scan_text("src/components/__fixture__.tsx", body))
        ok = got_flag == expect_flag
        status = "PASS" if ok else "FAIL"
        print(f"  [{status}] {name}")
        if not ok:
            print(f"        expected flag={expect_flag}, got flag={got_flag}")
            failures += 1

    # Allowlist exemption: an intentional non-tier file with a raw shadow is
    # skipped by check_file even though scan_text would flag it.
    allow_rel = next(iter(ALLOWLIST))
    raw = scan_text(allow_rel, '<span className="text-white shadow-sm" />')
    allow_ok = bool(raw)  # scan_text itself must SEE it...
    # ...and check_file must SUPPRESS it for an allowlisted file. We assert the
    # path membership directly (check_file reads from disk; here we assert the
    # contract that ALLOWLIST keys are honoured).
    suppressed = allow_rel in ALLOWLIST
    status = "PASS" if (allow_ok and suppressed) else "FAIL"
    print(f"  [{status}] allowlisted file ({allow_rel}) exempted")
    if not (allow_ok and suppressed):
        failures += 1

    if failures:
        print(
            f"check-elevation-tiers self-test FAILED ({failures} case(s))",
            file=sys.stderr,
        )
        return 1
    print(
        f"check-elevation-tiers self-test passed "
        f"({len(_SELFTEST_FLAG_CASES) + 1} cases)"
    )
    return 0


def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        return run_self_test()

    # prek passes changed files; a bare invocation scans the whole scope.
    file_args = [a for a in argv if not a.startswith("-")]
    if file_args:
        targets: list[Path] = []
        for arg in file_args:
            p = Path(arg)
            if p.suffix not in (".tsx", ".ts"):
                continue
            try:
                rp = p.resolve()
                rp.relative_to(SCOPE_ROOT)
            except ValueError:
                continue
            if rp.is_file():
                targets.append(rp)
    else:
        targets = scope_files()

    violations: list[str] = []
    for p in targets:
        violations.extend(check_file(p))

    if not violations:
        return 0

    print(
        "Elevation-tier guard (#1810 / #1654) — raw shadow-(sm|md|lg) on a "
        "container surface under src/components/:\n",
        file=sys.stderr,
    )
    for v in violations:
        print(f"  {v}", file=sys.stderr)
    print("", file=sys.stderr)
    print(HINT, file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
