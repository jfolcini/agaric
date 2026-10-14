# Session 2036 — Page open: pin its IPC, before/after #5481

Set out to finish #5445's acceptance: the before/after IPC counts for opening a page and following a link chip, which #5481 shipped without.

What shipped: one test in `e2e/perf.spec.ts`, next to the #5366 view table, opens a page from the Pages list and then follows a link chip, and pins each step's IPC as a sorted list of command names, from the click until the page settles. Measured on the commit before #5481 and on `main`: page open 19 → 15 calls, link click 18 → 16. The four gone at open are the second `get_properties` (one shared fetch), the collapsed unlinked panel's `get_page_aliases`, and the two closed filter builders' `list_tags_by_prefix('')`.

Traps: the issue's 20 counted a palette open and the boot sync's calls; this opens from the Pages list after the boot sync has run. The seeded page is short, so the unlinked panel is already in view and `list_unlinked_references` is still sent; holding it back needs a long page. The test pins the set, not the rounds, so #5481's `Promise.all` on the link click is not visible in it.

Ran: `e2e/perf.spec.ts` (6 passed, 2 opt-in skipped; the new test 3/3 with `--repeat-each=3`), shown red by re-adding the unlinked panel's eager `get_page_aliases`; `npm run typecheck:e2e`, oxlint, oxfmt.
