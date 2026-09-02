#!/usr/bin/env python3
"""Every path named by a baseline, allowlist or DENY_FILES set must resolve (#4501).

A path-keyed guard whose subject moves does not fail. It matches nothing,
reports nothing, exits 0, and the invariant it protected silently stops being
enforced. Six recorded instances (#3110, #3847, #2895, #3465, session 1299's
`android_re`, and `check-bulk-equivalence`'s own header), plus the live one
#3255/#4508 fixed: 11 of 15 `space-filter-baseline.txt` entries named files
that had moved to `agaric-store` in #2621. The allowlist checkers could not
detect a dangling entry AT ALL — they walked discovered files and asked "is
this one allowed?", never "does this entry still name a file?".

This is the mechanical half of that class, and only that half: a DIRECTORY
WALK. It has no opinion about hooks, about what each guard is FOR, about
whether an entry sits inside its owner's scan roots (assertion 2, unbuilt
outside `check-space-filter-drift`), or about `files:` triggers (assertion 4,
likewise). Those need judgement; this needs `Path.exists()`.

Deliberately standalone rather than a feature of a larger hook-dependency
guard: a directory walk must not inherit that dependency.

NO `--self-test`, deliberately (#4501, #4556's corollary). A guard earns a
self-test when it parses source text with its own parser and can therefore
fail OPEN in silence. A path-existence check cannot: a defect in it shows up
as a false POSITIVE — it names a file that does exist — which announces
itself the first time anyone runs it. Adding one here would be the third
level of meta this issue exists to complain about. What CAN fail open is
checking NOTHING, so the two silent-narrowing routes are closed explicitly:
discovery failing closed on an unknown file (below), and every source
asserting it yielded at least one entry. The run prints its own denominator.

--------------------------------------------------------------------------
THE POPULATION, and how it stays honest
--------------------------------------------------------------------------
"Every baseline in the repo" is only true if the population was enumerated,
so the population is not hand-maintained where it does not have to be.

DATA FILES are DISCOVERED, not listed: every TRACKED file whose name contains
`baseline` / `allowlist`, whatever its extension. A discovered file that is in
neither `DATA_SOURCES` nor `NO_PATHS` is a hard FAILURE, not a skip — so a
baseline added tomorrow is either covered or loud. That is the one property a
hand-written list cannot have, and the absence of which is this issue's entire
subject.

TRACKED, via `git ls-files`, rather than a filesystem walk, and NOT filtered by
extension. Both halves are load-bearing and both were learned the hard way:

- a walk sees whatever happens to be lying in the working directory. In a
  contributor's checkout that includes `.stryker-tmp/sandbox-*/scripts/`
  (gitignored, and a verbatim COPY of `scripts/`, so eight baselines apiece)
  and `src-tauri/gen/android/**/baseline-prof.txt` (gitignored Android build
  output). Measured on a real checkout: 36 files, every one a hard failure, on
  an `always_run` pre-commit hook — this guard would have blocked every commit
  for anyone who had run Stryker or built the Android app, while staying green
  in a fresh worktree that has neither. A tracked-file query cannot have that
  failure mode, and it needs no hand-maintained list of build directories,
  which would be this issue's own subject one level up;
- an extension allowlist made `*-baseline.yml`, `.toml`, `.csv` or a
  suffixless one invisible, which is precisely the "added tomorrow and
  silently exempt" case discovery exists to prevent.

An enumeration that FAILS or comes back empty is itself a finding, not a quiet
pass: it is the same negative-claim-over-an-empty-set as `checked == 0` below.

EMBEDDED SETS (a guard's own `DENY_FILES` / `ALLOWLIST` / `EXEMPT_FILES`)
cannot be discovered that way, so they are declared in `EMBEDDED_SOURCES`.
Each declaration is self-checking in two directions: the file must exist, and
extraction must yield at least one entry — so a renamed constant or a
restructured literal fails loudly instead of silently contributing zero. A
PARTIAL under-extraction is still possible; that limit is real, bounded by
the per-source counts this script prints, and recorded here rather than
denied. Two shapes produce it, both confirmed by running the extractor
against them: a set assembled from more than one literal (`X = [...] + EXTRA`,
or a second `X |= {...}` statement) yields only the first literal's entries,
and neither the file-exists nor the yields-something arm notices. A set whose
paths are the VALUES of a mapping (`{symbol: path}`) is the benign case: the
keys come back instead and `Path.exists()` names them, which is the false
POSITIVE this script's header argues announces itself. Keep these sets to one
literal with the paths on the left.

The same silence applies to two SYNTAX forms the literal scanner does not
model: a JavaScript template literal (backtick-quoted) and a `/* ... */` block
comment inside a declared set. Both would be scanned as code, and a PARTIAL
mis-parse is silent for the same reason as the multi-literal case above — the
`unread` arm fires only on ZERO entries, so a set that yields some of its
paths passes. None of today's eight embedded sources uses either construct;
this is named alongside the multi-literal limit so the next one that does is
recognised rather than rediscovered.

A third: the escape branch advances past `\\x` without appending either
character, so `"a\\b"` extracts as `ab`. No declared set uses an escape today,
and the failure direction is a self-announcing false positive (it would name a
path that does exist), but it belongs in this roster rather than being
rediscovered by whoever first writes one.

Entries that are GLOBS (containing `*` or `?`) are skipped per-entry, not
per-set: "matches at least one path" is a different assertion with different
false-positive behaviour (a deliberately forward-looking pattern is legal),
and mixing it in would make a red run ambiguous. The count of skipped globs
is printed so the denominator is visible.

Usage:
    python3 scripts/check-baseline-paths.py          # check
    python3 scripts/check-baseline-paths.py -v       # + per-source counts
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

# Tracked directories deliberately not searched. Only one is needed now that
# discovery asks git rather than the filesystem: the session-log corpus, whose
# prose filenames legitimately contain "baseline"
# (`session-1127-baseline-clippy-knip-e2e-cleanup.md`). Vendor and build trees
# are excluded for free by being untracked.
# Anchored to the directory it means, not matched as a bare path SEGMENT: a
# baseline that ever landed under some other `session-log/` directory would
# otherwise be silently invisible to discovery, which is the failure mode this
# whole script exists to end.
PRUNE_DIRS = ("docs/session-log/",)

# --- The population: data files ------------------------------------------
# repo-relative path -> (extractor, base directory the entries are relative to)
#
# `base` is part of the declaration because two of these are NOT repo-root
# relative, and guessing would make a dangling entry look resolvable. That is
# exactly how `check-space-filter-drift`'s DENY_FILES rotted: its single entry
# was written relative to `src-tauri/src/` and kept resolving nowhere.
DATA_SOURCES: dict[str, tuple[str, str]] = {
    # JSON array of objects; the `fn` field is `<path>::<symbol>`.
    "scripts/bulk-equivalence-baseline.json": ("json:fn::", "."),
    # JSON array of objects keyed by a `file` field.
    "scripts/content-regex-baseline.json": ("json:file", "."),
    # `file` is the DOCUMENT carrying the citation and must resolve. The
    # sibling `ref` field is the cited code path and is DELIBERATELY excluded:
    # a `ref` that no longer resolves is the very thing this baseline
    # grandfathers, so asserting it here would fail on the file's purpose.
    "scripts/doc-code-paths-baseline.json": ("json:file", "."),
    # JSON object; the keys are paths.
    "scripts/json-parse-cast-baseline.json": ("json:keys", "."),
    # JSON arrays of bare path strings.
    "scripts/lib-layering-baseline.json": ("json:list", "."),
    "scripts/strict-invoke-optout-baseline.json": ("json:list", "."),
    "scripts/tauri-import-baseline.json": ("json:list", "."),
    # `<count> <path>` text lines.
    "src-tauri/dynamic-sql-baseline.txt": ("text:count-path", "."),
    "src-tauri/space-filter-baseline.txt": ("text:count-path", "."),
    # One migration FILENAME per line, relative to the migrations directory.
    "src-tauri/migrations-mock-ack-baseline.txt": ("text:lines", "src-tauri/migrations"),
    # One path per line, relative to `src-tauri/` (the file's header says so).
    "src-tauri/unsafe-allowlist.txt": ("text:lines", "src-tauri"),
}

# Discovered files that name NO paths. Listed with the reason, so that a
# reader can tell "checked and found nothing to check" from "never looked".
NO_PATHS: dict[str, str] = {
    "scripts/coverage-baseline.json": "two coverage percentages, no paths",
    "scripts/metric-firing-baseline.json": "metric symbol names (`Type::field`)",
    "src-tauri/migrations-test-coverage-baseline.txt": (
        "bare migration NUMBERS (`0001`), not filenames — the guard resolves "
        "them against test names, not the filesystem"
    ),
    "src-tauri/table-ownership-baseline.txt": (
        "`<count> <crate> <table>` — crate labels and SQL table names"
    ),
    # Matched by name but is a guard script, not its data.
    "scripts/check-tauri-import-baseline.mjs": "a guard script, not a baseline",
    "scripts/check-unsafe-allowlist.sh": "a guard script, not an allowlist",
    "scripts/check-baseline-paths.py": (
        "this script — it DECLARES the population, it is not in it"
    ),
}

# --- The population: sets embedded in guard sources -----------------------
# (repo-relative guard file, constant name, base directory)
#
# Not discoverable, so declared — but each declaration is asserted below to
# still find its constant and still yield entries.
EMBEDDED_SOURCES: list[tuple[str, str, str]] = [
    # The files a guard must never police. A stale deny entry excludes
    # nothing, and #3255's did exactly that for two years.
    ("scripts/check-space-filter-drift.py", "DENY_FILES", "."),
    # The one module allowed to `DELETE FROM op_log`.
    ("scripts/check-op-log-delete.py", "ALLOWED_FILES", "."),
    # Files whose raw shadow utility is an intentional non-tier shadow.
    ("scripts/check-elevation-tiers.py", "ALLOWLIST", "."),
    # Sanctioned raw-transaction sites. Mixed exact paths and `**` globs;
    # the globs are skipped per-entry (see the module docstring).
    ("scripts/check-raw-tx.py", "ALLOWLIST_GLOBS", "."),
    # Sanctioned raw `invoke(` / `localStorage` seams.
    ("scripts/check-raw-invoke.mjs", "EXEMPT_FILES", "."),
    # Directory prefixes, not files — `exists()` covers both, and a prefix
    # that stopped naming a directory exempts nothing just as silently.
    ("scripts/check-raw-invoke.mjs", "EXEMPT_DIR_PREFIXES", "."),
    ("scripts/check-raw-local-storage.mjs", "EXEMPT_FILES", "."),
    # Components allowed to have no IPC error-path test.
    ("scripts/check-ipc-error-path.mjs", "NO_TEST_ALLOWLIST", "."),
]

# Embedded sets deliberately NOT in the population, with the reason. These
# name something other than a repo-relative path, so `Path.exists()` says
# nothing true about them.
#   check-git-fixture-isolation.mjs EXEMPT_BASENAMES  — bare basenames
#   check-store-layering.mjs PAGE_BLOCK_STORE_*       — basenames under src/stores/
#   check-raw-tx.py TEST_FILE_GLOBS / BIN_FILE_GLOBS  — structural patterns
#   check-dynamic-sql.py EXTRA_TEST_FILE_GLOBS        — structural patterns
#   check-table-ownership.py OWNER / EXTRA_TEST_...   — table names / patterns
# Two are path-keyed exemption sets and are still excluded, for reasons that
# are about this script rather than about them — recorded so a later sweep can
# tell "looked at and ruled out" from "never enumerated":
#   check-dead-symbol-citations.mjs ALLOWED_FILE_BY_SYMBOL — `{symbol: path}`,
#     the path on the RIGHT. `_strings_in_literal` returns a mapping's KEYS, so
#     declaring it would feed symbol names to `Path.exists()` and fail on every
#     one. Covering it means a values-side extractor, not a declaration.
#   check-tauri-command-sanitize.mjs ALLOWLIST — deliberately `new Set([])`,
#     and its docblock says it MUST stay empty. The "yielded no entries" arm
#     would fail permanently on the one state that set is allowed to be in.
# Scan ROOTS (`CRATE_ROOTS`, `SCAN_ROOTS`) are also out of scope here: they are
# each guard's own assertion 3, which the guards themselves now make (#4508,
# #4540, and this change for raw-tx / dynamic-sql / op-log-delete), because
# only the guard knows whether a tree is deliberately synthetic.


BANNERS = {
    "dangling": (
        "Baseline/allowlist path guard (#4501) — an entry names a path that "
        "does not exist:\n"
    ),
    "unknown": (
        "Baseline/allowlist path guard (#4501) — a baseline/allowlist file is "
        "outside this check's\ndeclared population:\n"
    ),
    "unread": (
        "Baseline/allowlist path guard (#4501) — a declared set was NOT READ, "
        "so nothing in it was\nchecked:\n"
    ),
    "discovery": (
        "Baseline/allowlist path guard (#4501) — the repository could not be "
        "ENUMERATED, so the\npopulation is unknown:\n"
    ),
    "vanished": (
        "Baseline/allowlist path guard (#4501) — a DECLARED source is gone "
        "from the checkout:\n"
    ),
}

HINTS = {
    "dangling": (
        "\n    -> A dangling entry protects nothing: the guard that owns it\n"
        "       walks discovered files and asks 'is this one allowed?', never\n"
        "       'does this entry still name a file?'. Repoint the entry at\n"
        "       where the file moved, or delete it if the subject is gone —\n"
        "       and check whether the OWNING guard's scan roots followed the\n"
        "       move too, which is the half this check cannot see.\n"
    ),
    "unknown": (
        "\n    -> Not a dangling entry. Discovery fails CLOSED on purpose: a\n"
        "       baseline this script has never been taught to read would\n"
        "       otherwise be silently exempt from the one check that exists to\n"
        "       stop baselines going stale. Add it to DATA_SOURCES, or to\n"
        "       NO_PATHS with the reason its entries are not paths.\n"
    ),
    "unread": (
        "\n    -> Not a dangling entry, and NOT a pass: a set that yields no\n"
        "       entries contributes zero findings for the same reason an empty\n"
        "       one does, which is how a guard reports success over a subject\n"
        "       it stopped reading (#4501's whole subject). Fix the extractor\n"
        "       or the declaration; do not delete the source to quiet it.\n"
    ),
    "vanished": (
        "\n    -> The inverse of `unknown`: this file IS declared and has gone\n"
        "       MISSING, so the declaration now protects nothing. Either the\n"
        "       source moved — repoint the DATA_SOURCES / NO_PATHS key — or it\n"
        "       was deleted, in which case remove the declaration. Leaving it\n"
        "       is a stale entry in a hand-maintained set, which is precisely\n"
        "       what this guard exists to catch.\n"
    ),
    "discovery": (
        "\n    -> Not a dangling entry, and NOT a pass. Discovery asks git for\n"
        "       the tracked file list; if that fails, the 'is anything new\n"
        "       unaccounted for?' half of this check silently becomes a\n"
        "       negative claim over an empty set — which is the exact shape\n"
        "       #4501 exists to end. Run this from inside a git checkout.\n"
    ),
}


def _strings_in_literal(text: str, const: str, comment: str) -> list[str] | None:
    """Quoted strings inside `const`'s collection literal, or None if absent.

    Bracket-depth scan from the constant's assignment to the matching close.
    Deliberately not a language parser: these are well-formed Python/JS
    collection literals, and "found nothing" is failed loudly by the caller
    rather than absorbed.

    A string whose next non-space character is `:` is a MAPPING KEY. If the
    literal has any, only the keys are returned — a `{path: reason}` allowlist
    states paths on the left and prose on the right, and feeding the prose to
    `Path.exists()` produces a name-too-long OSError, not a finding. `comment`
    is the language's line-comment marker; a commented-out example entry
    (`// 'src/components/<sub>/Foo.tsx': ...`, which the ipc-error-path
    allowlist carries as documentation) is not a declaration.
    """
    hit = -1
    for lead in (f"\n{const} ", f"\n{const}:", f"\nconst {const} ", f"\nexport const {const} "):
        hit = text.find(lead)
        if hit != -1:
            break
    if hit == -1:
        return None
    i = text.find("=", hit)
    if i == -1:
        return None
    opens, closes = "([{", ")]}"
    depth, started, quote = 0, False, ""
    buf: list[str] = []
    pairs: list[tuple[str, bool]] = []
    pending: str | None = None
    while i < len(text):
        ch = text[i]
        if quote:
            if ch == "\\":
                i += 2
                continue
            if ch == quote:
                pending, buf, quote = "".join(buf), [], ""
            else:
                buf.append(ch)
        elif pending is not None and not ch.isspace():
            pairs.append((pending, ch == ":"))
            pending = None
            continue  # re-dispatch this char below on the next pass
        elif text.startswith(comment, i):
            nl = text.find("\n", i)
            if nl == -1:
                break
            i = nl
        elif ch in "'\"":
            quote, buf = ch, []
        elif ch in opens:
            depth += 1
            started = True
        elif ch in closes:
            depth -= 1
            if started and depth <= 0:
                break
        i += 1
    if pending is not None:
        pairs.append((pending, False))
    if not started:
        return None
    if any(is_key for _s, is_key in pairs):
        return [s for s, is_key in pairs if is_key]
    return [s for s, _ in pairs]


def _tracked_files() -> list[str] | None:
    """Every file git tracks under `REPO_ROOT`, or None if git could not say.

    None, not `[]`: "git is not available here" and "this repository tracks no
    files" must not collapse into the same silent zero, because the second is
    indistinguishable from a pass. The caller turns either into a finding.
    """
    try:
        proc = subprocess.run(
            ["git", "-C", str(REPO_ROOT), "ls-files", "-z"],
            capture_output=True,
            check=False,
        )
    except OSError:
        return None
    if proc.returncode != 0:
        return None
    out = proc.stdout.decode("utf-8", "surrogateescape")
    files = [p for p in out.split("\0") if p]
    return files or None


def _entries(kind: str, path: Path) -> list[str]:
    """Every path-shaped entry a data source declares."""
    if kind.startswith("json:"):
        data = json.loads(path.read_text(encoding="utf-8"))
        field = kind.split(":", 1)[1]
        if field == "list":
            return list(data)
        if field == "keys":
            return list(data)
        if field.endswith("::"):
            return [str(o[field[:-2]]).split("::")[0] for o in data]
        return [str(o[field]) for o in data]
    lines = [
        ln.strip()
        for ln in path.read_text(encoding="utf-8").splitlines()
        if ln.strip() and not ln.lstrip().startswith("#")
    ]
    if kind == "text:count-path":
        return [ln.split(None, 1)[1].strip() for ln in lines if len(ln.split(None, 1)) == 2]
    return lines


def main(argv: list[str]) -> int:
    verbose = "-v" in argv or "--verbose" in argv
    unknown = [a for a in argv if a not in ("-v", "--verbose")]
    if unknown:
        print(f"check-baseline-paths: unknown argument(s): {unknown}", file=sys.stderr)
        return 2

    # (kind, message). Kind picks the banner and the hint: a run that is red
    # because a set went UNREAD is not a run with a dangling entry, and
    # saying so sends the reader hunting for a moved file that does not
    # exist. (#4508 had to split this out five separate times.)
    findings: list[tuple[str, str]] = []
    checked = globs = 0
    per_source: list[tuple[str, int, int]] = []

    # --- discovery, failing CLOSED on anything unrecognised --------------
    tracked = _tracked_files()
    if tracked is None:
        findings.append((
            "discovery",
            "`git ls-files` did not return a tracked file list, so no "
            "baseline could be DISCOVERED. The declared sources below were "
            "still checked, but a baseline added outside them would have gone "
            "unnoticed — which is the failure this check exists to prevent.",
        ))
        tracked = []
    found: list[str] = []
    for rel in tracked:
        if any(rel.startswith(d) for d in PRUNE_DIRS):
            continue
        low = rel.rsplit("/", 1)[-1].lower()
        if "baseline" in low or "allowlist" in low or "allow-list" in low:
            found.append(rel)
    stray = [r for r in found if r not in DATA_SOURCES and r not in NO_PATHS]
    if stray:
        for rel in stray:
            findings.append((
                "unknown",
                f"{rel}: a tracked file whose BASENAME matches "
                f"baseline/allowlist/allow-list, which this script has never "
                f"been taught to read. Three answers, and the third is the "
                f"common one for ordinary source: (1) it IS guard data with "
                f"paths -> DATA_SOURCES, with the base directory its entries "
                f"are relative to; (2) it IS guard data naming no paths -> "
                f"NO_PATHS, with the reason; (3) it is NOT guard data at all "
                f"(app source, a test fixture) -> NO_PATHS is still the right "
                f"home, and the reason should say so plainly, e.g. "
                f"'application source, not a guard baseline'. Discovery is "
                f"basename-based on purpose, so it will keep finding it.",
            ))
    # BOTH declaration tables get the existence check, not just DATA_SOURCES.
    # A NO_PATHS entry whose file was deleted or renamed is a declaration that
    # nothing notices any more — a stale path in a hand-maintained set, which
    # is the exact class this guard exists to catch. Leaving one table
    # unchecked would make this script an instance of its own subject.
    for rel in [r for r in DATA_SOURCES if not (REPO_ROOT / r).is_file()]:
        findings.append(("vanished", f"{rel}: declared in DATA_SOURCES but not in this checkout"))
    for rel in [r for r in NO_PATHS if not (REPO_ROOT / r).is_file()]:
        findings.append(("vanished", f"{rel}: declared in NO_PATHS but not in this checkout"))

    # --- data files -------------------------------------------------------
    for rel, (kind, base) in sorted(DATA_SOURCES.items()):
        src = REPO_ROOT / rel
        if not src.is_file():
            continue
        try:
            entries = _entries(kind, src)
        except (ValueError, KeyError, OSError) as err:
            findings.append(("unread", f"{rel}: could not be read as `{kind}` ({err!r})"))
            continue
        if not entries:
            findings.append((
                "unread",
                f"{rel}: yielded ZERO entries. Either the file was emptied, or "
                f"its format changed under the `{kind}` extractor — which would "
                f"make this script report success over a set it stopped reading.",
            ))
            continue
        n_bad = _check_entries(rel, entries, base, findings)
        checked += len(entries) - n_bad[1]
        globs += n_bad[1]
        per_source.append((rel, len(entries) - n_bad[1], n_bad[1]))

    # --- sets embedded in guard sources ----------------------------------
    for rel, const, base in EMBEDDED_SOURCES:
        src = REPO_ROOT / rel
        if not src.is_file():
            findings.append(("unread", f"{rel}: declared as carrying `{const}` but not in this checkout"))
            continue
        comment = "#" if src.suffix == ".py" else "//"
        entries = _strings_in_literal("\n" + src.read_text(encoding="utf-8"), const, comment)
        if not entries:
            findings.append((
                "unread",
                f"{rel}: `{const}` yielded no entries — renamed, restructured or "
                f"emptied. Until this is corrected the set is UNCHECKED, which is "
                f"the failure mode #4501 is about.",
            ))
            continue
        n_bad = _check_entries(f"{rel}:{const}", entries, base, findings)
        # Subtract BOTH the dangling entries and the skipped globs. Counting a
        # dangling entry as one that "resolved" makes the denominator line
        # disagree with the sentence it prints, and that line is this script's
        # own honesty mechanism. Unreachable while the line prints only when
        # `findings` is empty — but a number that is right by luck is exactly
        # the shape #4501 is about.
        resolved = len(entries) - n_bad[0] - n_bad[1]
        checked += resolved
        globs += n_bad[1]
        per_source.append((f"{rel}:{const}", resolved, n_bad[1]))

    if verbose:
        for label, n, g in per_source:
            print(f"  {n:4d} path(s){f' (+{g} glob)' if g else '':>12}  {label}")

    if findings:
        # Composed, not chosen by priority: a run can be red for two of these
        # at once, and collapsing them under one banner is what makes a reader
        # hunt for a moved file when the actual fault is a set going unread.
        for kind in ("dangling", "unknown", "vanished", "unread", "discovery"):
            hits = [m for k, m in findings if k == kind]
            if not hits:
                continue
            print(BANNERS[kind], file=sys.stderr)
            for m in hits:
                print(f"  {m}", file=sys.stderr)
            print(HINTS[kind], file=sys.stderr)
        return 1

    if checked == 0:
        print(
            "check-baseline-paths: checked ZERO paths. A negative claim over an "
            "empty set is not a pass.",
            file=sys.stderr,
        )
        return 1
    print(
        f"check-baseline-paths: {checked} path(s) resolve, across "
        f"{len(per_source)} baseline/allowlist set(s)"
        f"{f'; {globs} glob entr(ies) skipped' if globs else ''}."
    )
    return 0


def _check_entries(
    label: str, entries: list[str], base: str, findings: list[tuple[str, str]]
) -> tuple[int, int]:
    """Append a finding per dangling entry. Returns (n_dangling, n_globs)."""
    root = REPO_ROOT if base == "." else REPO_ROOT / base
    dangling = n_globs = 0
    for entry in entries:
        if "*" in entry or "?" in entry:
            n_globs += 1
            continue
        if not (root / entry).exists():
            dangling += 1
            findings.append(("dangling", f"{label}: `{entry}` names a path that does not exist"))
    return dangling, n_globs


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
