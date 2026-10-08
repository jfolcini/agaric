# Session 1935 — Android keyboard inset reaches the WebView again (#5353)

The user reported the Android soft keyboard covering the bottom search sheet.
The issue blamed `SearchSheet` for not using `useSoftKeyboardInset`; that was
wrong. The Sheet primitive has lifted every bottom sheet above the keyboard
since #760, and it does so in desktop Chrome with a simulated keyboard.

The cause is native. Since #4303, `MainActivity.kt` installs its own
`setOnApplyWindowInsetsListener` on the WebView to pad the host for the
system bars. A listener replaces the view's own `onApplyWindowInsets`, which
is where Android WebView (M139+, Android 12+) reads the `ime()` inset and
shrinks `window.visualViewport`, the only keyboard signal the web layer has.

What changed: after padding the host, the listener forwards the insets to the
WebView's default handler with the system-bar and cutout types zeroed, the
pattern Chromium's `android_webview/docs/insets.md` gives for apps that pad
themselves. Zeroing keeps `env(safe-area-inset-*)` at 0, so nothing is
padded twice. Android 11 is unchanged: there Chromium sets its own listener
in the WebView constructor, which ours replaces either way.
`e2e/search-sheet-mobile.spec.ts` gains a web-side case: with a simulated
keyboard, the sheet and its input sit above it.

Not verified on a device, and there is no local Kotlin lane; CI's Android
build compiles it. The PR stays a draft until the device check in its body
passes. The reviewer checked each claim against AOSP `View.java` /
`WebView.java`, androidx `ViewCompat`, and Chromium's
`AwDisplayCutoutController`.
