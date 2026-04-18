//! BUG-39: Android WiFi multicast lock.
//!
//! On Android 6+ (SDK 23+) an app must call
//! [`WifiManager.createMulticastLock()`] and `acquire()` before the
//! kernel will deliver UDP multicast packets to its sockets — even when
//! the app has `CHANGE_WIFI_MULTICAST_STATE` and `ACCESS_WIFI_STATE`
//! permissions in its manifest. The `mdns-sd` crate uses raw UDP
//! multicast for service discovery, so without the lock the daemon
//! appears to start (`MdnsService::new()` succeeds) but never resolves
//! any peers.
//!
//! This module is compiled only on Android (`#[cfg(target_os =
//! "android")]`). It bridges into Java via JNI using the current
//! Activity context resolved through [`ndk_context`]. The acquired lock
//! is kept alive for the daemon's lifetime by storing a `GlobalRef` in
//! [`MulticastLock`]; `Drop` releases it.
//!
//! ### Manifest permissions required
//!
//! `src-tauri/gen/android/app/src/main/AndroidManifest.xml` must declare:
//! - `android.permission.INTERNET`
//! - `android.permission.ACCESS_WIFI_STATE`
//! - `android.permission.CHANGE_WIFI_MULTICAST_STATE`
//!
//! Missing permissions surface as a `SecurityException` here and are
//! logged by [`crate::sync_daemon::orchestrator::daemon_loop`].
//!
//! [`WifiManager.createMulticastLock()`]: https://developer.android.com/reference/android/net/wifi/WifiManager#createMulticastLock(java.lang.String)

#![cfg(target_os = "android")]
// JNI FFI into Android's WifiManager is the only way to acquire the
// multicast lock. Each unsafe block below is justified inline.
#![allow(unsafe_code)]

use std::fmt;

use jni::objects::{GlobalRef, JObject, JValue};
use jni::JavaVM;

/// Error returned when the multicast lock cannot be acquired.
#[derive(Debug)]
pub enum MulticastLockError {
    /// The underlying JNI call failed (wrong method signature, Java
    /// exception, attach-thread failure, etc.).
    Jni(jni::errors::Error),
    /// Failed to resolve an Android Context (likely running outside the
    /// Tauri Android runtime, or `ndk_context` was not initialized).
    NoAndroidContext(String),
}

impl fmt::Display for MulticastLockError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Jni(e) => write!(f, "JNI error acquiring multicast lock: {e}"),
            Self::NoAndroidContext(s) => write!(f, "no Android context available: {s}"),
        }
    }
}

impl std::error::Error for MulticastLockError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Jni(e) => Some(e),
            Self::NoAndroidContext(_) => None,
        }
    }
}

impl From<jni::errors::Error> for MulticastLockError {
    fn from(e: jni::errors::Error) -> Self {
        Self::Jni(e)
    }
}

/// Holds an acquired `WifiManager.MulticastLock`.
///
/// The lock is released when this value is dropped (best effort — any
/// JNI failure during release is logged at `warn` and swallowed, since
/// process shutdown is imminent).
pub struct MulticastLock {
    lock: GlobalRef,
    vm: JavaVM,
}

impl MulticastLock {
    /// Acquire a `WifiManager.MulticastLock` for the current Android
    /// application context.
    ///
    /// The lock is tagged `"agaric-mdns"` (visible via `adb shell
    /// dumpsys wifi`) and has reference counting disabled so a single
    /// `release()` call always unlocks.
    pub fn acquire() -> Result<Self, MulticastLockError> {
        let ctx = ndk_context::android_context();
        if ctx.vm().is_null() || ctx.context().is_null() {
            return Err(MulticastLockError::NoAndroidContext(
                "ndk_context returned null vm/context pointer".into(),
            ));
        }
        // SAFETY: `ndk_context::android_context()` is initialized by
        // Tauri's Android entry point before this crate's Rust code
        // runs. Both pointers reference the process-global JavaVM and
        // Activity Context owned by the JVM for the app's lifetime.
        let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) }?;

        // Scope the `AttachGuard` borrow so it is dropped before we
        // move `vm` into `Self`. Without the explicit scope, `env`
        // lives until the end of the function and the compiler
        // complains that `vm` is borrowed (E0505).
        let global_ref = {
            let mut env = vm.attach_current_thread()?;
            // SAFETY: same invariant as above — ctx.context() is a
            // valid live JNI reference to the Activity.
            let context = unsafe { JObject::from_raw(ctx.context().cast()) };

            // Context.getSystemService("wifi") → WifiManager
            let wifi_service_name = env.new_string("wifi")?;
            let wifi_manager = env
                .call_method(
                    &context,
                    "getSystemService",
                    "(Ljava/lang/String;)Ljava/lang/Object;",
                    &[JValue::Object(&wifi_service_name)],
                )?
                .l()?;

            // wifiManager.createMulticastLock("agaric-mdns") → MulticastLock
            let tag = env.new_string("agaric-mdns")?;
            let lock = env
                .call_method(
                    &wifi_manager,
                    "createMulticastLock",
                    "(Ljava/lang/String;)Landroid/net/wifi/WifiManager$MulticastLock;",
                    &[JValue::Object(&tag)],
                )?
                .l()?;

            // lock.setReferenceCounted(false) — one release() always unlocks.
            env.call_method(&lock, "setReferenceCounted", "(Z)V", &[JValue::Bool(0)])?;

            // lock.acquire()
            env.call_method(&lock, "acquire", "()V", &[])?;

            // Promote to GlobalRef so it survives the AttachGuard drop.
            env.new_global_ref(lock)?
        };

        tracing::info!("Android WiFi multicast lock acquired (tag=agaric-mdns)");
        Ok(Self {
            lock: global_ref,
            vm,
        })
    }
}

impl Drop for MulticastLock {
    fn drop(&mut self) {
        // Best-effort release: any JNI failure during shutdown is
        // logged but cannot bubble up (we're in `Drop`), and the JVM
        // will reap the lock on process exit anyway.
        let mut env = match self.vm.attach_current_thread() {
            Ok(e) => e,
            Err(e) => {
                tracing::warn!(
                    error = %e,
                    "failed to attach JNI thread for multicast lock release"
                );
                return;
            }
        };
        if let Err(e) = env.call_method(self.lock.as_obj(), "release", "()V", &[]) {
            tracing::warn!(error = %e, "failed to release multicast lock");
        } else {
            tracing::info!("Android WiFi multicast lock released");
        }
    }
}

#[cfg(test)]
mod tests {
    //! Android-only unit tests. Actual JNI acquisition requires a
    //! running Android JVM and cannot be exercised in the host-machine
    //! test harness; the compile-level check that this module builds
    //! against the Android target is the production safety net.
    use super::*;

    #[test]
    fn error_display_mentions_jni_kind() {
        let err = MulticastLockError::NoAndroidContext("uninit".into());
        let msg = err.to_string();
        assert!(
            msg.contains("no Android context available"),
            "error display must describe the failure mode, got: {msg}"
        );
    }

    #[test]
    fn no_context_error_has_no_source() {
        let err = MulticastLockError::NoAndroidContext("uninit".into());
        assert!(
            std::error::Error::source(&err).is_none(),
            "NoAndroidContext variant has no underlying source"
        );
    }
}
