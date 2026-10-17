# Session 2296 — Toolbar icons render at 16 px instead of a blurry 12

#5682: the maintainer asked whether the toolbar icons were small and blurry.
They were, and smaller than the code said.

**Measured** (Playwright against the mock, at pixel ratios 1, 2, 0.9, 1.1
and 1.25):
- **Size.** Every icon in the formatting toolbar, the selection bubble and the
  Format popover rendered at 12×12 in a 24 px button. The `icon-xs` Button
  variant forces 12 px on any icon without a `size-*` class, which overrode
  the `h-3.5 w-3.5` the call sites asked for.
- **Stroke.** lucide's two-unit stroke becomes a 1 px line at 12 px that
  mostly lands between pixels. At 1x, 84% of the bubble's inked pixels were
  only partly covered.
- **Position.** The icons do sit on half pixels, because the page title's
  37.5 px line box shifts everything below it. Rendering them on whole
  pixels changed nothing, so position is not the blur.
- **Thinner strokes.** 1.5 and 1.75 looked fainter, not sharper, so the
  default stays.

**Fix.** One shared `toolbarIconClass` (`size-4`) for every icon in the
formatting toolbar, the Edit as Markdown toolbar, the overflow button, the
bubble menu and the Format popover. The buttons keep their 24 px (44 px on
touch), so the toolbar layout and its overflow do not move. Partly covered
pixels in the bubble at 1x fell from 84% to 68%.

`e2e/toolbar-icons.spec.ts` requires 16×16 for the 17 toolbar and 7 bubble
icons. It failed with all 24 at 12×12 with the old class restored, and
passed ten repeated runs with the fix.

**Not done here.** `icon-xs` forces 12 px on about 49 other call sites that
ask for 14 or 16 px, and `h-*`/`w-*` on an icon inside any Button has no
effect; only `size-*` does. Fixing that is the follow-up on #5682.

Gates: vitest (564), `npm run typecheck`, oxlint, oxfmt, and the toolbar,
bubble, mobile, Edit as Markdown and overflow Playwright specs (150 passed,
2 skips that already existed).
