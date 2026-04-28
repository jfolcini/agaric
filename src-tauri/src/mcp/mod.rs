//! MCP (Model Context Protocol) server — read-only access to Agaric's notes
//! for external agents via a local Unix domain socket (Linux/macOS) or
//! Windows named pipe.
//!
//! This module is the entry point for the FEAT-4 umbrella. FEAT-4a (this
//! slice) ships the transport + handshake skeleton; later sub-items fill in
//! the tool registry (FEAT-4b), the read-only tool handlers (FEAT-4c), and
//! the activity ring buffer (FEAT-4d). Sibling modules are pre-declared here
//! so each sub-item can land additively without rewriting `mod.rs`.
//!
//! # Threat model
//!
//! Single-user, local-only. The socket is kernel-enforced to the current
//! user via mode `0600` on unix or the default owner-only DACL on Windows
//! named pipes. There are no bearer tokens, no rate limits, no crypto.
//! See `AGENTS.md` §Threat Model for the rationale.

pub mod activity;
pub mod actor;
pub mod dispatch;
pub mod handler_utils;
pub mod registry;
pub mod server;
pub mod summarise;
pub mod tools_ro;
pub mod tools_rw;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::sync::Notify;

use sqlx::SqlitePool;

use crate::error::AppError;
use crate::materializer::Materializer;

// ---------------------------------------------------------------------------
// Runtime lifecycle (FEAT-4e)
// ---------------------------------------------------------------------------

/// Shared runtime handle surfaced to the FEAT-4e Tauri command layer
/// (`mcp_disconnect_all`, `mcp_set_enabled`, `get_mcp_status`).
///
/// - `disconnect_signal`: notified once per `mcp_disconnect_all` call. The
///   serve loop watches this signal in addition to its `accept()` future,
///   and each spawned per-connection task `select!`s on it, returning
///   early when the signal fires. Subsequent connects succeed — the
///   signal only kicks in-flight connections, not the listener itself.
///   The accept loop also wakes from this signal so [`shutdown`] can
///   pull it out of `accept().await` and have it re-check [`enabled`].
/// - `active_connections`: incremented by each per-connection task on
///   entry and decremented on exit via an RAII guard. `get_mcp_status`
///   reads this for the Settings activity-feed badge.
/// - `task_running`: set `true` while the accept loop owns the socket.
///   `mcp_set_enabled` consults this to decide whether a re-spawn is
///   needed after the marker file is toggled on.
/// - `enabled`: H-2 gate consulted by the accept loop on every iteration
///   *and* immediately after each accepted socket. Set to `false` by
///   [`shutdown`] (called from `mcp_set_enabled(false)`) to make the
///   accept loop drop its listener and return cleanly. Reset to `true`
///   by `spawn_*_task_with_registry` before each re-spawn so a fresh
///   enable gets a fresh gate.
///
/// [`enabled`]: McpLifecycle#structfield.enabled
/// [`shutdown`]: McpLifecycle::shutdown
#[derive(Debug, Clone)]
pub struct McpLifecycle {
    pub disconnect_signal: Arc<Notify>,
    pub active_connections: Arc<AtomicUsize>,
    pub task_running: Arc<std::sync::atomic::AtomicBool>,
    /// H-2 gate consulted by the accept loop. Defaults to `true` so a
    /// freshly-constructed lifecycle is ready to serve. `mcp_set_enabled(false)`
    /// flips this to `false` via [`shutdown`](McpLifecycle::shutdown);
    /// `spawn_*_task_with_registry` restores it to `true` before each
    /// re-spawn so a previous shutdown does not leak across enable/
    /// disable cycles.
    pub enabled: Arc<std::sync::atomic::AtomicBool>,
}

impl McpLifecycle {
    pub fn new() -> Self {
        Self {
            disconnect_signal: Arc::new(Notify::new()),
            active_connections: Arc::new(AtomicUsize::new(0)),
            task_running: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            enabled: Arc::new(std::sync::atomic::AtomicBool::new(true)),
        }
    }

    /// Number of currently-live MCP connections. Reported to the Settings
    /// activity feed via `get_mcp_status`.
    pub fn connection_count(&self) -> usize {
        self.active_connections.load(Ordering::Acquire)
    }

