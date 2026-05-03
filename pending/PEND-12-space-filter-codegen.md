# PEND-12 — Space-filter SQL fragment codegen via build.rs

User decision unblocks **MAINT-172**. Choosing option 1 from the original triage: generate per-callsite SQL strings from a single canonical fragment via `build.rs` text substitution into `OUT_DIR`. Each call site `include_str!`s the generated literal, which `sqlx::query!` / `query_as!` accept as a compile-time string literal.

## Problem

The space-filter SQL fragment is duplicated across **16 compile-time inlining sites in 12 files** (reviewer-corrected count; the original draft over-counted by including non-existent sites in `commands/pages.rs`/`journal.rs` and conflating compile-time `query!` macros with runtime `query_as::<_, T>()` calls):

```sql
(?N IS NULL OR COALESCE(b.page_id, b.id) IN
    (SELECT bp.block_id FROM block_properties bp
     WHERE bp.key = 'space' AND bp.value_ref = ?N))
```

Sites by file (verified):

- `pagination/{hierarchy.rs ×2, agenda.rs ×2, links.rs, undated.rs, tags.rs, properties.rs, trash.rs, history.rs}` — 10 compile-time sites
- `backlink/{grouped.rs ×2, query.rs}` — 3
- `commands/{agenda.rs ×3, blocks/queries.rs}` — 4 compile-time sites
- **(Out of scope, runtime SQL — separate plan if needed):** `fts/search.rs`, `tag_query/query.rs`, plus the runtime `query_as::<_, T>()` call in `commands/agenda.rs`. These sites can't use `include_str!` directly; they use `format!()` or `String::push_str()` and would compose with `let frag = include_str!(...); format!("... {} ...", frag)`.

Bind indices used: **2-8 (no `?1`)**. Reviewer-corrected from "1-8" — `?1` is reserved for other params at every actual site, so generating `space_filter_bind_1.sql` is wasteful.

Inline comments at every site say "mirrors `crate::space_filter_clause!`" — but that macro **does not exist**. It was aspirational, never implemented, because `sqlx::query_as!` requires a string literal at compile time and rejects `concat!()`.

Real maintenance hotspot: any change to filter semantics requires N coordinated edits. A single typo at one site (e.g., dropping the `COALESCE`) yields silent space leakage that's only catchable by per-site tests.

Inline comments at every site say "mirrors `crate::space_filter_clause!`" — but that macro **does not exist**. It was aspirational, never implemented, because `sqlx::query_as!` requires a string literal at compile time and rejects `concat!()`.

Real maintenance hotspot: any change to filter semantics requires N coordinated edits. A single typo at one site (e.g., dropping the `COALESCE`) yields silent space leakage that's only catchable by per-site tests.

## Sqlx + `include_str!` compatibility — gating question, **needs a Phase 0 spike**

**Theoretically:** sqlx's `query!` / `query_as!` accept any expression evaluating to a `&'static str` at compile time. `include_str!("path")` produces a compile-time `&'static str`. `concat!(env!("OUT_DIR"), "/file.sql")` produces a compile-time string for the *path* argument to `include_str!`. The composition `sqlx::query!(include_str!(concat!(env!("OUT_DIR"), "/file.sql")))` *should* work.

**Reviewer correction:** there's **no working precedent for this exact composition in the codebase.** `pairing.rs:47` uses `include_str!("eff_wordlist.txt")` but **NOT inside a sqlx macro** — it's a plain string constant. No code in `src-tauri/src` currently combines `include_str!` with `sqlx::query!`/`query_as!`, and no code uses `env!("OUT_DIR")` at all. A 1-2h Phase 0 spike is mandatory before committing to the migration.

### Phase 0 — Spike (1-2h, mandatory)

1. Extend `src-tauri/build.rs` minimally: write a single test fragment file `OUT_DIR/space_filter_test.sql` containing `?2`-style fragment.
2. Add one `sqlx::query_as!` call to a test module using `include_str!(concat!(env!("OUT_DIR"), "/space_filter_test.sql"))`.
3. Run `cargo build` and `cargo sqlx prepare`. Confirm: (a) compiles; (b) `.sqlx/` cache regenerates correctly; (c) the cached SQL matches what we expect.

**Kill criterion:** if any of (a)/(b)/(c) fails, fall back to MAINT-172 option 2 (drift-detection pre-commit hook only, no source consolidation). Document the failure in this file and don't proceed.

