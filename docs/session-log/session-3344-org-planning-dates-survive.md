# Session 3344 — Org planning dates survive warning periods and foreign day names

#6032 item N6, decided by the maintainer on 2026-11-04. An Org planning line
lost its whole date over one token the import did not model:
`parse_org_timestamp` skipped only all-ASCII-letter tokens, so a deadline
warning (`DEADLINE: <2026-10-01 Thu -3d>`, `--3d`) or a day name outside
English (`jeu.`, `周四`) left the line as text, and every Org user outside an
English locale lost every date.

A token with no digit is now a day name and is skipped. A warning period or
delay (`-` or `--`, digits, one of `h d w m y`) is dropped and counted into one
new `LossyCounts` warning, "N SCHEDULED/DEADLINE warning period(s) or delay(s)
were dropped; their dates were kept"; the count is added only once a line is
read, so a line read in part and then rejected still gives only the "could not
be read" warning. A repeater the rule cannot express still makes a line
unreadable, as before. The Org file converter passes planning lines through, so
`.org` imports get the fix too.

Three existing tests named `-2d` as unreadable, which the decision reverses:
the unit test of unreadable lines and the Logseq task-syntax command test
swapped it for `+1h` or `-2d +1h` (still unreadable), and the second-repeater
test's rejected line gained a `-1d` so a dropped period on a rejected line is
pinned too.

Ran: nextest over the whole `agaric-engine` package and the import, planning
and org filters, clippy `--workspace --all-targets`, the `SQLX_OFFLINE` check,
`cargo doc`, `cargo fmt --check`, the manual prek stage. The e2e-tauri specs
`just e2e-related` selects run in CI.
