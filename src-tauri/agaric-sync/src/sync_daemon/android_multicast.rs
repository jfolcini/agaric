//! Android WiFi multicast lock.
//!
//! On Android 6+ (SDK 23+) an app must call
//! [`WifiManager.createMulticastLock()`] and `acquire()` before the
//! kernel will deliver UDP multicast packets to its sockets — even when
//! the app has `CHANGE_WIFI_MULTICAST_STATE` and `ACCESS_WIFI_STATE`
//! permissions in its manifest. The discovery crate (`swarm-discovery`,
//! under `iroh-mdns-address-lookup`) uses raw UDP multicast, so without
//! the lock the daemon appears to start (`mdns::attach` succeeds) but
//! never resolves any peers.
//!
//! The JNI machinery here is compiled only on Android; the guard in front of
//! it, [`MulticastLock::acquire`]'s "is there an Android context at all?"
//! check, is compiled on the host under `cfg(test)` too, so the degrade path
//! can be tested off-device (#3847). It bridges into Java via JNI using the
//! Application context recorded by [`crate::android_context`]. An acquired
//! lock is a `Global` reference in [`MulticastLock`]; `Drop` releases it.
//!
//! ### When the lock is held (#6526)
//!
//! Only while the daemon runs and the app is not suspended. A suspended app's
//! packets are dropped by Android anyway, so a lock held then keeps the Wi-Fi
//! radio answering multicast for nothing. [`hold_for_daemon`] and the app's
//! `Suspended` / `Resumed` handler ([`app_suspended`], [`app_resumed`]) feed
//! one [`Hold`], which acquires and releases on each change. The release runs
//! in the handler itself, not on the daemon's tick: Android freezes a
//! suspended process before the tick comes round.
//!
//! [`Hold`] is tested on the host against a fake lock. Its three call sites
//! are `cfg(target_os = "android")` and run only on a device (#6513).
//!
//! ### Manifest permissions required
//!
//! `src-tauri/gen/android/app/src/main/AndroidManifest.xml` must declare:
//! - `android.permission.INTERNET`
//! - `android.permission.ACCESS_WIFI_STATE`
//! - `android.permission.CHANGE_WIFI_MULTICAST_STATE`
//!
//! Missing permissions surface as a `SecurityException` here and are
//! logged by [`crate::sync_daemon::session_supervisor::daemon_loop`].
//!
//! [`WifiManager.createMulticastLock()`]: https://developer.android.com/reference/android/net/wifi/WifiManager#createMulticastLock(java.lang.String)

// `cfg(test)` keeps this module compiling on the host so the
// no-Android-context degrade path has a real unit test. Everything that
// actually talks to the JVM stays `cfg(target_os = "android")`.
#![cfg(any(target_os = "android", test))]
// JNI FFI into Android's WifiManager is the only way to acquire the
// multicast lock. Each unsafe block below is justified inline.
#![allow(unsafe_code)]

use std::fmt;
#[cfg(target_os = "android")]
use std::sync::{Mutex, PoisonError};

#[cfg(target_os = "android")]
use jni::objects::{JObject, JValue};
#[cfg(target_os = "android")]
use jni::refs::Global;
#[cfg(target_os = "android")]
use jni::vm::JavaVM;
#[cfg(target_os = "android")]
use jni::{jni_sig, jni_str};

/// Error returned when the multicast lock cannot be acquired.
#[derive(Debug)]
pub enum MulticastLockError {
    /// The underlying JNI call failed (wrong method signature, Java
    /// exception, attach-thread failure, etc.).
    #[cfg(target_os = "android")]
    Jni(jni::errors::Error),
    /// No Android `Context` was available: either `JNI_OnLoad` never ran
    /// (not an Android process), or it ran and could not resolve the
    /// Application — see [`crate::android_context`]. Also covers a
    /// `Context` that yields a null `WifiManager`.
    NoAndroidContext(String),
}

impl fmt::Display for MulticastLockError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            #[cfg(target_os = "android")]
            Self::Jni(e) => write!(f, "JNI error acquiring multicast lock: {e}"),
            Self::NoAndroidContext(s) => write!(f, "no Android context available: {s}"),
        }
    }
}

impl std::error::Error for MulticastLockError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            #[cfg(target_os = "android")]
            Self::Jni(e) => Some(e),
            Self::NoAndroidContext(_) => None,
        }
    }
}

#[cfg(target_os = "android")]
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
    #[cfg(target_os = "android")]
    lock: Global<JObject<'static>>,
    #[cfg(target_os = "android")]
    vm: JavaVM,
}

