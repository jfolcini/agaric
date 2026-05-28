## Session 839 — CR-PERSIST: coercing `migrate` for tabs/journal persist stores + stale-plan cleanup (2026-05-25)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-25 |
| **Subagents** | 1 review (CR-PERSIST technical) — the store edits + tests + housekeeping were orchestrator-direct |
| **Items closed** | CR-PERSIST (tabs/journal persist stores lacked a `migrate`); deleted 3 stale plan files for already-shipped work (PEND-77 / PEND-78 / PEND-79) |
| **Items modified** | — |
| **Tests added** | +14 (frontend: 10 tabs persist-migrate + 4 journal persist-migrate) |
| **Files touched** | 7 (2 store src + 2 test + REVIEW-LATER + 3 plan-file deletions) |

**Summary:** Closed **CR-PERSIST**. `stores/tabs.ts` and `stores/journal.ts` both
declared `version: 1` on their zustand `persist` config but provided no `migrate`,
so the day anyone bumps to `version: 2` the middleware feeds `undefined` to `merge`
and silently discards the persisted blob to defaults (every open tab / per-space page
stack and per-space journal date+mode lost). Added a coercing `migrate` to each store,
mirroring the established `search-history.ts` pattern: it validates each partialized
field on read (dropping malformed tabs, invalid calendar dates, unknown journal modes,
non-integer indices) so the migrate doubles as corruption defense for any
legacy/version-mismatched `localStorage` payload. Also deleted three stale plan files
whose work already shipped in #58 (PEND-78 recent-strip cross-space leak, PEND-79
AppImage self-integration, PEND-77 Tier A property tests) — the README index already
treated them as retired.

**REVIEW-LATER impact:**
- **Top-level open count:** 30 → 29 (CR-PERSIST row + detail section removed).
- **Previously resolved:** 1348+ → 1349+ across 838 → 839 sessions.

**Files touched (this session):**
- `src/stores/tabs.ts` (+~70 — `coerceTab`/`coerceTabList`/`coerceTabsBySpace`/`coerceIndex`/`coerceIndexBySpace` + `migrate`)
- `src/stores/journal.ts` (+~50 — `coerceDateBySpace`/`coerceModeBySpace` + `migrate`)
- `src/stores/__tests__/tabs.test.ts` (new, 10 tests incl. prototype-pollution + float-index hardening)
- `src/stores/__tests__/journal.test.ts` (+4 — `journal persist migrate` block)
- `pending/REVIEW-LATER.md` (CR-PERSIST removed; summary count 30 → 29)
- `pending/PEND-77-…`, `pending/PEND-78-…`, `pending/PEND-79-…` (deleted — shipped in #58)

**Verification:**
- `npx vitest run src/stores` — 16 files, 431 tests passed (was 427 + 14 new − overlap).
- `npx tsc -p tsconfig.app.json --noEmit` — clean.
- `prek run --all-files` — all hooks pass.

**Process notes:** Orchestrator-direct build (2 small store files), independent technical
review subagent (no self-review) confirmed shape-match against each `partialize`, no
crash/prototype-pollution path, and consistency with the `search-history.ts` reference;
its two optional nits (explicit `__proto__` + float-index test cases) were folded in.

**Commit plan:** single commit on `claude/fervent-franklin-Famjk`; pushed; draft PR.
