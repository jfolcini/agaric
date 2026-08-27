# Session 1405 — the Android status bar, and the tap that went nowhere

The ask was a bug report from the phone: the hamburger cannot be tapped, and the app still
occupies the OS status bar. Both had been "fixed" in #4301, which was closed. Neither was
fixed. The session was run against a real Pixel 8 over adb, not against a simulation.

## The two symptoms were one bug

`targetSdk = 36` forces the activity edge-to-edge, so the webview is laid out at the full
display size. On the device that meant:

- the webview's on-screen bounds were `[0,0][1080,2400]` — the whole display, including the
  132 px the window manager reserves for the status bar;
- the hamburger sat at `[21,21][139,139]`, entirely inside that strip;
- the status bar window is **above** the app window in the z-order, so it also swallowed
  every touch there. The button was not merely mis-drawn, it was unreachable.

The overlap and the dead tap were never two problems.

## Why the previous fix could not have worked

#4301 pushed the insets into CSS custom properties with `evaluateJavascript` from
`MainActivity.onWebViewCreate`. Reading wry's `main_pipe.rs` settles it: wry calls
`setWebView` — which is what invokes `onWebViewCreate` — **before** `loadUrl` and before
`setContentView`. So the first push always landed on the pre-navigation document and was
wiped by the app's own document.

The code knew a reload would wipe it and re-armed on every layout pass by calling
`requestApplyInsets`. That re-arm re-entered the listener, which called `pushInsets`, which
compared against a `lastInsets` cache and **returned early** — the insets themselves had not
changed, only the document had. The cache existed to avoid redundant `evaluateJavascript`
calls and it suppressed the one call that mattered. Two mechanisms, each correct alone,
cancelling to a no-op. That is the same shape as #4421 and it is worth naming as a pattern:
a guard added in one round and a cache added in another do not compose by default.

## The fix

Pad the webview's parent (the activity content frame) by
`systemBars() | displayCutout()`, which shrinks the MATCH_PARENT webview inside it. The
webview then never overlaps a system bar in pixels **or** in touch region, and the strip
behind each bar falls back to the theme's DayNight `windowBackground` — which is already
what `enableEdgeToEdge()` tints the bar icons against, so the bars look like ordinary bars.

The JS injection is gone. A native layout inset has no document to outlive.

The web layer needs no Android branch now: measured on-device, `--safe-area-top` resolves to
`0px` and `body`'s `padding-top` is `0px`, because the webview no longer intersects a bar or
the cutout. `env()` is legitimately zero there. Three comments that described the old
mechanism (`index.css`, `SpaceTopStripe.tsx`, `App.test.tsx`) were corrected rather than
left to rot.

## The test

`scripts/android-e2e-safe-area.mjs` (`npm run test:e2e-android`) drives a connected device.
It asserts the webview's bounds and the hamburger's bounds are inside the system-bar safe
rect, then taps the hamburger at its real screen coordinates and asserts the drawer opens.

The expected insets come from `dumpsys window`'s `InsetsState` — the window manager's own
record. A test that asked the app where it thought it was would pass on exactly the builds
that are broken.

Falsified both ways on hardware: red on the installed 0.9.9 release build (`the webview
overlaps a system bar: [0,0][1080,2400] vs [0,132][1080,2337]`), green on the fixed build.
Not a screenshot diff — the status bar's clock is drawn in the OS's own tint and against a
light app header in night mode it is white-on-white, so the regression is invisible to the
eye while being obvious to the accessibility tree.

The debug APK could not be installed over the release-signed one without an uninstall, which
would have wiped the owner's real notes. It was built under a suffixed application id and
installed beside it instead; the test takes `--pkg` for that reason.

## Three ways the test lied before it was honest

Each was caught by running it again, not by reading it.

1. **It raced the onboarding coach-mark.** The dialog opens from an effect a tick after the
   header renders, so a single clean read could be taken in the gap. The tap then hit the
   overlay, dismissed it, and the drawer never opened — a failure of the test, reported as a
   failure of the app. Fixed by requiring two consecutive clean reads: one is a snapshot,
   two spanning a poll interval is a state.
2. **It blamed the app for a platform dialog.** Android's "app compatibility" warning — the
   16 KB-alignment notice, shown only for debuggable builds — appeared seconds after launch,
   hid the entire app hierarchy from `uiautomator dump`, and ate every injected tap. The
   test reported "the app never rendered a menu control", which is true and useless. It now
   detects a foreground window owned by another package and names it. It does **not**
   auto-dismiss system dialogs.
3. **A dismissed dialog is not a settled app.** The first version treated "no dialog right
   now" as ready.

`libagaric_lib.so` failing the 16 KB ELF alignment check is a real, separate finding —
Android 15+ requires it — and is not addressed here.
