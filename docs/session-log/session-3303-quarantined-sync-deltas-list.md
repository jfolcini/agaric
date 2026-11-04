# Session 3303 — List quarantined sync deltas in Settings

Slice 1 of #6057: make the sync deltas that `loro_sync_quarantine` holds visible, read-only. Retry (slice 2) and the boot toast (slice 3) ship separately.

- `list_quarantined_sync_slots(limit)` on the read pool. It validates `1..=100` (invariant 10) and returns `{ slots, total }`, with `total` from `count_quarantined_slots`, so the count stays true past the cap. `list_quarantined_slots` gained `LIMIT ?`. Its order (`quarantined_at_ms DESC, id DESC`) and `byte_len` (`LENGTH(bytes)`) were already there. `QuarantinedSlot` derives `specta::Type`.
- `QuarantinedSyncCard` sits first in Settings › Sync & devices and outside `SyncStatusCard`, which renders nothing with no paired device; a quarantined slot outlives an unpair. The card renders nothing at zero and uses the alert-warning tokens of `BoundedStalenessNotice`.
- The mock gained a quarantine map, `window.__addMockQuarantinedSlot`, and a handler that mirrors the Rust. The conformance ratchet carries a read waiver as debt: a fixture needs a `seed.loro_sync_quarantine` section on both stacks.
- One existing test changed, with the maintainer's approval on #6057: the `SettingsView.test.tsx` `beforeEach` stubs the new command, because its strict invoke fallback fails every Sync-tab test otherwise.
- Disk trap: the container fits one compiled `src-tauri/target`, so slices 1 and 3 share one worktree on different branches, built one after the other.

Ran: full nextest workspace (both partitions), clippy, full vitest, typecheck, lint, prek (all files and manual stage), Playwright `sync-quarantine`, `settings*`, `sync-ui`, `sync-happy-paths`. Reds shown by mutation for the limit, the total, validation, the card's guards and fallback, the mock's ordering and reset, and the e2e render.