impl MulticastLock {
    /// Acquire a `WifiManager.MulticastLock` for the current Android
    /// application context.
    ///
    /// The lock is tagged `"agaric-mdns"` (visible via `adb shell
    /// dumpsys wifi`) and has reference counting disabled so a single
    /// `release()` call always unlocks.
    ///
    /// Returns [`MulticastLockError::NoAndroidContext`] — it does **not**
    /// panic — when the Android context was never installed. That case used
    /// to abort the process (#3847): `ndk_context::android_context()`
    /// `expect()`s its global, and with `panic = "abort"` the resulting panic
    /// is a `SIGABRT`. [`crate::android_context::require`] answers the same
    /// question without ever touching the panicking accessor.
    pub fn acquire() -> Result<Self, MulticastLockError> {
        let ctx =
            crate::android_context::require().map_err(MulticastLockError::NoAndroidContext)?;

        #[cfg(target_os = "android")]
        {
            // SAFETY: `require()` returns `Ok` only after `JNI_OnLoad`
            // installed the context, and it installs a non-null `JavaVM*`
            // plus a JNI *global* reference to the Application object. Both
            // are owned by the JVM and valid until the process exits.
            let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) };
            let context_ptr = ctx.context();

            // jni 0.22 replaced the `AttachGuard`-returning form of
            // `attach_current_thread` with a callback-based API. The
            // provided `env` is only valid for the duration of the
            // callback, so every JNI call in the setup chain
            // (`getSystemService` → `createMulticastLock` →
            // `setReferenceCounted` → `acquire`) must run inside it, and
            // the resulting `MulticastLock` is promoted to a `Global`
            // reference before the closure returns so it survives the
            // attach scope.
            let global_ref = vm.attach_current_thread(
                |env| -> Result<Global<JObject<'static>>, MulticastLockError> {
                    // SAFETY: same invariant as above — `context_ptr` is a
                    // live JNI global reference to the Application. jni
                    // 0.22's `JObject::from_raw` now requires the `Env` to
                    // anchor the returned local reference's lifetime.
                    let context = unsafe { JObject::from_raw(env, context_ptr.cast()) };

                    // Context.getSystemService("wifi") → WifiManager
                    let wifi_service_name = env.new_string("wifi")?;
                    let wifi_manager = env
                        .call_method(
                            &context,
                            jni_str!("getSystemService"),
                            jni_sig!("(Ljava/lang/String;)Ljava/lang/Object;"),
                            &[JValue::Object(&wifi_service_name)],
                        )?
                        .l()?;

                    // Some devices and restricted/work profiles return a *null*
                    // WifiManager from getSystemService. Invoking
                    // createMulticastLock on a null receiver is a JNI fatal error
                    // (SIGSEGV under ART), not a catchable Java exception — it
                    // aborts the whole process before the `?`/exception-check
                    // machinery can turn it into an `Err`. Guard explicitly so the
                    // daemon fails soft (logs and runs without mDNS) instead of
                    // crashing.
                    if wifi_manager.as_raw().is_null() {
                        return Err(MulticastLockError::NoAndroidContext(
                            "Context.getSystemService(\"wifi\") returned null".into(),
                        ));
                    }

                    // wifiManager.createMulticastLock("agaric-mdns") → MulticastLock
                    let tag = env.new_string("agaric-mdns")?;
                    let lock = env
                        .call_method(
                            &wifi_manager,
                            jni_str!("createMulticastLock"),
                            jni_sig!(
                                "(Ljava/lang/String;)Landroid/net/wifi/WifiManager$MulticastLock;"
                            ),
                            &[JValue::Object(&tag)],
                        )?
                        .l()?;

                    // Same guard for a null MulticastLock before we call
                    // setReferenceCounted/acquire on it.
                    if lock.as_raw().is_null() {
                        return Err(MulticastLockError::NoAndroidContext(
                            "WifiManager.createMulticastLock returned null".into(),
                        ));
                    }

                    // lock.setReferenceCounted(false) — one release() always unlocks.
                    env.call_method(
                        &lock,
                        jni_str!("setReferenceCounted"),
                        jni_sig!("(Z)V"),
                        &[JValue::Bool(false)],
                    )?;

                    // lock.acquire()
                    env.call_method(&lock, jni_str!("acquire"), jni_sig!("()V"), &[])?;

                    // Promote to a `Global` reference so it survives the attach scope.
                    Ok(env.new_global_ref(lock)?)
                },
            )?;

            tracing::info!("Android WiFi multicast lock acquired (tag=agaric-mdns)");
            Ok(Self {
                lock: global_ref,
                vm,
            })
        }

        #[cfg(not(target_os = "android"))]
        {
            // Unreachable in practice: `require()` can only return `Ok` once
            // `JNI_OnLoad` has run, and that writer does not exist off
            // Android. Kept as a plain `Err` rather than `unreachable!()` so
            // no host build can be talked into panicking here.
            let _ = ctx;
            Err(MulticastLockError::NoAndroidContext(
                "WifiManager.MulticastLock is an Android-only API".to_owned(),
            ))
        }
    }
}

