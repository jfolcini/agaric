# Session 3721 — Text never sits in a pill

The maintainer saw strongly rounded controls on mobile: the "Exclude journal pages" filter pill in the graph filter bar first, and the same shape across the app. This makes the radius rule part of the design system and sweeps every text-bearing pill.

- The rule now sits in the `src/index.css` radius comment and `docs/UX.md` § Radius. Anything that carries text takes `--radius-sm` (chips and badges, through `Badge`) or `--radius-md` (controls), never `rounded-full`. Full rounding is only for things round by nature: dots, swatches, avatars, the switch, spinners, progress and scrollbar thumbs, the FAB, and icon-only buttons floating over media.
- In the variants: `Badge`'s `shape` axis loses `pill`, so `rounded` (`rounded-sm`) is the only shape and the default. `PropertyChip` composes it. `FilterPill` takes `rounded-md`, since on touch it is a 44px-tall control, and its remove button takes `rounded-sm`, concentric inside it.
- Hand-rolled text chips and controls are swept:
  - Date, repeat, property-overflow and attachment chips.
  - The agenda due chip and the journal count chips.
  - The Group by / Sort by buttons.
  - The History touch-nav bar.
  - The in-chip remove buttons of the alias, tag, agenda-filter and search-history chips.
- The screenshots showed one row mixing 4px priority badges with fully round date chips. They now share one shape.
- With maintainer approval, the two tests that pinned the old pill (`badge.test.tsx`, `PropertyChip.test.tsx`) now pin the new radius and assert `rounded-full` is absent. Both went red with the pill restored. A new `filter-pill.test.tsx` case pins the control radius and was shown red the same way.
