# Session 4546 — #7165 U4, U5: one control height on touch, a compact brand switch

Round 3 of the UI review, lane B. A first attempt was lost before it pushed. This one restarted from `origin/main`.

**U5: control heights on a coarse pointer**

- `Input` is `h-9` on every pointer, a button's height. It can't carry a pseudo-element hit area, so on touch it gives up 8 px of tap height. The comment where the height is set says so. The 16 px touch text (the iOS zoom guard) stays.
- Framed icon buttons (`icon`, `icon-sm`, `icon-xs` in every variant except ghost and link) are 36 px on touch with `touch-hit-area`. Ghost and link icon buttons keep a 44 px box through a compound variant. Such a button paints nothing at rest, so the 44 px box shows only as its hover fill. The phone header, drawer and toolbars are laid out on those boxes.
- `SearchInput`'s clear button is 28 px with a hit area, so it fits inside the 36 px field.
- On a phone, Pages' sort trigger and New page button were 36 px tall but forced 44 px wide. Both are now 36 px squares.
- `Textarea`'s minimum height has no tie to the 44 px rule, so it is unchanged. The Tasks & reminders time input is an `Input`, so it follows.

**U4: switches and segmented toggles**

- `Switch` on touch is 24 × 44 px with `touch-hit-area`; on desktop it stays 20 × 36 px. The on track is `bg-brand`; the off track stays `bg-muted-foreground/40` in light and is `/12` in the dark themes (see Contrast). The thumb is white in every theme and state. A theme token would turn dark under a dark theme.
- Premise check: the Tasks & reminders and bug-report switches were already centred by `ToggleRow`'s `items-center`. But each sat 2 px high, because an `inline-flex` switch in a block wrapper leaves room for a descender under it. `ToggleRow` renders the switch `flex`.
- `MirrorSection`'s four switch rows used a bare `SettingRow`, which stacks into a column below `sm`. They now go through `ToggleRow`, which gains an optional `description` and a `ref` for the mass-change focus return.
- `ToggleGroup` on a phone filled its row with `flex grow`. In a flex column that also stretched it down: 367 px in the search sheet's All pages mode. It keeps `grow` and adds `max-h-fit`, which stops the stretch down a column and does nothing in a row. Lane C's reviewer tested this in place of the brief's `w-full` idea, which would shrink a row's siblings. Its heights were already 36 px on touch at every size. On desktop the default and `sm` sizes match the buttons beside them (32 px, 28 px), so they were left alone.

**Contrast** (WCAG, OKLCH tokens from `src/index.css`, composited in sRGB; page / card / popover where they differ)

The off track is `--muted-foreground` at 40 % in the light themes. At 40 % the dark themes' lighter grey left the coral under 3:1 against it (1.90 to 2.68), so under `.dark` it is 12 %.

| Theme | off track | on vs off | white thumb on off | off vs surface | on vs surface | white thumb on on |
|---|---|---|---|---|---|---|
| Light | muted-fg 40 % | 3.32 | 1.83 | 1.77 | 5.89 | 6.07 |
| Solarized Light | muted-fg 40 % | 3.16 | 1.92 | 1.76 | 5.55 | 6.07 |
| Dark | muted-fg 12 % | 4.94 / 4.32 / 3.90 | 15.42 / 13.49 / 12.18 | 1.20 / 1.23 / 1.24 | 5.93 / 5.32 / 4.83 | 3.12 |
| Solarized Dark | muted-fg 12 % | 4.59 / 3.91 / 3.91 | 14.32 / 12.22 / 12.22 | 1.20 / 1.21 / 1.21 | 5.50 / 4.75 / 4.75 | 3.12 |
| Dracula | muted-fg 12 % | 3.72 / 3.24 / 3.24 | 11.61 / 10.11 / 10.11 | 1.26 | 4.68 / 4.07 / 4.07 | 3.12 |
| One Dark Pro | muted-fg 12 % | 3.61 / 3.15 / 3.15 | 11.29 / 9.83 / 9.83 | 1.25 / 1.24 / 1.24 | 4.50 / 3.90 / 3.90 | 3.12 |

- On vs off clears 3:1 everywhere; the tightest is One Dark Pro on a card, 3.15.
- In the dark themes the faint off track is 1.20 to 1.26 against its surface; the white thumb on it, 9.8:1 or more, is what marks the control.
- The white thumb on the light off track is 1.83 (1.92 in Solarized Light), as before. Its shadow outlines it.

**Tests**

- `e2e/control-heights.spec.ts`, on Pixel 7 and 1440 × 900, pins the heights, the switch's size and centring, its colours in both themes, and the toggle group in a flex column. Each was shown red by breaking the code in one trap-restored command:
  - restoring the input's 44 px: 44 for 36;
  - the switch's old `h-7`: 28 for at most 24;
  - `bg-primary`: a dark track for `--brand`;
  - dropping the dark 12 % off track: 0.4 alpha for 0.12;
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
- Two more specs pinned the old heights. Old → new:
  - `phone-touch-targets` "the Tags and Templates name inputs": `expect44` on each input → each input and Add tag are 36 px tall. Red with the 44 px input: 44 for 36.
  - `phone-view-headers` "Pages: … search pinned": `search.top - bar < 16` → `⋮.top - bar < 16`. The pinned row is as tall as its 44 px ghost ⋮, and the 36 px search is centred in it, 16 px below the bar.
- Related e2e run: 130 specs that touch these controls (switch, radiogroup, search clear, 44 px probes, phone profiles). 676 passed; the two above failed and were updated, then 21 of 21 passed.
