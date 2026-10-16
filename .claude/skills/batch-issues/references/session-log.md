# Session log — numbering and format

`docs/session-log/README.md` owns layout, numbering, and immutability; this file covers what the loop adds.

**Number:** one log per PR. The `session-log-numbering` guard sees only your branch and `origin/main`, not unmerged branches, so parallel PRs that each pick a number collide. The orchestrator assigns every in-flight PR a distinct number from the README's window before builders launch; builders never pick one. Other sessions draw from the same window: while any is active, take numbers from its upper part, not `max + 1`, and right before pushing check `origin/main` and the open PRs (`gh pr list --state open --json files --jq '.[].files[].path' | grep session-log`). A renumber renames the file and fixes its H1 in one staged change, since the guard checks the H1 against the filename.

**Format:** the first line is `# Session NNNN — <title>` (a real H1). Then short prose for a future agent: what the session set out to do, the decisions and traps, what shipped (PR numbers), and which suites actually ran. Not a review diary: no round-by-round narrative, workflow snippets, or metadata.
