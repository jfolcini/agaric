#!/usr/bin/env python3
"""Enforce the migration → JS-mock schema-contract rule (#3084).

The browser/e2e Tauri mock (`src/lib/tauri-mock/`) is a hand-maintained
SECOND implementation of the SQLite schema + command behaviour. When a
migration changes a table the mock models — a promoted native column, a
renamed/dropped table, a rebuilt table — the mock **silently keeps
modeling the old schema** and drifts from the backend. That is exactly
the tag-space bug: after migrations 0087/0088 moved space membership from
a `block_properties(key='space')` row to the native `blocks.space_id`
column, the mock kept reading the retired property row, the tag vanished
in production, and the whole e2e suite stayed green. Nothing flagged it.

This guard converts the migrations/AGENTS.md "update the mock in the same
PR" RULE into an enforced contract, in the same class as its sibling
guards (check-dynamic-sql, check-table-ownership, migrations-immutable).

CONTRACT map (below)
--------------------
An explicit, hand-curated map: backend TABLE → the mock's in-memory store
symbol that models it + the production mock file(s) that own that store.
Grep-based auto-discovery of column strings is too noisy; the explicit
map is the low-false-positive source of truth for "what the mock models".
A `--self-test` asserts every mapped file exists, actually mentions its
store symbol, and that every mapped table is a real backend table — so
the map cannot rot silently as the mock or schema evolves.

Trigger semantics (DIFF-scoped, unlike the aggregate ratchets)
--------------------------------------------------------------
prek invokes the hook with the set of changed files (`files` matches BOTH
`^src-tauri/migrations/.*\\.sql$` and `^src/lib/tauri-mock/.*`), so a
single invocation sees a migration AND any mock file changed alongside
it. For every changed migration that is NOT grandfathered in the baseline
(see below), the guard parses the affected table names
(CREATE/ALTER/DROP TABLE, CREATE TRIGGER … ON <t>, and the `_new_<t>` /
`<t>_new` rebuild forms), intersects them with the CONTRACT map, and for
each hit requires an ACKNOWLEDGEMENT — EITHER:

  (a) a mock file that models that table is ALSO among the changed
      filenames (the mock was updated in the same change), OR
  (b) the migration file carries a literal `-- mock-unaffected: <reason>`
      annotation line (the author asserts the mock does not model the
      touched aspect — e.g. an index-only or cache-only change).

Otherwise the guard fails, naming the table and both escape hatches.

The baseline & two invocation modes (`src-tauri/migrations-mock-ack-baseline.txt`)
---------------------------------------------------------------------------------
CI runs `prek run --all-files`, which passes EVERY file — so every
migration ever written looks "changed". Without a floor, the guard would
demand acknowledgements for ancient migrations. The baseline is the fix:
a checked-in list of already-grandfathered migration basenames. Anything
in the baseline is exempt; only NEW migration files (not yet baselined)
must be acknowledged. Because the checked-in tree has every migration
baselined, `--all-files`, pre-commit, and pre-push all exit 0 on a clean
tree, with ZERO git dependence.

Acknowledgement differs by mode, because `--all-files` also passes EVERY
mock file — which would make acknowledgement (a) "a modeling mock file
changed alongside" trivially true and the CI back-stop vacuous:

  * DIFF-SCOPED (pre-commit / pre-push, a real changed-set): a NEW
    migration touching a modeled table is acknowledged by (a) a modeling
    mock file in the same change, OR (b) a `-- mock-unaffected:` line.
  * AGGREGATE (CI `--all-files`, detected via >=2 baselined migrations in
    one invocation — impossible in a real diff since migrations are
    immutable): the mock-file signal is discarded; only (b) the annotation
    or baseline membership (an explicit `--update-baseline`) exempts. This
    is the back-stop that catches a migration committed with `--no-verify`
    (it skipped the diff-scoped pre-commit run but CI still runs all-files).

After satisfying the guard, grandfather the new migration so future runs
stay quiet:

    python3 scripts/check-migration-mock-contract.py --update-baseline

Stdlib only — no third-party deps.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
MIGRATIONS_DIR = REPO_ROOT / "src-tauri" / "migrations"
BASELINE_PATH = REPO_ROOT / "src-tauri" / "migrations-mock-ack-baseline.txt"
MOCK_PREFIX = "src/lib/tauri-mock/"

# ---------------------------------------------------------------------------
# CONTRACT map — backend table → how the mock models it.
#
# `store`: the mock's in-memory Map/array symbol that stands in for the table.
# `files`: the production mock files that DEFINE or OWN that store (the files a
#          mock author edits when the table's schema changes). The `__tests__`
#          tree is deliberately excluded — it exercises the mock, it does not
#          model the schema.
#
# Seeded by reading src/lib/tauri-mock/seed.ts (the in-memory store
# definitions) and the per-table handlers. The self-test pins every entry
# (file exists + mentions its store symbol + table is a real backend table),
# so this map cannot drift out of sync with the mock unnoticed.
# ---------------------------------------------------------------------------
CONTRACT: dict[str, dict[str, object]] = {
    "blocks": {
        "store": "blocks",
        "files": ["seed.ts", "handlers/blocks.ts"],
    },
    "block_properties": {
        "store": "properties",
        "files": ["seed.ts", "handlers/properties.ts"],
    },
    "block_tags": {
        "store": "blockTags",
        "files": ["seed.ts", "handlers/tags.ts"],
    },
    "block_tag_refs": {
        "store": "blockTagRefs",
        "files": ["seed.ts", "handlers/shared.ts"],
    },
    "property_definitions": {
        "store": "propertyDefs",
        "files": ["seed.ts", "handlers/properties.ts"],
    },
    "page_aliases": {
        "store": "pageAliases",
        "files": ["seed.ts", "handlers/pages.ts"],
    },
    "attachments": {
        "store": "attachments",
        "files": ["seed.ts", "handlers/attachments.ts"],
    },
    "attachment_blobs": {
        "store": "attachmentBytes",
        "files": ["seed.ts", "handlers/attachments.ts"],
    },
    "op_log": {
        "store": "opLog",
        "files": ["seed.ts"],
    },
}


def _contract_files(table: str) -> list[str]:
    """CONTRACT[table].files as repo-root-relative posix paths."""
    files = CONTRACT[table]["files"]
    assert isinstance(files, list)
    return [MOCK_PREFIX + f for f in files]


# ---------------------------------------------------------------------------
# Migration SQL parsing
# ---------------------------------------------------------------------------

_BLOCK_COMMENT_RE = re.compile(r"/\*.*?\*/", re.DOTALL)
_LINE_COMMENT_RE = re.compile(r"--[^\n]*")

# `-- mock-unaffected: <reason>` — the (b) escape hatch. A non-empty reason is
# required so the annotation documents WHY the mock is untouched.
_MOCK_UNAFFECTED_RE = re.compile(
    r"--\s*mock-unaffected:\s*(\S.*)", re.IGNORECASE
)

_CREATE_TABLE_RE = re.compile(
    r'\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?', re.IGNORECASE
)
_ALTER_TABLE_RE = re.compile(r'\bALTER\s+TABLE\s+"?(\w+)"?', re.IGNORECASE)
_DROP_TABLE_RE = re.compile(
    r'\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?"?(\w+)"?', re.IGNORECASE
)
# CREATE TRIGGER … ON <table>: the `ON <table>` clause is the first `ON` after
# the CREATE TRIGGER keyword (SQLite has no earlier `ON` in trigger syntax —
# `INSTEAD OF` / `UPDATE OF` use `OF`, not `ON`). Lazy body match stops there.
_CREATE_TRIGGER_RE = re.compile(
    r'\bCREATE\s+TRIGGER\b[\s\S]*?\bON\s+"?(\w+)"?', re.IGNORECASE
)


def _normalize_table(name: str) -> set[str]:
    """A raw DDL identifier → the set of contract table names it implies.

    Table-rebuild scratch names map back to their real table so a rebuild of
    `blocks` (via `_new_blocks` / legacy `blocks_new`) is still recognized as
    touching `blocks`. Both the raw name and any normalized base are returned;
    intersection with CONTRACT discards scratch names that are not real tables.
    """
    out = {name}
    m = re.fullmatch(r"_new_(\w+)", name)
    if m:
        out.add(m.group(1))
    m = re.fullmatch(r"(\w+)_new", name)
    if m:
        out.add(m.group(1))
    return out


def strip_sql_comments(sql: str) -> str:
    sql = _BLOCK_COMMENT_RE.sub(" ", sql)
    sql = _LINE_COMMENT_RE.sub(" ", sql)
    return sql


def parse_touched_tables(sql_text: str) -> set[str]:
    """Return the set of table names a migration's DDL touches.

    Only schema-contract statements are considered (CREATE/ALTER/DROP TABLE,
    CREATE TRIGGER … ON). CREATE INDEX is intentionally excluded — an index is
    not a contract the JS mock models. Comments are stripped first so a table
    name inside prose or an annotation never fires.
    """
    body = strip_sql_comments(sql_text)
    tables: set[str] = set()
    for rx in (
        _CREATE_TABLE_RE,
        _ALTER_TABLE_RE,
        _DROP_TABLE_RE,
        _CREATE_TRIGGER_RE,
    ):
        for m in rx.finditer(body):
            tables |= _normalize_table(m.group(1))
    return tables


def has_mock_unaffected(sql_text: str) -> bool:
    """True iff the migration carries a `-- mock-unaffected: <reason>` line."""
    return _MOCK_UNAFFECTED_RE.search(sql_text) is not None


# ---------------------------------------------------------------------------
# Core evaluation (pure — over parsed inputs, so it is directly self-testable)
# ---------------------------------------------------------------------------


def is_aggregate_mode(migrations: list[tuple[str, str]], baseline: set[str]) -> bool:
    """True when the invocation is CI's `prek run --all-files`, not a real diff.

    In all-files mode prek passes the ENTIRE corpus — every migration AND every
    mock file. That makes acknowledgement (a) "a modeling mock file changed
    alongside" trivially (and meaninglessly) true, so a `--no-verify`'d NEW
    migration would sail through the CI back-stop. We detect the mode instead:
    migrations are immutable (the migrations-immutable guard), so a genuine
    commit/push adds at most one NEW (non-baselined) migration and touches ZERO
    already-baselined ones. Seeing >=2 baselined migrations in one invocation
    therefore means the whole corpus was passed — aggregate mode. In that mode
    the mock-file-presence signal is discarded (see `evaluate`).
    """
    return sum(1 for bn, _ in migrations if bn in baseline) >= 2


def evaluate(
    migrations: list[tuple[str, str]],
    changed_mock: set[str],
    baseline: set[str],
) -> list[tuple[str, str]]:
    """Return the list of (migration_basename, unacknowledged_table) violations.

    `migrations`  : (basename, sql_text) for each changed migration.
    `changed_mock`: repo-root-relative posix paths of changed mock files.
    `baseline`    : grandfathered migration basenames (exempt).

    Two modes (see `is_aggregate_mode`):
    * diff-scoped (commit/push): ack = a modeling mock file changed alongside
      the migration, OR a `-- mock-unaffected:` annotation.
    * aggregate (CI `--all-files`): every mock file is present regardless, so
      mock-file presence is NOT a valid ack — only the `-- mock-unaffected:`
      annotation or baseline membership (an explicit `--update-baseline` act)
      exempts a migration. This is the real back-stop for a `--no-verify`'d
      migration that skipped the diff-scoped pre-commit run.
    """
    violations: list[tuple[str, str]] = []
    aggregate = is_aggregate_mode(migrations, baseline)
    for basename, sql_text in migrations:
        if basename in baseline:
            continue  # grandfathered
        touched = parse_touched_tables(sql_text) & CONTRACT.keys()
        if not touched:
            continue  # touches nothing the mock models
        if has_mock_unaffected(sql_text):
            continue  # escape hatch (b): author asserts mock unaffected
        for table in sorted(touched):
            # In aggregate mode the mock-file-changed signal is worthless (all
            # mock files are always passed), so it never acknowledges.
            acked = not aggregate and any(
                f in changed_mock for f in _contract_files(table)
            )
            if not acked:
                violations.append((basename, table))
    return violations


# ---------------------------------------------------------------------------
# Baseline I/O
# ---------------------------------------------------------------------------


def all_migration_basenames() -> list[str]:
    return sorted(p.name for p in MIGRATIONS_DIR.glob("*.sql"))


def read_baseline() -> set[str]:
    if not BASELINE_PATH.exists():
        return set()
    out: set[str] = set()
    for raw in BASELINE_PATH.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        out.add(line)
    return out


def write_baseline(basenames: list[str]) -> None:
    lines = [
        "# Migration → mock schema-contract acknowledgement baseline (#3084).",
        "# Grandfathered migration filenames — exempt from the "
        "check-migration-mock-contract guard.",
        "# A NEW migration (not listed here) that touches a mock-modeled table "
        "must EITHER update a",
        "# mock file that models the table in the same change, OR carry a "
        "`-- mock-unaffected: <reason>`",
        "# annotation line. Regenerate after landing such a migration with:",
        "#   python3 scripts/check-migration-mock-contract.py --update-baseline",
        "",
    ]
    lines.extend(sorted(basenames))
    BASELINE_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")


# ---------------------------------------------------------------------------
# Self-test
# ---------------------------------------------------------------------------


def _backend_tables() -> set[str]:
    """Every table CREATE'd across all shipped migrations (base names)."""
    tables: set[str] = set()
    for p in MIGRATIONS_DIR.glob("*.sql"):
        body = strip_sql_comments(p.read_text(encoding="utf-8"))
        for m in _CREATE_TABLE_RE.finditer(body):
            tables |= _normalize_table(m.group(1))
    return tables


