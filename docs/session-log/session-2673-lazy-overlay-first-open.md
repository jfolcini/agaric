# Session 2673 — the first Cmd+K, Ctrl+F and search-sheet open render at once instead of 300 ms later

Found while speeding up `App.test.tsx` (#5908): the first open of each search
overlay waited behind React's Suspense reveal throttle although `App.tsx`
preloads their chunks.

- **Mechanism (React 19.3.0):** `lazyInitializer` calls the factory, attaches
  `then(cb)` and, in the same call, checks whether `cb` already set the payload
  resolved; the old factory, `loadX().then(m => ({ default }))`, returned a new
  Promise each time, whose `cb` runs a microtask late. So the first render
  always suspended, committed the null fallback, and the retry waited out
  `FALLBACK_THROTTLE_MS` (300 ms) after it.
- **Fix:** `lazyView`, written for the views in #5444 for exactly this, moves
  to `src/lib/lazy-with-preload.ts` as `lazyWithPreload`: its factory hands
  `lazy` a thenable whose `then` calls back at once once preloaded, so nothing
  suspends. `CommandPalette`, `InPageFind` and `SearchSheet` use it and
  `preloadSearchOverlays` calls each `.preload()`; the search sheet's own lazy
  `InPageFind` and `PaletteBody` had the same problem and preload with its
  module. What is lazy and when chunks download are unchanged.

Measured in Playwright, 10 fresh loads each, Cmd+K to the palette input in the
DOM: median 400 ms (max 528) before, 22 ms (max 65) after, at load 35–40.

Tests: `App.test.tsx`'s overlay test expects each overlay right after its
opening `act` once the idle preload has run, and
`SearchSheet.preload.test.tsx` does the same for the sheet's segments; both
fail on main's code at the predicted lookup.

Ran: vitest over `App.test.tsx`, `src/components/mobile/__tests__/` and the
ViewDispatcher tests (208), `npm run typecheck`, `oxlint src`, the 14 palette,
find and search Playwright specs (76).
