# PEND-18 — `SpaceId` newtype + `SpaceScope` enum

> **Status (Session 678):** Phase 0 spike LANDED. `SpaceId` newtype + `SpaceScope` tagged enum live in `src-tauri/src/space.rs`; specta emits the desired discriminated-union TS shape (`{ kind: "global" } | { kind: "active"; space_id: SpaceId }`); sqlx accepts `SpaceId` in column-cast position. A throwaway `pend18_spike_probe` Tauri command is registered in `agaric_commands!` — Phase 1's first deliverable is to remove it (probe + macro entry) and add the remaining `PartialEq<&str>/<str>/<String>` impls (mirroring `ActiveBlockId`) plus comprehensive tests. Phases 2/2.5/3 unchanged from the plan body below.

## Problem

The Spaces architectural review verdict was **data model A, enforcement C+**. The enforcement gap: `space_id: Option<String>` is the contract across the codebase. Reviewer-corrected counts:

- **~30 production call sites** (across `commands/{agenda,blocks/{queries,crud},queries,pages,tags,history}.rs`, `pagination/*.rs`, `backlink/{query,grouped}.rs`, `tag_query/query.rs`, `fts/search.rs`, `mcp/tools_ro.rs`).
- **15+ test-fixture sites** across `commands/tests/*.rs`, `pagination/tests.rs`, `spaces/tests.rs` that hardcode `space_id: None` / `Some(TEST_SPACE_ID)`.
- **Total migration surface: ~45 sites in ~18 files** (planner originally estimated 49 in 13+ files; corrected after reviewer grep).

`None` means "global / pre-FEAT-3 unscoped"; `Some(id)` means "scoped." Every new caller has to *remember* to pass `Some(active_space_id)` or the query silently behaves as global. The compiler can't help — a forgotten parameter defaults to `None` and the code compiles.

Doc comment from <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/commands/agenda.rs" lines="21-24" />: *"`None` is the unscoped (pre-FEAT-3) behaviour preserved for callsites that have not migrated."*

This mirrors the in-progress MAINT-113 effort (`ActiveBlockId` newtype to lift the `is_conflict = 0` invariant into the type system; M1+M1.5+M2 already landed).

## Proposed types

### `SpaceId` newtype

Mirror **`ActiveBlockId`** (the strict MAINT-113 newtype, not the lenient base `BlockId`). Reviewer correction: the base `BlockId` does NOT derive `PartialOrd`/`Ord`/`sqlx::Type`/`specta::Type`; the strict subset does. The proposed `SpaceId` shape below matches `ActiveBlockId`, which is the right precedent for this use case (sqlx column casts + specta IPC + ordering).

```rust
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, sqlx::Type, specta::Type)]
#[serde(transparent)]
#[sqlx(transparent)]
pub struct SpaceId(String);

impl<'de> Deserialize<'de> for SpaceId {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        Ok(Self(s.to_ascii_uppercase()))
    }
}

impl SpaceId {
    pub fn from_string(s: impl Into<String>) -> Result<Self, AppError> {
        let s = s.into();
        ulid::Ulid::from_str(&s).map_err(|e| AppError::Ulid(format!("Invalid space ULID '{}': {}", s, e)))?;
        Ok(Self(s.to_ascii_uppercase()))
    }
    pub fn from_trusted(s: &str) -> Self { Self(s.to_ascii_uppercase()) }
    pub fn as_str(&self) -> &str { &self.0 }
    pub fn into_string(self) -> String { self.0 }
}

impl Display for SpaceId { /* ... */ }
impl AsRef<str> for SpaceId { /* ... */ }
impl From<SpaceId> for String { /* ... */ }
```

### `SpaceScope` enum

```rust
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(tag = "kind", content = "space_id")]
pub enum SpaceScope {
    #[serde(rename = "global")]
    Global,
    #[serde(rename = "active")]
    Active(SpaceId),
}

impl SpaceScope {
    pub fn as_filter_param(&self) -> Option<&str> {
        match self {
            SpaceScope::Global => None,
            SpaceScope::Active(id) => Some(id.as_str()),
        }
    }
}
```