def run_self_test() -> int:
    failures: list[str] = []

    # --- CONTRACT map integrity (anti-rot) ---------------------------------
    backend = _backend_tables()
    for table, spec in CONTRACT.items():
        if table not in backend:
            failures.append(
                f"CONTRACT table {table!r} is not CREATE'd by any migration "
                f"(schema drift or typo)."
            )
        store = spec["store"]
        assert isinstance(store, str)
        for rel in _contract_files(table):
            path = REPO_ROOT / rel
            if not path.is_file():
                failures.append(f"CONTRACT file {rel!r} for {table!r} is missing.")
                continue
            text = path.read_text(encoding="utf-8")
            if not re.search(rf"\b{re.escape(store)}\b", text):
                failures.append(
                    f"CONTRACT file {rel!r} no longer mentions store "
                    f"symbol {store!r} that models {table!r}."
                )

    # --- Behavioural fixtures ----------------------------------------------
    # A brand-new migration touching a modeled table (blocks). basename is NOT
    # in the baseline the fixtures pass in.
    new_mig = ("9999_touch_blocks.sql", "ALTER TABLE blocks ADD COLUMN zzz TEXT;")
    blocks_mock = MOCK_PREFIX + "handlers/blocks.ts"

    cases: list[tuple[str, list[tuple[str, str]], set[str], set[str], bool]] = [
        # (label, migrations, changed_mock, baseline, expect_pass)
        # 1. new migration, no mock change, no annotation -> FAIL
        ("new+no-mock+no-annotation", [new_mig], set(), set(), False),
        # 2. same migration WITH annotation -> PASS
        (
            "new+annotation",
            [
                (
                    "9999_touch_blocks.sql",
                    "-- mock-unaffected: index-only tweak\n"
                    "ALTER TABLE blocks ADD COLUMN zzz TEXT;",
                )
            ],
            set(),
            set(),
            True,
        ),
        # 3. new migration WITH a modeling mock file among changed files -> PASS
        ("new+mock-changed", [new_mig], {blocks_mock}, set(), True),
        # 4. same migration but grandfathered in baseline -> PASS
        (
            "baselined",
            [new_mig],
            set(),
            {"9999_touch_blocks.sql"},
            True,
        ),
        # 5. new migration touching an UNMODELED table -> PASS
        (
            "unmodeled-table",
            [("9999_cache.sql", "CREATE TABLE pages_cache (id TEXT) STRICT;")],
            set(),
            set(),
            True,
        ),
        # 6. mock file changed but it models a DIFFERENT table than the one the
        #    migration touches (blocks touched, only pages mock changed) -> FAIL
        (
            "new+wrong-mock-changed",
            [new_mig],
            {MOCK_PREFIX + "handlers/pages.ts"},
            set(),
            False,
        ),
        # 7. table-rebuild form `_new_blocks` is recognized as touching blocks.
        (
            "rebuild-new-prefix",
            [("9999_rebuild.sql", "CREATE TABLE _new_blocks (id TEXT) STRICT;")],
            set(),
            set(),
            False,
        ),
        # 8. AGGREGATE / CI --all-files: the whole corpus is passed (>=2
        #    baselined migrations) together with EVERY mock file. The
        #    mock-file-changed signal must be discarded, so a NEW migration
        #    touching a modeled table with no annotation still -> FAIL. This is
        #    the back-stop a `--no-verify`'d migration hits in CI.
        (
            "aggregate+all-mock+no-annotation",
            [
                ("0001_a.sql", "CREATE TABLE blocks (id TEXT) STRICT;"),
                ("0002_b.sql", "ALTER TABLE block_tags ADD COLUMN q TEXT;"),
                new_mig,
            ],
            {blocks_mock, MOCK_PREFIX + "seed.ts", MOCK_PREFIX + "handlers/tags.ts"},
            {"0001_a.sql", "0002_b.sql"},
            False,
        ),
        # 9. Same aggregate invocation but the NEW migration carries the
        #    annotation -> PASS (the only valid all-files acknowledgement).
        (
            "aggregate+all-mock+annotation",
            [
                ("0001_a.sql", "CREATE TABLE blocks (id TEXT) STRICT;"),
                ("0002_b.sql", "ALTER TABLE block_tags ADD COLUMN q TEXT;"),
                (
                    "9999_touch_blocks.sql",
                    "-- mock-unaffected: derived-cache-only\n"
                    "ALTER TABLE blocks ADD COLUMN zzz TEXT;",
                ),
            ],
            {blocks_mock, MOCK_PREFIX + "seed.ts"},
            {"0001_a.sql", "0002_b.sql"},
            True,
        ),
        # 10. Boundary: diff-scoped semantics are unchanged when a single
        #     baselined migration is also present (1 < 2, so NOT aggregate) —
        #     the mock-file-changed ack still counts -> PASS.
        (
            "diff-scoped+one-baselined+mock-changed",
            [("0001_a.sql", "CREATE TABLE blocks (id TEXT) STRICT;"), new_mig],
            {blocks_mock},
            {"0001_a.sql"},
            True,
        ),
    ]

    for label, migs, mock, base, expect_pass in cases:
        got_pass = not evaluate(migs, mock, base)
        if got_pass != expect_pass:
            failures.append(
                f"fixture {label!r}: expected "
                f"{'PASS' if expect_pass else 'FAIL'}, got "
                f"{'PASS' if got_pass else 'FAIL'}."
            )

    # --- Parser unit assertions --------------------------------------------
    if "blocks" not in parse_touched_tables("DROP TABLE blocks;"):
        failures.append("parser: DROP TABLE blocks not detected.")
    if parse_touched_tables("CREATE INDEX idx ON blocks (space_id);"):
        failures.append("parser: CREATE INDEX must NOT register a touched table.")
    if "blocks" not in parse_touched_tables(
        "CREATE TRIGGER t AFTER UPDATE OF x ON blocks BEGIN SELECT 1; END;"
    ):
        failures.append("parser: CREATE TRIGGER … ON blocks not detected.")
    if parse_touched_tables("-- ALTER TABLE blocks in a comment\nSELECT 1;"):
        failures.append("parser: table name inside a comment must not fire.")

    if failures:
        print("check-migration-mock-contract self-test FAILED:", file=sys.stderr)
        for f in failures:
            print(f"  {f}", file=sys.stderr)
        return 1
    print(
        f"check-migration-mock-contract self-test passed "
        f"({len(cases)} fixtures + CONTRACT integrity + parser cases)."
    )
    return 0


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