    /// `true` while the accept loop owns the listener.
    pub fn is_running(&self) -> bool {
        self.task_running.load(Ordering::Acquire)
    }

    /// `true` while the accept loop is gated open. Cleared by [`shutdown`]
    /// and reset by `spawn_*_task_with_registry` on re-enable.
    ///
    /// [`shutdown`]: McpLifecycle::shutdown
    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::Acquire)
    }

    /// Wake every in-flight connection task so each observes the signal
    /// via `select!` and drops its stream. Safe to call with no active
    /// connections (no-op).
    ///
    /// **Edge-triggered semantics (L-120).** Internally this calls
    /// [`tokio::sync::Notify::notify_waiters`], which only wakes tasks
    /// already parked inside `Notify::notified().await`. Connections
    /// that arrive *after* this call register a fresh waiter on entry
    /// to `run_connection` and observe no permit — they run to
    /// completion as if `disconnect_all` had never fired. This is the
    /// intended one-shot kill-switch shape ("kick everything currently
    /// in flight") and is distinct from a steady-state listener
    /// shutdown — pair with [`shutdown`](McpLifecycle::shutdown) to
    /// also stop the accept loop, otherwise new connections continue
    /// to be accepted on the existing listener.
    pub fn disconnect_all(&self) {
        self.disconnect_signal.notify_waiters();
    }

    /// H-2: tear the accept loop down cleanly.
    ///
    /// Stores `false` into [`enabled`] so the loop's per-iteration gate
    /// observes the disable, then fires `disconnect_signal.notify_waiters()`
    /// so any task currently parked inside `listener.accept().await`
    /// (or each per-connection handler's `select!`) wakes immediately.
    /// On wake the loop re-checks the gate, drops the listener (the OS
    /// port / socket file is released), and returns. The next
    /// `mcp_set_enabled(true)` call sees `task_running == false` and
    /// re-spawns a fresh task on a freshly-bound listener.
    ///
    /// Distinct from [`disconnect_all`](McpLifecycle::disconnect_all),
    /// which only kicks in-flight connections without affecting the
    /// listener — `mcp_disconnect_all` is a one-shot kill switch, not
    /// a toggle.
    ///
    /// [`enabled`]: McpLifecycle#structfield.enabled
    pub fn shutdown(&self) {
        self.enabled.store(false, Ordering::Release);
        self.disconnect_signal.notify_waiters();
    }
}

impl Default for McpLifecycle {
    fn default() -> Self {
        Self::new()
    }
}

/// Newtype wrapper around an [`Arc<McpLifecycle>`] for the **read-write**
/// MCP server (FEAT-4h slice 2).
///
/// Tauri's managed-state resolver keys on type, so the RO and RW servers
/// cannot share `Arc<McpLifecycle>` as separate managed states — the
/// resolver would collide. The newtype gives them distinct types at the
/// type-system level without duplicating the lifecycle machinery itself.
///
/// Callers read the inner lifecycle transparently via `Deref`:
///
/// ```ignore
/// let rw_lifecycle: McpRwLifecycle = state.inner().clone();
/// let n = rw_lifecycle.connection_count(); // same as (*rw_lifecycle).connection_count()
/// ```
#[derive(Debug, Clone)]
pub struct McpRwLifecycle(pub Arc<McpLifecycle>);

