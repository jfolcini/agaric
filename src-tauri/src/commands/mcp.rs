//! FEAT-4e — Tauri commands backing the Settings "Agent access" tab.
//!
//! Three commands are exposed to the frontend:
//!
//! - `get_mcp_status` — returns `{ enabled, socket_path, active_connections }`
//!   for the RO toggle + activity-feed badge. Reads the `mcp-ro-enabled`
//!   marker file and the shared [`McpLifecycle`] counter. Never touches the
//!   socket itself.
//! - `mcp_set_enabled(enabled)` — creates or deletes the marker file, then
//!   either spawns the MCP serve task (enable) or notifies the disconnect
//!   signal and lets the serve loop drop its listener (disable). The
//!   marker file is always the source of truth for the `enabled`
//!   status — the runtime `McpLifecycle::is_running()` flag is only used
//!   to decide whether a re-spawn is needed.
//! - `mcp_disconnect_all` — fires `McpLifecycle::disconnect_all()` so every
//!   in-flight connection's `select!` branch wakes and the handler drops
//!   the socket. Subsequent connects succeed — the kill switch is a
//!   one-shot, not a toggle.
//! - `get_mcp_socket_path` — pure path resolver for the Settings "Copy"
//!   button (no DB access, no lifecycle state).
//!
//! Each command has an `inner_*` helper that takes the pieces of state it
//! needs as plain arguments so the unit tests do not need a full Tauri
//! `AppHandle`.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use specta::Type;

use super::sanitize_internal_error;
use crate::error::AppError;
use crate::mcp::{
    self, default_mcp_ro_socket_path, default_mcp_rw_socket_path, mcp_ro_enabled, mcp_rw_enabled,
    McpLifecycle, McpRwLifecycle, MCP_RO_ENABLED_MARKER, MCP_RW_ENABLED_MARKER,
};

// ---------------------------------------------------------------------------
// Response type
// ---------------------------------------------------------------------------

/// Snapshot of the MCP RO server state surfaced to the Settings tab.
///
/// `socket_path` is a display string on every platform (the Unix socket
/// filesystem path on Linux / macOS, the named-pipe path on Windows).
/// `active_connections` reports the instantaneous count from
/// [`McpLifecycle::connection_count`] — it is not a rolling average.
#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct McpStatus {
    pub enabled: bool,
    pub socket_path: String,
    pub active_connections: u32,
}

// ---------------------------------------------------------------------------
// Inner implementations — testable without Tauri state
// ---------------------------------------------------------------------------

/// Resolve the default MCP RO socket path for `app_data_dir` and render it
/// as a display string. On Windows this is the named-pipe path; on unix
/// it is the filesystem socket path under the app data directory.
pub fn get_mcp_socket_path_inner(app_data_dir: &Path) -> String {
    default_mcp_ro_socket_path(app_data_dir)
        .to_string_lossy()
        .into_owned()
}

/// Compute the status struct from `app_data_dir` + a shared
/// [`McpLifecycle`]. Pure function — no IO besides `is_file()` on the
/// marker file. Safe to call regardless of whether the MCP task is
/// currently running.
pub fn get_mcp_status_inner(app_data_dir: &Path, lifecycle: &McpLifecycle) -> McpStatus {
    let enabled = mcp_ro_enabled(app_data_dir);
    let socket_path = get_mcp_socket_path_inner(app_data_dir);
    // `connection_count` is a usize; cap at u32::MAX for the wire (the
    // serialized frontend type uses `number`, which is a safe IEEE-754
    // double — anything under 2^53 round-trips cleanly).
    let active_connections = u32::try_from(lifecycle.connection_count()).unwrap_or(u32::MAX);
    McpStatus {
        enabled,
        socket_path,
        active_connections,
    }
}

/// Wake every in-flight MCP connection so the serve loop's per-connection
/// `select!` branch fires and the stream is dropped. Idempotent.
pub fn mcp_disconnect_all_inner(lifecycle: &McpLifecycle) {
    lifecycle.disconnect_all();
}

