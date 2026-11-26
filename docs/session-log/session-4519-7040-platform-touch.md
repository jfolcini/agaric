# Session 4519 — the platform decides touch

Part of the #7040 UI review, item M7 (maintainer decisions 26 and 34; #1236).

**What shipped**

- **One answer to "is this touch?", for CSS and JS alike (decision 26).** `detectTouch()` (`src/lib/touch.ts`) says the desktop Tauri app is never touch, the Android app always is, and a plain browser is when its pointer is coarse and it has touch points. `window.isTauri`, which the Tauri runtime defines before any page script and the browser mock and the bridge never do, tells the app from a browser.
- **CSS reads the same answer.** `main.tsx` writes it onto `<html data-touch>` before the first render, and a `coarse` custom variant reads that attribute. `index.css`'s pointer media blocks, `touch-target`, `touch-hit-area` and `hover-reveal` use it, so WebKitGTK's false coarse pointer no longer reveals row actions or widens rows in the desktop app. `useIsTouch` and the suggestion popup's edge read `detectTouch()`.
- **Block rows stay flush (decision 34).** The block tree's and the embed tree's `space-y-[var(--block-row-gap)]` never applied, because every row carries `m-0`, so it is gone. `--block-row-gap` keeps its name, since it is on the custom-CSS token list. Its one reader is the indent guide's reach, and `docs/features/appearance.md` now says so.

**Left as they are**

The inline `[@media(pointer:coarse)]:` classes in components still read the media query until M6 moves them to `coarse:`. `docs/UX.md` says so.

**Tests**

- e2e (mock lane): new `desktop-app-touch`, a 1280 px page with a coarse pointer and touch points that identifies as the Tauri app. Its row actions stay hidden at rest, the indent guide keeps its desktop reach, and the desktop control lane shows. It was red on the old code: the Delete button's opacity was 1.
- vitest: new `touch.test` covers the desktop app, the Android app, a coarse pointer with and without touch points, and the attribute following a pointer change. `suggestion-renderer.test` gains the desktop app's 16 px edge.
- Falsified one mutation at a time: each branch of `detectTouch`, the change listener, the suggestion popup's read, and the `syncTouchAttribute()` call, which `phone-block-lists` catches.
- The reviewer compiled the old and new `index.css`: every converted rule gives the same declarations at the same specificity, under the attribute instead of the media query. A temporary spec measured the rows on three pages at desktop and phone width, identical before and after dropping the gap.
- A separate session reviewed it, dropped the dead row gap and inlined a one-line helper.
