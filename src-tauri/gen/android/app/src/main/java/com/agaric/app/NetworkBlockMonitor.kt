package com.agaric.app

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.util.Log

/**
 * Reports Android's per-uid network block to the Rust sync daemon (#3852).
 *
 * ## Why this class exists
 *
 * Android 15+ runs a per-uid firewall chain (`FIREWALL_CHAIN_BACKGROUND`) that
 * drops every packet for an app that is not top-of-stack — including when the
 * app *is* the top activity and the screen has merely gone to sleep
 * (`procState=TOP_SLEEPING`). The sync daemon cannot notice: its sockets stay
 * open, `sendto` keeps returning success, and inbound datagrams are discarded
 * at the cgroup-BPF ingress hook before they are ever enqueued. On the
 * reporting Pixel 8 that made a first-ever pair impossible, while both devices
 * displayed "Waiting for the other device…" until the pairing window expired.
 *
 * `NetworkCallback.onBlockedStatusChanged` is the platform stating this uid's
 * firewall status about itself. Every other route to the same fact is an
 * inference from silence, and silence is also what a quiet LAN, a sleeping
 * peer, and a wrong service type look like.
 *
 * ## Why Kotlin
 *
 * `ConnectivityManager.NetworkCallback` is an abstract **class**, so it cannot
 * be implemented from JNI with a `java.lang.reflect.Proxy` (which only supports
 * interfaces) and cannot be subclassed from Rust at all. A real subclass in the
 * app's own dex is the only way to receive the callback.
 *
 * The Rust side is `agaric_sync::sync_daemon::android_network_block`; the
 * native symbol below is exported by the app crate
 * (`src-tauri/src/android_jni.rs`) because only the crate producing the
 * `cdylib` exports symbols reliably.
 *
 * Requires `android.permission.ACCESS_NETWORK_STATE`.
 */
object NetworkBlockMonitor {
    private const val TAG = "AgaricNetBlock"

    /**
     * Receives the blocked status on a `ConnectivityManager` thread and hands
     * it straight to Rust, which owns the dedup and the event emission.
     */
    private external fun nativeOnBlockedStatusChanged(blocked: Boolean)

    /**
     * `true` once [start] has registered the callback. The registration is
     * process-wide and deliberately never unregistered — the daemon starts,
     * stops and restarts many times per process (dormant ⇄ active) and the
     * firewall state is a property of the process, not of any one daemon run.
     */
    private var registered = false

    private val callback =
        object : ConnectivityManager.NetworkCallback() {
            override fun onBlockedStatusChanged(
                network: Network,
                blocked: Boolean,
            ) {
                // No level gate here. `Logger.kt`'s `shouldLog()` is
                // `BuildConfig.DEBUG`, which is what made phone-side diagnosis
                // of #3852 look impossible on a release build for three days.
                // This line is one event per firewall transition, not a stream.
                Log.i(TAG, "onBlockedStatusChanged: blocked=$blocked")
                try {
                    nativeOnBlockedStatusChanged(blocked)
                } catch (e: UnsatisfiedLinkError) {
                    // The native library is loaded by WryActivity before any
                    // Rust code can ask for this registration, so this should be
                    // unreachable. Caught rather than thrown because an
                    // uncaught throw on a ConnectivityManager callback thread
                    // kills the process — turning a degraded report into a crash.
                    Log.w(TAG, "native block-status callback is not linked", e)
                }
            }
        }

    /**
     * Register the default-network callback. Idempotent: safe to call on every
     * dormant → active transition of the sync daemon.
     */
    @JvmStatic
    @Synchronized
    fun start(context: Context) {
        if (registered) return
        val cm = context.getSystemService(ConnectivityManager::class.java)
        if (cm == null) {
            // Restricted / work profiles can return null system services.
            // Degrade the same way the multicast lock does: log and carry on
            // without the report, never crash the daemon over diagnostics.
            Log.w(TAG, "ConnectivityManager unavailable; block status will not be reported")
            return
        }
        try {
            cm.registerDefaultNetworkCallback(callback)
            registered = true
            Log.i(TAG, "default network callback registered")
        } catch (e: SecurityException) {
            Log.w(TAG, "ACCESS_NETWORK_STATE missing; block status will not be reported", e)
        } catch (e: RuntimeException) {
            // `registerDefaultNetworkCallback` throws TooManyRequestsException
            // (a RuntimeException) if the process has leaked callbacks.
            Log.w(TAG, "could not register default network callback", e)
        }
    }
}
