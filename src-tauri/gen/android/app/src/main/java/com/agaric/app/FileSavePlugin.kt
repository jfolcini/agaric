package com.agaric.app

import android.app.Activity
import android.content.ContentValues
import android.net.Uri
import android.os.Environment
import android.provider.MediaStore
import android.util.Log
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.io.IOException

/**
 * Saves a file to the shared Downloads folder (#6546): the WebView handles no
 * `blob:` download, so this is how an export, a bug-report ZIP or a tapped
 * attachment leaves the app.
 *
 * The Rust side is `src-tauri/src/commands/file_save.rs`, behind the
 * `save_to_downloads` command. It stages the bytes in the app's cache directory
 * and calls `saveToDownloads` with `{ path, fileName }`; this copies the staged
 * file into `MediaStore.Downloads` and resolves `{ fileName }`, the name the
 * file has there (MediaStore renames a file whose name is taken, and reads the
 * MIME type from the name's extension). Rust deletes the staged file afterwards.
 *
 * `MediaStore.Downloads` needs no permission for a file the app adds itself
 * (API 29+; the app's minimum is 30).
 *
 * The repo has no Kotlin test harness: CI's `android-build` compiles this, and
 * the Rust tests pin the argument and reply shapes.
 */
@TauriPlugin
class FileSavePlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun saveToDownloads(invoke: Invoke) {
    val args = invoke.getArgs()
    val path = args.getString("path")
    val fileName = args.getString("fileName")
    // A copy can take seconds for a large export; never on the caller's thread.
    Thread {
      try {
        invoke.resolve(JSObject().put("fileName", copyToDownloads(File(path), fileName)))
      } catch (e: Exception) {
        Log.w(TAG, "could not save $fileName to Downloads", e)
        invoke.reject(e.message ?: e.toString())
      }
    }.start()
  }

  private fun copyToDownloads(source: File, fileName: String): String {
    val resolver = activity.contentResolver
    val values = ContentValues().apply {
      put(MediaStore.MediaColumns.DISPLAY_NAME, fileName)
      put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
      // Hidden from other apps until the bytes are all there.
      put(MediaStore.MediaColumns.IS_PENDING, 1)
    }
    val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
      ?: throw IOException("MediaStore refused a new Downloads entry")
    try {
      val out = resolver.openOutputStream(uri)
        ?: throw IOException("MediaStore opened no stream for the new Downloads entry")
      out.use { sink -> source.inputStream().use { it.copyTo(sink) } }
      resolver.update(
        uri,
        ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) },
        null,
        null,
      )
      return displayName(uri) ?: fileName
    } catch (e: Exception) {
      // A half-written entry would show in Files as a broken download.
      resolver.delete(uri, null, null)
      throw e
    }
  }

  private fun displayName(uri: Uri): String? =
    activity.contentResolver
      .query(uri, arrayOf(MediaStore.MediaColumns.DISPLAY_NAME), null, null, null)
      ?.use { cursor -> if (cursor.moveToFirst()) cursor.getString(0) else null }

  private companion object {
    const val TAG = "AgaricFileSave"
  }
}
