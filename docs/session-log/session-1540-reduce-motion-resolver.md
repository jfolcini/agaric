# Session 1540 — Animations Off now reaches the JavaScript

Fifth PR of the batch run alongside a second agent in another container (sessions 1536 to 1539 carry the others). This PR closes #3285 in the scope the maintainer narrowed on 2026-09-02; the media-query singleton rewrite and the migration of the inline scroll copies onto the shared helper were dropped there.

Every JavaScript-driven motion site read the OS `prefers-reduced-motion` query directly, so the app's own Animations preference was invisible to the d3 graph layout, drag auto-scroll, the lightbox, the drop animation and the smooth-scroll sites: Off stopped the CSS and nothing else, and Full could not override an OS flag. One resolver, `shouldReduceMotion()`, now answers the question: Off is true, Full is false, System and Fast defer to the OS query. It lives in `src/lib/preferences.ts` because the tier-layering ratchet forbids `lib` importing `hooks` and three of the sites are lib-tier; `useMotionPreference.ts` re-exports it. Eleven sites swap their inline read for it at the same point they read before, so no per-frame localStorage read was introduced; the reviewer checked each placement.

Review also found that `usePrefersReducedMotion` only re-synced on the OS query's change event, so `DaySection` kept its old lazy-mount decision after a Settings flip until remount. The preference writer already broadcasts a synthetic storage event, so the hook subscribes to that too; nothing new was built. `'fast'` under an OS reduce flag still plays CSS motion at half speed while JavaScript motion is suppressed; that asymmetry errs toward less motion and is left.

Verified: all four resolver arms as separate cases, a site-level test through the real resolver, and a reactivity test through the real preference writer; the preference arms removed reddens three tests, the storage listener removed reddens the reactivity test, both restored `cmp`-identical. Full vitest: 807 files, 18594 passed, 1 expected fail, 37 skipped. Typecheck, oxlint, the import-cycle and lib-layering guards clean.

Shipped: fix for #3285.
