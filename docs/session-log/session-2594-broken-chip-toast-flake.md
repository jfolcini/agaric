# Session 2594 — The broken-chip spec clicks Undo on the newest toast

`link-chip-lifecycle.spec.ts › from a static block…` (from #5863) failed on #5870's
Playwright shard: the click on the toast's Undo timed out, with the front toast
reported as intercepting pointer events.

**Cause:** the test removes the broken link twice, so two "Broken link removed" toasts
can be on screen at once. `removedToast` took `.last()`, documented as the newest,
but sonner prepends each new toast to its list, so the DOM's last toast is the oldest,
stacked behind the front one. Whether the test passed depended on the first toast
having expired before the second click. It now takes `.first()`.

**Shown red:** with the toast given `duration: Infinity` so the first one stays on
screen, `.last()` failed exactly as CI did (front toast intercepts pointer events, at
the Undo click) and `.first()` passed.

**Ran:** the whole spec file, 8 passed; oxlint and oxfmt on it.
