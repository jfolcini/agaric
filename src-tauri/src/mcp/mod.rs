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
pub mod registry;
pub mod server;

use std::path::{Path, PathBuf};

use crate::error::AppError;

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
    #[cfg(windows)]
    Pipe(tokio::net::windows::named_pipe::NamedPipeServer),
}

impl std::fmt::Debug for SocketKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            #[cfg(unix)]
            SocketKind::Unix(_) => f.write_str("SocketKind::Unix"),
            #[cfg(windows)]
            SocketKind::Pipe(_) => f.write_str("SocketKind::Pipe"),
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
#[cfg(unix)]
pub async fn bind_socket(socket_path: &Path) -> Result<SocketKind, AppError> {
    use std::os::unix::fs::PermissionsExt;
    use tokio::net::{UnixListener, UnixStream};

    // Detect a second live instance by attempting a client connect to the
    // existing path. A successful connect means another process owns the
    // socket; a connection error means the file is stale and safe to unlink.
    if socket_path.exists() {
        match UnixStream::connect(socket_path).await {
            Ok(_) => {
                return Err(AppError::InvalidOperation(format!(
                    "MCP RO socket already bound at {}",
                    socket_path.display()
                )));
            }
            Err(_) => {
                // Stale file from a prior run — remove so `bind()` succeeds.
                if let Err(e) = std::fs::remove_file(socket_path) {
                    tracing::warn!(
                        target: "mcp",
                        path = %socket_path.display(),
                        error = %e,
                        "failed to remove stale MCP RO socket file",
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
        path = %socket_path.display(),
        "MCP RO socket bound",
    );

    Ok(SocketKind::Unix(listener))
}

#[cfg(windows)]
pub async fn bind_socket(pipe_path: &Path) -> Result<SocketKind, AppError> {
    use tokio::net::windows::named_pipe::ServerOptions;

    let pipe_str = pipe_path.to_str().ok_or_else(|| {
        AppError::InvalidOperation(format!(
            "MCP RO pipe path is not valid UTF-8: {}",
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
                    "MCP RO pipe already bound at {}",
                    pipe_path.display()
                ))
            } else {
                AppError::Io(e)
            }
        })?;

    tracing::info!(
        target: "mcp",
        path = %pipe_path.display(),
        "MCP RO named pipe created",
    );

    Ok(SocketKind::Pipe(server))
}

/// Spawn the MCP read-only task onto the current Tokio runtime.
///
/// Checks the `mcp-ro-enabled` marker-file gate and, when enabled, binds the
/// default socket for `app_data_dir` and spawns the serve loop. When
/// disabled, logs at info level and returns. When the socket is already
/// bound by another instance, logs at warn level and returns — the first
/// owner keeps the socket.
///
/// FEAT-4a ships with a placeholder [`server::PlaceholderRegistry`] that
/// exposes zero tools. FEAT-4b / FEAT-4c swap this for the real
/// `ReadOnlyTools` registry via [`spawn_mcp_ro_task_with_registry`].
pub fn spawn_mcp_ro_task(app_data_dir: &Path) {
    if !mcp_ro_enabled(app_data_dir) {
        tracing::info!(
            target: "mcp",
            "MCP RO disabled ({} marker absent)", MCP_RO_ENABLED_MARKER,
        );
        return;
    }

    let socket_path = default_mcp_ro_socket_path(app_data_dir);
    spawn_mcp_ro_task_with_registry(socket_path, server::PlaceholderRegistry);
}

/// Spawn the MCP RO task against a caller-supplied registry and socket path.
///
/// Exposed separately so later sub-items (FEAT-4b/4c) can swap in the real
/// `ReadOnlyTools` registry and integration tests can exercise the bind +
/// accept + dispatch pipeline against a tempdir socket path.
pub fn spawn_mcp_ro_task_with_registry<R>(socket_path: PathBuf, registry: R)
where
    R: server::ToolRegistry + Send + Sync + 'static,
{
    let registry = std::sync::Arc::new(registry);
    tauri::async_runtime::spawn(async move {
        match bind_socket(&socket_path).await {
            Ok(socket) => {
                if let Err(e) = server::serve(socket, registry).await {
                    tracing::error!(
                        target: "mcp",
                        error = %e,
                        "MCP RO serve loop exited with error",
                    );
                }
            }
            Err(AppError::InvalidOperation(msg)) => {
                tracing::warn!(target: "mcp", msg = %msg, "already bound");
            }
            Err(e) => {
                tracing::error!(
                    target: "mcp",
                    error = %e,
                    path = %socket_path.display(),
                    "failed to bind MCP RO socket",
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

    #[cfg(unix)]
    #[tokio::test]
    async fn bind_socket_enforces_mode_0600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("mcp-ro.sock");
        let _socket = bind_socket(&path).await.expect("bind succeeds");
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
        let _socket = bind_socket(&path).await.expect("bind succeeds over stale");
        assert!(path.exists(), "socket file exists after re-bind");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn bind_socket_rejects_second_live_instance() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("mcp-ro.sock");
        let _first = bind_socket(&path).await.expect("first bind succeeds");
        let second = bind_socket(&path).await;
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
            let _ = handle_connection(server_side, &registry).await;
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
