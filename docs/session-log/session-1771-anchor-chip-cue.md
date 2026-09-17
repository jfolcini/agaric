# Session 1771 — the anchor-chip marker stops impersonating a focus ring

#5076. In a Linked References row, the chip naming the page being viewed
carried `outline: 2px solid var(--ring); outline-offset: 1px`. `--ring` is the
token `focus-visible` owns, and in the default theme it is a crimson
(`oklch(0.55 0.25 28.71)`), so a permanent opaque 2px of it inline in a
sentence read as a focus ring or a validation error rather than as "this is
the link that put the row here".

Screenshotting it against the real app confirmed the rest of the report: at
`outline-offset: 1px` around an `11.9px` `rounded-md` pill, the outline draws a
stray red oval visibly clear of the fill, and the word space before the chip
disappears into the gap. The rule's own comment claimed it was "one step down
in weight" from focus, but the only step taken was 3px → 2px; the focus ring is
50% alpha and this was fully opaque, so it read *heavier* than the thing it was
supposed to defer to.

Maintainer picked the hug-the-chip direction of the three the issue listed:

```css
outline: 1px solid color-mix(in oklab, var(--ring) 55%, transparent);
outline-offset: 0;
```

`oklab` rather than `oklch` for the mix, matching `--embed-surface`, the file's
existing `color-mix` precedent — mixing toward `transparent` in a polar space
interpolates hue for no reason.

A hairline at 55% is the first cue to vanish for users who asked for more
contrast, so `@media (prefers-contrast: more)` takes it back to opaque and 2px.
Focus stays above it there: that block's `:focus-visible` override is 3px of
`currentColor`, a different colour as well as a heavier one. The override sits
directly under the rule rather than in the accessibility section at the foot of
the file, following the `--embed-surface` convention of keeping a token and its
contrast sibling together.

## Verified

Playwright against the real frontend (`Getting Started` → the linked-references
panel), before and after, reading the screenshots and the computed style:

- before: `lab(45.27 78.87 75.45) solid 2px`, `outline-offset: 1px`
- after: `oklab(0.55001 0.219238 0.1201 / 0.55) solid 1px`, `outline-offset: 0`

No unit test pins the CSS — jsdom applies no stylesheet, and an assertion on
the declaration would only restate it. What is pinned is that the right chip
gets the class, by the three existing tests in
`BacklinkGroupRenderer.anchorChip.test.tsx`, which stay green.