/// Shared body for [`mcp_set_enabled_inner`] and
/// [`mcp_rw_set_enabled_inner`].
///
/// L-47: the RO and RW markers used to live in two byte-identical
/// helpers that differed only in the marker filename and the log
/// strings. Any future change (e.g. closing the listener for the H-2
/// fix) had to be applied twice. Parameterising on `marker_filename`
/// and `log_label` (`"RO"` / `"RW"`) reduces the surface to one
/// implementation; the public RO/RW wrappers below are the only places
/// that pick the per-surface constants.
///
/// See [`mcp_set_enabled_inner`] for the per-state semantics
/// (idempotent, fires `lifecycle.shutdown()` on disable, etc.).
fn set_marker_enabled(
    app_data_dir: &Path,
    lifecycle: &McpLifecycle,
    marker_filename: &str,
    log_label: &'static str,
    enabled: bool,
) -> Result<bool, AppError> {
    let marker_path = app_data_dir.join(marker_filename);
    let currently_enabled = marker_path.is_file();

    if enabled == currently_enabled {
        // Already in the requested state — keep the operation idempotent
        // so the frontend does not have to track UI-local state to avoid
        // double-toggle errors.
        return Ok(false);
    }

    if enabled {
        // Ensure parent dir exists (may be a freshly-created temp dir in
        // tests). `app_data_dir` is assumed to exist in production since
        // it is set up by the Tauri bootstrap in `lib.rs`.
        if !app_data_dir.exists() {
            std::fs::create_dir_all(app_data_dir)?;
        }
        std::fs::write(&marker_path, b"")?;
        tracing::info!(
            target: "mcp",
            label = log_label,
            path = %marker_path.display(),
            "MCP marker created (enabled)",
        );
    } else {
        match std::fs::remove_file(&marker_path) {
            Ok(_) => {
                tracing::info!(
                    target: "mcp",
                    label = log_label,
                    path = %marker_path.display(),
                    "MCP marker removed (disabled)",
                );
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                // Race with another toggle — treat as idempotent rather
                // than surfacing an IO error.
            }
            Err(e) => return Err(AppError::Io(e)),
        }
        // H-2: tell the accept loop to drop its listener AND kick every
        // in-flight connection. The single `disconnect_signal.notify_waiters()`
        // inside `shutdown` wakes both — the per-connection `run_connection`
        // tasks observe it via their existing `select!`, and the accept
        // loop observes it via the new `serve_unix` / `serve_pipe` select.
        // Without `shutdown`'s `enabled = false` store the loop would just
        // re-arm `accept()` on the next iteration; with it the loop's
        // gate check fires before another `accept()` call and the function
        // returns, dropping the listener.
        lifecycle.shutdown();
    }

    Ok(true)
}

/// Toggle the `mcp-ro-enabled` marker file under `app_data_dir`.
///
/// - `enabled=true`: creates the marker (if missing). The caller is
///   responsible for re-spawning the MCP task if `lifecycle.is_running()`
///   is `false` — this helper only owns the on-disk state so it is
///   trivially testable without a Tauri runtime.
/// - `enabled=false`: removes the marker (if present) and fires
///   [`McpLifecycle::shutdown`]. Shutdown stores `enabled = false` into
///   the lifecycle gate so the accept loop's next iteration drops its
///   listener and returns (releasing the OS socket file / named pipe),
///   then notifies every in-flight per-connection task so each observes
///   the disconnect signal via its `select!` and drops its stream.
///   Subsequent `bind_socket` calls (e.g. at next app startup with the
///   marker absent, or via a follow-up `mcp_set_enabled(true)`) get a
///   fresh listener.
///
/// Returns `Ok(true)` when the marker file state actually changed and
/// `Ok(false)` when the requested state was already in effect (so the
/// frontend can surface "already on / already off" without an error).
///
/// L-47: thin wrapper around [`set_marker_enabled`].
pub fn mcp_set_enabled_inner(
    app_data_dir: &Path,
    lifecycle: &McpLifecycle,
    enabled: bool,
) -> Result<bool, AppError> {
    set_marker_enabled(
        app_data_dir,
        lifecycle,
        MCP_RO_ENABLED_MARKER,
        "RO",
        enabled,
    )
}

// ---------------------------------------------------------------------------
// Tauri command wrappers
// ---------------------------------------------------------------------------

fn app_data_dir_from_handle<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<PathBuf, AppError> {
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))
}

/// Serialise rapid `mcp_set_enabled` calls so the marker write +
/// `is_running()` check + spawn cannot interleave with a concurrent
/// disable.
///
/// L-46: under fast UI toggling (double-click, power-user flicking the
/// Settings switch) the read-modify-spawn sequence inside
/// [`mcp_set_enabled`] could race with itself — a previous serve loop's
/// `task_running` flag could already be `false` while the listener was
/// still bound, and the next spawn would hit "already bound" and silently
/// no-op, leaving the user in an "enabled but not bound" stall that
/// survived until restart.
///
/// Holding this gate for the *full* command body (inner toggle +
/// re-spawn) forces sequential execution; the underlying lifecycle
/// shutdown / restart can then complete in order. The RW surface gets
/// its own gate ([`McpRwToggleGate`]) so RO and RW toggles do not block
/// each other — they manage independent listeners and lifecycles.
pub struct McpToggleGate(pub Arc<tokio::sync::Mutex<()>>);