**Wire format:** `{"kind":"global"}` vs `{"kind":"active","space_id":"01HK..."}`. Tagged-enum representation is unambiguous on the IPC boundary and matches specta's auto-regen.

## Migration strategy — 4 phases, each landable independently

### Phase 0 — Spike: validate specta + sqlx + tagged enum (NEW, ~1-2h)

Reviewer flagged: specta 2.0.0-rc.24 has **no in-codebase precedent** for `#[serde(tag, content)]` enums. Validate before committing the enum design.

**Deliverables:**

1. Define a throwaway `SpaceScope` exactly as proposed below (in a feature-gated module to avoid polluting the build).
2. Add a `#[tauri::command]` accepting `SpaceScope` and a unit test that round-trips through `serde_json` and through the specta binding emitter.
3. Generate `bindings.ts` via `cargo test specta_tests --ignored`. Inspect: does the TS shape look correct (tagged enum with `kind` + `space_id`)? If specta produces something broken or unusable, this whole plan needs redesign (e.g., use `Option<SpaceId>` IPC-side + translate at boundary).
4. Add a minimal `sqlx::query_as!` test using a `SpaceId` column cast (`SELECT id as "id: SpaceId"`) — confirms `#[sqlx(transparent)]` works in column-cast position. MAINT-113 used this pattern for `ActiveBlockId`; should work here.

**Kill criteria:** if either specta or sqlx misbehaves, the plan needs material redesign. Don't proceed to Phase 1 without green from both.

### Phase 1 — Define types (no callers changed). S (1-2h after spike)

Land `SpaceId` + `SpaceScope` in a new `src-tauri/src/space.rs` (parallel to `ulid.rs`). Unit tests for FromStr validation, serde round-trip, `as_filter_param()`. Verify specta binding generation via `cargo build`. **Reversibility: trivial.**

### Phase 2 — Migrate `_inner` functions, one domain at a time. M (4-6h total)

Each `_inner` becomes `scope: SpaceScope` instead of `space_id: Option<String>`. The SQL bind site changes from `space_id` (an `Option<String>`) to `scope.as_filter_param()` (an `Option<&str>`) — **SQL fragments stay byte-identical**. Tauri command wrappers temporarily translate the IPC-side `Option<String>` to `SpaceScope` before calling `_inner`:

```rust
let scope = match space_id {
    Some(id) => SpaceScope::Active(SpaceId::from_string(id)?),
    None => SpaceScope::Global,
};
```

Order: agenda → blocks → pages → tags → history → queries → pagination → backlink → FTS → MCP. Each domain is one commit; ~30-45 min per domain.

For each migrated function: parity test asserting old shape (`None`) and new shape (`SpaceScope::Global`) produce identical SQL output / result rows. Delete the old shape only when parity holds.

### Phase 2.5 — Test-fixture migration (NEW, 1-2h)

Reviewer correction: ~15 test files hardcode `space_id: None`/`Some(TEST_SPACE_ID)` across `commands/tests/{block,agenda,...}.rs`, `pagination/tests.rs`, `spaces/tests.rs`. Each test must update to use `SpaceScope::Global` / `SpaceScope::Active(SpaceId::from_trusted(TEST_SPACE_ID))`. The migration is mostly mechanical but each test needs a one-line review to confirm intent.

Land this immediately after Phase 2 (or interleaved per-domain).

### Phase 3 — IPC boundary + frontend update (atomic, after Phase 2/2.5 complete). M (2-3h)

**Reviewer correction: Phase 3 cannot defer the frontend update.** The IPC wire shape changes; `bindings.ts` regenerates; `tauri.ts` wrappers MUST update in the same commit, or the frontend breaks at runtime.

Steps in one commit:

1. Tauri command signatures take `SpaceScope` directly.
2. `cargo test specta_tests --ignored` regenerates `bindings.ts`.
3. `tauri.ts` wrappers updated to construct `SpaceScope::Global`/`SpaceScope::Active(...)` from the JS-side shape (`spaceId: string | null` mapped to the tagged enum).
4. Verified by `tauri-mock-parity` hook + PEND-08 parity hook (when landed) + `prek run --all-files`.

