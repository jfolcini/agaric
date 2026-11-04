# Session 3316 — Warn at startup when a boot quarantined a sync delta

Slice 3 of #6057. The list card (#6280) shows quarantined deltas once someone goes looking. This slice adds the signal that makes them look: a persistent warning toast on the start that moved a delta into quarantine, with a *Review* action that opens Settings › Sync & devices.

- `RecoveryStatus` gained `sync_quarantined_this_boot`, which `to_status()` copies from `RecoveryReport.sync_inbox_quarantined`. That is the count this boot moved, not the pending total, so a user who cannot fix a slot is not warned again on every start (maintainer decision Q4).
- `useRecoveryStatus` shows the toast from the mount backfill only, under its own fixed id, so it stacks beside the degraded banner instead of replacing it. The `recovery:degraded` listener fires only on a degraded boot, so it does not show the toast.
- Two existing literals had to name the new required field: `status_state_round_trips_degraded` and the `HEALTHY`/`DEGRADED` fixtures. The maintainer approved both on #6057; they were added with no assertion changes.
- No e2e spec yet. The mock always reports 0, and stubbing `get_recovery_status` in Playwright would test call shape only. The real-backend spec (seed an inbox row one boot short, restart, see the toast, follow *Review*) needs the DB-seeding helpers slice 2 adds to e2e-tauri, so it lands in slice 2's spec file.

Ran: full nextest workspace (four partitions), clippy, full vitest, typecheck, lint, prek (all files and manual stage), Playwright boot/settings/sync specs. Reds by mutation: `to_status` copying the pending count, the zero guard, *Review*'s target tab, and shared toast ids.
