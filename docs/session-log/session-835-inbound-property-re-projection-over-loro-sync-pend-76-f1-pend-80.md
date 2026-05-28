## Session 835 — inbound property re-projection over Loro sync (PEND-76 F1 / PEND-80) (2026-05-25)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-25 |
| **Subagents** | 1 build + 1 review |
| **Items closed** | PEND-76 F1 property-propagation residual |
| **Items modified** | PEND-80 (Phase-1 properties: functional outcome shipped) |
| **Tests added** | +12 (backend) |
| **Files touched** | 3 (+ PEND-80 doc) |

**Summary:** Remote `SetProperty`/`DeleteProperty` changes now reach SQL. `apply_remote`
re-projects each changed block's properties from the Loro engine into `block_properties`
via `reproject_block_properties_from_engine` (authoritative DELETE-then-INSERT, so remote
deletes propagate). **Key finding:** no engine-model migration is needed — the engine's
existing string value + `property_definitions.value_type` (all types present since
migration 0043) recovers the SQL type losslessly (`f64::to_string` round-trips), so
PEND-80's "native typed engine values" is not required for correctness and is deferred as
a representation refinement. Reserved hot-path keys + derived caches + `LoroTree` remain
follow-ups.

**Process:** built by one subagent, reviewed by a second (no self-review). The review
caught a **BLOCKER**: an explicit-null or unparseable-`number` value routed to no column
→ an all-NULL row that violates the `block_properties.exactly_one_value` CHECK (migration
0062) and would abort the entire inbound-sync tx. Fixed by skipping the INSERT (cleared
property = row-absent, which the up-front DELETE already achieves) + a regression test.
Also strengthened the F1 cascade-wipe regression test to assert a SQL-only property is
swept by the authoritative replace.

**REVIEW-LATER impact:**
- **Top-level open count:** unchanged (PEND-track item).
- **Previously resolved:** 1342+ (unchanged).

**Files touched (this session):**
- `src-tauri/src/loro/engine.rs` (`read_all_properties` + 2 tests)
- `src-tauri/src/loro/projection.rs` (`reproject_block_properties_from_engine` + 5 tests)
- `src-tauri/src/sync_protocol/loro_sync.rs` (wire into `apply_remote` + 2 E2E tests + strengthened F1 test)
- `pending/PEND-80-extend-loro-engine-model.md` (progress note)

**Verification:**
- `cargo nextest run loro_sync reproject read_all_properties` — 29 pass (12 new); `prek` at commit.
- `scripts/push.sh` CI-equivalent at push.

**Lessons learned:** Reviewer subagents must not `git checkout` over an uncommitted
working tree — the review agent here discarded the (uncommitted) change and had to
reconstruct it from memory. Commit before spawning the reviewer.

**Commit plan:** code commit + docs commit on `loro-inbound-property-reprojection` (stacked on the quick-wins branch); pushed; PR to open.
