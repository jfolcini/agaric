# Session 3036 — Four slow tests trimmed: a test that only logged, a middle scale, nesting runs, a zoom sweep's sleeps

The maintainer asked for every slow test to be fixed. This is the first batch from the discovery report's ranked list, the small items (S6–S8). Times are local medians of three runs on a loaded box, so read the direction, not the digits.

**Changed:**
- **`catalog-parity`'s "orphan keys (informational)" test is deleted.** Its only assertion was that the catalog is not empty, and its orphan list went to `console.info`, so it could never fail. `KNOWN_DYNAMIC_PREFIXES` and `baseKey`, used only by it, went with it. The "no missing keys" guard is unchanged.
- **`BlockTree.scale-envelope` drops its 5,000-row middle scale**, keeping 1,000 and 10,000: 8.7 s → 7.4 s. Every assertion is per row or compares the two endpoints. Three planted defects each fail already at 1,000 rows:
  - a quadratic `buildFlatTree`;
  - a layout read in `SortableBlockWrapper`'s effect;
  - an extra render per row.

  The weekly lane runs all of vitest, not tagged files, so moving the test there was not an option.
- **`markdown-roundtrip.property` runs its nesting properties 1,000 times instead of 5,000**: 4.9 s → 1.8 s. Each of seven planted parse/serialize defects was caught within 550 runs in every seeded trial. The one rarer defect, the `>=` in `needsWhitespaceDefuse`, is caught every time by the `#4049` fixpoint test in `markdown-serializer.test.ts`. `SWEEP_RUNS` still raises the count.
- **`interface-zoom`'s largest-zoom sweep** waits for each view's level-1 heading and for no `aria-busy` element instead of `networkidle` plus a 250 ms sleep: 15 s → 13 s. The sleeps were only 2 s of it; the rest is the 11 navigations being swept.

**Found, for the next batch:**
- **The page-root overflow check can miss a view's own overflow.** The app shell clips it, and content inside a scroller is skipped. This affects `interface-zoom` and likely `mobile-overflow`. A header forced to 900 px wide still left the document 682 px wide, and the check passed. Overflow that escapes the shell is caught: the reviewer showed that with a 2,000 px element.
- `mobile-overflow.spec.ts` has the same `networkidle` plus sleep across 22 view tests.
- 40 `waitForTimeout` calls remain in `e2e/`.

**Review:**
- A second agent re-ran the planted defects: four for the property file, three trials each; two for the scale test.
- It ran `interface-zoom` three times and broke it twice. An overflow on `document.body` failed it. A 2,000 px element in flow inside a view's scroller did not, which is the gap above.
- One planted defect survives at any run count: `column += TAB_STOP` in `leadingIndent`. It predates this change.

**Suites:**
- vitest over i18n, the scale test and the editor tests (2,884 tests);
- typecheck and lint;
- `interface-zoom` three times.
