# Session 1599 — the guard for #3081 could not have caught #3081 (#4667)

## The finding

`check-migration-mock-contract.py` exists because of #3081: a tag vanished after
a view switch, because the mock kept reading `block_properties(key='space')`
after migrations 0087/0088 retired it. Found by a user, with e2e green.

Its parser only understood DDL. Migration 0087 is:

```sql
DELETE FROM block_properties WHERE key = 'space';
DROP INDEX IF EXISTS idx_block_properties_space_covering;
```

No `CREATE TABLE`, no `ALTER TABLE`. `parse_touched_tables(0087)` returned the
empty set, so the guard built to prevent #3081 would have waved #3081 through.

Reproduced rather than argued: 0087's literal body as a new migration exits 0
under the old parser and 1 under the new one, naming `block_properties` and the
two mock files that model it.

`INSERT INTO` / `UPDATE … SET` / `DELETE FROM` are now parsed. `\s+SET\b` is
load-bearing on the UPDATE arm — a bare `UPDATE\s+(\w+)` reads `ON UPDATE
CASCADE` and `AFTER UPDATE OF` as table names, which a parser case pins.

## Two more fail-opens

`CREATE VIRTUAL TABLE` did not match `CREATE\s+TABLE`, so `fts_blocks` — which
has no other creation form — was invisible to the parser AND to the backend
table list.

Nothing related the map to the schema, which is how 9 of 35 tables sat mapped
and 26 unclassified without anyone noticing. The self-test now asserts
CONTRACT ∪ UNMODELED == the real backend table list, disjointly, so a new
table lands in one bucket or reds.

## 9 → 19 mapped, 16 documented as unread

The mock inventory took three passes, because the obvious one is a false
negative. Module-level stores find only what the mock STORES; the tables it has
no store for but re-derives on read — `block_links`, `pages_cache`,
`fts_blocks`, `tags_cache`, `block_tag_inherited`, `page_link_cache`,
`agenda_cache` — are contract surfaces too, since the mock reproduces what the
cache holds. Column-vocabulary overlap surfaced those; a literal name grep, read
in context, separated "models it" from "mentions it in a comment saying it does
not".

`peer_refs` was not a judgement call. Migrations 0113 and 0114 say in their own
headers that the mock has a real `peerRefs` store and that `peer_refs` is
"correspondingly absent from the CONTRACT map". The gap was documented in the
migrations and never closed in the map.

The backend has 35 real tables, not the 59 the issue cites — that number counts
transaction-scratch names (`_new_<t>`, `_keep_*`). The script derives it now
rather than asserting it.

## Not fixed, because it cannot be

0113/0114 write `-- mock-unaffected,` with a comma; the regex anchors on
`mock-unaffected:`, so their annotation never registered. Migrations are
append-only, so the baseline is the only resolution. Those two plus 0111–0116
were never baselined at all; `--update-baseline` added exactly those six lines.

## Falsification

All 10 added tables exercised for real — a throwaway migration per table,
deliberately a different statement shape each time so the new parser paths meet
real files: DDL alter, rebuild, drop, virtual, trigger, and DML insert, update,
delete, insert-or. All 10 exit 1.

Negative controls, so the guard is not merely always-red: the same migration
plus its modeling mock file exits 0; an `UNMODELED` table with no ack exits 0;
`ON UPDATE CASCADE` clause noise exits 0; an already-baselined migration exits 0.

The new machinery is falsified too — a probe creating an unknown table reds the
self-test, as do a renamed store symbol, a CONTRACT entry pointing at a missing
file, a stale `UNMODELED` key, and a table in both buckets, each with its own
message. Fixture 5 had to change: it used `pages_cache` as its unmodeled
example, and that red was the first evidence the additions bite.

## Worth knowing

The hook's `files` pattern does not include its own script, so editing the
CONTRACT map does not re-run it at pre-commit; the self-test hook is
`always_run` but `stages = ["manual"]`. CI is what catches map rot.

## Review round: two of my own assertions could not fire

`pages_cache` was mapped on `inbound_link_count` and `page_link_cache` on
`pageLinkStats`. Both symbols appear in their cited files only in PROSE —
`handlers/pages.ts:207` and `handlers/shared.ts:342` are comments, and
`link-scan.ts:109` names `pageLinkStats` in a docblock while the definition is
in `handlers/shared.ts`. So those two anti-rot assertions could never fire:
delete the derivation and the self-test still passes. Re-pointed at
`buildPageMetaRow` and `deriveLinkEdges`, which are code in every listed file;
renaming either now reds with the symbol named.

The same shape in the parser cases. The first UPDATE-noise case parked
`ON UPDATE CASCADE` in a `--` trailer, and `strip_sql_comments` runs before any
regex, so it reduced to `CREATE INDEX i ON t (c);` and tested nothing. Replaced
with the case the comment above it claims and neither case covered:
`CREATE TRIGGER tg AFTER UPDATE OF c ON t` as live SQL. Dropping the `\s+SET\b`
anchor now reds both noise cases; before, only the second.

A guard written to catch guards-that-cannot-fire shipped two of them.