HINT = (
    "    -> #3084: this NEW migration changes a table the browser/e2e Tauri\n"
    "       mock (src/lib/tauri-mock/) models as a second implementation of\n"
    "       the schema. If the mock is not updated in lockstep it silently\n"
    "       keeps modeling the OLD schema (the tag-space bug: a retired\n"
    "       block_properties(key='space') row kept alive after space moved to\n"
    "       the native blocks.space_id column). Resolve by EITHER:\n"
    "         (a) update the mock file(s) that model the table in this change\n"
    "             (they are then acknowledged automatically), OR\n"
    "         (b) add a `-- mock-unaffected: <reason>` line to the migration\n"
    "             if the change genuinely does not affect anything the mock\n"
    "             models (e.g. an index-only or derived-cache-only change).\n"
    "       Then grandfather the migration so future runs stay quiet:\n"
    "         python3 scripts/check-migration-mock-contract.py "
    "--update-baseline"
)

# Aggregate (CI `--all-files`) mode: prek passes EVERY mock file, so "a mock
# file changed" is meaningless here — it is not accepted as an acknowledgement.
# This branch is the back-stop for a migration that skipped the diff-scoped
# pre-commit run (e.g. `git commit --no-verify`).
HINT_AGGREGATE = (
    "    -> #3084 (CI --all-files back-stop): this NEW migration changes a\n"
    "       table the browser/e2e Tauri mock (src/lib/tauri-mock/) models and\n"
    "       is not yet grandfathered. In all-files mode the mock-file-changed\n"
    "       signal does NOT count (every mock file is always passed), so\n"
    "       resolve by EITHER:\n"
    "         (a) add a `-- mock-unaffected: <reason>` line to the migration\n"
    "             if it genuinely does not affect anything the mock models, OR\n"
    "         (b) update the mock in the same PR, then grandfather the\n"
    "             migration (an explicit, reviewable act):\n"
    "               python3 scripts/check-migration-mock-contract.py "
    "--update-baseline"
)


