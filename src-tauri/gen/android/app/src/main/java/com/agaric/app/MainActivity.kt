package com.agaric.app

import android.os.Bundle
import android.util.Log
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/**
 * Keeps the webview out of the status and navigation bars.
 *
 * WHY THIS EXISTS
 * ---------------
 * `enableEdgeToEdge()` makes the activity draw behind the system bars, and from
 * `targetSdk = 36` (Android 15+) the platform enforces that anyway — so removing
 * the call would not buy anything back. Left alone, the webview is laid out at
 * the full display size and the app paints its own header underneath the system
 * clock. That is not only a cosmetic overlap: the status bar window sits ABOVE
 * the app window in the z-order and eats touches in its strip, so the header's
 * leading control — the nav hamburger, which lands at y≈21..139px against a
 * 132px status bar inset on a Pixel 8 — cannot be tapped at all (#4301).
 *
 * WHAT WE DO
 * ----------
 * Pad the webview's parent (the activity's content frame) by the system-bar
 * insets, which shrinks the MATCH_PARENT webview inside it. The webview then
 * never overlaps a system bar, in either pixels or touch region, and the strip
 * behind each bar falls back to the theme's DayNight `windowBackground` — which
 * is what `enableEdgeToEdge()` already tints the bar icons against.
 *
 * The web layer needs no cooperation for this: `index.css` keeps reading
 * `env(safe-area-inset-*)`, which stays 0 here because the webview no longer
 * intersects a system bar or the display cutout. iOS and desktop are untouched.
 *
 * WHAT THIS COSTS: THE BAR STRIP NO LONGER FOLLOWS THE IN-APP THEME
 * ----------------------------------------------------------------
 * Accepted knowingly. Before this change the webview painted the full display,
 * so the app's own background filled the strip behind the status bar. Now that
 * strip is the Android theme's DayNight `windowBackground`, which follows the
 * OS uiMode and nothing else. The app's theme is a web-layer preference the
 * native side never sees — `src/hooks/useTheme.ts` offers seven (light, dark,
 * auto, solarized-light, solarized-dark, dracula, one-dark-pro), settable
 * independently of the OS — so a user running a dark in-app theme while the OS
 * is in light mode gets a pale band above a dark app.
 *
 * Closing that gap means pushing the resolved theme colour from the web layer
 * down to native, i.e. re-introducing exactly the native<->web channel whose
 * failure mode is documented below. A mismatched band is cosmetic; the thing
 * it replaced was a control the user could not tap. This is the better trade.
 *
 * WHY NOT PUSH THE INSETS INTO CSS
 * --------------------------------
 * The previous fix injected the insets as `--safe-area-*` custom properties via
 * `evaluateJavascript`, and could not work: wry calls `setWebView` (which is
 * what invokes `onWebViewCreate` below) BEFORE it calls `loadUrl`, so the first
 * push always landed on the pre-navigation document and was wiped by the app's
 * own document — while the "did anything change?" cache it kept to avoid
 * redundant pushes then suppressed every later re-application, because the
 * insets themselves never changed. A native layout inset has no document to
 * outlive.
 */
class MainActivity : TauriActivity() {
  companion object {
    /** Logcat tag for the inset plumbing: `adb logcat -s AgaricInsets`. */
    private const val TAG = "AgaricInsets"
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    // The listener is attached to the webview rather than to its parent
    // because `setContentView` has not run yet — at this point the webview has
    // no parent. Insets are only ever dispatched to an ATTACHED view, so by the
    // time this runs the parent lookup below is resolved.
    ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
      // systemBars() covers the status and navigation bars; displayCutout() is
      // unioned in so a notch taller than the status bar still clears.
      val safe = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
      )
      // There is deliberately NO `?: view` fallback here. Padding the WEBVIEW
      // insets the web content but leaves the webview itself occupying the bar
      // strip, so the status bar window keeps swallowing touches over the
      // header — precisely the half of #4301 that made the hamburger
      // untappable. That half-fix looks correct in a screenshot and is still
      // broken to a finger, so a missing parent must be loud, not papered over.
      //
      // It should be unreachable: insets are only dispatched to ATTACHED views,
      // and an attached view has a parent. We log rather than throw because
      // this runs in a user's app — a crash here would be a worse bug than the
      // one it reports. So: the error lands in `adb logcat`, and the un-inset
      // bounds that follow fail assertion 1 of scripts/android-e2e-safe-area.mjs
      // whenever someone runs it (nothing in CI does — see that file's header).
      val host = view.parent as? ViewGroup
      if (host == null) {
        Log.e(
          TAG,
          "window insets dispatched to a webview with no ViewGroup parent " +
            "(parent=${view.parent}); refusing to pad the webview itself — " +
            "see #4301. The app will draw under the system bars.",
        )
        return@setOnApplyWindowInsetsListener insets
      }
      // `host` is the activity's content frame, and it is SHARED: anything else
      // added to it is inset by the same padding. That includes a
      // `WebChromeClient` fullscreen video surface and the camera preview used
      // for QR pairing. Correct for ordinary content, wrong for anything that
      // wants the whole display — so if a camera or video view ever looks
      // letterboxed by exactly the status/navigation bar heights, this is why,
      // and the fix is to inset the webview's own frame rather than the shared
      // parent, not to drop the padding.
      //
      // Padding triggers a re-layout, which re-dispatches these same insets, so
      // the equality check is what terminates the loop — not an optimisation.
      if (
        host.paddingLeft != safe.left ||
        host.paddingTop != safe.top ||
        host.paddingRight != safe.right ||
        host.paddingBottom != safe.bottom
      ) {
        host.setPadding(safe.left, safe.top, safe.right, safe.bottom)
      }
      // Returned unconsumed: nothing else in this activity reads insets today,
      // and consuming them would silently break anything that later does.
      insets
    }
  }
}
