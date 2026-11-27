# Session 4544 — main red: the Group by picker counted the query results as its options

`main` went red on ddefca5 (#7163) in `bridge-specs`: `advanced-query-group.spec.ts` "group by a property key and by a date bucket from the picker" expected the Group by picker's 8 options and got 35. The extra 27 were the query results: every block of the seed, then its pages and tags.

**Cause**

- Radix Select hides the page from assistive tech when it opens. The `aria-hidden` package it uses keeps every `[aria-live]` element exposed, with its ancestors, and hides only the nodes that exist when the Select opens.
- The Advanced query opens on its results, and the results pane holds a `role="status" aria-live="polite"` region. When the results arrive from the real backend after the picker has opened, their listbox mounts as a new sibling of that live region, never hidden. Its options join `getByRole('option')`.
- When the results land first, they are hidden with the rest of the page, which is why the test passed on #7163's own run.
- This is a test-only defect. The app was not changed.

**Fix**

- The assertion reads the options inside the picker (`[data-slot="select-content"]`), as `list-keys-overlays-focus.spec.ts` already does. The later picks use exact option names, which no result row carries.

**Verification**

- Red on the mock: a throwaway copy of the test set `__setMockLatency(1500)` before opening the view. With the unscoped locator, 31 result options joined the picker's 8, the same assertion CI failed on. Scoped, the same run passed. The probe was deleted.
- On the real backend, with the bridge binary from the red run: the spec, 3 tests × 5 repeats at 3 workers, 15 passed.