def _rel(arg: str) -> str | None:
    """Resolve an argv path to a repo-root-relative posix path, or None."""
    try:
        return (Path(arg).resolve().relative_to(REPO_ROOT)).as_posix()
    except ValueError:
        return None


def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        return run_self_test()
    if "--update-baseline" in argv:
        write_baseline(all_migration_basenames())
        print(f"Wrote {BASELINE_PATH.relative_to(REPO_ROOT)}")
        return 0

    baseline = read_baseline()

    migrations: list[tuple[str, str]] = []
    changed_mock: set[str] = set()
    for arg in argv:
        rel = _rel(arg)
        if rel is None:
            continue
        if rel.startswith("src-tauri/migrations/") and rel.endswith(".sql"):
            p = REPO_ROOT / rel
            if p.is_file():
                migrations.append((p.name, p.read_text(encoding="utf-8")))
        elif rel.startswith(MOCK_PREFIX) and "/__tests__/" not in rel:
            changed_mock.add(rel)

    violations = evaluate(migrations, changed_mock, baseline)
    if violations:
        aggregate = is_aggregate_mode(migrations, baseline)
        mode_label = "CI --all-files" if aggregate else "diff"
        print(
            f"Migration → mock schema-contract guard (#3084, {mode_label} mode) "
            "— new migration(s) touch a mock-modeled table without "
            "acknowledgement:\n",
            file=sys.stderr,
        )
        for basename, table in violations:
            files = ", ".join(_contract_files(table))
            print(
                f"  {basename}: touches `{table}` — modeled by the mock in "
                f"[{files}]",
                file=sys.stderr,
            )
        print("", file=sys.stderr)
        print(HINT_AGGREGATE if aggregate else HINT, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
