# Session 1924: ink primary, Inter, warm neutrals, tighter radius (#5332 items 3–5)

This is the brand batch of the #5332 design plan. The maintainer decided all of it this session:
- item 3: Option A, ink primary;
- item 4: Inter;
- item 5: warm stone in light and graphite in dark;
- the radius, after agreeing the corners were too round.

The red active-nav bar the issue gave to `--brand` was already gone: the maintainer chose a neutral pill with no bar in #5342. That leaves `--brand` with two jobs, the today markers and the quick-capture button. The logo SVG keeps its own red.

## What shipped

**Ink primary**
- `--primary` is near-black in light and near-white in dark: 16.6:1 and 14.7:1 against its label.
- The alternate themes keep their own primaries and inherit `--brand`. The brand pairs are pinned in all six themes, with and without high contrast. The tightest is One Dark at 4.52:1.

**Destructive**
- `--destructive` is crimson, with separate light and dark values.
- In dark the label is near-black. At that chroma, no lightness clears AA both as text on graphite (L ≥ 0.62) and under a near-white label (L ≤ 0.56).
- The shadcn workaround, a white label over `dark:bg-destructive/60`, is AA only where each consumer remembers the `/60`. Review found one that didn't: the query editor's NOT toggle used `text-white` and would have dropped to 3.15:1. That toggle now uses the pinned pair, and the `/60` is removed from Button and Badge.

**Links, tags and cues**
- Links are underlined foreground text.
- Tags are muted pills.
- The Button `link` variant and the Keyboard tab's Reset link are underlined at rest, since ink alone gave them no affordance.
- Pointer-driven drag, drop and swipe cues use the blue ring family.
- Inputs fall back to the native selection colour.

**Font**
- Inter Variable is bundled (`@fontsource-variable/inter@5.3.0`, the opsz axis).
- OFL-1.1 joins the license allowlist. The check passes with it and fails without it.
- The bundle budget counts only `.js`, so the font does not touch it.

**Neutrals**
- Warm stone in light and graphite in dark, with no navy.
- Muted text reads 5.21:1 on `--muted`, 5.60 on the page and 4.69 on the hover fill. It was 4.34 and 3.85.
- The previous PR's slate accents are retuned into the same family. Active nav items keep the full fill and hover keeps half.

**Radius**
- `--radius` is 0.5rem: 6px for rows, buttons and inputs, 8px for cards, 12px for dialogs.

**Cleanup**
- The unused `--sidebar-primary` pair is deleted from every theme.

**Found by the PR's review**
- Dropping `/60` also reached the alternate dark themes, which carry `.dark`: their light destructive labels on an opaque red were 3.3:1 (Solarized Dark), 2.6:1 (Dracula) and 2.2:1 (One Dark Pro). They now take a dark label in their own background hue, and Solarized Dark's red lightens to 0.65. Solarized Light, already 3.8:1 without any `/60`, darkens its red to 0.52. The destructive-label pin moved into the every-theme matrix and went red on the old CSS in all four themes.
- The attach-drop caption is muted text (5.6:1) instead of `text-ring`, which is 4.2:1 as small text.

## How it was built and verified
- A builder, then a separate reviewer.
- Every new contrast pin was shown red against a mutated copy, then restored.
- `npm run typecheck`: clean.
- `npx knip`: clean.
- License check: passes.
- Bundle budget: passes.
- Full vitest: 870 files, 20 690 passed, 1 expected fail, 51 skipped. The run came before the reviewer's NOT-toggle fix, so the AdvancedQuery suites were re-run after it: 66 tests, all passing.
- Playwright: 261 passed. This covered the chip, focus, nav, drag, settings, link and tag specs.
