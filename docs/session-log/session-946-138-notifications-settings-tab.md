## Session 946 — FEAT-11 Notifications Settings tab (slice) (2026-06-02)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-06-02 |
| **Subagents** | orchestrator-only |
| **Items closed** | — (issue `#138` left open — Settings slice only) |
| **Items modified** | `#138` |
| **Tests added** | +9 (NotificationsTab) / +2 (SettingsView panel + count) |
| **Files touched** | 5 |

**Summary:** Shipped the **Settings + permission slice** of FEAT-11 (#138), building on
the plugin/`notify_task`/wrapper work that landed in PR #321 (session 940). Added a new
"Notifications" tab to the Settings panel with an enable/disable preference (persisted via
the existing `useLocalStoragePreference` localStorage mechanism, key
`agaric-notifications-enabled`) plus two affordances wired to the merged wrappers:
"Request permission" → `ensureNotificationPermission`, and "Send test notification" →
`ensureNotificationPermission` then `notifyTask`. The test button is gated on the enable
toggle. Every handler has the AGENTS.md error-path fallback (log + toast, never throw).

**Explicitly out of scope (left open on #138):** the due-task scheduler, the dedupe
ledger / "don't re-fire on materialize replay" guard, and snooze semantics — all too
correctness-sensitive for this bounded slice.

**Files touched (this session):**
- `src/components/settings/NotificationsTab.tsx` — new tab component (toggle + permission +
  test affordances), preference via `useLocalStoragePreference` (new)
- `src/components/SettingsView.tsx` — registered the `notifications` tab (union, TAB_IDS,
  label map, panel render, import)
- `src/lib/i18n/settings.ts` — `settings.tabNotifications` + `notifications.*` strings
- `src/components/settings/__tests__/NotificationsTab.test.tsx` — 9 tests (render/default-off,
  persist toggle, hydrate, permission grant/deny/throw, test send/deny/reject, axe) (new)
- `src/components/__tests__/SettingsView.test.tsx` — updated tab count 10→11; added a
  Notifications-panel render test

**Verification:**
- `vitest run NotificationsTab.test.tsx SettingsView.test.tsx` — 65 passed.
- `vitest run src/lib/__tests__/i18n.test.ts` — 103 passed.
- `tsc` — no errors.

**Anti-collision:** no edits to `src-tauri/src/db.rs` or `src-tauri/migrations/`; reused the
merged `notifyTask`/`ensureNotificationPermission`; avoided editor block/placeholder/breadcrumb
files (#217) and page-title/tag files (PR #325).

**Commit plan:** single commit; PR opened against `main`; not merged.
