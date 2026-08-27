package com.agaric.app

import android.graphics.Color
import android.os.Bundle
import android.util.Log
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

/**
 * Keeps the webview out of the status and navigation bars, and keeps the
 * strip behind them painted in the app's OWN theme colour.
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
 * never overlaps a system bar, in either pixels or touch region.
 *
 * The web layer needs no cooperation for the inset itself: `index.css` keeps
 * reading `env(safe-area-inset-*)`, which stays 0 here because the webview no
 * longer intersects a system bar or the display cutout. iOS and desktop are
 * untouched.
 *
 * KEEPING THE STRIP ON-THEME: THE `ThemeBridge` (#4433)
 * -------------------------------------------------------
 * Padding (rather than resizing) `host` means anything painted on `host`
 * itself — not just the webview — shows through the padding, i.e. behind the
 * system bars. Left unpainted, that strip falls back to the Android theme's
 * DayNight `windowBackground`, resolved once at activity creation and never
 * revisited: the `<activity>` declares `android:configChanges="…|uiMode"`, so
 * a uiMode change is delivered to the running activity instead of recreating
 * it, and nothing re-resolves `windowBackground` in response. Worse, the
 * app's theme is a WEB-layer preference the native side never sees at all —
 * `src/hooks/useTheme.ts` offers seven (light, dark, auto, solarized-light,
 * solarized-dark, dracula, one-dark-pro), settable independently of the OS —
 * so `windowBackground` can neither match a custom theme nor track a live OS
 * switch.
 *
 * [ThemeBridge] closes this by letting the web layer paint `host` itself.
 * `useTheme.ts` calls `AgaricThemeBridge.applyBackground(r, g, b, isDark)`
 * (via `src/lib/platform/android-theme-bridge.ts`) every time the resolved
 * theme changes — including a live OS switch while the preference is
 * `'auto'` — and the bridge repaints [contentHost] and re-tints the system
 * bar icons (`isAppearanceLightStatusBars`/`NavigationBars`, so the icons
 * stay legible against whichever colour just landed) on every call, not only
 * once at activity creation.
 *
 * This is a WEB -> NATIVE call, the opposite direction from the mechanism
 * that failed in #4301 (see below), and does not share its failure mode:
 * `addJavascriptInterface` binds an object to the WEBVIEW INSTANCE, not to
 * any one document, and Tauri's own IPC on Android already uses the exact
 * same primitive for every `invoke()` call — so there is no "pushed before
 * the real document loaded" race to have.
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
 * outlive. (This is about the INSETS specifically; [ThemeBridge] above pushes
 * a COLOUR, in the other direction, through a different mechanism.)
 */
class MainActivity : TauriActivity() {
  companion object {
    /** Logcat tag for the inset plumbing: `adb logcat -s AgaricInsets`. */
    private const val TAG = "AgaricInsets"
  }

  /**
   * The activity's content frame — resolved by [onWebViewCreate]'s inset
   * listener the first time insets are dispatched — and the paint target for
   * [ThemeBridge.applyBackground]. Null until the webview is attached; a
   * background push that arrives first is cached in [pendingBackgroundColor]
   * and applied as soon as this is set.
   */
  private var contentHost: ViewGroup? = null

  /**
   * The last colour [ThemeBridge.applyBackground] received, re-applied to
   * [contentHost] if it is (re)assigned afterwards — guards the startup race
   * where the web layer's first push could in principle arrive before the
   * webview's first inset dispatch has resolved [contentHost].
   */
  private var pendingBackgroundColor: Int? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    // Registered once per webview creation. `addJavascriptInterface` binds
    // `ThemeBridge` to THIS webview instance, so it survives every later
    // navigation — see the class doc's "WEB -> NATIVE call" note.
    webView.addJavascriptInterface(ThemeBridge(), "AgaricThemeBridge")

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
      contentHost = host
      // A background push that raced ahead of this listener's first run is
      // applied now rather than lost — see [pendingBackgroundColor]'s doc.
      pendingBackgroundColor?.let { host.setBackgroundColor(it) }
      // `host` is the activity's content frame, and it is SHARED: anything else
      // added to it is inset by the same padding. That includes a
      // `WebChromeClient` fullscreen video surface — QR pairing has no native
      // camera view to worry about; it scans through the webview's own
      // `getUserMedia` (see `src/components/peers/QrScanner.tsx`), so that
      // preview is inset along WITH the webview, not as a sibling of it.
      // Correct for ordinary content, wrong for anything that wants the whole
      // display — so if a fullscreen video view ever looks letterboxed by
      // exactly the status/navigation bar heights, this is why, and the fix is
      // to inset the webview's own frame rather than the shared parent, not to
      // drop the padding.
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

  /**
   * JS-callable bridge letting the web layer push its resolved theme
   * background colour to native (#4433) — see the class doc's "KEEPING THE
   * STRIP ON-THEME" section. Bound to the webview in [onWebViewCreate].
   */
  private inner class ThemeBridge {
    /**
     * `r`/`g`/`b` are 0-255 channels of the app's currently-resolved
     * `--background` colour (see `src/lib/platform/android-theme-bridge.ts`
     * for how the web layer derives them); `isDark` mirrors `useTheme.ts`'s
     * `isDark`.
     *
     * `@JavascriptInterface` methods run on a WebView background thread —
     * NEVER the UI thread — so every touch of a `View` or the `Window` below
     * is marshalled via [runOnUiThread].
     */
    @JavascriptInterface
    fun applyBackground(r: Int, g: Int, b: Int, isDark: Boolean) {
      val color = Color.rgb(r.coerceIn(0, 255), g.coerceIn(0, 255), b.coerceIn(0, 255))
      runOnUiThread {
        pendingBackgroundColor = color
        contentHost?.setBackgroundColor(color)
        // Mirrors the colour into bar-icon contrast: `enableEdgeToEdge()`
        // tints icons from the OS `uiMode` alone, which is exactly wrong once
        // the strip itself stops following the OS — a dark strip must not
        // get dark icons just because the OS happens to be in light mode.
        val controller = WindowCompat.getInsetsController(window, window.decorView)
        controller.isAppearanceLightStatusBars = !isDark
        controller.isAppearanceLightNavigationBars = !isDark
      }
    }
  }
}
