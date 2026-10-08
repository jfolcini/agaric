//! Process-global Android `JavaVM` + Application `Context` handles (#3847).
//!
//! ## The `ndk_context` global is tao's, not ours
//!
//! `hickory-resolver` (via `iroh` → `iroh-dns`) and `netdev` read the Android
//! context through the `ndk_context` process-global, whose accessor
//! `expect()`s it: under `panic = "abort"` a missing context is a SIGABRT.
//! tao (0.37+) installs it from `WryActivity.onCreate`, before `main` runs any
//! of our code. Never install it here too: `ndk-context` asserts on a second
//! install, which aborted every Android launch of 0.15.0. This crate no longer
//! depends on `ndk-context`, so that call cannot come back unnoticed.
//!
//! ## Why we keep our own copy of the handles
//!
//! `ndk-context 0.1.1` exposes **no** non-panicking accessor, so callers
//! cannot probe whether the global is set. Our own JNI callers (the multicast
//! lock and the network-block monitor) go through
//! [`require`](crate::android_context::require) instead, which reads the copy
//! `jni_on_load` records here and is trivially empty on every non-Android
//! target. Callers get an `Err` and degrade; nothing panics.
//!
//! `jni_on_load` is driven by `JNI_OnLoad`, which the JVM calls the instant
//! `libagaric_lib.so` is loaded. The exported symbol lives in the **app**
//! crate (`src-tauri/src/android_jni.rs`), not here: only the crate that
//! produces the `cdylib` exports `#[unsafe(no_mangle)]` symbols
//! unconditionally.

// Wrapping the raw `JavaVM*` is inherently `unsafe`. Every `unsafe` block
// below is justified inline with a `// SAFETY:` comment. Listed in
// `src-tauri/unsafe-allowlist.txt`.
#![allow(unsafe_code)]

use std::ffi::c_void;
use std::sync::OnceLock;

/// Raw JNI handles for the process-global `JavaVM` and Application `Context`.
///
/// The two fields are stored as `usize` rather than `*mut c_void` so the
/// handle is `Send + Sync` without an `unsafe impl`. Both refer to JVM-owned
/// objects that live for the whole process (the `Context` is held by a JNI
/// global reference that is intentionally never released).
#[derive(Clone, Copy, Debug)]
pub struct AndroidContext {
    java_vm: usize,
    context: usize,
}

impl AndroidContext {
    /// Pointer to the process-global `JavaVM`.
    pub fn vm(self) -> *mut c_void {
        self.java_vm as *mut c_void
    }

    /// Global reference to the Android Application `Context`.
    pub fn context(self) -> *mut c_void {
        self.context as *mut c_void
    }
}

/// Set exactly once, by `jni_on_load`, and never cleared.
static ANDROID_CONTEXT: OnceLock<AndroidContext> = OnceLock::new();

/// Why `jni_on_load` declined to install the context, if it ran and failed.
///
/// `JNI_OnLoad` runs before the tracing subscriber exists, so a log line
/// emitted there would be dropped. Recording the reason here lets the
/// eventual consumer-side warning (which *does* have a subscriber) name the
/// actual cause instead of just "not installed".
static INSTALL_FAILURE: OnceLock<String> = OnceLock::new();

/// Whether the Android `JavaVM` + Application `Context` are available.
///
/// Always `false` off Android: `jni_on_load` is the only writer and it does
/// not exist on other targets.
pub fn is_installed() -> bool {
    ANDROID_CONTEXT.get().is_some()
}

/// Renders the message attached to a failed [`require`].
///
/// Split out from [`require`] so both branches are testable without touching
/// process-global state (which would make tests order-dependent).
fn unavailable_message(failure: Option<&str>) -> String {
    match failure {
        Some(reason) => {
            format!("Android JavaVM/Application context was not installed: {reason}")
        }
        None => "Android JavaVM/Application context was not installed \
                 (JNI_OnLoad did not run in this process)"
            .to_owned(),
    }
}

/// Returns the Android context handles, or an error explaining their absence.
///
/// This is the **only** sanctioned way for this crate to reach the Android
/// context. Call it instead of `ndk_context::android_context()`, which aborts
/// the process when the context was never installed.
pub fn require() -> Result<AndroidContext, String> {
    match ANDROID_CONTEXT.get() {
        Some(ctx) => Ok(*ctx),
        None => Err(unavailable_message(
            INSTALL_FAILURE.get().map(String::as_str),
        )),
    }
}

/// Records why the context could not be installed (first reason wins).
#[cfg(target_os = "android")]
fn record_failure(reason: String) {
    tracing::warn!(
        reason = %reason,
        "Android context not installed; sync will run without a multicast lock \
         or network-block reports"
    );
    let _ = INSTALL_FAILURE.set(reason);
}

