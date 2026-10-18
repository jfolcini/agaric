# Session 2617 — two "on every PR" claims Playwright no longer meets

Since #5869 the classifier starts Playwright only when a diff can affect
it, so `e2e/AGENTS.md`'s "Its other tests run on every PR" and
`e2e/perf.spec.ts`'s "costs on every PR" now say "whenever Playwright
does" and "in every Playwright run". A #5869 note, found by the session
that handed #5903 over.
