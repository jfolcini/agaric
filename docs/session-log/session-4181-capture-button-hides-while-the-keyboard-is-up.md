# Session 4181 — The quick-capture button hides while the on-screen keyboard is up

Session 4180 left this open: on a phone, in Settings › Spaces › Create new space, the quick-capture button sat on the form's Create button once the keyboard came up. Checked on a Pixel 8 (Android 17) with a debug build of main.

## What shipped

- **The button hides while the on-screen keyboard is up, and returns when it closes.** With the keyboard up the screen pans, and the button, fixed to the bottom of the layout viewport, lands on whatever follows the focused field.

## Decisions and traps

- **The keyboard, not focus.** Hiding while any text field has focus also fixes it, and breaks `e2e/page-mode-touch.spec.ts`, which pins the button showing while the page title has focus. A browser has no on-screen keyboard, so that spec still holds; on a phone the title's keyboard now hides the button, as editing a block already did.
- **`computeKeyboardInset` reads 0 here.** On the Pixel the layout viewport keeps its 840 px while the visual viewport is 520 px tall and panned down 320, so `innerHeight - (vv.height + vv.offsetTop)` is 0. The button compares the two heights and ignores the offset. The pinned toolbar and `Sheet`, which use that function, were not looked at.
- The web view of a debug build answers the DevTools protocol over `adb forward tcp:<port> localabstract:webview_devtools_remote_<pid>`, which is how the viewport numbers were read.

## Suites run

`npx vitest related src/components/mobile/QuickCaptureFab.tsx --run` (5 files, 153 passed), `npm run typecheck`, and Playwright `e2e/page-mode-touch.spec.ts`, `e2e/phone-bottom-sheets.spec.ts`, `e2e/phone-views.spec.ts` and `e2e/settings-phone.spec.ts` (32 passed). Both new tests were shown red by one mutation each. On the phone, with a debug build holding the change: the form's Create button was clear with the keyboard up (`data-shown="false"`), and the button was back after Cancel. No e2e spec: Playwright's browser has no on-screen keyboard. Not run: the whole vitest and Playwright suites; CI's runs are the check.
