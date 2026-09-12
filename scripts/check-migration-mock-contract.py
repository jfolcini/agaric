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
(CREATE/ALTER/DROP TABLE — `VIRTUAL` included, since `fts_blocks` has no
other creation form — CREATE TRIGGER … ON <t>, the row-writing INSERT
INTO / UPDATE … SET / DELETE FROM, and the `_new_<t>` / `<t>_new` rebuild
forms), intersects them with the CONTRACT map, and for each hit requires
an ACKNOWLEDGEMENT — EITHER:

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
# `store`: the mock symbol that stands in for the table. For a table the mock
#          persists that is an in-memory Map/array in seed.ts; for one the mock
#          DERIVES on read (the backend's materialized caches) it is the
#          deriving function or the row field the derivation produces. Either
#          way it is the thing that goes stale when the table changes.
# `files`: the production mock files that DEFINE or OWN that store (the files a
#          mock author edits when the table's schema changes). The `__tests__`
#          tree is deliberately excluded — it exercises the mock, it does not
#          model the schema.
#
# Seeded by reading src/lib/tauri-mock/seed.ts (the in-memory store
# definitions) and the per-table handlers. The self-test pins every entry
# (file exists + mentions its store symbol + table is a real backend table),
# so this map cannot drift out of sync with the mock unnoticed. It also pins
# CONTRACT + UNMODELED against the FULL backend table list, so a migration that
# introduces a table lands in one bucket or the other — never in neither.
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
    "peer_refs": {
        "store": "peerRefs",
        "files": ["seed.ts", "handlers/sync.ts"],
    },
    # The tag-space bug's own table (#3081). The mock has no `spaces` registry
    # row; it derives one per block carrying `is_space` and mirrors membership
    # on the `space_id` block field, so both halves move when `spaces` does.
    "spaces": {
        "store": "space_id",
        "files": ["seed.ts", "handlers/pages.ts", "handlers/properties.ts"],
    },
    # --- Backend caches the mock re-derives on every read ------------------
    # These have no mock table, but the mock reproduces what the cache HOLDS.
    # A migration that changes what the backend materializes into one of them
    # changes what the mock must compute, which is the same contract.
    "tags_cache": {
        "store": "tagCacheRows",
        "files": ["handlers/tags.ts"],
    },
    "block_tag_inherited": {
        "store": "inheritedTagIds",
        "files": ["handlers/tags.ts"],
    },
    "block_links": {
        "store": "deriveLinkEdges",
        "files": ["link-scan.ts", "handlers/shared.ts"],
    },
    "page_link_cache": {
        # `pageLinkStats` is only NAMED in link-scan.ts (a comment); the symbol
        # that is CODE in both files is the edge derivation it consumes.
        "store": "deriveLinkEdges",
        "files": ["link-scan.ts", "handlers/shared.ts"],
    },
    "pages_cache": {
        # NOT `inbound_link_count`: that appears in both files only in prose,
        # so the anti-rot assertion could never fire on it.
        "store": "buildPageMetaRow",
        "files": ["handlers/pages.ts", "handlers/shared.ts"],
    },
    "fts_blocks": {
        "store": "stripForFts",
        "files": ["handlers/search.ts", "handlers/links.ts"],
    },
    "agenda_cache": {
        "store": "agendaRangeDate",
        "files": ["handlers/blocks.ts"],
    },
    "app_settings": {
        "store": "appSettings",
        "files": ["seed.ts", "handlers/properties.ts"],
    },
}

