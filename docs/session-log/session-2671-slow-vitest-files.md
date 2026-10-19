# Session 2671 — the Edit as Markdown test file stops paying for a toolbar it never uses and for real debounce waits

#5908's slow vitest files, measured locally beside `uptime` (CI is slower by a
roughly constant factor).

- **`PageSourceEditor.test.tsx`** (median 10.6 s → 3.6 s): half its time was
  the source toolbar, which no test there uses but which re-rendered about 34
  tooltip-wrapped buttons on every keystroke; it is stubbed, as
  `src/components/__tests__/AGENTS.md` allows for heavy children, and the
  first toolbar test now asserts the buffer keeps focus when it opens. Eight
  tests waited out the real 300 ms typing debounce; a `typingPause` helper
  fakes timers for the edit and advances exactly 300 ms, pinning the debounce.
- **`PageSourceToolbar.test.tsx`** (5.1 → 4.3 s) mounts the real editor and
  toolbar per test, which is the test. The toolbar's hidden measuring copy no
  longer builds Radix tooltips for its plain buttons, as Format and Turn into
  already did; that also helps the block editor's toolbar. Its header says why
  its cost is its tests.
- **`App.test.tsx`** (9.4 → 7.9 s) is about 129 full App mounts; one test lost
  0.9 s by opening each lazy overlay inside an async `act`, out of React's
  Suspense reveal throttle. Its header says why its cost is its tests.

Shown red: the debounce changed to 600 ms, draft and diff run on every edit,
`discardDraft` not removing the draft, the title lookup delay changed, the
conflict dialog never opening, the toolbar taking focus, and the App overlays
mounting wrongly each failed their predicted assertions.

Found, not fixed here: the first open of each lazy overlay (Cmd+K, Ctrl+F, the
search sheet) still waits up to about 300 ms behind Suspense's reveal throttle
despite the preload, and the React Compiler skips `PageSourceEditor` because of
the `try/finally` in `submit`, so every keystroke re-renders the whole source
toolbar in production too.

Ran: the three files 5 times before and after (239 tests), `npm run typecheck`,
`oxlint`, and the 38 test files that cover `FormattingToolbar/shared.tsx`.