## Approach: build.rs text substitution

### Canonical source

`src-tauri/sql_fragments/space_filter_template.sql`:

```sql
(?SPACE IS NULL OR COALESCE(b.page_id, b.id) IN
    (SELECT bp.block_id FROM block_properties bp
     WHERE bp.key = 'space' AND bp.value_ref = ?SPACE))
```

Uses placeholder `?SPACE`, not a numbered parameter.

### Build-time codegen

`src-tauri/build.rs` reads the template at compile time and generates per-bind-index files into `OUT_DIR`:

```text
OUT_DIR/space_filter_bind_2.sql   ← ?SPACE → ?2
OUT_DIR/space_filter_bind_3.sql   ← ?SPACE → ?3
...
OUT_DIR/space_filter_bind_8.sql   ← ?SPACE → ?8
```

(Bind indices 2-8 only; no actual call site uses `?1` for the space filter — reviewer correction.)

`cargo:rerun-if-changed=src-tauri/sql_fragments/space_filter_template.sql` ensures rebuild on template change without spuriously invalidating the rest of the workspace.

The current `src-tauri/build.rs` is a one-liner (`fn main() { tauri_build::build() }`); extending it adds ~30 LOC of file I/O.

### Call-site shape

```rust
// Before:
AND (?6 IS NULL OR COALESCE(b.page_id, b.id) IN (
     SELECT bp.block_id FROM block_properties bp
     WHERE bp.key = 'space' AND bp.value_ref = ?6))

// After:
AND include_str!(concat!(env!("OUT_DIR"), "/space_filter_bind_6.sql"))
```

## Per-callsite migration order

**Phase 1 — build.rs codegen + template (2-3h).** Land the template + build.rs + verify generation by reading one of the OUT_DIR files manually after `cargo build`. No source files migrated yet.

**Phase 2 — migrate sites in difficulty-ascending order:**

1. **Simple (single fragment, single bind index):** `pagination/{undated,tags,links,trash}.rs`, `tag_query/query.rs`, `fts/search.rs`, `commands/journal.rs`. ~7 sites. ~1-2h.

2. **Medium (multiple fragments in one file):** `pagination/{hierarchy,agenda,properties,mod}.rs`, `backlink/query.rs`. ~5 files, ~10 sites. ~2-3h.

3. **Complex (cross-link queries, multiple bind indices, multi-fragment per query):** `commands/pages.rs` (cross-space link query with two fragments and same bind), `backlink/grouped.rs` (4 fragments, 2 bind indices), `commands/agenda.rs` (8 fragments, 4 bind indices). ~3 files, ~15 sites. ~3-4h.

Each migrated site: `cargo build` → `cargo sqlx prepare` → `cargo nextest run --lib <module>`. Single-commit-per-domain or single-commit-per-file at choice.

## Per-callsite parity tests

For each migrated file, write **one parity test** that:

1. Calls the migrated function with `space_id=Some(SPACE_PERSONAL_ULID)` against a fixture.
2. Calls the same function with `space_id=None`.
3. Asserts results identical to a pre-migration `insta` snapshot.

Since the SQL is byte-identical (only placeholder substitution), passing `cargo build` after migration is itself the strongest sanity check — sqlx's `.sqlx/` cache catches any drift in the produced SQL string. The parity test backs up that confidence at the result-row level.

## Pre-commit guard

Reviewer flagged: the naive grep would false-positive on (a) the template file itself, (b) source comments mentioning the pattern (e.g., `pagination/mod.rs`, `pagination/tests.rs` carry the pattern in comments), (c) future docs. The hook needs comment-aware filtering and an explicit allowlist:

```bash
#!/bin/bash
set -e
PATTERN="WHERE bp.key = 'space' AND bp.value_ref"

# Find inlined matches in src-tauri/src, excluding:
#  - target/, .git/, node_modules/
#  - the template file itself
#  - lines that are clearly comments (start with whitespace + //)
HITS=$(grep -rn "$PATTERN" src-tauri/src \
    --exclude-dir=target --exclude-dir=.git --exclude-dir=node_modules \
    | grep -v ":[0-9]*:[[:space:]]*//" \
    || true)

# Allowlist of files where the pattern appears legitimately (docs / fixtures that test the pattern itself)
ALLOWLIST="src-tauri/src/(pagination/tests\.rs|spaces/tests\.rs)"

REAL_HITS=$(echo "$HITS" | grep -vE "$ALLOWLIST" || true)

if [ -n "$REAL_HITS" ]; then
  echo "ERROR: space-filter fragment found inlined — use include_str! from OUT_DIR instead"
  echo "$REAL_HITS" | head -10
  exit 1
fi
echo "OK: space-filter canonical check passed"
```