impl std::ops::Deref for McpRwLifecycle {
    type Target = McpLifecycle;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

/// RAII guard used by per-connection tasks to keep
/// [`McpLifecycle::active_connections`] balanced even when the task panics
/// or returns an error mid-way. Dropping the guard decrements the counter.
pub struct ConnectionCounterGuard(Arc<AtomicUsize>);

impl ConnectionCounterGuard {
    pub fn new(counter: Arc<AtomicUsize>) -> Self {
        counter.fetch_add(1, Ordering::AcqRel);
        Self(counter)
    }
}

impl Drop for ConnectionCounterGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

/// Tauri application identifier — must mirror the `identifier` field in
/// `tauri.conf.json`. Surfaced here (rather than as a hidden literal in
/// `bin/agaric-mcp.rs`) so the stub binary and any future MCP-adjacent
/// path-resolver share a single source of truth for the per-platform
/// data-dir layout.
///
/// MAINT-150 (i).
pub const APP_IDENTIFIER: &str = "com.agaric.app";

/// Marker-file name inside the application data directory. When this file
/// exists, the MCP read-only socket is bound at startup; otherwise the task
/// stays dormant. FEAT-4e wires the Settings UI toggle to create / remove
/// this file atomically; FEAT-4a only reads it.
pub const MCP_RO_ENABLED_MARKER: &str = "mcp-ro-enabled";

/// Default socket file-name under the application data directory on unix.
#[cfg(unix)]
pub const MCP_RO_SOCKET_FILENAME: &str = "mcp-ro.sock";

/// Default named-pipe path on Windows. Named pipes live in a global
/// namespace rather than the filesystem, so the app data directory is not
/// involved.
#[cfg(windows)]
pub const MCP_RO_PIPE_PATH: &str = r"\\.\pipe\agaric-mcp-ro";

/// Resolve the default MCP read-only socket path for the given app data
/// directory.
///
/// - Linux / macOS: `<app_data_dir>/mcp-ro.sock`
/// - Windows: the fixed named-pipe path [`MCP_RO_PIPE_PATH`] (the
///   `app_data_dir` argument is unused there).
pub fn default_mcp_ro_socket_path(
    #[cfg_attr(windows, allow(unused_variables))] app_data_dir: &Path,
) -> PathBuf {
    #[cfg(unix)]
    {
        app_data_dir.join(MCP_RO_SOCKET_FILENAME)
    }
    #[cfg(windows)]
    {
        PathBuf::from(MCP_RO_PIPE_PATH)
    }
}

/// Return `true` when the MCP read-only socket is enabled. The gate is a
/// marker file in the application data directory; its presence means "on"
/// and absence means "off". This mirrors the on-disk patterns used for
/// `device-id` and `sync-cert` so no new persistence mechanism is introduced
/// by FEAT-4a.
///
/// Ignored on Windows in the same way as unix (the marker file is created
/// in the same `app_data_dir` on every platform; only the socket transport
/// differs).
pub fn mcp_ro_enabled(app_data_dir: &Path) -> bool {
    app_data_dir.join(MCP_RO_ENABLED_MARKER).is_file()
}

/// Marker-file name for the MCP **read-write** socket (FEAT-4h slice 2).
/// Distinct from [`MCP_RO_ENABLED_MARKER`] so the user can opt into
/// read-only access without also opening the write socket.
pub const MCP_RW_ENABLED_MARKER: &str = "mcp-rw-enabled";

/// Default socket file-name for the MCP RW socket on unix.
#[cfg(unix)]
pub const MCP_RW_SOCKET_FILENAME: &str = "mcp-rw.sock";

/// Default named-pipe path for the MCP RW server on Windows.
#[cfg(windows)]
pub const MCP_RW_PIPE_PATH: &str = r"\\.\pipe\agaric-mcp-rw";

/// Resolve the default MCP read-write socket path for the given app data
/// directory. Mirrors [`default_mcp_ro_socket_path`] for the RW surface:
/// a sibling socket file on unix, a distinct named pipe on Windows.
pub fn default_mcp_rw_socket_path(
    #[cfg_attr(windows, allow(unused_variables))] app_data_dir: &Path,
) -> PathBuf {
    #[cfg(unix)]
    {
        app_data_dir.join(MCP_RW_SOCKET_FILENAME)
    }
    #[cfg(windows)]
    {
        PathBuf::from(MCP_RW_PIPE_PATH)
    }
}

/// Return `true` when the MCP read-write socket is enabled. Parallel to
/// [`mcp_ro_enabled`]; the two gates are independent so the Settings UI
/// can expose RO and RW as separate toggles.
pub fn mcp_rw_enabled(app_data_dir: &Path) -> bool {
    app_data_dir.join(MCP_RW_ENABLED_MARKER).is_file()
}

/// Transport-agnostic listener handle. The rest of the module matches on
/// this enum so the serve loop does not have to care whether the backing
/// transport is a Unix-domain socket or a Windows named pipe.
#[allow(dead_code)] // variants used behind cfg(unix) / cfg(windows)
pub enum SocketKind {
    /// Linux / macOS Unix-domain socket.
    #[cfg(unix)]
    Unix(tokio::net::UnixListener),
    /// Windows named pipe (first server instance). Successive connections
    /// require re-creating a `NamedPipeServer` each time the previous one
    /// is handed off to a connection handler; `serve_pipe` takes care of
    /// that in FEAT-4a's accept loop.
    ///
    /// The bound `path` is captured on the variant (M-83 fix) so the
    /// accept loop creates each successor instance on the same pipe
    /// namespace it bound on. Recovering the path from a constant
    /// (the pre-M-83 implementation) silently routed RW callers onto
    /// the RO pipe namespace once the first RW client connected and
    /// the loop tried to spin up the second server instance.
    #[cfg(windows)]
    Pipe {
        server: tokio::net::windows::named_pipe::NamedPipeServer,
        path: String,
    },
}

impl std::fmt::Debug for SocketKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            #[cfg(unix)]
            SocketKind::Unix(_) => f.write_str("SocketKind::Unix"),
            #[cfg(windows)]
            SocketKind::Pipe { path, .. } => write!(f, "SocketKind::Pipe({path})"),
        }
    }
}

