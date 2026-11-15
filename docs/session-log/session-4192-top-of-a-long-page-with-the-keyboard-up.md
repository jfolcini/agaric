# Session 4192 — The top of a long page with the keyboard up: a spec, and why no fix beyond #6792

#6790: on Android, with the keyboard up after typing at the end of a long page, the top of the page could not be scrolled back into view. #6792 had removed the visual viewport `scroll` listener of `useScrollCaretAboveKeyboard`, but it had not been run on a phone. This session was to decide whether #6792 fixes the issue, and to remove the condition behind it: the keyboard shrinks only the visual viewport, so the screen is a panned window over a full-height layout.

## What shipped

- **`e2e/phone-keyboard-pan.spec.ts`.** It runs on a Pixel 7 profile with a page scale of `innerHeight / 520`, which gives the visual viewport the 520 px height it had on the Pixel 8 with the keyboard up. The spec focuses the last of 23 lines, which pans the screen down as the keyboard did, then swipes down six times with CDP touch events. It expects `visualViewport.offsetTop` 0 and `#main-content` `scrollTop` 0. With the `scroll` listener put back, it ends at offsetTop 319 and scrollTop 0, the state #6790 measured on the phone (320, 0).

## Decisions

- **#6792 fixes the symptom reported in #6790.** #6792's own device table shows the screen panning on the swipes that started with the content at its top. Each of those pans was undone by the listener's `scrollIntoView`. The spec shows the same thing in Chromium with the app's real CSS. The reviewer's caveat about a visual viewport `resize` during a pan does not hold in WebView: `RenderWidgetHostViewAndroid::GetVisibleViewportSize` is the renderer size minus `getBottomViewportInset()`. `AwDisplayCutoutController` derives that inset from the `ime()` inset and the WebView's place in the window, and a pan changes neither.
- **The scroll area's overscroll setting does not block the pan** (the open question in #6790). `#main-content` sets no `overscroll-behavior`, and `html { overscroll-behavior: none }` does not stop chaining into the viewport. The spec only passes because the gesture chains. Setting `contain` on the scroll area would make the top unreachable for good.
- **`interactive-widget=resizes-content` does nothing in Android System WebView.** In Chromium the mode is consumed by Chrome's own `CompositorViewHolder` (chrome/android). The content layer reads it only for `overlays-content` (`NotifyVirtualKeyboardOverlayRect`). WebView's IME path (`AwContents.getBottomViewportInset`) never reads it. Neither Tauri's `TauriActivity` nor wry's `WryActivity` sets `windowSoftInputMode`, and `enableEdgeToEdge()` keeps the window from resizing for the IME. Shrinking the layout with the keyboard therefore needs the native side to pad or resize the WebView by the `ime()` inset in `MainActivity.kt`, under `src-tauri/gen/android/`. That is out of bounds without the maintainer, so it was reported, not made.
- **Sizing the shell to `visualViewport.height` was rejected.** The visual viewport can still pan over the layout below a shortened shell, and Chromium's focus reveal pans it, so this would mean chasing the pan.

## Not verified

No phone. The spec stands in for the keyboard with a page scale (scale above 1, where the keyboard keeps scale 1). Whether a swipe at the top pans back to the header on a device is the unticked line added to #6513.

## Suites run

The new spec, green on main and red with the `scroll` listener restored (`offsetTop` 319 against the expected 0). `npm run typecheck`, oxlint and oxfmt on the spec, and `just e2e-related --range origin/main...HEAD`. Not run: e2e-tauri, whose WebKitGTK window has no visual viewport pan to drive.
