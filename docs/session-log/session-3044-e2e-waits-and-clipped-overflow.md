# Session 3044 — e2e waits on real conditions; the overflow check sees a view's own clipped overflow

This is the second slow-and-flaky batch. It takes the items batch 1 found: the overflow gap, `mobile-overflow`'s sleeps, and the fixed pauses left in `e2e/`. Times come from a loaded box, so read the direction, not the digits.

**Changed:**
- **The page-root overflow check fails on any box that clips content sideways where the user cannot scroll to it** (`collectClipped` in `e2e/helpers.ts`).
  - The app shell and every `ScrollArea` viewport clip with `overflow-x: hidden`. So a view wider than its column never reached the document's `scrollWidth`, and the old check passed.
  - Not flagged:
    - a box the user can scroll;
    - a text ellipsis;
    - a visually hidden box (`clip-path`, or the `clip: rect(...)` that Radix's visually-hidden labels use);
    - a `data-overflow-clip="intentional"` marker.
  - The diagram viewer's zoom-and-pan area now carries that marker. It clips its own diagram on purpose, and the check flagged it in all three zoom states.
- **`mobile-overflow` waits for each view's heading and no `aria-busy`,** instead of `networkidle` plus a 250 ms sleep. `expectViewLoaded` moved to `helpers.ts`, shared with `interface-zoom`.
- **Drag helpers wait for a frame, or for the row to lift,** instead of fixed step pauses. The table, scroll and dnd specs wait on their own conditions.
- **The pauses that remain** are absence checks or the gesture itself (a long press, a wheel cadence), each with its reason.

**Red first:**
- **A `<header>` forced to 900 px:** the new check fails on Pages and Trash at both phone profiles, naming the clipping `sidebar-inset`. The old check passed.
- **A 2,000 px element inside the Trash view's scroller:** the new check fails, naming the `ScrollArea` viewport. The old check passed.
- **The five exclusion clauses:** each, removed alone, reddens exactly its paired fixture in `horizontal-overflow-helper.spec.ts`.
- **The `clip: rect` clause:** the reviewer called it dead. Removing it reddened 25 view tests on a 1 px visually hidden box, so it stays.
- **The diagram viewer's marker:** removing it flags the viewer fitted, at 100% and zoomed.

**Found, not changed here:**
- **At 820 px wide, Settings › General and Settings › Keyboard clip their cards:** the date-format label and the "Edit shortcut" buttons run past the card. No spec covers that width; it is fixed separately.
- **`e2e/AGENTS.md`'s overflow section** still describes only the document-width check. It is left for the maintainer, per the AGENTS edit rule.

**Review:**
- A second agent re-ran each red, and ran the dnd specs ×5 and the table and scroll specs ×6 under CPU load: all passed.
- Removing `renderedFrame` before a drop stayed green under load. So it cannot be shown red, but it is harmless, and the specs assert the resulting order.

**Suites:**
- every changed spec plus the dnd users (121);
- `mobile-overflow`, `interface-zoom` and the helper spec (82);
- typecheck and oxlint.