/// Bind the MCP read-only socket at `socket_path`.
///
/// On unix this creates the parent directory if missing, binds a
/// `UnixListener`, and enforces mode `0600` on the resulting socket file.
/// On Windows this creates the first named-pipe instance; the DACL is the
/// default owner-only descriptor supplied by `CreateNamedPipeW`.
///
/// If a previous process left a stale socket file behind on unix, it is
/// removed and re-bound. If another live process already owns the socket
/// (a second Agaric instance racing on the same app data directory), the
/// function returns [`AppError::InvalidOperation`] so the caller can log
/// a structured warning instead of panicking.
///
/// `socket_kind` is a short identifier (`"RO"` / `"RW"`) baked into the
/// log + error-message strings so operators can tell which server failed
/// when the marker-file gate is flipped on both paths simultaneously. The
/// function itself is transport-agnostic — the label is purely for
/// diagnostics.
#[cfg(unix)]
pub async fn bind_socket(socket_path: &Path, socket_kind: &str) -> Result<SocketKind, AppError> {
    use std::os::unix::fs::PermissionsExt;
    use tokio::net::{UnixListener, UnixStream};

    // Detect a second live instance by attempting a client connect to the
    // existing path. A successful connect means another process owns the
    // socket; a connection error means the file is stale and safe to unlink.
    if socket_path.exists() {
        match UnixStream::connect(socket_path).await {
            Ok(_) => {
                return Err(AppError::InvalidOperation(format!(
                    "MCP {socket_kind} socket already bound at {}",
                    socket_path.display()
                )));
            }
            Err(_) => {
                // Stale file from a prior run — remove so `bind()` succeeds.
                if let Err(e) = std::fs::remove_file(socket_path) {
                    tracing::warn!(
                        target: "mcp",
                        kind = socket_kind,
                        path = %socket_path.display(),
                        error = %e,
                        "failed to remove stale MCP socket file",
                    );
                }
            }
        }
    }

    if let Some(parent) = socket_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let listener = UnixListener::bind(socket_path)?;

    // Enforce 0600 on the socket file. The kernel already restricts connect
    // access to the owning user, but a tight mode is the single line of
    // defence called out in AGENTS.md §Threat Model.
    let meta = std::fs::metadata(socket_path)?;
    let mut perms = meta.permissions();
    perms.set_mode(0o600);
    std::fs::set_permissions(socket_path, perms)?;

    tracing::info!(
        target: "mcp",
        kind = socket_kind,
        path = %socket_path.display(),
        "MCP socket bound",
    );

    Ok(SocketKind::Unix(listener))
}

#[cfg(windows)]
pub async fn bind_socket(pipe_path: &Path, socket_kind: &str) -> Result<SocketKind, AppError> {
    use tokio::net::windows::named_pipe::ServerOptions;

    let pipe_str = pipe_path.to_str().ok_or_else(|| {
        AppError::InvalidOperation(format!(
            "MCP {socket_kind} pipe path is not valid UTF-8: {}",
            pipe_path.display()
        ))
    })?;

    let server = ServerOptions::new()
        .first_pipe_instance(true)
        .create(pipe_str)
        .map_err(|e| {
            // ERROR_ACCESS_DENIED (5) / ERROR_PIPE_BUSY (231) / ERROR_ALREADY_EXISTS (183)
            // all indicate "another instance owns the pipe". Map them to an
            // explicit InvalidOperation so the caller can log the double-launch
            // case without crashing.
            if matches!(e.raw_os_error(), Some(5) | Some(183) | Some(231)) {
                AppError::InvalidOperation(format!(
                    "MCP {socket_kind} pipe already bound at {}",
                    pipe_path.display()
                ))
            } else {
                AppError::Io(e)
            }
        })?;

    tracing::info!(
        target: "mcp",
        kind = socket_kind,
        path = %pipe_path.display(),
        "MCP named pipe created",
    );

    Ok(SocketKind::Pipe {
        server,
        path: pipe_str.to_string(),
    })
}