### Phase 4 — Frontend internal type tightening (optional, deferred)

TypeScript adopts a richer mirror type internally (still `spaceId: string | null` at the IPC boundary, but a `SpaceScope` discriminated union inside the app). Nice-to-have; orthogonal to Phase 3.

## What this does NOT replace

- **SQL fragments stay bit-identical.** PEND-12 DRYs them up via build.rs codegen.
- **`block_id: String` → `BlockId`** is MAINT-113's scope.
- **Bootstrap & migration paths** unchanged.
- **A pre-commit hook** that says "every list query MUST take a SpaceScope" is enforcement layer, not type-system foundation. PEND-12 (or a sibling) covers the static-check.

## Files touched

**Phase 1:** `src-tauri/src/space.rs` (~150 LOC new), `lib.rs` (+3 LOC).

**Phase 2:** ~30 files, ~400-500 lines touched (mostly mechanical parameter renames + docstring updates).

**Phase 3:** ~7 command files (signatures), `bindings.ts` auto-regen, `tauri.ts` (~100 lines).

## Testing

- Phase 1: `SpaceId::from_string` validates 26-char Crockford base32 ULID. Rejects invalid strings. Serde round-trip preserves uppercase. `SpaceScope::as_filter_param()` correctness.
- Phase 2: per-`_inner` parity test (old `None` vs new `SpaceScope::Global`).
- Phase 3: end-to-end Tauri command boundary integration test.

## Cost (reviewer-revised)

| Phase | Time |
| --- | --- |
| 0 — specta + sqlx + tagged-enum spike (NEW) | 1-2h |
| 1 — types + tests | 1-2h |
| 2 — migrate `_inner` (10 domains × ~30-45 min) | 4-6h |
| 2.5 — test-fixture migration (NEW) | 1-2h |
| 3 — IPC boundary + frontend wrappers (atomic) | 2-3h |
| **Total** | **9-15h** |

Originally estimated 7-10h; reviewer corrected upward after surfacing the spike + fixture-migration + frontend-coupling realities.

## Impact

- **Maintainability: high.** Eliminates the "did I remember to pass space_id" footgun at compile time. Every new query author makes an explicit choice via `SpaceScope::Global` or `SpaceScope::Active(...)`.
- **User-visible behavior: zero.** Same SQL, same results, same wire shape (trivially translated).
- **Closes the Spaces enforcement gap.** A → A.

## Risk

**Low.**

- **Specta + newtype interaction:** Phase 1 unit tests verify specta binding generation. Mitigation if specta misbehaves: fall back to `#[serde(transparent)]` newtype that serializes as `String` (like `BlockId` already does).
- **Tauri command signature changes are wire-visible.** Phase 3 happens only after Phase 2 complete; the `tauri-mock-parity` and PEND-08 parity hooks catch drift.
- **Migration churn.** Many small commits. Mitigation: keep phases small and never mix Phase 2 with Phase 3.

## Sequencing (reviewer-revised)

- **PEND-18 should land BEFORE PEND-12** (not in parallel). Reviewer correction: both touch the same `_inner` function signatures. Parallel work risks merge conflicts in `pagination/*.rs`, `backlink/*.rs`, `commands/agenda.rs`. Serialize.
- **PEND-13 lands after PEND-18 + PEND-12.** Drift test is more meaningful when parameter + SQL are both canonicalized.
- **PEND-18 has no dependency on PEND-14 or PEND-15.**

## Open questions

1. **Should `SpaceId::from_string` validate against the database** (does this ULID exist as a space block)? **Recommendation: no** — structural validation only, mirroring `BlockId`. Semantic check happens at the call site.
2. **Should there be an `ActiveSpaceScope = SpaceId` shape** for callers that should never accept Global? **Recommendation: defer.** Ship the simple enum first; add the stricter type later if needed (mirrors MAINT-113's path of `BlockId` then `ActiveBlockId`).
3. **`src-tauri/src/space.rs` vs `spaces/mod.rs`?** Recommend `space.rs` (parallel to `ulid.rs`) — the `spaces/` module is bootstrap-specific; the types are general-purpose.