`prek.toml` entry mirrors the `tauri-mock-parity` block. Allowlist may grow during migration; audit on first run.

## Files touched

| File | Change |
| --- | --- |
| `src-tauri/sql_fragments/space_filter_template.sql` | New — canonical fragment |
| `src-tauri/build.rs` | Modified — generate OUT_DIR files |
| ~15 source files (listed above) | Inline fragment → `include_str!(concat!(env!("OUT_DIR"), "/space_filter_bind_<N>.sql"))` |
| `scripts/check-space-filter-canonical.sh` | New — pre-commit guard |
| `prek.toml` | Add hook entry |

## Testing

- **Unit:** build.rs round-trip — for each bind index 1-8, generated file content matches expected substitution.
- **Integration:** per-file parity test (snapshot-backed).
- **CI:** `cargo build` is the canary — if `include_str!` doesn't compose with `query_as!`, compilation breaks at the first migrated site.
- **Pre-commit hook:** verify it fails on a deliberately-inlined fragment in a test source file.

## Cost (reviewer-revised)

**M (7-11h total).**

| Phase | Time |
| --- | --- |
| 0 — Spike: verify `include_str!` + `sqlx::query!` composition (NEW, mandatory) | 1-2h |
| 1 — template + build.rs codegen | 2-3h |
| 2a — simple sites (~7) | 1-2h |
| 2b — medium sites (~5 files, 8 sites) | 2-3h |
| 2c — complex sites (`commands/agenda.rs` 3 fragments, `backlink/grouped.rs` multi-fragment) | 2-3h |
| 3 — pre-commit hook + parity tests + allowlist | 2-3h |

## Impact

- **Closes a long-tail correctness foot-gun.** "One site forgets the `COALESCE`" is impossible — fragment is generated, not hand-copied.
- **Single source of truth.** Change the fragment in one place; every call site picks up the change at next build.
- **Composable with PEND-18.** Independent layers — type-checked parameter (PEND-18) + DRY'd SQL (PEND-12). After both land, "is this query space-scoped correctly?" reduces to "does the function signature take a `SpaceScope`?" — answered at compile time.

## Risk

**Low.**

- **`include_str!` + `query_as!` compatibility** — verified above; mechanism is sound.
- **Coarse rebuild surface from build.rs** — mitigated by `cargo:rerun-if-changed=` on the template path only.
- **Cross-link queries with multiple bind indices** — Phase 2c handles `commands/pages.rs` and `backlink/grouped.rs` (multiple fragments per query, sometimes same bind index, sometimes different). Each fragment gets its own `include_str!`; bind index is per-fragment.
- **Pre-commit guard's allowlist** — must whitelist any legitimate test fixture containing the SQL pattern as a string. Audit on first run.

## Sequencing (reviewer-revised)

- **PEND-12 lands AFTER PEND-18** (not in parallel). Reviewer correction: both touch the same `_inner` signatures + bodies. Serialize to avoid merge conflicts.
- **Combined with PEND-18**, the space-scoping enforcement is bulletproof at both compile time (parameter) and SQL time (fragment).
- **PEND-13 (drift test) is more meaningful after PEND-12 lands** — fewer drift surfaces means the test focuses on schema-level invariants, not SQL-fragment drift.

## Open questions

1. **Does the codegen need to handle multiple parameter indices in one file?** Yes — `commands/pages.rs` has two fragments referencing `?1` (one for source-space, one for target-space). The generated `space_filter_bind_1.sql` is referenced twice in that query via two `include_str!` calls. Confirmed feasible.
2. **Should the pre-commit hook ALSO enforce a bind-index numbering convention** (e.g., always the last param)? **Defer.** Current sites use 1-8 with no consistent convention; standardizing is a separate cleanup.
3. **Allowlist for test files containing the SQL pattern as a string** — audit on first run; expect few entries.
