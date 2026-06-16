# Session 1002 — useCheckboxSyntax re-entrancy guard (#1341)

`/loop /batch-issues` run (2026-06-16), one of three issues built in parallel isolated
worktrees (#1325 Rust, #1341 this, #1345 agenda).

## Shipped

- **#1341 — `useCheckboxSyntax` missing re-entrancy guard.** The hook performed an optimistic
  `todo_state` mutation with no guard, so a rapid double-invoke on the *same* block queued two
  in-flight `setTodoStateCmd` calls whose error-path rollbacks both fired, restoring a stale
  `priorTodoState` snapshot. Added a hook-level `inProgress = useRef(false)` guard: early-return
  if already in progress, arm before the optimistic write, reset in a `.finally` when the
  promise settles (resolve or reject). `setTodoStateCmd` is `async` so it can't throw
  synchronously — no stuck-`true` path. Matches the established pattern in
  `useBlockKeyboardHandlers.ts` and `src/components/__tests__/AGENTS.md` items 2 & 4.

## Tests

- `useCheckboxSyntax.test.ts`: double-invoke on the same block with a pending command →
  `setTodoStateCmd` called exactly once (second dropped); after settle, a later invoke is
  allowed (guard re-arms via `.finally`). Added `beforeEach(vi.clearAllMocks())` for exact
  call-count asserts.
- 4 tests green; `tsc` clean. Independent adversarial reviewer confirmed the guard correctness
  (no stuck-true path), test discrimination (disabling the guard fails the double-invoke test),
  and 276/276 consumer tests (`useBlockSlashCommands`, `BlockTree`) still pass.

Severity low (local sqlite IPC settles fast, rarely rejects) but a real correctness gap.
