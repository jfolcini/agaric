# Session log — numbering and format

`docs/session-log/README.md` owns layout, numbering, and immutability; this file covers what the loop adds.

**Number:** one log per PR. The orchestrator assigns it when it commits that PR, with `node scripts/next-session-log.mjs`, not before builders launch: the `session-log-numbering` guard checks the number against `origin/main` and the branch, so one handed out early falls behind the PRs that merge meanwhile. Builders never pick one. The script also counts the open PRs' logs; two sessions committing at once can still take the same number, which the PR-collision check reports. A renumber is `node scripts/next-session-log.mjs --rename <file>`, which fixes the H1 the guard checks against the filename; stage both paths.

**Format:** the first line is `# Session NNNN — <title>` (a real H1). Then short prose for a future agent: what the session set out to do, the decisions and traps, what shipped (PR numbers), and which suites actually ran. Not a review diary: no round-by-round narrative, workflow snippets, or metadata.