#[cfg(target_os = "android")]
impl Drop for MulticastLock {
    fn drop(&mut self) {
        // Best-effort release: any JNI failure during shutdown is
        // logged but cannot bubble up (we're in `Drop`), and the JVM
        // will reap the lock on process exit anyway.
        //
        // `attach_current_thread` in jni 0.22 folds attach failures and
        // callback failures into the same `Result`, so a single match
        // covers both "failed to attach the JNI thread" and "release()
        // returned a Java exception".
        let result = self
            .vm
            .attach_current_thread(|env| -> Result<(), jni::errors::Error> {
                env.call_method(
                    self.lock.as_obj(),
                    jni_str!("release"),
                    jni_sig!("()V"),
                    &[],
                )?;
                Ok(())
            });
        match result {
            Ok(()) => tracing::info!("Android WiFi multicast lock released"),
            Err(e) => tracing::warn!(error = %e, "failed to release multicast lock"),
        }
    }
}

/// Whether the lock is wanted, and the lock while it is held: exactly while the
/// daemon runs and the app is not suspended. Generic over the lock so the
/// transitions are tested on the host.
struct Hold<L> {
    daemon_running: bool,
    suspended: bool,
    lock: Option<L>,
}

impl<L> Hold<L> {
    const fn new() -> Self {
        Self {
            daemon_running: false,
            suspended: false,
            lock: None,
        }
    }

    fn set_daemon_running(&mut self, running: bool, acquire: impl FnOnce() -> Option<L>) {
        self.daemon_running = running;
        self.settle(acquire);
    }

    fn set_suspended(&mut self, suspended: bool, acquire: impl FnOnce() -> Option<L>) {
        self.suspended = suspended;
        self.settle(acquire);
    }

    /// Acquires a wanted lock that is not held, and drops (releases) a held
    /// one that is not wanted. An `acquire` that fails leaves it unheld, and
    /// the next change tries again.
    fn settle(&mut self, acquire: impl FnOnce() -> Option<L>) {
        if self.daemon_running && !self.suspended {
            if self.lock.is_none() {
                self.lock = acquire();
            }
        } else {
            self.lock = None;
        }
    }
}

#[cfg(target_os = "android")]
static HOLD: Mutex<Hold<MulticastLock>> = Mutex::new(Hold::new());

#[cfg(target_os = "android")]
fn with_hold(change: impl FnOnce(&mut Hold<MulticastLock>)) {
    change(&mut HOLD.lock().unwrap_or_else(PoisonError::into_inner));
}

/// A missing context degrades to no lock, and the daemon carries on without
/// peer discovery (#3847).
#[cfg(target_os = "android")]
fn acquire_or_warn() -> Option<MulticastLock> {
    MulticastLock::acquire()
        .inspect_err(|e| {
            tracing::warn!(
                error = %e,
                "failed to acquire Android WiFi multicast lock; mDNS peer discovery may not work"
            );
        })
        .ok()
}

/// The daemon's claim on the lock, for as long as this is alive.
#[cfg(target_os = "android")]
pub(crate) struct DaemonHold;

/// Wants the lock for the daemon until the returned value drops, and takes it
/// now unless the app is suspended.
#[cfg(target_os = "android")]
pub(crate) fn hold_for_daemon() -> DaemonHold {
    with_hold(|hold| hold.set_daemon_running(true, acquire_or_warn));
    DaemonHold
}

#[cfg(target_os = "android")]
impl Drop for DaemonHold {
    fn drop(&mut self) {
        with_hold(|hold| hold.set_daemon_running(false, acquire_or_warn));
    }
}

/// The app was suspended: release the lock.
#[cfg(target_os = "android")]
pub fn app_suspended() {
    with_hold(|hold| hold.set_suspended(true, acquire_or_warn));
}

/// The app is back: take the lock again if the daemon runs.
#[cfg(target_os = "android")]
pub fn app_resumed() {
    with_hold(|hold| hold.set_suspended(false, acquire_or_warn));
}

#[cfg(test)]
mod tests {
    //! Host-target tests. Real JNI acquisition needs a running Android JVM
    //! and cannot be exercised here; what *can* be exercised — and is the
    //! regression under test (#3847) — is that a missing Android context
    //! degrades to an `Err` instead of aborting the process.
    use std::cell::Cell;
    use std::rc::Rc;

