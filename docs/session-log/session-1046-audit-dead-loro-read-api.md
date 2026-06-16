# Session 1046 — audit fix #1261: remove dead LoroEngine string-read API

2026-06-16. From the 2026-06 Opus quality audit (maintainability, low).
`/loop /batch-issues` run.

## Finding
`LoroEngine::read_property` / `read_all_properties` (the lossy `as_legacy_string` string
path) had no production callers — only the `*_typed` variants are used (the sole prod
property read is `read_all_properties_typed` in `loro_sync.rs`). All callers of the
string variants were `#[cfg(test)]`-gated across 5 files.

## Fix
- Removed both dead string-typed methods from `loro/engine.rs`.
- Added a `#[cfg(test)] read_property_typed` companion (single-key; matches
  `read_all_properties_typed` semantics — absent→None, explicit-null→Some(Null),
  present→Some(value)) so single-key test lookups migrate cleanly.
- Migrated all test callers (engine.rs, engine_proptest.rs, snapshot.rs,
  engine_path_tests.rs, merge/apply.rs) to the typed variants, translating assertions
  `Option<Option<String>>` → `Option<PropertyValue>` faithfully.

## Adversarial correction to the issue
The issue claimed `PropertyValue::as_legacy_string` was kept "solely to feed dead
getters" — FALSE. It has live production callers in `projection.rs` (consuming
`read_all_properties_typed` output), so it was **kept**.

## Verification
`cargo check --all-targets` clean (compiler proof: no caller remained). Reviewer ran the
full Rust suite (4173 passed) + clippy clean, and spot-checked the test-assertion
translations for faithfulness. No behavior change (production already used only the typed
path).