/// Spawn the MCP read-only task onto the current Tokio runtime.
///
/// Checks the `mcp-ro-enabled` marker-file gate and, when enabled, binds the
/// default socket for `app_data_dir` and spawns the serve loop. When
/// disabled, logs at info level and returns. When the socket is already
/// bound by another instance, logs at warn level and returns — the first
/// owner keeps the socket.
///
/// FEAT-4c wires the real [`tools_ro::ReadOnlyTools`] registry, replacing
/// FEAT-4a's [`server::PlaceholderRegistry`]. The registry owns the
/// read-pool [`SqlitePool`], the [`Materializer`] (used only by the
/// `journal_for_date` tool for idempotent page creation), and this
/// device's `device_id` so any op-log entries the tool creates are
/// attributed correctly.
///
/// M-82: `journal_for_date` is the only RO tool with a write side-effect
/// (it inserts a fresh `page` block whenever the requested date has no
/// existing journal page). The registry therefore takes **both** pools:
/// `read_pool` backs the eight pure-read tools and the lookup branch of
/// `journal_for_date`, while `write_pool` backs the create branch —
/// `BEGIN IMMEDIATE` on the read pool fails with `SQLITE_READONLY`
/// because that pool sets `PRAGMA query_only = ON`.
///
/// `app_handle` is used to build the FEAT-4d activity emitter — every
/// completed tool call pushes an [`activity::ActivityEntry`] into the ring
/// and emits an `mcp:activity` event on this handle's bus.
///
/// `lifecycle` is the FEAT-4e managed state that surfaces connection
/// counts and disconnect-signal plumbing to the Settings UI. Passed as
/// `Option` so headless / test callers can elide it.
pub fn spawn_mcp_ro_task<R: tauri::Runtime>(
    app_data_dir: &Path,
    app_handle: tauri::AppHandle<R>,
    read_pool: SqlitePool,
    write_pool: SqlitePool,
    materializer: Materializer,
    device_id: String,
    lifecycle: Option<McpLifecycle>,
) {
    if !mcp_ro_enabled(app_data_dir) {
        tracing::info!(
            target: "mcp",
            "MCP RO disabled ({} marker absent)", MCP_RO_ENABLED_MARKER,
        );
        return;
    }

    let socket_path = default_mcp_ro_socket_path(app_data_dir);
    let activity_ctx = activity::ActivityContext::from_app_handle(app_handle);
    let registry = tools_ro::ReadOnlyTools::new(read_pool, write_pool, materializer, device_id);
    spawn_mcp_ro_task_with_registry(socket_path, registry, Some(activity_ctx), lifecycle);
}

