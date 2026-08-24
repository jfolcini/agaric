package com.agaric.app

import android.os.Bundle
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/**
 * Bridges Android's window insets into CSS custom properties.
 *
 * WHY THIS EXISTS
 * ---------------
 * `enableEdgeToEdge()` makes the activity draw behind the status and navigation
 * bars, and from `targetSdk = 36` (Android 15+) the platform enforces that
 * anyway — so removing the call would not buy anything back. The web layer
 * already tries to compensate: `index.html` sets `viewport-fit=cover` and
 * `index.css` pads `body` by the safe-area insets.
 *
 * That compensation silently does nothing here, and the reason is easy to miss:
 * **Android's WebView only reports `env(safe-area-inset-*)` for display
 * CUTOUTS, never for system bars.** On a handset without a notch every one of
 * those `env()` values resolves to `0px`, so the app paints its own header
 * underneath the system clock. On a notched device it reports the cutout only,
 * which is usually smaller than the status bar — so the bug survives there too,
 * just less obviously. Either way `env()` alone cannot express what we need.
 *
 * So the insets are pushed in from the native side as CSS variables, which
 * `index.css` declares with `env(...)` as their fallback. Desktop and iOS keep
 * using `env()` untouched; only Android overrides. Writing them as an INLINE
 * style on `documentElement` is what makes the override win — an inline style
 * beats the `:root` rule in the stylesheet without needing `!important`.
 *
 * Values are emitted in CSS pixels (device pixels / density), because that is
 * the unit the web layer lays out in.
 */
class MainActivity : TauriActivity() {
  /**
   * The last values pushed to the web layer, so repeated layout passes do not
   * re-run `evaluateJavascript` with an identical payload. Insets are applied
   * many times during startup, rotation and keyboard show/hide.
   */
  private var lastInsets: String? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    ViewCompat.setOnApplyWindowInsetsListener(webView) { view, insets ->
      // systemBars() covers the status and navigation bars; displayCutout() is
      // unioned in so a notch taller than the status bar still clears. Taking
      // the max of the two per-edge is what `getInsets` already does for a
      // combined type mask.
      val safe = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
      )
      pushInsets(view as WebView, safe.top, safe.bottom, safe.left, safe.right)
      insets
    }

    // A layout pass is the cheapest signal that the document may have been
    // (re)created — a reload drops the inline style we set, and no new inset
    // event necessarily follows it. `pushInsets` no-ops when nothing changed,
    // so re-arming here costs one string comparison, but a reload DOES change
    // it back to "unset", which we cannot observe. Clearing `lastInsets` on
    // every layout would defeat the cache, so instead re-request insets, which
    // re-enters the listener above and re-applies.
    webView.addOnLayoutChangeListener { v, _, _, _, _, _, _, _, _ ->
      ViewCompat.requestApplyInsets(v)
    }
    ViewCompat.requestApplyInsets(webView)
  }

  private fun pushInsets(webView: WebView, top: Int, bottom: Int, left: Int, right: Int) {
    val density = webView.resources.displayMetrics.density
    if (density <= 0f) return
    val css = buildString {
      append(top / density).append(',')
      append(bottom / density).append(',')
      append(left / density).append(',')
      append(right / density)
    }
    if (css == lastInsets) return
    lastInsets = css

    val js = """
      (function () {
        var s = document.documentElement && document.documentElement.style
        if (!s) return
        s.setProperty('--safe-area-top', '${top / density}px')
        s.setProperty('--safe-area-bottom', '${bottom / density}px')
        s.setProperty('--safe-area-left', '${left / density}px')
        s.setProperty('--safe-area-right', '${right / density}px')
      })()
    """.trimIndent()
    webView.evaluateJavascript(js, null)
  }
}
