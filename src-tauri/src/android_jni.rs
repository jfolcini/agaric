//! Android `JNI_OnLoad` — installs the process-global Android context (#3847).
//!
//! ## Why this lives in the app crate and not in `agaric-sync`
//!
//! The work is `agaric_sync::android_context`'s (that crate owns the `jni` /
//! `ndk-context` dependencies); only the exported **symbol** lives here. The
//! `.so` Android loads is `libagaric_lib.so` — the `cdylib` produced by *this*
//! crate (`[lib] name = "agaric_lib"`, `crate-type = ["lib", "cdylib",
//! "staticlib"]`), loaded by `WryActivity`'s
//! `companion object { init { System.loadLibrary("agaric_lib") } }`.
//!
//! A `#[unsafe(no_mangle)]` symbol defined in a dependency rlib is exported
//! from the `cdylib` only when the linker pulls that rlib's objects in at all;
//! measured on `aarch64-linux-android` with the release profile in use here
//! (`lto = "thin"`, `codegen-units = 1`, `strip = "symbols"`, `panic =
//! "abort"`), an rlib whose objects are not otherwise referenced loses its
//! `JNI_OnLoad` entirely — and a `JNI_OnLoad` that is not exported fails
//! *silently*, which is exactly the shape of the bug #3847 reported. Defining
//! it in the `cdylib` root crate has no such precondition, so that is what we
//! do.
//!
//! ## What the JVM does with it
//!
//! `JNI_OnLoad` is called by the VM the moment `libagaric_lib.so` is loaded —
//! before `WryActivity.onCreate`, and long before the sync daemon exists. It
//! must return a JNI version the VM recognises or the library is rejected with
//! `UnsatisfiedLinkError`; `agaric_sync::android_context::jni_on_load` always
//! returns `JNI_VERSION_1_6`, including when it declines to install anything.

// `#[unsafe(no_mangle)]` is what the `unsafe_code` lint fires on here; the one
// `unsafe` call is justified inline. Listed in `src-tauri/unsafe-allowlist.txt`.
#![allow(unsafe_code)]

use std::ffi::c_void;

/// JVM entry point, called once when `libagaric_lib.so` is loaded.
///
/// Delegates to [`agaric_sync::android_context::jni_on_load`], which resolves
/// the Application context and hands it plus the `JavaVM` to `ndk_context` so
/// the multicast lock and iroh's DNS resolver can use them.
///
/// The return type is `jni::sys::jint`, spelled `i32` so the app crate does
/// not take a direct `jni` dependency to name one function's return type — the
/// JNI ABI fixes `jint` to a 32-bit signed integer on every platform.
///
/// # Safety
///
/// Called by the JVM with a valid `JavaVM*`. Never called from Rust.
#[unsafe(no_mangle)]
#[allow(
    non_snake_case,
    reason = "JNI_OnLoad is a symbol name mandated by the JNI spec"
)]
pub extern "system" fn JNI_OnLoad(vm: *mut c_void, _reserved: *mut c_void) -> i32 {
    // SAFETY: `vm` is the `JavaVM*` the JVM passes to `JNI_OnLoad`, valid for
    // the process lifetime. `jni_on_load` null-checks it before use.
    unsafe { agaric_sync::android_context::jni_on_load(vm) }
}