# ---------------------------------------------------------------------------
# UNMODELED — backend tables the mock deliberately does NOT read.
#
# The other half of the contract, and the reason the self-test can insist on
# completeness: a new backend table must be classified here or in CONTRACT, so
# "the guard covers 9 of 35 tables and nobody noticed" (#4667) cannot recur.
#
# Each reason is a claim a reader can check against the cited file. A table
# stops belonging here the moment the mock grows real state for it — the entry
# moves to CONTRACT, it is not amended.
# ---------------------------------------------------------------------------
UNMODELED: dict[str, str] = {
    "block_drafts": (
        "no drafts store; save_draft/flush_draft/delete_draft return null and "
        "list_drafts returns [] (handlers/system.ts)"
    ),
    "block_links_unresolved": (
        "no mock reference; the mock derives link edges live from block "
        "content (link-scan.ts) and keeps no unresolved-target bookkeeping"
    ),
    "compaction_watermark": (
        "op-log compaction is backend-only; get_compaction_status and "
        "compact_op_log_cmd are constant stubs (handlers/history.ts)"
    ),
    "log_snapshots": (
        "same constant compaction stubs; the mock never snapshots its op log"
    ),
    "_op_log_mutation_allowed": (
        "the op-log immutability triggers' bypass sentinel (migration 0036); "
        "the mock has no triggers to bypass and no command exposes it"
    ),
    "gcal_agenda_event_map": "no Google-Calendar command is implemented",
    "gcal_settings": "no Google-Calendar command is implemented",
    "gcal_space_config": "no Google-Calendar command is implemented",
    "link_metadata": (
        "fetch_link_metadata/get_link_metadata return a constant literal "
        "(handlers/links.ts); no stored row, so nothing can go stale"
    ),
    "loro_doc_state": (
        "no Loro counterpart: the mock's in-memory stores ARE its convergent "
        "state, it does not model CRDT storage"
    ),
    "loro_sync_inbox": "no Loro counterpart (see loro_doc_state)",
    "loro_sync_quarantine": "no Loro counterpart (see loro_doc_state)",
    "merge_parity_log": (
        "engine-internal merge-parity telemetry; no command exposes it"
    ),
    "materializer_apply_cursor": (
        "the mock applies every command synchronously; it has no materializer "
        "queue, so there is no cursor or retry state to model"
    ),
    "materializer_retry_queue": "no materializer queue (see "
    "materializer_apply_cursor)",
    "projected_agenda_cache": (
        "list_projected_agenda returns an empty page "
        "(handlers/properties.ts); the repeat-rule projection is not modeled"
    ),
    "projected_agenda_horizon": "no repeat-rule projection (see "
    "projected_agenda_cache)",
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

# `VIRTUAL` matters: `fts_blocks` is only ever created as
# `CREATE VIRTUAL TABLE … USING fts5(…)`, so a `CREATE\s+TABLE`-only pattern
# makes it invisible to BOTH the parser and `_backend_tables()`.
_CREATE_TABLE_RE = re.compile(
    r'\bCREATE\s+(?:TEMP(?:ORARY)?\s+|VIRTUAL\s+)?TABLE\s+'
    r'(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?',
    re.IGNORECASE,
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

# DML. A migration needs no DDL to break the mock: 0087 — the migration in the
# tag-space bug itself — is `DELETE FROM block_properties WHERE key = 'space'`
# plus a `DROP INDEX`, and a DDL-only parser reads it as touching NOTHING. Data
# moves (a retired property row, a seeded `property_definitions` builtin, a
# backfilled cache) are exactly the contract the mock re-implements, so they
# count as touching the table.
_INSERT_INTO_RE = re.compile(
    r'\b(?:INSERT\s+(?:OR\s+\w+\s+)?|REPLACE\s+)INTO\s+"?(\w+)"?', re.IGNORECASE
)
# `\s+SET\b` is load-bearing: it is what separates a real `UPDATE <t> SET …`
# from the `ON UPDATE CASCADE` and `AFTER UPDATE OF <col> ON <t>` clauses that
# a bare `UPDATE\s+(\w+)` would misread as table names.
_UPDATE_SET_RE = re.compile(
    r'\bUPDATE\s+(?:OR\s+\w+\s+)?"?(\w+)"?\s+SET\b', re.IGNORECASE
)
_DELETE_FROM_RE = re.compile(r'\bDELETE\s+FROM\s+"?(\w+)"?', re.IGNORECASE)


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
    """Return the set of table names a migration touches.

    Schema-contract statements (CREATE/ALTER/DROP TABLE, CREATE TRIGGER … ON)
    AND row-writing statements (INSERT INTO, UPDATE … SET, DELETE FROM): the
    mock re-implements the data contract as well as the schema, and migration
    0087 — the tag-space bug's own migration — carries no DDL at all.

    CREATE INDEX is intentionally excluded — an index is not a contract the JS
    mock models. A bare `SELECT … FROM <t>` is excluded for the same reason: a
    migration that only reads a table changes nothing the mock must mirror.
    Comments are stripped first so a table name inside prose or an annotation
    never fires.
    """
    body = strip_sql_comments(sql_text)
    tables: set[str] = set()
    for rx in (
        _CREATE_TABLE_RE,
        _ALTER_TABLE_RE,
        _DROP_TABLE_RE,
        _CREATE_TRIGGER_RE,
        _INSERT_INTO_RE,
        _UPDATE_SET_RE,
        _DELETE_FROM_RE,
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


_SCRATCH_PREFIXES = ("_new_", "_keep_", "_preserve_")

# Migration scratch that does not follow the prefix convention. 0089 creates
# `_spaces_backfill` and drops it in the same migration; `db/tests.rs` asserts
# `sqlite_master` holds no such row at head.
_SCRATCH_NAMES = frozenset({"_spaces_backfill"})


def _real_backend_tables() -> set[str]:
    """`_backend_tables()` minus table-rebuild scratch names.

    `_new_<t>` / `_keep_*` / `_preserve_*` / `<t>_new` exist only inside one
    migration's transaction and are never a mock contract; `_normalize_table`
    has already contributed their real base name.

    Keyed on those prefixes rather than a blanket leading `_`, which also
    swallowed `_op_log_mutation_allowed` — a permanent table (migration 0036)
    that `op_log/bypass.rs` and `db/pool.rs` read at runtime. A table dropped
    here is in neither CONTRACT nor UNMODELED, which is exactly the hole the
    completeness assertion below exists to close.
    """
    return {
        t
        for t in _backend_tables()
        if not t.startswith(_SCRATCH_PREFIXES)
        and not t.endswith("_new")
        and t not in _SCRATCH_NAMES
    }


def run_self_test() -> int:
    failures: list[str] = []

    # --- Every backend table is classified (#4667) -------------------------
    # The gap this closes: the map covered 9 of 35 tables and nothing said so.
    # A table in neither bucket is a table nobody decided about.
    real = _real_backend_tables()
    overlap = CONTRACT.keys() & UNMODELED.keys()
    if overlap:
        failures.append(
            f"tables in BOTH CONTRACT and UNMODELED: {sorted(overlap)}."
        )
    for table in sorted(real - CONTRACT.keys() - UNMODELED.keys()):
        failures.append(
            f"backend table {table!r} is in neither CONTRACT nor UNMODELED — "
            f"decide whether the mock reads it (add to CONTRACT) or not (add "
            f"to UNMODELED with a checkable reason)."
        )
    for table in sorted(UNMODELED.keys() - real):
        failures.append(
            f"UNMODELED table {table!r} is not CREATE'd by any migration "
            f"(schema drift or typo)."
        )

    # --- CONTRACT map integrity (anti-rot) ---------------------------------
    # `real`, not `_backend_tables()`: the looser set includes the `_new_<t>`
    # rebuild scratch names, so a CONTRACT key typo'd as one would pass.
    for table, spec in CONTRACT.items():
        if table not in real:
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
        # 5. new migration touching a table in UNMODELED -> PASS
        (
            "unmodeled-table",
            [
                (
                    "9999_parity.sql",
                    "CREATE TABLE merge_parity_log (id TEXT) STRICT;",
                )
            ],
            set(),
            set(),
            True,
        ),
        # 5b. #4667 — the tag-space bug's own migration shape: DML only, no
        #     DDL, on a modeled table. Must FAIL; 0087 did not.
        (
            "dml-only-on-modeled-table",
            [
                (
                    "9999_drop_space_rows.sql",
                    "DELETE FROM block_properties WHERE key = 'space';\n"
                    "DROP INDEX IF EXISTS idx_block_properties_space;",
                )
            ],
            set(),
            set(),
            False,
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
    # --- DML paths (#4667). 0087, the tag-space bug's own migration, is
    # DML-only; a DDL-only parser reads it as touching nothing.
    if "block_properties" not in parse_touched_tables(
        "DELETE FROM block_properties WHERE key = 'space';"
    ):
        failures.append("parser: DELETE FROM block_properties not detected.")
    if "property_definitions" not in parse_touched_tables(
        "INSERT OR IGNORE INTO property_definitions (key) VALUES ('x');"
    ):
        failures.append("parser: INSERT INTO property_definitions not detected.")
    if "blocks" not in parse_touched_tables("UPDATE blocks SET page_id = id;"):
        failures.append("parser: UPDATE blocks SET not detected.")
    # `ON UPDATE CASCADE` / `AFTER UPDATE OF <col>` must not be read as tables:
    # a bare `UPDATE\s+(\w+)` captures `CASCADE` and `OF` from these.
    for noise in (
        # Live SQL, not a comment: `strip_sql_comments` runs before the regex,
        # so a clause parked in a `--` trailer would test nothing.
        "CREATE TRIGGER tg AFTER UPDATE OF c ON t BEGIN SELECT 1; END;",
        "ALTER TABLE zzz ADD COLUMN c TEXT REFERENCES q(id) ON UPDATE CASCADE",
    ):
        if {"cascade", "CASCADE", "of", "OF"} & parse_touched_tables(noise):
            failures.append(f"parser: UPDATE clause noise fired on {noise!r}.")
    if "blocks" not in parse_touched_tables(
        "CREATE VIRTUAL TABLE fts_blocks USING fts5(x); DROP TABLE blocks;"
    ):
        failures.append("parser: statement after CREATE VIRTUAL TABLE lost.")
    if "fts_blocks" not in parse_touched_tables(
        "CREATE VIRTUAL TABLE fts_blocks USING fts5(block_id, stripped);"
    ):
        failures.append("parser: CREATE VIRTUAL TABLE fts_blocks not detected.")
    # A read is not a write: a migration that only SELECTs a table changes
    # nothing the mock must mirror (0116 reads log_snapshots that way).
    if parse_touched_tables("SELECT up_to_hash FROM log_snapshots;"):
        failures.append("parser: a bare SELECT … FROM must not register.")

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
