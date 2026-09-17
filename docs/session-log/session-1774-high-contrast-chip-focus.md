# Session 1774 — focus read lighter than its absence in high-contrast mode

#5082, filed during the #5079 review and fixed here. A keyboard user in
`prefers-contrast: more` tabbing through a Linked References panel had focus as
the *weakest* thing on screen — weaker than the chip's own permanent markings.

## The mechanism, measured

`.block-link-chip:focus-visible, .tag-ref-chip:focus-visible,
.block-ref-chip:focus-visible { outline-hidden; ring-[3px] ring-ring/50 }` is
specificity (0,2,0). The accessibility block's bare `:focus-visible { outline:
3px solid currentColor; outline-offset: 2px }` is (0,1,0), and a media query
adds no specificity, so the chip rule wins and `outline-hidden` stands.

Measured in Chromium with genuine Tab traversal, not inferred from the
stylesheet. Under `prefers-contrast: more`, before the fix:

```
focused chip     outline "3px none lab(40.15 58.86 45.77)" offset 2px
                 ring    oklab(0.500014 0.263086 0.144112 / 0.5)
unfocused anchor outline "2px solid lab(40.15 58.86 45.77)" offset 0
                 ring    none
```

Note the half-application: the accessibility block's *width* and *offset* did
land, because `outline-hidden` only sets `outline-style`. So the outline was
3px wide, painted nothing, and the entire focus indication was a half-alpha
ring — against an unfocused neighbour wearing an opaque 2px outline.

## Why the fix is both halves, not the ring alone

The issue proposed restoring full alpha on the ring. Measuring
`forced-colors: active` first showed that would not be enough:

```
forced-colors active + contrast more, focused chip:
  outline "2px solid rgba(5, 0, 73, 0.8)"   ← Tailwind's outline-hidden fallback
  box-shadow "none"                          ← the ring is GONE
```

Chromium drops box-shadows entirely under forced colours, and
`prefers-contrast: more` matches there too — the same population. A ring-only
fix would have left them with no cue this rule contributes. So the override
does both: `outline-solid` readmits the accessibility block's `3px solid
currentColor` as a cue that survives forced colours, and `ring-ring` makes the
ring opaque so focus keeps `--ring`'s hue — which matters on an *anchor* chip,
whose unfocused state is already `currentColor`, and which would otherwise
differ from focused by 1px of the same colour.

Default mode is untouched: the focused chip's computed outline and box-shadow
strings are byte-identical before and after. No new tokens, no restructuring of
the accessibility block.

## Verified

`e2e/high-contrast-chip-focus.spec.ts`, two tests, against real Chromium. It
Tabs to the chip rather than calling `.focus()` — `:focus-visible` is a
modality, not a state — and pins the ring's *alpha* by resolving `var(--ring)`
live through a probe span, so the assertion does not hard-code a token colour
the high-contrast block already re-keys.

Four independent falsifications, each restored and `cmp`-verified:

- Full revert of `index.css` → `outlineStyle` `"none"` vs expected `"solid"`.
- Half revert (`outline-solid` kept, `ring-ring` dropped) → the ring assertion
  alone reddens, so it is not riding on the outline one.
- Media query removed, making the rule unconditional → the default-mode guard
  reddens, so that guard is not vacuous.
- Ring removed from the base rule → the default-mode test's
  `expect(ring).not.toBeNull()` reddens. That assertion was added in review:
  `not.toBe(opaque)` on its own would also have passed with the ring gone,
  which is the other way to lose focus here.

`npx playwright test e2e/high-contrast-chip-focus.spec.ts --workers=1` →
2 passed. `npm run typecheck:e2e`, `oxlint --type-aware` and `oxfmt --check`
clean on both touched files.

## Left alone, deliberately

Under `forced-colors: active`, Tailwind's own `outline-hidden` fallback pins
the focus outline at 2px system colour, so there the focused chip matches the
anchor's 2px rather than exceeding it. Measured identical before and after, and
both cues remain visible; widening it would mean fighting a Tailwind utility's
forced-colors block for no measured defect.
