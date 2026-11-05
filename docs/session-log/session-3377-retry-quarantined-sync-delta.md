# Session 3377 — Retry a quarantined sync delta

Slice 2 of #6057, which finishes the issue: each quarantined delta in Settings › Sync & devices gets a *Retry* button. Slice 1 (#6280, the list) and slice 3 (#6287, the startup toast) ship separately.

- **One-boot budget (maintainer decision Q1).** `readmit_quarantined_slot` moves the slot back into the inbox with `unresolved_boots = QUARANTINE_AFTER_BOOTS - 1`. The old reset to 0 would have hidden a retry that failed again for five starts, so it looked like it had worked. The maintainer approved changing the one assertion in `readmitted_quarantined_blob_projects_on_the_next_boot_3226`.
- **First seen is kept (Q1b).** The inbox row's `created_at` takes the quarantine row's `first_seen_at_ms`. No other reader depends on that column.
- **No in-process retry.** The inbox is replayed only at boot. Replaying it at runtime would add a post-commit engine write path that races live sync, so the toast says the slot is tried "the next time Agaric starts" and offers *Restart now*.
- **e2e-tauri seeding.** No command creates a quarantine row. The spec reads the vault from the app's `/proc/<pid>/environ` and writes `notes.db` with `node:sqlite` while the app is closed, through `restartApp(how, beforeOpen)`. The spec was shown red in CI on a probe branch that restored the 0 reset (run 41804038815): the boot logged "unresolved boot 1 of 5", and the spec timed out waiting for the row to come back. The probe branch `claude/6057-retry-red-probe` could not be deleted from the cloud session.
- **Left for the follow-up PR.** Slice 3's real-backend toast case needs both PRs on main. The same goes for the COMPARISON line that says the boot fields reach the logs only.

Ran: full nextest workspace in four partitions, clippy, full vitest, typecheck, lint, prek (all files and the manual stage), and the Playwright settings and sync specs, including the new Retry case.
