# Session 4546 — #7165 U4, U5: one control height on touch, a compact brand switch

Round 3 of the UI review, lane B. A first attempt was lost before it pushed. This one restarted from `origin/main`.

**U5: control heights on a coarse pointer**

- `Input` is `h-9` on every pointer, a button's height. It can't carry a pseudo-element hit area, so on touch it gives up 8 px of tap height. The comment where the height is set says so. The 16 px touch text (the iOS zoom guard) stays.
- Framed icon buttons (`icon`, `icon-sm`, `icon-xs` in every variant except ghost and link) are 36 px on touch with `touch-hit-area`. Ghost and link icon buttons keep a 44 px box through a compound variant. Such a button paints nothing at rest, so the 44 px box shows only as its hover fill. The phone header, drawer and toolbars are laid out on those boxes.
- `SearchInput`'s clear button is 28 px with a hit area, so it fits inside the 36 px field.
- On a phone, Pages' sort trigger and New page button were 36 px tall but forced 44 px wide. Both are now 36 px squares.
- `Textarea`'s minimum height has no tie to the 44 px rule, so it is unchanged. The Tasks & reminders time input is an `Input`, so it follows.

**U4: switches and segmented toggles**

- `Switch` on touch is 24 × 44 px with `touch-hit-area`; on desktop it stays 20 × 36 px. The on track is `bg-brand` and the off track stays `bg-muted-foreground/40`. The thumb is white in every theme and state. A theme token would turn dark under a dark theme.
- Premise check: the Tasks & reminders and bug-report switches were already centred by `ToggleRow`'s `items-center`. But each sat 2 px high, because an `inline-flex` switch in a block wrapper leaves room for a descender under it. `ToggleRow` renders the switch `flex`.
- `MirrorSection`'s four switch rows used a bare `SettingRow`, which stacks into a column below `sm`. They now go through `ToggleRow`, which gains an optional `description` and a `ref` for the mass-change focus return.
- `ToggleGroup` on a phone filled its row with `flex grow`. In a flex column that also stretched it down: 367 px in the search sheet's All pages mode. It keeps `grow` and adds `max-h-fit`, which stops the stretch down a column and does nothing in a row. Lane C's reviewer tested this in place of the brief's `w-full` idea, which would shrink a row's siblings. Its heights were already 36 px on touch at every size. On desktop the default and `sm` sizes match the buttons beside them (32 px, 28 px), so they were left alone.

**Contrast** (WCAG, OKLCH tokens from `src/index.css`; off track = `--muted-foreground` at 40 % over the surface)

| Theme | on vs off track | on vs surface (page / card / popover) | thumb (white) on on | thumb on off |
|---|---|---|---|---|
| Light | 3.32 | 5.90 | 6.07 | 1.83 |
| Dark | 2.69 / 2.44 / 2.26 | 5.92 / 5.35 / 4.83 | 3.12 | 8.38 / 7.04 |
| Solarized Light | 3.15 | 5.56 | 6.07 | 1.93 |
| Solarized Dark | 2.67 / 2.39 / 2.39 | 5.49 / 4.77 / 4.77 | 3.12 | 8.34 / 7.47 |
| Dracula | 2.09 / 1.91 / 1.91 | 4.69 / 4.08 / 4.08 | 3.12 | 6.53 / 5.96 |
| One Dark Pro | 2.11 / 1.93 / 1.93 | 4.52 / 3.91 / 3.91 | 3.12 | 6.59 / 6.01 |

- `--brand` clears 3:1 against every surface in every theme.
- It fails 3:1 against the off track in every dark theme (1.91 to 2.69). The thumb's position still marks the state.
- The white thumb fails 3:1 on the light off track (1.83), as it did before. Its shadow outlines it.

**Tests**

- `e2e/control-heights.spec.ts`, on Pixel 7 and 1440 × 900, pins the heights, the switch's size and centring, its colours in both themes, and the toggle group in a flex column. Each was shown red by breaking the code in one trap-restored command:
  - restoring the input's 44 px: 44 for 36;
  - the switch's old `h-7`: 28 for at most 24;
  - `bg-primary`: a dark track for `--brand`;
  - the old thumb: not white;
  - `inline-flex` in `ToggleRow`: off centre by 2 px;
  - dropping `max-h-fit`: 367 for 36;
  - the 44 px New page: 44 for 36.
- `e2e/table-handles.spec.ts`: the handles' 44 px boxes became 36 px boxes with a 44 px `::before` hit area. The row handle overhangs the screen's edge, so a tap probe can't reach its left side. Making the outline icon buttons 44 px again turned it red.
- Updated vitest class assertions (old → new):
  - `button.test`: `coarse:size-(--touch-target)` on every icon size → `touch-hit-area` plus `coarse:size-9` for framed, and the 44 px box for ghost;
  - `input.test` and `primitives.test`: `coarse:h-(--touch-target)` → none;
  - `search-input.test`: `coarse:h/w-(--touch-target)` → `touch-hit-area`;
  - `switch.test`: `coarse:h-7` / `coarse:w-12` → `coarse:h-6` and `touch-hit-area`.
