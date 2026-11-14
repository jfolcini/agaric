# Session 4183 — A pan of the screen with the keyboard up is left alone

#6790: on Android, after typing at the end of a long page, the top of the page could not be scrolled back into view while the keyboard stayed up.

## What shipped

- **`useScrollCaretAboveKeyboard` no longer listens to the visual viewport's `scroll`.** It re-ran on `resize` and on `scroll`, and each run scrolls the focused block back into view. `resize` is the keyboard opening or closing. `scroll` is the reader panning the screen, so every pan was answered by a scroll back to the block.

## How it was found

On a Pixel 8 (Android 17) with a debug build of main at `c5d8fde70`, the web view read over the DevTools protocol after each `adb shell input swipe`, caret in the last of 23 lines:

| after | `visualViewport.offsetTop` | `#main-content` `scrollTop` |
|---|---|---|
| keyboard up | 144 | 541 |
| swipe 1 | 144 | 153 |
| swipe 2 | 144 | 0 |
| swipe 3 | 320 | 365 |
| swipe 4 | 320 | 0 |
| swipe 5 | 320 | 365 |

Swipe 3 starts with the content at its top, so it pans the screen; the content then jumps to 365, where the focused block is, and the screen pans fully down to it.

## Not verified

The phone was unplugged before the fixed build could be run on it. The cause is read from the table and the code, and the unit test covers the listener; whether a swipe at the top now pans the screen back to the header has not been seen on a device.

## Suites run

`npx vitest related src/hooks/useScrollCaretAboveKeyboard.ts --run` and `npm run typecheck`. The new test and the listener test were shown red by putting the `scroll` listener back. Not run: the whole vitest suite and Playwright, whose browser has no on-screen keyboard; CI's runs are the check.
