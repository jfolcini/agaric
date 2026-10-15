# Session 2119 — Drop CodeQL's js/superfluous-trailing-arguments

Code-scanning alerts #283, #284 and #285 flag `new StorageEvent('storage',
init)` in `src/lib/local-storage-preference.ts` and its tests. The alert
links the callee to CodeQL's bundled `externs/web/webstorage.js`, not to any
code here: CodeQL's stub constructor takes fewer parameters than the DOM one.
These are #233, #234 and #236 again. Those were dismissed as false positives
and closed when #5527 moved the hook from `src/hooks/` to `src/lib/`.

Every alert this rule has raised in the repo was dismissed as a false
positive. The one closed as fixed (#129) pointed at the `ResizeObserver` mock
in `src/test-setup.ts`, not at a defect. So the rule is excluded in
`.github/codeql/codeql-config.yml`, next to the `rust/unused-variable`
exclusion and for the same reason: another gate already answers the question
exactly. `tsc -b` reports an extra argument as TS2554. Checked by adding
`one(1, 2)` against a one-parameter function in a `src/__tests__` file, which
`npm run typecheck` rejected, then removing it.

Excluding a query does not close its open alerts. The last
`rust/unused-variable` alerts were dismissed by hand on the day that
exclusion landed. #283, #284 and #285 are dismissed as false positives the
same way, pointing at this PR.