    use super::*;

    /// Counts the locks acquired and released; a lock releases on drop, as
    /// [`MulticastLock`] does.
    #[derive(Default)]
    struct Radio {
        acquired: Cell<usize>,
        released: Rc<Cell<usize>>,
        /// The next acquire fails, as with no Android context.
        refuses: Cell<bool>,
    }

    struct FakeLock(Rc<Cell<usize>>);

    impl Drop for FakeLock {
        fn drop(&mut self) {
            self.0.set(self.0.get() + 1);
        }
    }

    impl Radio {
        fn acquire(&self) -> Option<FakeLock> {
            if self.refuses.get() {
                return None;
            }
            self.acquired.set(self.acquired.get() + 1);
            Some(FakeLock(Rc::clone(&self.released)))
        }

        /// (acquired, released) so far.
        fn counts(&self) -> (usize, usize) {
            (self.acquired.get(), self.released.get())
        }
    }

    #[test]
    fn the_lock_is_acquired_released_on_suspend_and_acquired_again_on_resume() {
        let radio = Radio::default();
        let mut hold = Hold::new();

        hold.set_daemon_running(true, || radio.acquire());
        assert_eq!(radio.counts(), (1, 0));

        hold.set_suspended(true, || radio.acquire());
        assert_eq!(radio.counts(), (1, 1));

        hold.set_suspended(false, || radio.acquire());
        assert_eq!(radio.counts(), (2, 1));
    }

    #[test]
    fn a_resume_while_the_lock_is_held_acquires_no_second_lock() {
        let radio = Radio::default();
        let mut hold = Hold::new();
        hold.set_daemon_running(true, || radio.acquire());

        hold.set_suspended(false, || radio.acquire());

        assert_eq!(radio.counts(), (1, 0));
    }

    #[test]
    fn a_daemon_that_starts_while_suspended_takes_the_lock_only_on_resume() {
        let radio = Radio::default();
        let mut hold = Hold::new();
        hold.set_suspended(true, || radio.acquire());

        hold.set_daemon_running(true, || radio.acquire());
        assert_eq!(radio.counts(), (0, 0));

        hold.set_suspended(false, || radio.acquire());
        assert_eq!(radio.counts(), (1, 0));
    }

    #[test]
    fn a_resume_with_no_daemon_running_takes_no_lock() {
        let radio = Radio::default();
        let mut hold = Hold::new();

        hold.set_suspended(true, || radio.acquire());
        hold.set_suspended(false, || radio.acquire());

        assert_eq!(radio.counts(), (0, 0));
    }

    #[test]
    fn a_daemon_that_stops_releases_the_lock_and_a_later_resume_takes_none() {
        let radio = Radio::default();
        let mut hold = Hold::new();
        hold.set_daemon_running(true, || radio.acquire());

        hold.set_daemon_running(false, || radio.acquire());
        assert_eq!(radio.counts(), (1, 1));

        hold.set_suspended(true, || radio.acquire());
        hold.set_suspended(false, || radio.acquire());
        assert_eq!(radio.counts(), (1, 1));
    }

    #[test]
    fn an_acquire_that_fails_is_tried_again_on_the_next_resume() {
        let radio = Radio::default();
        let mut hold = Hold::new();
        radio.refuses.set(true);
        hold.set_daemon_running(true, || radio.acquire());
        assert_eq!(radio.counts(), (0, 0));

        radio.refuses.set(false);
        hold.set_suspended(true, || radio.acquire());
        hold.set_suspended(false, || radio.acquire());

        assert_eq!(radio.counts(), (1, 0));
    }

    #[test]
    fn acquire_degrades_to_an_error_without_an_android_context() {
        // Before #3847 this call reached `ndk_context::android_context()`,
        // which `expect()`s a global nothing ever set: a panic, and under the
        // release profile's `panic = "abort"` a `SIGABRT` that killed the app
        // ~9s after launch. Reaching this assertion at all is the fix.
        let Err(err) = MulticastLock::acquire() else {
            panic!("no Android context exists in the host test harness");
        };
        assert!(
            matches!(err, MulticastLockError::NoAndroidContext(_)),
            "a missing Android context must surface as NoAndroidContext, got: {err:?}"
        );
    }

    #[test]
    fn acquire_error_names_the_missing_context() {
        let Err(err) = MulticastLock::acquire() else {
            panic!("no Android context exists in the host test harness");
        };
        let msg = err.to_string();
        assert!(
            msg.contains("no Android context available"),
            "the daemon logs this string; it must name the failure mode, got: {msg}"
        );
        assert!(
            msg.contains("was not installed"),
            "the message must carry the android_context reason, got: {msg}"
        );
    }

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
