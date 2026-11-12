# Session 3894 — The export round-trip spec clicks a menu row a toast can cover

`e2e-tauri/export-roundtrip.e2e.ts` began failing in the real-backend lane with "element click intercepted" on the page menu's *Delete page* row: on two PRs that share nothing with it (#6590, #6593), and not on a third (#6594). The failed run's screenshot shows why. #6584 added a *Page history* row to the page menu, so its last row now reaches the bottom-right corner of the lane's 1024×768 window, where the "Markdown copied to clipboard" toasts from the export step sit. Whether the click lands on a toast depends on when they expire.

The spec's `pageAction` now clicks the row through `clickUncovered`, the lane's helper for this hazard (it closes toasts, then hit-tests and clicks in one script). `trash-page-cascade.e2e.ts` already clicked *Delete page* that way.

Not changed: the app. In a window that small a toast can sit over the menu's last row for a user too, for the few seconds the toast lives; nobody has reported it.

The real-backend lane was not run locally; CI's shard 1 is the check. Typecheck, oxlint and the e2e tag test ran.
