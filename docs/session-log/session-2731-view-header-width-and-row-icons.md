# Session 2731 — the view header vanishing on desktop, and the Pages row icons

Maintainer report (#5992): the Pages row's `↗` drew as a colour emoji, and on desktop the Blocks | Page switch "disappears together with other controls".

Root cause of the switch: it was never the switch. Reproduced on the mock: after a mouse window went below 768 px and back, the whole view header (title, switch, bookmark, kebab) was gone, on every view. `ViewHeaderOutletSlot` (#5955) keeps two portal targets, one above the scroller and one inside it, and picks by width alone. The two slots re-render in separate commits as the width crosses `md` (a console trace showed the order), so going wide the outer slot attached before the inner one detached, and the detach's `setOutlet(null)` won. Going narrow happened to run detach first, which is why only widening lost it. Separately, below 768 px a mouse window got the phone's scroll-away header, so the switch scrolled off with the content.

Shipped:
- The slot's ref callback returns a cleanup that clears the outlet only if it is still its own element.
- The inner slot serves only on `useIsTouch() && useIsMobile()`, the touch-phone signal #5990 used for the header bar and Back / Forward; a narrow mouse window keeps the header pinned. App's and the phone spec's comments say "touch phone".
- `PageRow`'s counts draw lucide `Link2` (links, the app's link icon in `UnlinkedReferences` and `DependencyIndicator`; `ArrowUpRight` reads as "open externally") and `List` (blocks, an outline's bullets) at `h-3 w-3`, in `currentColor` so `text-muted-foreground` holds in both themes. No other UI chrome in `src/` draws an emoji-prone glyph; the rest are in comments or the keyboard-chord names.

Ruled out on the mock at 1280 and 700: tag page and source mode hide the switch by design (`pageModeOffered`), star and kebab stay; page mode, a long title and navigating between pages kept the header.

Tests: `ViewHeaderOutlet.test.tsx` (slot order, narrow mouse window), `PageRow.test.tsx` (an SVG per count), `e2e/view-header-width.spec.ts` (scroll at 700, 700↔1280 by mouse, 1000→700→1000 on touch), `pages-view.spec.ts` metadata badges, and the two real-backend specs that read the `N ↗` text (`pages-most-linked`, `sync-cross-space-move`; a first push missed them, CI caught it). Falsified in one command each: the old width-only gate (vitest narrow-window and e2e scroll red), the old ref callback (vitest order and e2e touch red), both (e2e mouse widening red), the old glyphs (vitest text-content red).
