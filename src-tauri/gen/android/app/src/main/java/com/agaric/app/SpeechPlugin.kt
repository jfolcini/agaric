package com.agaric.app

import android.app.Activity
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * *Read aloud*'s engine on Android (#5745): the OS `TextToSpeech`, with its
 * default engine, voice and rate.
 *
 * The Rust side is `src-tauri/src/commands/speech.rs`, which loads this class
 * with `register_android_plugin` and calls its commands with
 * `run_mobile_plugin_async`:
 * - `status` resolves `{ available }`. The first call starts the engine; it is
 *   available once `onInit` reports success and the default voice is installed.
 * - `speak` resolves `{ outcome: "Done" | "Stopped" }` when the utterance ends,
 *   and rejects when the engine fails it. A new `speak` cuts off the last one.
 * - `stop` cuts off the utterance under way.
 *
 * Nothing here may break app start: the constructor does no work, the engine
 * starts on the first command, and every failure (a missing engine, an `onInit`
 * error, an exception from the binder) becomes "unavailable" or a rejection.
 *
 * Engine state is touched only on the main thread, where `onInit` arrives;
 * commands come in on a Rust thread and post there, and never wait on it.
 * Pending utterances are resolved from the binder thread that runs
 * [UtteranceProgressListener], so they live in a concurrent map, and removing
 * an entry is what makes each one settle exactly once.
 *
 * The repo has no Kotlin test harness: CI's `android-build` compiles this,
 * `android-launch-smoke.yml` launches it, and the Rust tests pin the reply
 * shapes against a fake engine.
 *
 * Package visibility: binding a TTS engine needs the `TTS_SERVICE` `<queries>`
 * entry in `AndroidManifest.xml`.
 */
@TauriPlugin
class SpeechPlugin(private val activity: Activity) : Plugin(activity) {
  private val main = Handler(Looper.getMainLooper())
  private var tts: TextToSpeech? = null
  /** `null` while the engine starts; then whether it started. Main thread only. */
  private var started: Boolean? = null
  /** Work waiting for `onInit`. Main thread only. */
  private val waiting = mutableListOf<() -> Unit>()
  private val pending = ConcurrentHashMap<String, Invoke>()

  @Command
  fun status(invoke: Invoke) {
    withEngine(
      onUnavailable = { invoke.resolve(JSObject().put("available", false)) },
    ) { engine ->
      invoke.resolve(JSObject().put("available", hasInstalledVoice(engine)))
    }
  }

  @Command
  fun speak(invoke: Invoke) {
    val text = invoke.getArgs().getString("text")
    withEngine(
      onUnavailable = { invoke.reject("no text-to-speech engine is available") },
    ) { engine ->
      val id = UUID.randomUUID().toString()
      pending[id] = invoke
      if (engine.speak(text, TextToSpeech.QUEUE_FLUSH, null, id) != TextToSpeech.SUCCESS) {
        pending.remove(id)?.reject("the text-to-speech engine refused the utterance")
      }
    }
  }

  @Command
  fun stop(invoke: Invoke) {
    withEngine(onUnavailable = { invoke.resolve() }) { engine ->
      engine.stop()
      // Not every engine reports `onStop` for a flushed utterance.
      settleAll { it.resolve(outcome(STOPPED)) }
      invoke.resolve()
    }
  }

  override fun onDestroy() {
    main.post {
      settleAll { it.resolve(outcome(STOPPED)) }
      tts?.shutdown()
      tts = null
      started = null
    }
  }

  /** Runs `action` on the main thread once the engine has started, or `onUnavailable`. */
  private fun withEngine(onUnavailable: () -> Unit, action: (TextToSpeech) -> Unit) {
    main.post {
      try {
        when (started) {
          true -> action(tts!!)
          false -> onUnavailable()
          null -> {
            waiting.add {
              val engine = tts
              if (started == true && engine != null) action(engine) else onUnavailable()
            }
            if (tts == null) startEngine()
          }
        }
      } catch (e: Exception) {
        Log.w(TAG, "text-to-speech command failed", e)
        onUnavailable()
      }
    }
  }

  private fun startEngine() {
    try {
      tts = TextToSpeech(activity.applicationContext) { status -> main.post { onInit(status) } }
    } catch (e: Exception) {
      Log.w(TAG, "TextToSpeech did not start", e)
      onInit(TextToSpeech.ERROR)
    }
  }

  private fun onInit(status: Int) {
    val engine = tts
    started = status == TextToSpeech.SUCCESS && engine != null
    if (started == true) {
      engine!!.setOnUtteranceProgressListener(listener)
    } else {
      Log.w(TAG, "TextToSpeech failed to start: $status")
      tts?.shutdown()
    }
    val work = waiting.toList()
    waiting.clear()
    for (run in work) {
      try {
        run()
      } catch (e: Exception) {
        Log.w(TAG, "text-to-speech command failed after onInit", e)
      }
    }
  }

  private fun hasInstalledVoice(engine: TextToSpeech): Boolean = try {
    val voice = engine.defaultVoice
    voice != null && TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED !in voice.features
  } catch (e: Exception) {
    Log.w(TAG, "could not read the default voice", e)
    false
  }

  private fun settleAll(settle: (Invoke) -> Unit) {
    for (id in pending.keys.toList()) pending.remove(id)?.let(settle)
  }

  private val listener = object : UtteranceProgressListener() {
    override fun onStart(utteranceId: String) {}

    override fun onDone(utteranceId: String) {
      pending.remove(utteranceId)?.resolve(outcome(DONE))
    }

    override fun onStop(utteranceId: String, interrupted: Boolean) {
      pending.remove(utteranceId)?.resolve(outcome(STOPPED))
    }

    @Deprecated("Deprecated in Java")
    override fun onError(utteranceId: String) {
      pending.remove(utteranceId)?.reject("the text-to-speech engine failed")
    }

    override fun onError(utteranceId: String, errorCode: Int) {
      pending.remove(utteranceId)?.reject("the text-to-speech engine failed: $errorCode")
    }
  }

  private fun outcome(value: String) = JSObject().put("outcome", value)

  private companion object {
    const val TAG = "AgaricSpeech"
    const val DONE = "Done"
    const val STOPPED = "Stopped"
  }
}
