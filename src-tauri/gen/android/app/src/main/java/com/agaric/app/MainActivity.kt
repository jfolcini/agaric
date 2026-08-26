package com.agaric.app

import android.os.Bundle
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
      val host = view.parent as? ViewGroup ?: view
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