impl McpToggleGate {
    /// Construct a fresh gate for managed state in `lib.rs`.
    pub fn new() -> Self {
        Self(Arc::new(tokio::sync::Mutex::new(())))
    }
}

impl Default for McpToggleGate {
    fn default() -> Self {
        Self::new()
    }
}

/// L-46: RW counterpart to [`McpToggleGate`]. Independent gate so RO
/// and RW toggles do not contend.
pub struct McpRwToggleGate(pub Arc<tokio::sync::Mutex<()>>);

impl McpRwToggleGate {
    pub fn new() -> Self {
        Self(Arc::new(tokio::sync::Mutex::new(())))
    }
}

impl Default for McpRwToggleGate {
    fn default() -> Self {
        Self::new()
    }
}

/// Tauri command: return the current MCP RO status for the Settings tab.
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn get_mcp_status(
    app: tauri::AppHandle,
    lifecycle: tauri::State<'_, Arc<McpLifecycle>>,
) -> Result<McpStatus, AppError> {
    let app_data_dir = app_data_dir_from_handle(&app).map_err(sanitize_internal_error)?;
    Ok(get_mcp_status_inner(&app_data_dir, lifecycle.inner()))
}

/// Tauri command: return the default socket path for the current platform.
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn get_mcp_socket_path(app: tauri::AppHandle) -> Result<String, AppError> {
    let app_data_dir = app_data_dir_from_handle(&app).map_err(sanitize_internal_error)?;
    Ok(get_mcp_socket_path_inner(&app_data_dir))
}

/// Tauri command: disconnect every in-flight MCP connection.
///
/// Fires the `McpLifecycle` disconnect signal — every connection's
/// `select!` branch wakes asynchronously and drops its stream. The
/// signal is fire-and-forget; this command returns `Ok(())` as soon
/// as the signal has been emitted.
///
/// L-51: the previous doc-comment promised this command "returns the
/// connection count observed immediately after firing the signal", but
/// the signature is `Result<(), AppError>`. The mismatch was a doc
/// drift — the count was never surfaced. The Settings tab observes the
/// connection count via `get_mcp_status` (which polls
/// `lifecycle.connection_count()` directly) rather than via this
/// command's return value, so adding a count return here would be
/// pure noise. Aligned the doc to the actual `Ok(())` contract.
///
/// Reporting a count adjacent to disconnect-all would also be
/// misleading: `lifecycle.disconnect_all()` is asynchronous, so any
/// snapshot taken right after the signal fires is racy — connections
/// observed at T may already be unwinding by T + ε. The Settings tab's
/// `get_mcp_status` polling loop is the right place to read the
/// post-disconnect count, not this command.
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn mcp_disconnect_all(
    lifecycle: tauri::State<'_, Arc<McpLifecycle>>,
) -> Result<(), AppError> {
    mcp_disconnect_all_inner(lifecycle.inner());
    Ok(())
}

/// Tauri command: toggle the MCP RO enabled marker file and start / stop
/// the serve task accordingly.
///
/// L-46: the inner toggle + spawn sequence is serialised through the
/// shared [`McpToggleGate`] (`tokio::sync::Mutex`) so rapid UI toggles
/// cannot interleave and leave the server in an "enabled but not
/// bound" stall. The lock is held for the full command body so a
/// concurrent disable cannot race ahead of the spawn.
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub async fn mcp_set_enabled(
    app: tauri::AppHandle,
    lifecycle: tauri::State<'_, Arc<McpLifecycle>>,
    toggle_gate: tauri::State<'_, McpToggleGate>,
    read_pool: tauri::State<'_, crate::db::ReadPool>,
    write_pool: tauri::State<'_, crate::db::WritePool>,
    materializer: tauri::State<'_, crate::materializer::Materializer>,
    device_id: tauri::State<'_, crate::device::DeviceId>,
    enabled: bool,
) -> Result<bool, AppError> {
    // L-46: serialise rapid toggles. Cloning the `Arc` lets us hold the
    // gate across `await` without borrowing the `tauri::State`.
    let gate = toggle_gate.inner().0.clone();
    let _guard = gate.lock().await;

    let app_data_dir = app_data_dir_from_handle(&app).map_err(sanitize_internal_error)?;
    let lc = lifecycle.inner().clone();
    let changed =
        mcp_set_enabled_inner(&app_data_dir, &lc, enabled).map_err(sanitize_internal_error)?;

    // Start the task if the marker was just created and no serve loop
    // is currently running. `spawn_mcp_ro_task` rechecks the marker file
    // itself, so racing with a concurrent disable ends in a no-op rather
    // than a phantom serve loop.
    //
    // FEAT-4c — the reader pool, materializer, and device_id are pulled
    // from managed state so the respawn rewires the real `ReadOnlyTools`
    // registry rather than a placeholder.
    //
    // M-82 — also pull the writer pool from managed state because
    // `journal_for_date` (the lone RO tool with a write side-effect)
    // needs it whenever the requested date page does not yet exist.
    if enabled && !lc.is_running() {
        mcp::spawn_mcp_ro_task(
            &app_data_dir,
            app.clone(),
            read_pool.inner().0.clone(),
            write_pool.inner().0.clone(),
            materializer.inner().clone(),
            device_id.inner().as_str().to_string(),
            Some((*lc).clone()),
        );
    }

    Ok(changed)
}

