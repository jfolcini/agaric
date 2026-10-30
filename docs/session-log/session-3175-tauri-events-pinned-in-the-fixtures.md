# Session 3175 — Tauri events pinned in the conformance fixtures

Section C of #6054: the mock emits the events the backend emits for the commands the frontend calls, and the fixtures pin them.

**Audit.** Of the frontend-invocable commands, only the eight property commands emit (`block:properties-changed`, from their `#[tauri::command]` wrappers). `start_sync` and `cancel_sync` emit nothing themselves; the sync daemon's sinks emit `sync:*` and `blocks:changed`, and the mock has no sync transport. `sync:progress` is live (daemon sessions without a channel) but has no frontend listener. `mcp:activity`, `recovery:degraded`, `deeplink:*` and the remaining `sync:*` events have no command behind them.

**Design.**
- `property_changed_events` in `commands/properties.rs` builds every wrapper's payload, and the Rust harness calls it, so each `via: "command"` record carries an `events` list (omitted when empty, so fixtures without emitting ops did not churn). The wrapper itself does not run in the harness: each arm restates the ids and keys it passes, which the review accepted because no smaller shape removes that.
- The mock publishes through `src/lib/tauri-mock/events.ts`; `setupMock` routes it to the real `emit()`, the replay records it per op. The mock's `apply_page_source` reuses property handlers internally, so those calls run under `withoutEvents`, as the backend's internal calls emit nothing.

**Divergences found and fixed.**
- `delete_property` emits even when it removed nothing (`[]`), and deleting `repeat` names the bounds it removed.
- The mock's `set_todo_state`, `set_priority`, `set_due_date` and `set_scheduled_date` accepted an unknown state, a bad date and a trashed block; the backend refuses all of them (pinned in `property_change_events.json`).

**Dropped:** an AppHandle-based ratchet over the command list. AppHandle is the wrong proxy for "can emit" (most such commands only reach the OS or the app-data dir), and the fixtures already pin the real emitters.

**Tests.** `e2e/property-change-refresh.spec.ts` draws a list marker with no reopen, which only the event refresh makes pass (red with the event sink unwired). Four existing specs had comments saying the mock emits no event; the comments are corrected.

**Suites:** conformance nextest and the ignored fuzz lane, vitest over `src/lib`, `src/hooks`, `src/stores`, `src/components`, typecheck, lint, clippy, the manual-stage hooks. The whole Playwright lane ran locally against Chromium 153 symlinked as the pinned revision: everything passed but two `diagram-legibility` cases that fail identically on `origin/main` with that browser.