/// Spawn the MCP RO task against a caller-supplied registry and socket path.
///
/// Exposed separately so later sub-items (FEAT-4b/4c) can swap in the real
/// `ReadOnlyTools` registry and integration tests can exercise the bind +
/// accept + dispatch pipeline against a tempdir socket path.
///
/// `activity_ctx` is optional: production passes
/// `Some(ActivityContext::from_app_handle(...))`; tests and headless
/// scenarios pass `None` (and any tool dispatches fall through without
/// emitting events).
///
/// `lifecycle` is the FEAT-4e shared state that exposes the
/// disconnect-signal and per-connection counter to the Settings UI. When
/// `Some`, the serve loop sets `task_running = true` on entry and back to
/// `false` on exit so `get_mcp_status` reflects the accept loop's state;
/// each spawned per-connection task increments / decrements
/// `active_connections` and `select!`s on the disconnect signal.
pub fn spawn_mcp_ro_task_with_registry<R>(
    socket_path: PathBuf,
    registry: R,
    activity_ctx: Option<activity::ActivityContext>,
    lifecycle: Option<McpLifecycle>,
) where
    R: server::ToolRegistry + Send + Sync + 'static,
{
    let registry = std::sync::Arc::new(registry);
    tauri::async_runtime::spawn(async move {
        // H-2: a previous disable cleared `enabled` to `false` and left
        // it that way (so the prior accept loop observed the gate and
        // exited). Reset before binding so the fresh accept loop is
        // not torn down on its first iteration. Done before bind so a
        // bind failure does not leave the gate stuck at `false`.
        if let Some(ref lc) = lifecycle {
            lc.enabled.store(true, std::sync::atomic::Ordering::Release);
        }
        match bind_socket(&socket_path, "RO").await {
            Ok(socket) => {
                if let Some(ref lc) = lifecycle {
                    lc.task_running
                        .store(true, std::sync::atomic::Ordering::Release);
                }
                if let Err(e) =
                    server::serve(socket, registry, activity_ctx, lifecycle.clone()).await
                {
                    tracing::error!(
                        target: "mcp",
                        error = %e,
                        "MCP RO serve loop exited with error",
                    );
                }
                if let Some(ref lc) = lifecycle {
                    lc.task_running
                        .store(false, std::sync::atomic::Ordering::Release);
                }
            }
            Err(AppError::InvalidOperation(msg)) => {
                tracing::warn!(target: "mcp", kind = "RO", msg = %msg, "already bound");
            }
            Err(e) => {
                tracing::error!(
                    target: "mcp",
                    kind = "RO",
                    error = %e,
                    path = %socket_path.display(),
                    "failed to bind MCP socket",
                );
            }
        }
    });
}

/// Spawn the MCP **read-write** task onto the current Tokio runtime
/// (FEAT-4h slice 2).
///
/// Mirrors [`spawn_mcp_ro_task`] but reads the RW marker
/// ([`MCP_RW_ENABLED_MARKER`]) and builds a [`tools_rw::ReadWriteTools`]
/// registry bound to the **writer** pool — the six RW tools all mutate.
///
/// When the marker is absent, logs at info level and returns. When the
/// socket is already bound by another instance, logs at warn level and
/// returns — the first owner keeps the socket.
///
/// `lifecycle` is the FEAT-4e / FEAT-4h managed state that surfaces
/// connection counts and disconnect-signal plumbing to the Settings UI.
/// Passed as `Option` so headless / test callers can elide it. Call sites
/// normally wrap the lifecycle in an [`McpRwLifecycle`] newtype before
/// handing it to Tauri's managed-state resolver.
pub fn spawn_mcp_rw_task<R: tauri::Runtime>(
    app_data_dir: &Path,
    app_handle: tauri::AppHandle<R>,
    write_pool: SqlitePool,
    materializer: Materializer,
    device_id: String,
    lifecycle: Option<McpLifecycle>,
) {
    if !mcp_rw_enabled(app_data_dir) {
        tracing::info!(
            target: "mcp",
            "MCP RW disabled ({} marker absent)", MCP_RW_ENABLED_MARKER,
        );
        return;
    }

    let socket_path = default_mcp_rw_socket_path(app_data_dir);
    let activity_ctx = activity::ActivityContext::from_app_handle(app_handle);
    let registry = tools_rw::ReadWriteTools::new(write_pool, materializer, device_id);
    spawn_mcp_rw_task_with_registry(socket_path, registry, Some(activity_ctx), lifecycle);
}

