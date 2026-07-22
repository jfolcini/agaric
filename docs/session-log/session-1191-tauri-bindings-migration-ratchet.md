# Session 1191 — tauri.ts→bindings.ts migration: ratchet guard + first slice

**Date:** 2026-07-22
**Branch:** `refactor/tauri-bindings-migration`
**Issue:** #2927 (partial — first shippable slice; migration continues in follow-ups)

## Summary

`src/lib/tauri.ts` is a 2,936-line hand-maintained wrapper over the specta-generated
`src/lib/bindings.ts`; the staged migration to `bindings.ts` stalled ~4 months ago
with 213 non-test files still importing `@/lib/tauri` vs 22 importing `@/lib/bindings`.
This lands the mechanism to make the migration monotonic, plus a first behavior-preserving
slice. It does **not** attempt the full 200+-file conversion (that would be an
unreviewable merge-conflict bomb) — subsequent PRs chip away under the guard.

## Ratchet guard

- `scripts/check-tauri-import-baseline.mjs` — computes the live set of non-test files
  importing `@/lib/tauri` (static + dynamic imports; excludes tests/`.d.ts`; the
  sibling `@/lib/tauri-mock` deliberately does not match) and compares to a committed
  baseline. Fails on (a) any NEW importer not in the baseline, and (b) any STALE
  baseline entry that no longer imports the module — so the count can only decrease.
  Has `--update-baseline` and `--self-test`.
- `scripts/tauri-import-baseline.json` — seeded with the current 208 importers.
- `prek.toml` — two pre-commit hooks (`tauri-import-baseline`, `tauri-import-baseline-selftest`).

## First migrated slice (diagnostics / op-log-maintenance domain)

- Moved `unwrap<T>` from `tauri.ts` into the tauri-free `src/lib/app-error.ts` (re-exported
  from `tauri.ts` for back-compat) — the enabling refactor that lets a migrated file drop
  `@/lib/tauri` entirely.
- Deleted 5 pure pass-through wrappers (`collectBugReportMetadata`, `readLogsForReport`,
  `getCompactionStatus`, `compactOpLog`, `getLogDir` — the last was dead) + 4 interfaces
  from `tauri.ts`.
- Repointed 5 production files to `commands.*` from `@/lib/bindings`
  (`CompactionCard`, `BugReportDialog`, `DiagnosticsCollector`, `bug-report`,
  `bug-report-zip`); importer count 213 → 208.
- Added the 5 now-wrapperless bindings to `check-tauri-bindings-parity.mjs`'s
  `KNOWN_UNWRAPPED` allowlist (its documented "consumed directly" escape hatch) —
  without this the pre-existing parity guard aborts the commit.

## Verification

`tsc -b --noEmit` clean; `vitest run` on affected files 306 pass; import cycles 0;
both ratchet directions proven (new importer → fail, stale entry → fail); parity guard
exit 0.

## Follow-up phasing

~93 pure pass-through wrappers remain (migration targets); ~46 value-adding wrappers
(Channel streams, pagination/scope shaping, param-object/progress reshaping, OS-integration
seams) stay permanently. Suggested order: type-only re-exports → invoke-mock-transparent
domains → wrapper-mocked domains (convert `vi.mock('@/lib/tauri')` factories to invoke-level).
