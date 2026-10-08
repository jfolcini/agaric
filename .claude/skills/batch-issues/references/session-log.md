# Session log — numbering and format

`docs/session-log/README.md` owns layout, numbering, and immutability; this file covers what the loop adds.

**Number:** one log per PR. The `session-log-numbering` guard sees only your branch and `origin/main`, not sibling unmerged branches, so parallel builders that each pick a number collide. The orchestrator assigns every in-flight PR a distinct number from the README's window before builders launch; builders never pick one.

**Format:** the first line is `# Session NNNN — <title>` (a real H1; the guard checks it against the filename). Then short prose for a future agent: what the session set out to do, the decisions and traps, what shipped (PR numbers), and which suites actually ran. Not a review diary: no round-by-round narrative, tables, counts, workflow snippets, or metadata.
