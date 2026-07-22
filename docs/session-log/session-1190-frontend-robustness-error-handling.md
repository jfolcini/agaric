## Session 1190 — frontend robustness: error-handling hardening (2026-07-22)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-07-22 |
| **Subagents** | 3 build + 3 review (frontend) |
| **Items closed** | `#2923`, `#2924`, `#2925`, `#2926` |
| **Files touched** | 12 source + 4 test + 1 doc |

**Summary:** A cohesive batch of four `robustness(frontend)` findings from the
2026-07-22 whole-app deep-analysis report, all in the same "don't let a failure
produce a silent or dead-end state" theme:

- **#2924 — entry-point `main()` had no catch → permanent white screen.** Observability
  init (which deliberately re-throws for retryability) is now best-effort at the call site
  (`try/catch` → `logger.warn`, render continues), and `main()` is invoked as
  `main().catch(renderFatalBootError)`. `renderFatalBootError` is dependency-free plain-DOM
  code that injects a `role="alert"` fallback panel (heading + message + Reload button,
  wording matching `ErrorBoundary`) when a pre-mount failure occurs (incl. missing `#root`).
- **#2925 — all eight persisted Zustand stores used unguarded localStorage**, so a
  `setItem` failure (QuotaExceededError) threw synchronously out of unrelated store
  actions, aborting multi-store chains and stranding persisted state. Added a shared
  `safePersistStorage` (`createJSONStorage` wrapper) whose `setItem`/`getItem`/`removeItem`
  try/catch, log via `logger.warn`, and surface a one-shot deduped
  `notify.warning(t('error.settingsSaveFailed'), { id })`; wired into all 8 stores.
- **#2923 — page alias add/remove was optimistic with no rollback on IPC failure.**
  `handleAddAlias`/`handleRemoveAlias` now capture the prior `aliases` array before the
  optimistic update and restore it in the `.catch`; `aliasInput` clears only after the
  write resolves. Rollback is reference-guarded
  (`setAliases((current) => (current === next ? previous : current))`) so a stale rollback
  can't clobber a later, already-successful interleaved mutation (caught in review).
- **#2926 — terminal read-failure toasts shipped without a retry action.** The
  `load()`-failure toast in `page-blocks.ts` is now
  `notify.retry(t('error.loadBlocksFailed'), () => void get().load(), { id })`, giving the
  user a one-click recovery instead of forcing navigate-away-and-back.

**Files touched:**
- `src/main.tsx`; `src/lib/safe-persist-storage.ts` (new); `src/lib/i18n/errors.ts`
  (`error.settingsSaveFailed` key); `src/hooks/usePageAliases.ts`;
  `src/stores/page-blocks.ts`; the 8 persisted stores
  (`tabs.ts`, `navigation.ts`, `recent-pages.ts`, `space.ts`, `journal.ts`,
  `search-history.ts`, `pageBrowserFilters.ts`, `useDebugStore.ts`).
- Tests: `src/__tests__/main-boot-error.test.ts`,
  `src/lib/__tests__/safe-persist-storage.test.ts`,
  `src/hooks/__tests__/usePageAliases.test.ts`, `src/stores/__tests__/page-blocks.test.ts`.
- Also commits the orphaned source report the four issues cite:
  `docs/session-log/analysis-report-2026-07-22.md`.

**Verification:**
- `tsc -p tsconfig.app.json --noEmit` 0 errors; vitest 254 passed across the four changed
  test files (stores' existing suites 279 passed, no regression).
- **Adversarial review earned its cost twice:** reviewer found a real interleaving race in
  the #2923 rollback (a stale rollback could revive a removed alias and discard a later
  successful removal) — fixed with a reference-guarded functional updater + regression test.
  The orchestrator caught a `TS2352` regression the two reviewers mislabeled "pre-existing"
  (a mock-call cast in the new #2926 test) — fixed with `as unknown as`.
- Circular import introduced by #2925 (`useDebugStore → safe-persist-storage → notify →
  error-display → getDebugMode`) independently verified safe: `getDebugMode` is a hoisted
  `function` declaration called only inside a function body, never at module-init.

**Commit plan:** single PR (own branch `fix/frontend-robustness-error-handling`); merge
when green.