/// Records the Android context for [`require`]. Call from `JNI_OnLoad` only.
///
/// Returns the JNI version to hand back to the JVM. This is **always**
/// `JNI_VERSION_1_6`, including on failure: returning an unrecognised version
/// makes the JVM reject the library outright with `UnsatisfiedLinkError`,
/// which would turn a degraded-discovery problem into a dead app.
///
/// # Safety
///
/// `vm` must be the `JavaVM*` the JVM passed to `JNI_OnLoad`; it is valid for
/// the lifetime of the process.
#[cfg(target_os = "android")]
pub unsafe fn jni_on_load(vm: *mut c_void) -> jni::sys::jint {
    use jni::JNIVersion;
    use jni::objects::JObject;
    use jni::refs::Global;
    use jni::vm::JavaVM;
    use jni::{jni_sig, jni_str};

    if vm.is_null() {
        record_failure("JNI_OnLoad received a null JavaVM pointer".to_owned());
        return JNIVersion::V1_6.into();
    }

    // SAFETY: the caller contract above — `vm` is the JVM-owned `JavaVM*`
    // handed to `JNI_OnLoad`, valid until the process exits. `from_raw` only
    // null-checks, and we have already rejected null.
    let java_vm = unsafe { JavaVM::from_raw(vm.cast()) };

    // `JNI_OnLoad` runs on the thread that called `System.loadLibrary`, which
    // is already attached; `attach_current_thread` reduces to a TLS lookup.
    //
    // `JNI_OnLoad` is handed a VM but *not* a Context, so we ask the runtime
    // for the Application: `ActivityThread.currentApplication()` is the
    // conventional route and returns the process-wide `android.app.Application`
    // — a longer-lived and safer choice than an Activity, which would dangle
    // across configuration changes. It can legitimately return null when no
    // Application has been created yet, which we treat as "skip", never as a
    // reason to panic or to store a null pointer.
    let resolved = java_vm.attach_current_thread(
        |env| -> Result<Option<Global<JObject<'static>>>, jni::errors::Error> {
            let app = env
                .call_static_method(
                    jni_str!("android/app/ActivityThread"),
                    jni_str!("currentApplication"),
                    jni_sig!("()Landroid/app/Application;"),
                    &[],
                )?
                .l()?;
            if app.as_raw().is_null() {
                return Ok(None);
            }
            // Promote to a global reference: the pointer we record must stay
            // valid for the whole process, and a local reference dies when
            // this attach scope ends.
            Ok(Some(env.new_global_ref(app)?))
        },
    );

    let context = match resolved {
        Ok(Some(global)) => global,
        Ok(None) => {
            record_failure("ActivityThread.currentApplication() returned null".to_owned());
            return JNIVersion::V1_6.into();
        }
        Err(e) => {
            record_failure(format!("ActivityThread.currentApplication() failed: {e}"));
            return JNIVersion::V1_6.into();
        }
    };

    // Deliberately leaks the global reference: our JNI callers hold this
    // pointer for the process lifetime, so it must never be deleted.
    let context_ptr: *mut c_void = context.into_raw().cast();

    // Recorded for `require` only, never handed to `ndk_context`: tao installs
    // that global itself, and `ndk-context` asserts on a second install.
    let _ = ANDROID_CONTEXT.set(AndroidContext {
        java_vm: vm as usize,
        context: context_ptr as usize,
    });

    JNIVersion::V1_6.into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn context_is_not_installed_on_a_host_target() {
        // `jni_on_load` is the only writer and is `#[cfg(target_os =
        // "android")]`, so a host build can never observe an installed
        // context. This is what makes the degrade path in
        // `MulticastLock::acquire` reachable (and testable) off-device.
        assert!(
            !is_installed(),
            "nothing off Android may install the Android context"
        );
    }

    #[test]
    fn require_errors_instead_of_panicking_when_uninstalled() {
        let err = require().expect_err("no Android context exists on a host target");
        assert!(
            err.contains("was not installed"),
            "error must say the context is missing, got: {err}"
        );
    }

    #[test]
    fn unavailable_message_reports_a_recorded_failure_reason() {
        let msg = unavailable_message(Some("ActivityThread.currentApplication() returned null"));
        assert!(
            msg.contains("ActivityThread.currentApplication() returned null"),
            "a recorded JNI_OnLoad failure must be surfaced to the consumer, got: {msg}"
        );
    }

    #[test]
    fn unavailable_message_reports_jni_on_load_never_running() {
        let msg = unavailable_message(None);
        assert!(
            msg.contains("JNI_OnLoad did not run"),
            "with no recorded failure the message must name the absent JNI_OnLoad, got: {msg}"
        );
    }
}
