package com.agaric.app

import android.app.Activity
import android.util.Log
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * The HTTPS request behind Android's check for a newer release (#6546).
 *
 * The Rust side is `src-tauri/src/commands/release_check.rs`. It calls
 * `fetchText` with `{ url }`, always the release manifest the desktop updater
 * reads, and this resolves `{ body }` with the response text, or rejects on a
 * network error or a status other than 200. Rust compares the versions; nothing
 * is downloaded or installed here.
 *
 * The request uses the platform's `HttpURLConnection` so that certificates are
 * checked against the system trust store.
 *
 * The repo has no Kotlin test harness: CI's `android-build` compiles this, and
 * the Rust tests pin the argument and reply shapes.
 */
@TauriPlugin
class ReleaseCheckPlugin(activity: Activity) : Plugin(activity) {
  @Command
  fun fetchText(invoke: Invoke) {
    val url = invoke.getArgs().getString("url")
    // Network I/O is not allowed on the main thread.
    Thread {
      try {
        invoke.resolve(JSObject().put("body", get(url)))
      } catch (e: Exception) {
        Log.w(TAG, "the release manifest could not be fetched", e)
        invoke.reject(e.message ?: e.toString())
      }
    }.start()
  }

  private fun get(url: String): String {
    val connection = URL(url).openConnection() as HttpURLConnection
    try {
      connection.connectTimeout = TIMEOUT_MS
      connection.readTimeout = TIMEOUT_MS
      val status = connection.responseCode
      if (status != HttpURLConnection.HTTP_OK) throw IOException("HTTP $status")
      return connection.inputStream.bufferedReader().use { it.readText() }
    } finally {
      connection.disconnect()
    }
  }

  private companion object {
    const val TAG = "AgaricReleaseCheck"
    const val TIMEOUT_MS = 15_000
  }
}
