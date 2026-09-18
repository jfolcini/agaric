# Session 1788 — review notes from #5107

One non-blocking note on #5107, verified before acting: `_validate.yml`
routes the guard scripts that have vitest files to the `frontend` category,
and `scripts/check-mutation-reports.mjs` was not on that list. #5106 gave it
a vitest file without routing it, so #5107, which changed exactly that
script, ran with `validate / vitest` skipped and the guard's only unit tests
never executed. One alternation added to `frontend_re`; the comment's count
moves from six to seven.