// ---------------------------------------------------------------------------
// Read-write parallel surface (FEAT-4h slice 2)
// ---------------------------------------------------------------------------

/// Snapshot of the MCP **read-write** server state surfaced to the
/// Settings tab. Identical fields to [`McpStatus`] but a distinct type so
/// the Tauri command surface stays RO / RW symmetric and the frontend
/// can present them as separate toggles.
#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct McpRwStatus {
    pub enabled: bool,
    pub socket_path: String,
    pub active_connections: u32,
}

/// Resolve the default MCP RW socket path for `app_data_dir` and render
/// it as a display string. See [`get_mcp_socket_path_inner`] for the RO
/// counterpart.
pub fn get_mcp_rw_socket_path_inner(app_data_dir: &Path) -> String {
    default_mcp_rw_socket_path(app_data_dir)
        .to_string_lossy()
        .into_owned()
}

/// Compute the RW status struct from `app_data_dir` + a shared
/// [`McpLifecycle`]. Mirrors [`get_mcp_status_inner`] but reads the RW
/// marker file.
pub fn get_mcp_rw_status_inner(app_data_dir: &Path, lifecycle: &McpLifecycle) -> McpRwStatus {
    let enabled = mcp_rw_enabled(app_data_dir);
    let socket_path = get_mcp_rw_socket_path_inner(app_data_dir);
    let active_connections = u32::try_from(lifecycle.connection_count()).unwrap_or(u32::MAX);
    McpRwStatus {
        enabled,
        socket_path,
        active_connections,
    }
}

/// Wake every in-flight RW MCP connection. Idempotent — see
/// [`mcp_disconnect_all_inner`] for the RO twin.
pub fn mcp_rw_disconnect_all_inner(lifecycle: &McpLifecycle) {
    lifecycle.disconnect_all();
}

/// Toggle the `mcp-rw-enabled` marker file under `app_data_dir`. Same
/// shape and semantics as [`mcp_set_enabled_inner`] but for the RW
/// marker; the caller is responsible for re-spawning the RW task if
/// `lifecycle.is_running()` is `false` after a fresh enable. The disable
/// path also fires [`McpLifecycle::shutdown`] (H-2) so the RW accept
/// loop drops its listener instead of staying open until app restart.
///
/// L-47: thin wrapper around [`set_marker_enabled`].
pub fn mcp_rw_set_enabled_inner(
    app_data_dir: &Path,
    lifecycle: &McpLifecycle,
    enabled: bool,
) -> Result<bool, AppError> {
    set_marker_enabled(
        app_data_dir,
        lifecycle,
        MCP_RW_ENABLED_MARKER,
        "RW",
        enabled,
    )
}

/// Tauri command: return the current MCP RW status for the Settings tab.
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn get_mcp_rw_status(
    app: tauri::AppHandle,
    lifecycle: tauri::State<'_, McpRwLifecycle>,
) -> Result<McpRwStatus, AppError> {
    let app_data_dir = app_data_dir_from_handle(&app).map_err(sanitize_internal_error)?;
    Ok(get_mcp_rw_status_inner(&app_data_dir, &lifecycle.inner().0))
}

/// Tauri command: return the default RW socket path for the current
/// platform. Same shape as [`get_mcp_socket_path`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn get_mcp_rw_socket_path(app: tauri::AppHandle) -> Result<String, AppError> {
    let app_data_dir = app_data_dir_from_handle(&app).map_err(sanitize_internal_error)?;
    Ok(get_mcp_rw_socket_path_inner(&app_data_dir))
}

