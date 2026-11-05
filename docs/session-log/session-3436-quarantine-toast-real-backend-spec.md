# Session 3436 — Real-backend spec for the quarantine startup toast

Follow-up to #6057, whose three slices merged as #6280 (the list), #6287 (the startup toast) and #6324 (*Retry*). Their non-blocking review notes were collected here.

- **Landed:** `e2e-tauri/sync-quarantine-toast.e2e.ts`.
  - The spec seeds a `loro_sync_inbox` slot one failed start short of `QUARANTINE_AFTER_BOOTS`, using bytes that are not a Loro blob, and restarts.
  - That start must quarantine the slot, show the toast, and *Review* must open the Sync & devices card listing it.
  - #6287 deferred this spec because the seeding helpers arrived with #6324. It is its own file because each file gets its own vault, so the count in the toast does not depend on the retry spec.
- **Dropped:** the #6287 note that `openSyncSettings` in `useRecoveryStatus.ts` copies `handleOpenSyncSettings` in `App.tsx`.
  - The copy is two store calls. The same `setPendingSettingsTab(...)` + `setView('settings')` pair appears at several other call sites (`SpaceSwitcher`, `UnfitValueMark`, `palette-commands`, `KeyboardShortcuts`), and nobody has hit a failure from any of them.
  - A shared helper for two lines would be a helper for a one-off.
- **Already fixed in #6324:** the COMPARISON row that said the boot fields reach the logs only.
- **Probe branch:** `claude/6057-retry-red-probe` from #6324 could not be deleted from the cloud session (the proxy refuses branch deletes), and neither can this PR's red probe. Both carry a "never merge" commit.

Ran: the new spec shown red in CI on a probe branch that skips the toast, then green on the PR's `e2e-tauri-gate`; `npm run typecheck`; oxlint and oxfmt on the spec; `node --test scripts/e2e-related.test.mjs`.