/// Spawn the MCP RW task against a caller-supplied registry and socket
/// path. Mirrors [`spawn_mcp_ro_task_with_registry`] — see its docs for
/// the `activity_ctx` / `lifecycle` semantics.
pub fn spawn_mcp_rw_task_with_registry<R>(
    socket_path: PathBuf,
    registry: R,
    activity_ctx: Option<activity::ActivityContext>,
    lifecycle: Option<McpLifecycle>,
) where
    R: server::ToolRegistry + Send + Sync + 'static,
{
    let registry = std::sync::Arc::new(registry);
    tauri::async_runtime::spawn(async move {
        // H-2: see RO spawn helper for the rationale — clear any stale
        // `enabled = false` left over by a previous shutdown before
        // binding the new listener.
        if let Some(ref lc) = lifecycle {
            lc.enabled.store(true, std::sync::atomic::Ordering::Release);
        }
        match bind_socket(&socket_path, "RW").await {
            Ok(socket) => {
                if let Some(ref lc) = lifecycle {
                    lc.task_running
                        .store(true, std::sync::atomic::Ordering::Release);
                }
                if let Err(e) =
                    server::serve(socket, registry, activity_ctx, lifecycle.clone()).await
                {
                    tracing::error!(
                        target: "mcp",
                        error = %e,
                        "MCP RW serve loop exited with error",
                    );
                }
                if let Some(ref lc) = lifecycle {
                    lc.task_running
                        .store(false, std::sync::atomic::Ordering::Release);
                }
            }
            Err(AppError::InvalidOperation(msg)) => {
                tracing::warn!(target: "mcp", kind = "RW", msg = %msg, "already bound");
            }
            Err(e) => {
                tracing::error!(
                    target: "mcp",
                    kind = "RW",
                    error = %e,
                    path = %socket_path.display(),
                    "failed to bind MCP socket",
                );
            }
        }
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn mcp_ro_enabled_returns_false_when_marker_absent() {
        let dir = TempDir::new().unwrap();
        assert!(
            !mcp_ro_enabled(dir.path()),
            "expected gate off when marker absent",
        );
    }

    #[test]
    fn mcp_ro_enabled_returns_true_when_marker_present() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join(MCP_RO_ENABLED_MARKER), b"").unwrap();
        assert!(
            mcp_ro_enabled(dir.path()),
            "expected gate on when marker present",
        );
    }

    #[test]
    fn mcp_ro_enabled_ignores_directory_with_marker_name() {
        // A directory at the marker path must not be mistaken for the gate.
        let dir = TempDir::new().unwrap();
        std::fs::create_dir(dir.path().join(MCP_RO_ENABLED_MARKER)).unwrap();
        assert!(
            !mcp_ro_enabled(dir.path()),
            "directory at marker path must not flip the gate",
        );
    }

    #[cfg(unix)]
    #[test]
    fn default_mcp_ro_socket_path_under_app_data_dir_on_unix() {
        let dir = TempDir::new().unwrap();
        let path = default_mcp_ro_socket_path(dir.path());
        assert_eq!(path, dir.path().join(MCP_RO_SOCKET_FILENAME));
    }

    #[cfg(windows)]
    #[test]
    fn default_mcp_ro_socket_path_is_named_pipe_on_windows() {
        let dir = TempDir::new().unwrap();
        let path = default_mcp_ro_socket_path(dir.path());
        assert_eq!(path, std::path::PathBuf::from(MCP_RO_PIPE_PATH));
    }

    // -----------------------------------------------------------------
    // RW parity tests (FEAT-4h slice 2)
    // -----------------------------------------------------------------

    #[test]
    fn mcp_rw_enabled_returns_false_when_marker_absent() {
        let dir = TempDir::new().unwrap();
        assert!(
            !mcp_rw_enabled(dir.path()),
            "expected RW gate off when marker absent",
        );
    }

    #[test]
    fn mcp_rw_enabled_returns_true_when_marker_present() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join(MCP_RW_ENABLED_MARKER), b"").unwrap();
        assert!(
            mcp_rw_enabled(dir.path()),
            "expected RW gate on when marker present",
        );
    }

    #[test]
    fn mcp_rw_enabled_ignores_directory_with_marker_name() {
        // Mirror of the RO guard: a directory at the marker path must
        // not be mistaken for the gate.
        let dir = TempDir::new().unwrap();
        std::fs::create_dir(dir.path().join(MCP_RW_ENABLED_MARKER)).unwrap();
        assert!(
            !mcp_rw_enabled(dir.path()),
            "directory at RW marker path must not flip the gate",
        );
    }

    #[cfg(unix)]
    #[test]
    fn default_mcp_rw_socket_path_under_app_data_dir_on_unix() {
        let dir = TempDir::new().unwrap();
        let path = default_mcp_rw_socket_path(dir.path());
        assert_eq!(path, dir.path().join(MCP_RW_SOCKET_FILENAME));
    }

    #[cfg(windows)]
    #[test]
    fn default_mcp_rw_socket_path_is_named_pipe_on_windows() {
        let dir = TempDir::new().unwrap();
        let path = default_mcp_rw_socket_path(dir.path());
        assert_eq!(path, std::path::PathBuf::from(MCP_RW_PIPE_PATH));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn bind_socket_ro_and_rw_can_coexist_in_same_dir() {
        // Pins the invariant that the RO and RW sockets do not clash
        // on the filesystem — they live side-by-side under the same
        // app data directory.
        let dir = TempDir::new().unwrap();
        let ro_path = dir.path().join(MCP_RO_SOCKET_FILENAME);
        let rw_path = dir.path().join(MCP_RW_SOCKET_FILENAME);
        let _ro = bind_socket(&ro_path, "RO").await.expect("RO bind");
        let _rw = bind_socket(&rw_path, "RW").await.expect("RW bind");
        assert!(ro_path.exists(), "RO socket file exists");
        assert!(rw_path.exists(), "RW socket file exists");
        assert_ne!(ro_path, rw_path, "RO and RW must not share a path");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn bind_socket_enforces_mode_0600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("mcp-ro.sock");
        let _socket = bind_socket(&path, "RO").await.expect("bind succeeds");
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(
            mode & 0o777,
            0o600,
            "MCP RO socket must be user-only (0600), got {:o}",
            mode & 0o777,
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn bind_socket_removes_stale_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("mcp-ro.sock");
        // Prior-run stale file — not a live listener.
        std::fs::write(&path, b"stale").unwrap();
        let _socket = bind_socket(&path, "RO")
            .await
            .expect("bind succeeds over stale");
        assert!(path.exists(), "socket file exists after re-bind");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn bind_socket_rejects_second_live_instance() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("mcp-ro.sock");
        let _first = bind_socket(&path, "RO").await.expect("first bind succeeds");
        let second = bind_socket(&path, "RO").await;
        assert!(
            matches!(second, Err(AppError::InvalidOperation(_))),
            "second bind must return InvalidOperation, got {second:?}",
        );
    }

    // End-to-end smoke test of the `agaric-mcp` stub binary against a
    // locally-bound UDS. Ignored by default because it requires the bin to
    // have been built (`cargo build --bin agaric-mcp`) before running.
    // Run with:  cargo nextest run stub_binary --run-ignored=all
    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "spawns the agaric-mcp binary; run after `cargo build --bin agaric-mcp`"]
    async fn stub_binary_roundtrips_initialize_over_uds() {
        use std::io::BufRead;
        use std::io::Write as _;
        use std::process::{Command, Stdio};

        use crate::mcp::server::{handle_connection, PlaceholderRegistry};
        use tokio::net::UnixListener;

        let dir = TempDir::new().unwrap();
        let socket_path = dir.path().join("bin-test.sock");
        let listener = UnixListener::bind(&socket_path).unwrap();

        // Spawn the in-process server against this socket.
        tokio::spawn(async move {
            let (server_side, _) = listener.accept().await.unwrap();
            let registry = PlaceholderRegistry;
            let _ = handle_connection(server_side, &registry, None).await;
        });

        // Locate the built binary relative to CARGO_MANIFEST_DIR.
        let manifest_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let bin_path = ["debug", "release"]
            .iter()
            .map(|p| manifest_dir.join("target").join(p).join("agaric-mcp"))
            .find(|p| p.exists())
            .expect(
                "run `cargo build --bin agaric-mcp` before running this ignored integration test",
            );

        let mut child = Command::new(&bin_path)
            .arg("--socket")
            .arg(&socket_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn agaric-mcp");

        let mut stdin = child.stdin.take().expect("stdin");
        let stdout = child.stdout.take().expect("stdout");

        stdin
            .write_all(
                b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\
                  \"params\":{\"protocolVersion\":\"2024-11-05\",\
                  \"clientInfo\":{\"name\":\"integration\",\"version\":\"0\"}}}\n",
            )
            .unwrap();
        stdin.flush().unwrap();
        drop(stdin);

        let mut reader = std::io::BufReader::new(stdout);
        let mut line = String::new();
        reader.read_line(&mut line).expect("read response");
        let response: serde_json::Value = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(response["id"], 1);
        assert_eq!(response["result"]["serverInfo"]["name"], "agaric");

        let _ = child.kill();
        let _ = child.wait();
    }
}