/// Tauri command: disconnect every in-flight RW MCP connection.
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn mcp_rw_disconnect_all(
    lifecycle: tauri::State<'_, McpRwLifecycle>,
) -> Result<(), AppError> {
    mcp_rw_disconnect_all_inner(&lifecycle.inner().0);
    Ok(())
}

/// Tauri command: toggle the MCP RW enabled marker file and start / stop
/// the RW serve task accordingly. Mirrors [`mcp_set_enabled`] but binds
/// the **writer** pool into the `ReadWriteTools` registry.
///
/// L-46: serialised through [`McpRwToggleGate`] — see `mcp_set_enabled`
/// for the rationale. RO and RW each hold their own gate so they do
/// not block each other.
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn mcp_rw_set_enabled(
    app: tauri::AppHandle,
    lifecycle: tauri::State<'_, McpRwLifecycle>,
    toggle_gate: tauri::State<'_, McpRwToggleGate>,
    write_pool: tauri::State<'_, crate::db::WritePool>,
    materializer: tauri::State<'_, crate::materializer::Materializer>,
    device_id: tauri::State<'_, crate::device::DeviceId>,
    enabled: bool,
) -> Result<bool, AppError> {
    // L-46: serialise rapid toggles.
    let gate = toggle_gate.inner().0.clone();
    let _guard = gate.lock().await;

    let app_data_dir = app_data_dir_from_handle(&app).map_err(sanitize_internal_error)?;
    let lc = lifecycle.inner().0.clone();
    let changed =
        mcp_rw_set_enabled_inner(&app_data_dir, &lc, enabled).map_err(sanitize_internal_error)?;

    if enabled && !lc.is_running() {
        mcp::spawn_mcp_rw_task(
            &app_data_dir,
            app.clone(),
            write_pool.inner().0.clone(),
            materializer.inner().clone(),
            device_id.inner().as_str().to_string(),
            Some((*lc).clone()),
        );
    }

    Ok(changed)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn make_lifecycle() -> McpLifecycle {
        McpLifecycle::new()
    }

    // ── get_mcp_socket_path_inner ────────────────────────────────────────

    #[test]
    fn socket_path_is_non_empty() {
        let dir = TempDir::new().unwrap();
        let path = get_mcp_socket_path_inner(dir.path());
        assert!(!path.is_empty(), "socket path must be non-empty");
    }

    #[cfg(unix)]
    #[test]
    fn socket_path_is_under_app_data_dir_on_unix() {
        let dir = TempDir::new().unwrap();
        let path = get_mcp_socket_path_inner(dir.path());
        let expected = dir.path().join("mcp-ro.sock");
        assert_eq!(path, expected.to_string_lossy().into_owned());
    }

    #[cfg(windows)]
    #[test]
    fn socket_path_is_named_pipe_on_windows() {
        let dir = TempDir::new().unwrap();
        let path = get_mcp_socket_path_inner(dir.path());
        assert_eq!(path, crate::mcp::MCP_RO_PIPE_PATH);
    }

    // ── get_mcp_status_inner ─────────────────────────────────────────────

    #[test]
    fn status_reports_disabled_when_marker_absent() {
        let dir = TempDir::new().unwrap();
        let lc = make_lifecycle();
        let status = get_mcp_status_inner(dir.path(), &lc);
        assert!(!status.enabled, "must be disabled when marker absent");
        assert_eq!(status.active_connections, 0);
        assert!(
            !status.socket_path.is_empty(),
            "socket path reported even when disabled",
        );
    }

    #[test]
    fn status_reports_enabled_when_marker_present() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join(MCP_RO_ENABLED_MARKER), b"").unwrap();
        let lc = make_lifecycle();
        let status = get_mcp_status_inner(dir.path(), &lc);
        assert!(status.enabled, "must be enabled when marker present");
    }

    #[test]
    fn status_reports_current_connection_count() {
        let dir = TempDir::new().unwrap();
        let lc = make_lifecycle();
        lc.active_connections
            .store(3, std::sync::atomic::Ordering::Release);
        let status = get_mcp_status_inner(dir.path(), &lc);
        assert_eq!(
            status.active_connections, 3,
            "status must reflect the lifecycle's current connection count",
        );
    }

    // ── mcp_set_enabled_inner ────────────────────────────────────────────

    #[test]
    fn set_enabled_true_creates_marker() {
        let dir = TempDir::new().unwrap();
        let lc = make_lifecycle();
        let changed = mcp_set_enabled_inner(dir.path(), &lc, true).unwrap();
        assert!(changed, "must report a state change on fresh enable");
        assert!(
            dir.path().join(MCP_RO_ENABLED_MARKER).is_file(),
            "marker file must exist after enable",
        );
    }

    #[test]
    fn set_enabled_false_removes_marker() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join(MCP_RO_ENABLED_MARKER), b"").unwrap();
        let lc = make_lifecycle();
        let changed = mcp_set_enabled_inner(dir.path(), &lc, false).unwrap();
        assert!(changed, "must report a state change on fresh disable");
        assert!(
            !dir.path().join(MCP_RO_ENABLED_MARKER).exists(),
            "marker file must not exist after disable",
        );
    }

    #[test]
    fn set_enabled_is_idempotent_when_already_enabled() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join(MCP_RO_ENABLED_MARKER), b"").unwrap();
        let lc = make_lifecycle();
        let changed = mcp_set_enabled_inner(dir.path(), &lc, true).unwrap();
        assert!(
            !changed,
            "enabling when already enabled must not report a change",
        );
    }

    #[test]
    fn set_enabled_is_idempotent_when_already_disabled() {
        let dir = TempDir::new().unwrap();
        let lc = make_lifecycle();
        let changed = mcp_set_enabled_inner(dir.path(), &lc, false).unwrap();
        assert!(
            !changed,
            "disabling when already disabled must not report a change",
        );
    }

    #[test]
    fn set_enabled_false_fires_disconnect_signal() {
        // The disconnect_signal is a tokio::Notify — to assert that a
        // waiter was woken we need a tokio runtime. Run the test inside
        // a single-threaded runtime and await the notification.
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let dir = TempDir::new().unwrap();
                std::fs::write(dir.path().join(MCP_RO_ENABLED_MARKER), b"").unwrap();
                let lc = make_lifecycle();

                // Pre-register a waiter on the notify so we can observe
                // that the disable path woke it.
                let signal = lc.disconnect_signal.clone();
                let waiter = tokio::spawn(async move { signal.notified().await });

                // Yield once so the waiter is registered before we fire.
                tokio::task::yield_now().await;

                mcp_set_enabled_inner(dir.path(), &lc, false).unwrap();

                // The waiter must complete within a tight timeout if the
                // notify fired.
                tokio::time::timeout(std::time::Duration::from_millis(500), waiter)
                    .await
                    .expect("disconnect_signal must fire on disable")
                    .expect("waiter task joined cleanly");
            });
    }

    // ── mcp_disconnect_all_inner ─────────────────────────────────────────

    #[test]
    fn disconnect_all_wakes_waiters() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let lc = make_lifecycle();
                let signal = lc.disconnect_signal.clone();
                let waiter = tokio::spawn(async move { signal.notified().await });
                tokio::task::yield_now().await;

                mcp_disconnect_all_inner(&lc);

                tokio::time::timeout(std::time::Duration::from_millis(500), waiter)
                    .await
                    .expect("disconnect_all must fire the notify")
                    .expect("waiter task joined cleanly");
            });
    }

    #[test]
    fn disconnect_all_is_safe_with_no_waiters() {
        // Safety property: calling disconnect with no active connections
        // must not panic or deadlock — the notify is a one-shot-per-call.
        let lc = make_lifecycle();
        mcp_disconnect_all_inner(&lc);
        mcp_disconnect_all_inner(&lc);
    }

    #[test]
    fn lifecycle_counter_guard_increments_and_decrements() {
        let lc = make_lifecycle();
        assert_eq!(lc.connection_count(), 0, "starts at zero");
        {
            let _g = crate::mcp::ConnectionCounterGuard::new(lc.active_connections.clone());
            assert_eq!(lc.connection_count(), 1, "guard bumps the counter");
            {
                let _g2 = crate::mcp::ConnectionCounterGuard::new(lc.active_connections.clone());
                assert_eq!(lc.connection_count(), 2, "nested guard stacks");
            }
            assert_eq!(lc.connection_count(), 1, "inner drop restores previous");
        }
        assert_eq!(lc.connection_count(), 0, "outer drop restores zero");
    }

    // ── RW parity tests (FEAT-4h slice 2) ────────────────────────────────

    #[test]
    fn rw_socket_path_is_non_empty() {
        let dir = TempDir::new().unwrap();
        let path = get_mcp_rw_socket_path_inner(dir.path());
        assert!(!path.is_empty(), "RW socket path must be non-empty");
    }

    #[cfg(unix)]
    #[test]
    fn rw_socket_path_is_under_app_data_dir_on_unix() {
        let dir = TempDir::new().unwrap();
        let path = get_mcp_rw_socket_path_inner(dir.path());
        let expected = dir.path().join("mcp-rw.sock");
        assert_eq!(path, expected.to_string_lossy().into_owned());
    }

    #[cfg(windows)]
    #[test]
    fn rw_socket_path_is_named_pipe_on_windows() {
        let dir = TempDir::new().unwrap();
        let path = get_mcp_rw_socket_path_inner(dir.path());
        assert_eq!(path, crate::mcp::MCP_RW_PIPE_PATH);
    }

    #[test]
    fn rw_status_reports_disabled_when_marker_absent() {
        let dir = TempDir::new().unwrap();
        let lc = make_lifecycle();
        let status = get_mcp_rw_status_inner(dir.path(), &lc);
        assert!(!status.enabled, "RW must be disabled when marker absent");
        assert_eq!(status.active_connections, 0);
        assert!(!status.socket_path.is_empty());
    }

    #[test]
    fn rw_status_reports_enabled_when_marker_present() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join(MCP_RW_ENABLED_MARKER), b"").unwrap();
        let lc = make_lifecycle();
        let status = get_mcp_rw_status_inner(dir.path(), &lc);
        assert!(status.enabled, "RW must be enabled when marker present");
    }

    #[test]
    fn rw_set_enabled_true_creates_marker() {
        let dir = TempDir::new().unwrap();
        let lc = make_lifecycle();
        let changed = mcp_rw_set_enabled_inner(dir.path(), &lc, true).unwrap();
        assert!(changed, "must report a state change on fresh enable");
        assert!(
            dir.path().join(MCP_RW_ENABLED_MARKER).is_file(),
            "RW marker file must exist after enable",
        );
    }

    #[test]
    fn rw_set_enabled_false_removes_marker() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join(MCP_RW_ENABLED_MARKER), b"").unwrap();
        let lc = make_lifecycle();
        let changed = mcp_rw_set_enabled_inner(dir.path(), &lc, false).unwrap();
        assert!(changed, "must report a state change on fresh disable");
        assert!(
            !dir.path().join(MCP_RW_ENABLED_MARKER).exists(),
            "RW marker file must not exist after disable",
        );
    }

    #[test]
    fn rw_set_enabled_is_idempotent_when_already_enabled() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join(MCP_RW_ENABLED_MARKER), b"").unwrap();
        let lc = make_lifecycle();
        let changed = mcp_rw_set_enabled_inner(dir.path(), &lc, true).unwrap();
        assert!(!changed);
    }

    #[test]
    fn rw_set_enabled_is_idempotent_when_already_disabled() {
        let dir = TempDir::new().unwrap();
        let lc = make_lifecycle();
        let changed = mcp_rw_set_enabled_inner(dir.path(), &lc, false).unwrap();
        assert!(!changed);
    }

    #[test]
    fn rw_set_enabled_false_fires_disconnect_signal() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let dir = TempDir::new().unwrap();
                std::fs::write(dir.path().join(MCP_RW_ENABLED_MARKER), b"").unwrap();
                let lc = make_lifecycle();
                let signal = lc.disconnect_signal.clone();
                let waiter = tokio::spawn(async move { signal.notified().await });
                tokio::task::yield_now().await;
                mcp_rw_set_enabled_inner(dir.path(), &lc, false).unwrap();
                tokio::time::timeout(std::time::Duration::from_millis(500), waiter)
                    .await
                    .expect("disconnect_signal must fire on RW disable")
                    .expect("waiter task joined cleanly");
            });
    }

    #[test]
    fn rw_disconnect_all_wakes_waiters() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let lc = make_lifecycle();
                let signal = lc.disconnect_signal.clone();
                let waiter = tokio::spawn(async move { signal.notified().await });
                tokio::task::yield_now().await;
                mcp_rw_disconnect_all_inner(&lc);
                tokio::time::timeout(std::time::Duration::from_millis(500), waiter)
                    .await
                    .expect("RW disconnect_all must fire the notify")
                    .expect("waiter task joined cleanly");
            });
    }

    #[test]
    fn rw_and_ro_markers_are_independent() {
        // Flipping RW must not affect RO state and vice versa.
        let dir = TempDir::new().unwrap();
        let lc = make_lifecycle();

        mcp_rw_set_enabled_inner(dir.path(), &lc, true).unwrap();
        assert!(mcp_rw_enabled(dir.path()));
        assert!(!mcp_ro_enabled(dir.path()), "RW enable must not flip RO");

        mcp_set_enabled_inner(dir.path(), &lc, true).unwrap();
        assert!(mcp_ro_enabled(dir.path()));

        mcp_rw_set_enabled_inner(dir.path(), &lc, false).unwrap();
        assert!(!mcp_rw_enabled(dir.path()));
        assert!(mcp_ro_enabled(dir.path()), "RW disable must not flip RO");
    }

    #[test]
    fn mcp_rw_lifecycle_newtype_deref_reaches_inner() {
        // The newtype is thin: `Deref` must resolve to the wrapped
        // `McpLifecycle`'s methods transparently.
        let rw = McpRwLifecycle(std::sync::Arc::new(make_lifecycle()));
        assert_eq!(rw.connection_count(), 0, "deref lookup resolves");
        assert!(!rw.is_running(), "deref reaches is_running()");
    }

    // ── L-47: parameterised set_marker_enabled ──────────────────────────

    #[test]
    fn set_marker_enabled_works_for_both_ro_and_rw() {
        // Direct exercise of the shared helper proves the RO/RW
        // wrappers genuinely thin-delegate. Using the same lifecycle
        // for both is intentional — the marker file is the only
        // surface that differs.
        let dir = TempDir::new().unwrap();
        let lc = make_lifecycle();

        // Enable both via the helper directly, verify markers exist
        // under their respective filenames.
        let changed_ro =
            set_marker_enabled(dir.path(), &lc, MCP_RO_ENABLED_MARKER, "RO", true).unwrap();
        let changed_rw =
            set_marker_enabled(dir.path(), &lc, MCP_RW_ENABLED_MARKER, "RW", true).unwrap();
        assert!(changed_ro && changed_rw);
        assert!(dir.path().join(MCP_RO_ENABLED_MARKER).is_file());
        assert!(dir.path().join(MCP_RW_ENABLED_MARKER).is_file());

        // Re-enable is idempotent (returns Ok(false), no marker churn).
        let again = set_marker_enabled(dir.path(), &lc, MCP_RO_ENABLED_MARKER, "RO", true).unwrap();
        assert!(!again, "re-enable must report no change");
    }

    // ── L-46: rapid-toggle gate serialises concurrent callers ───────────

    /// Verify the `tokio::sync::Mutex` inside `McpToggleGate` actually
    /// blocks a second async caller while the first holds the guard.
    /// This pins the wiring (gate + Arc + lock) without exercising the
    /// full Tauri command — the toggle-gate shape itself is the
    /// load-bearing piece for L-46.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn mcp_toggle_gate_serializes_concurrent_callers() {
        use std::sync::atomic::{AtomicU32, Ordering};

        let gate = std::sync::Arc::new(McpToggleGate::new());
        let entered = std::sync::Arc::new(AtomicU32::new(0));
        let max_concurrent = std::sync::Arc::new(AtomicU32::new(0));

        let make_task = || {
            let gate = gate.clone();
            let entered = entered.clone();
            let max_concurrent = max_concurrent.clone();
            async move {
                let _g = gate.0.lock().await;
                let n = entered.fetch_add(1, Ordering::AcqRel) + 1;
                let prev_max = max_concurrent.load(Ordering::Acquire);
                if n > prev_max {
                    max_concurrent.store(n, Ordering::Release);
                }
                // Simulate the real spawn / inner-toggle window the
                // gate is protecting.
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                entered.fetch_sub(1, Ordering::AcqRel);
            }
        };

        let t1 = tokio::spawn(make_task());
        let t2 = tokio::spawn(make_task());
        let t3 = tokio::spawn(make_task());
        t1.await.unwrap();
        t2.await.unwrap();
        t3.await.unwrap();

        assert_eq!(
            max_concurrent.load(Ordering::Acquire),
            1,
            "gate must serialise: at most one task inside the critical \
             section at any time",
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn mcp_rw_toggle_gate_is_independent_of_ro_gate() {
        // RO and RW gates are independent — holding one must NOT block
        // the other (the production wiring uses two separate managed
        // states for exactly this reason).
        let ro_gate = std::sync::Arc::new(McpToggleGate::new());
        let rw_gate = std::sync::Arc::new(McpRwToggleGate::new());

        let ro_lock = ro_gate.0.clone();
        let _ro_guard = ro_lock.lock_owned().await;

        // RW lock must succeed immediately even with RO held.
        let rw_lock = rw_gate.0.clone();
        let try_acquire =
            tokio::time::timeout(std::time::Duration::from_millis(100), rw_lock.lock_owned())
                .await
                .expect("RW lock must not block on RO gate");
        drop(try_acquire);
    }
}
