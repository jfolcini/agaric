# Session 4454 — the graph fills its canvas on a phone, and journal pages get their own tone

Part of the #7040 UI review: the Graph halves of items P9 (phone) and D6 (desktop). The Query half of D6 is separate.

**What shipped**

- **Journal pages draw in `--graph-journal`**, a new token defined in all six themes, apart from each theme's red accent and focus ring. The current page keeps `--graph-accent`. Templates keep the page tone, since amber beside the red accent is hard to tell apart for colour-blind users.
- **The filter bar and the local-graph control are a plain row above the canvas** on every width. They used to be an overlay inside the bordered canvas, covering its top, and the fit ignored them.
- **Framing:**
  - The fit padding is `min(64, shorter side / 8)`, so a phone keeps more of its canvas and desktop is unchanged.
  - Gravity is stronger on the canvas's shorter axis, by its aspect ratio squared (d3 `forceX`/`forceY` strengths), so a tall phone canvas gets a tall layout.
  - A phone's fitted zoom went from about 0.70 to 1.31, so hub labels now show there; at 0.70 no node reached #5430's 6 px label threshold.

**False premises in the issue**

- Nodes were already sized by degree (#5429).
- Labels already had collision handling (#5430). "Faint labels" on a phone meant no labels, because of the zoom.
- None of the graph's controls intersected the capture button: the zoom controls already move to bottom-left on a phone.

**Tests**

- vitest:
  - journal tone in `markNodes`;
  - the phone fit padding;
  - a tall canvas lays out taller than wide;
  - `theme-contrast`'s new "graph journal node" pair in every theme, with and without more contrast.
- e2e (`graph-view`): a journal node's fill differs from a page's. On a phone the filter row sits above the canvas, unboxed, and neither it nor the zoom controls intersect the capture button.
- Each was shown red before the change and by a mutation after it.
- The graph vitest set passed (24 files), and the graph and phone specs passed as local bridge copies.
