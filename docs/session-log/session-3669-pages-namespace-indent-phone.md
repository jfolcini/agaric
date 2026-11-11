# Session 3669 — Namespaced pages indent half a phone screen

On a phone, the Pages list's namespace tree started about a third of the screen in from the flat page rows around it. A page three levels deep sat near the middle of the screen.

- The cause was the gutter, not the per-level step (16px). `page-tree-gutter` reserves the flat row's checkbox and star width, 2 × 44px under `pointer: coarse`. A touch phone's `PageRow` hides both (`useIsTouch() && useIsMobile()`), so the tree reserved width that no flat row used.
- `TreePageRow` now takes the gutter only where `PageRow` draws those affordances, on the same predicate. On a phone it takes `pl-3`, the flat row's own inset. The 16px step stays and has no depth cap: without the bogus gutter, five levels cost 80px.
- `PagesTreeSection` (child pages under the editor) has no gutter and was already fine. No other surface indents by namespace depth.
- `pages-namespace-indent.spec.ts` gains an iPhone 13 test. A namespace root aligns with a flat row's content, and a nested title starts at most one level in. It went red on main (root 112px right of the flat content) and green with the fix.
