# Session 2487 — the first click below the search-history dropdown lands

The #5738 sweep found a lost click on the Search view.
- **The cause:** the search-history dropdown sits in normal page flow and
  shows only while the input is focused. Pressing a control below it blurred
  the input and unmounted the dropdown, so the panel moved up under the
  pointer and the release landed somewhere else.
- **The effect:** these controls each needed a second click:
  - a Recent page card;
  - *Add filter*;
  - during a history recall, a chip's remove button and *Clear all*.

**Changed:** each of the four controls now prevents the default mousedown,
so the input keeps focus and the click lands. The history and autocomplete
rows already work this way.
- **Unchanged:** keyboard activation, right-click (*Open in new tab*),
  middle-click (background tab) and touch taps.
- **Focus afterwards:**
  - *Add filter* still moves focus into its popover;
  - *Clear all* now leaves focus in the input instead of the page body.

**Rejected:** overlaying the dropdown, which needs a Radix rebuild and covers
these controls, and delaying the hide, which is a timeout that was removed
before.

**Spec:** `e2e/search-recent-click.spec.ts`. With search history showing, one
click each:
- opens a Recent card's page;
- opens *Add filter*;
- removes a chip;
- clears all chips.

A vitest pins the Recent card's mousedown keeping the input focused.

**Shown red:**
- **All four guards removed:** every test fails.
- **Each guard alone removed:** its own assertion fails, in the spec and the
  vitest.

**Review** merged the change with #5798 locally. Both PRs' tests pass on the
result, and *Clear all* still writes the free text and re-runs it.

**Ran:**
- the new spec with `--repeat-each=3`;
- every search and recent-pages spec;
- vitest over the Search panel and `src/components/search`;
- `npm run typecheck`, type-aware oxlint and oxfmt.
