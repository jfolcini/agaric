//! MCP (Model Context Protocol) server — agent access to Agaric's notes
//! over a local Unix domain socket (Linux/macOS) or Windows named pipe.
//!
//! # Threat model
//!
//! Single-user, local-only. On unix the socket is restricted to the
//! current user via mode `0600`. On Windows the *default* named-pipe DACL
//! is **not** owner-only — it grants read access to `Everyone` and
//! `Anonymous` (#2720) — so relying on it would leave the fixed-name MCP
//! pipe open to any local process. Each pipe instance is therefore
//! created with an *explicit* security descriptor whose DACL grants
//! access only to the current process user's SID (plus SYSTEM and the
//! local Administrators group); see
//! `win_security::current_user_security_attributes`. A connection presents
//! an agent's token (#5667), which keeps an agent to its mode and spaces;
//! it guards against an agent's mistakes, not an attacker. No rate limits,
//! no crypto. See `AGENTS.md` §Threat Model for the rationale.

pub mod activity;
pub mod agents;
pub mod dispatch;
pub mod handler_utils;
pub mod registry;
pub mod server;
pub mod summarise;
pub mod tools_ro;
pub mod tools_rw;
pub mod view_notify;

// The rmcp adapter is the production dispatcher.
// Hand-rolled framing in `mcp/server.rs` is retained for the helper
// types `ConnectionState`, `serve_unix`, `serve_pipe`, and the
// lifecycle/grace-period plumbing — those wrap (rather than replace)
// the rmcp `serve` loop.
pub mod rmcp_adapter;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::sync::Notify;

use sqlx::SqlitePool;

use crate::materializer::Materializer;
use agaric_core::error::AppError;

// ---------------------------------------------------------------------------
// Server surface (#693)
// ---------------------------------------------------------------------------

/// The id and content-token rules both modes' instructions share.
macro_rules! ids_and_tokens_primer {
    () => {
        "Ids are 26-character ULIDs in uppercase Crockford base32 \
         (e.g. 01HZY3V9Q8K2M4N6P7R8S9T0VW). Take them from tool results; never \
         invent one.\n\
         Block content refers to things by id:\n\
         - `[[ULID]]` links a page\n\
         - `#[ULID]` applies a tag\n\
         - `((ULID))` references a block\n"
    };
}

/// The read tools' rules, which both modes serve (#5379).
macro_rules! read_tools_primer {
    () => {
        "Where ids come from:\n\
         - spaces: `list_spaces`, the spaces you may use. Call it first.\n\
         - pages and blocks: `list_pages`, `search`, `get_page`, `get_journal`, \
         `list_journal`, `list_trash`.\n\
         - tags: `list_tags`, one space at a time.\n\
         Spaces: every tool but `list_spaces` and `list_property_defs` requires \
         `space_id`; nothing defaults it. A call naming a space you may not use, or \
         on a block or page in another space, is refused.\n\
         Dates are YYYY-MM-DD; `get_journal` also takes `today` or `yesterday`, on \
         this device's clock.\n\
         History: `page_history` and `block_history` show who changed what, and \
         when.\n\
         Long reads: `get_page`, `list_backlinks` and `get_page_markdown` stop at a \
         size budget with `truncated: true`; pass `next_cursor` back as `cursor` to \
         read on.\n\
         Names: in a tool that takes `space_id`, a page or tag argument that is not \
         a ULID is a page's title or alias, or a tag's name, in that space; \
         `resolve` looks many up at once.\n\
         Query: `query` filters one space's blocks with a `where` tree (its ids are \
         ULIDs, not names), then sorts, groups (`group_by`) or counts (`aggregate`); \
         its description has the grammar. E.g. LastEdited {spec: Range {start, end}}, \
         DueDate {predicate: Between {from, to}}, HasProperty {key, predicate: Gt \
         {value: {type: Num, value: 3}}}, State {values: [TODO]} with group_by \
         {type: Page}. Tag matches attached tags, TagOrRef also inline #refs; neither \
         matches inherited ones.\n"
    };
}

/// The first line `agaric-mcp` writes, before any MCP byte:
/// `AGARIC-TOKEN <token>`. MCP lines are JSON objects, so a line that starts
/// with this is never MCP traffic.
pub const TOKEN_PREAMBLE: &str = "AGARIC-TOKEN";

impl agents::McpAgentMode {
    /// MCP `initialize` instructions advertised by
    /// [`RmcpAdapter`](rmcp_adapter::RmcpAdapter)'s `ServerHandler::get_info`:
    /// a short primer so an agent knows the id, token, space and name rules
    /// before its first call. Agents weight it heavily, so a read-write agent
    /// is never told it is read-only (#693).
    pub fn instructions(self) -> &'static str {
        match self {
            Self::ReadOnly => concat!(
                "Agaric MCP read-only server: reads a local, block-based notes vault. \
                 Use tools/list for the tools.\n",
                ids_and_tokens_primer!(),
                read_tools_primer!(),
            ),
            Self::ReadWrite => concat!(
                "Agaric MCP read-write server: reads and writes a local, block-based notes \
                 vault. Use tools/list for the tools. Every mutation is recorded in the \
                 user-visible activity feed and is reversible from the app.\n",
                ids_and_tokens_primer!(),
                read_tools_primer!(),
                "Writes: a write that creates blocks returns them with their ids. `capture` \
                 also takes `today` or `yesterday` as its date.\n\
                 Undo: a write that changed something returns `op_refs`; pass them to \
                 `undo` to revert it. `delete_block` is a soft delete that `restore_block` \
                 reverses.\n\
                 Names in written content: `[[Name]]` and `#name` link the page or tag of \
                 that name, creating it when none matches.\n",
            ),
        }
    }
}

// ---------------------------------------------------------------------------
// Runtime lifecycle
// ---------------------------------------------------------------------------

/// Shared runtime handle surfaced to the Tauri command layer
/// (`mcp_disconnect_all`, `mcp_set_enabled`, `get_mcp_status`).
///
/// - `disconnect_signal`: notified once per `mcp_disconnect_all` call.
///   Each spawned per-connection task `select!`s on it, returning early
///   when the signal fires. Subsequent connects succeed — the signal only
///   kicks in-flight connections, not the listener itself. Edge-triggered
///   (`notify_waiters`), which is correct here: the per-connection kick
///   always has a live parked waiter by construction.
/// - `shutdown_signal`: #2824 level-triggered `watch` channel the accept
///   loop races against its `accept()` / `connect()` / back-off `sleep`,
///   so [`shutdown`] can pull it out of the FFI call and have it re-check
///   [`enabled`] — and, being level-triggered, without any risk of a
///   missed wake if `shutdown` fires while the loop is mid-FFI. See the
///   field doc for the full rationale.
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
///   by `spawn_mcp_task_with_server` before each re-spawn so a fresh
///   enable gets a fresh gate.
///
/// [`enabled`]: McpLifecycle#structfield.enabled
/// [`shutdown`]: McpLifecycle::shutdown
#[derive(Debug, Clone)]
pub struct McpLifecycle {
    pub disconnect_signal: Arc<Notify>,
    /// #2824 — **level-triggered** shutdown wake for the accept loop(s).
    ///
    /// The accept loops (`serve_unix` / `serve_pipe`) race their blocking
    /// `accept()` / `connect()` / back-off `sleep` against this channel so
    /// a [`shutdown`](McpLifecycle::shutdown) pulls them out of the FFI
    /// call immediately. It is a `watch` channel (not the edge-triggered
    /// `disconnect_signal` `Notify`) precisely so the wake **cannot be
    /// missed**: `watch` stores the level, so a `shutdown` that fires
    /// while a loop is mid-FFI (not currently parked in the select arm)
    /// is still observed on the loop's next poll. The previous
    /// `notify_waiters()` approach stored no permit and dropped such a
    /// wake, leaving the loop blocked until an incoming connection or the
    /// (≤30s) back-off elapsed — the disable latency this field closes.
    ///
    /// `true` == shutdown requested. `shutdown` sets it; the
    /// `spawn_mcp_task_with_server` helper resets it to `false` alongside
    /// `enabled` before each re-spawn so a prior shutdown does not leak
    /// across enable/disable cycles (the lifecycle — and thus this
    /// channel — is reused, not recreated). Wrapped in `Arc` because
    /// `watch::Sender` is not `Clone` and `McpLifecycle` is.
    pub shutdown_signal: Arc<tokio::sync::watch::Sender<bool>>,
    pub active_connections: Arc<AtomicUsize>,
    pub task_running: Arc<std::sync::atomic::AtomicBool>,
    /// H-2 gate consulted by the accept loop. Defaults to `true` so a
    /// freshly-constructed lifecycle is ready to serve. `mcp_set_enabled(false)`
    /// flips this to `false` via [`shutdown`](McpLifecycle::shutdown);
    /// `spawn_mcp_task_with_server` restores it to `true` before each
    /// re-spawn so a previous shutdown does not leak across enable/
    /// disable cycles.
    pub enabled: Arc<std::sync::atomic::AtomicBool>,
}

impl McpLifecycle {
    pub fn new() -> Self {
        Self {
            disconnect_signal: Arc::new(Notify::new()),
            // #2824 — starts `false` (no shutdown pending).
            shutdown_signal: Arc::new(tokio::sync::watch::channel(false).0),
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
    /// and reset by `spawn_mcp_task_with_server` on re-enable.
    ///
    /// [`shutdown`]: McpLifecycle::shutdown
    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::Acquire)
    }

    /// Wake every in-flight connection task so each observes the signal
    /// via `select!` and drops its stream. Safe to call with no active
    /// connections (no-op).
    ///
    /// **Edge-triggered semantics.** Internally this calls
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
    /// observes the disable, then wakes the accept loop **two ways**:
    ///
    /// 1. [`shutdown_signal`] is flipped to `true` (a `watch` send). This
    ///    is the **level-triggered** wake for the accept loop
    ///    (`serve_unix` / `serve_pipe`): it stores the level, so even if
    ///    the loop is mid-FFI (not parked in its `select!` shutdown arm)
    ///    when this fires, the loop still observes the flip on its next
    ///    poll and cannot miss it (#2824). On wake the loop re-checks the
    ///    gate, drops the listener (the OS port / socket file is
    ///    released), and returns. The next `mcp_set_enabled(true)` call
    ///    sees `task_running == false` and re-spawns a fresh task on a
    ///    freshly-bound listener.
    /// 2. `disconnect_signal.notify_waiters()` (edge-triggered) kicks any
    ///    per-connection handler currently parked in its grace-period
    ///    `select!`, so in-flight clients are torn down too. This
    ///    preserves the pre-#2824 behavior; only the *accept-loop* wake
    ///    moved to the level-triggered channel (the per-connection kick
    ///    has a live waiter by construction, so edge-triggered is fine).
    ///
    /// Distinct from [`disconnect_all`](McpLifecycle::disconnect_all),
    /// which only kicks in-flight connections without affecting the
    /// listener — `mcp_disconnect_all` is a one-shot kill switch, not
    /// a toggle.
    ///
    /// [`enabled`]: McpLifecycle#structfield.enabled
    /// [`shutdown_signal`]: McpLifecycle#structfield.shutdown_signal
    pub fn shutdown(&self) {
        self.enabled.store(false, Ordering::Release);
        // #2824 — level-triggered wake for the accept loop (cannot be
        // missed even if the loop is not currently parked in its select).
        self.shutdown_signal.send_replace(true);
        // Edge-triggered kick for in-flight per-connection handlers.
        self.disconnect_signal.notify_waiters();
    }
}

impl Default for McpLifecycle {
    fn default() -> Self {
        Self::new()
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
/// (i).
pub const APP_IDENTIFIER: &str = "com.agaric.app";

/// Marker-file name inside the application data directory. When this file
/// exists, the MCP socket is bound at startup; otherwise the task stays
/// dormant. Settings' switch (`mcp_set_enabled`) creates and removes it.
pub const MCP_ENABLED_MARKER: &str = "mcp-enabled";

/// The markers of the read-only and read-write sockets before #5667.
const LEGACY_ENABLED_MARKERS: [&str; 2] = ["mcp-ro-enabled", "mcp-rw-enabled"];

/// Default socket file-name under the application data directory on unix.
#[cfg(unix)]
pub const MCP_SOCKET_FILENAME: &str = "mcp.sock";

/// Default named-pipe path on Windows. Named pipes live in a global
/// namespace rather than the filesystem, so the app data directory is not
/// involved.
#[cfg(windows)]
pub const MCP_PIPE_PATH: &str = r"\\.\pipe\agaric-mcp";

/// Resolve the default MCP socket path for the given app data directory.
///
/// - Linux / macOS: `<app_data_dir>/mcp.sock`
/// - Windows: the fixed named-pipe path `MCP_PIPE_PATH` (`#[cfg(windows)]`,
///   so it is absent from a non-Windows doc build; the
///   `app_data_dir` argument is unused there).
pub fn default_mcp_socket_path(
    #[cfg_attr(windows, allow(unused_variables))] app_data_dir: &Path,
) -> PathBuf {
    #[cfg(unix)]
    {
        app_data_dir.join(MCP_SOCKET_FILENAME)
    }
    #[cfg(windows)]
    {
        PathBuf::from(MCP_PIPE_PATH)
    }
}

/// Return `true` when the MCP socket is enabled: the marker file exists in
/// the application data directory. This mirrors the on-disk patterns used
/// for `device-id` and `sync-cert`, so no new persistence mechanism is
/// introduced. The marker lives in `app_data_dir` on every platform; only
/// the socket transport differs.
pub fn mcp_enabled(app_data_dir: &Path) -> bool {
    app_data_dir.join(MCP_ENABLED_MARKER).is_file()
}

/// Agent access that was on under either of the two pre-#5667 sockets stays
/// on: either legacy marker becomes [`MCP_ENABLED_MARKER`], and both go.
pub fn adopt_legacy_markers(app_data_dir: &Path) -> std::io::Result<()> {
    let legacy: Vec<PathBuf> = LEGACY_ENABLED_MARKERS
        .iter()
        .map(|marker| app_data_dir.join(marker))
        .filter(|path| path.is_file())
        .collect();
    if legacy.is_empty() {
        return Ok(());
    }
    std::fs::write(app_data_dir.join(MCP_ENABLED_MARKER), b"")?;
    for path in legacy {
        std::fs::remove_file(path)?;
    }
    Ok(())
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
    /// That in accept loop.
    ///
    /// The bound `path` is captured on the variant so the accept loop
    /// creates each successor instance on the same pipe namespace it
    /// bound on (M-83), including a test's own pipe.
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

/// Bind the MCP socket at `socket_path`.
///
/// On unix this creates the parent directory if missing, binds a
/// `UnixListener`, and enforces mode `0600` on the resulting socket file.
/// On Windows this creates the first named-pipe instance with an
/// **explicit** security descriptor: the default named-pipe DACL is *not*
/// owner-only (it grants read to `Everyone` + `Anonymous`, #2720), so the
/// pipe is created via `win_security::create_secured_pipe_instance`,
/// whose DACL grants access only to the current user's SID (plus SYSTEM /
/// Administrators).
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
                    "MCP socket already bound at {}",
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
        path = %socket_path.display(),
        "MCP socket bound",
    );

    Ok(SocketKind::Unix(listener))
}

/// Windows named-pipe security helpers (#2720).
///
/// The default DACL on a Windows named pipe is **not** owner-only — it
/// grants read access to `Everyone` and `Anonymous`. Left unaddressed, any
/// local process could open the fixed-name MCP pipe
/// (`\\.\pipe\agaric-mcp`). These helpers build an explicit
/// security descriptor whose DACL grants access only to the current
/// process user's SID (plus SYSTEM and the local Administrators group) and
/// hand it to tokio's `create_with_security_attributes_raw`, so every pipe
/// instance — the initial bind and every successor the accept loop spins
/// up — is created with it.
///
/// No external Windows crate is a direct dependency of this crate, so the
/// handful of Win32 entry points are declared inline behind a scoped
/// `#![allow(unsafe_code)]` (the crate otherwise denies `unsafe_code`).
/// The SDDL route
/// (`ConvertStringSecurityDescriptorToSecurityDescriptorW`) is used because
/// it yields a single self-contained, self-relative descriptor buffer,
/// avoiding manual `ACL`/`SID` buffer-lifetime juggling.
#[cfg(windows)]
pub(crate) mod win_security {
    #![allow(unsafe_code)]
    // FFI struct fields are read only by the kernel across the ABI, and the
    // extern fn names must match the exported symbols verbatim.
    #![allow(dead_code)]
    #![allow(non_snake_case)]

    use std::ffi::c_void;
    use std::io;

    type Handle = *mut c_void;
    type Bool = i32;

    const TOKEN_QUERY: u32 = 0x0008;
    /// `TOKEN_INFORMATION_CLASS::TokenUser`.
    const TOKEN_USER_CLASS: i32 = 1;
    /// `SDDL_REVISION_1`.
    const SDDL_REVISION_1: u32 = 1;

    #[repr(C)]
    struct SidAndAttributes {
        sid: *mut c_void,
        attributes: u32,
    }

    #[repr(C)]
    struct TokenUser {
        user: SidAndAttributes,
    }

    #[repr(C)]
    struct SecurityAttributes {
        n_length: u32,
        lp_security_descriptor: *mut c_void,
        b_inherit_handle: Bool,
    }

    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn OpenProcessToken(
            process_handle: Handle,
            desired_access: u32,
            token_handle: *mut Handle,
        ) -> Bool;
        fn GetTokenInformation(
            token_handle: Handle,
            token_information_class: i32,
            token_information: *mut c_void,
            token_information_length: u32,
            return_length: *mut u32,
        ) -> Bool;
        fn ConvertSidToStringSidW(sid: *mut c_void, string_sid: *mut *mut u16) -> Bool;
        fn ConvertStringSecurityDescriptorToSecurityDescriptorW(
            string_security_descriptor: *const u16,
            string_sd_revision: u32,
            security_descriptor: *mut *mut c_void,
            security_descriptor_size: *mut u32,
        ) -> Bool;
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetCurrentProcess() -> Handle;
        fn CloseHandle(h_object: Handle) -> Bool;
        fn LocalFree(h_mem: *mut c_void) -> *mut c_void;
    }

    /// RAII wrapper closing an access-token handle on drop.
    struct TokenHandle(Handle);
    impl Drop for TokenHandle {
        fn drop(&mut self) {
            if !self.0.is_null() {
                // SAFETY: `self.0` is a token handle from `OpenProcessToken`.
                unsafe { CloseHandle(self.0) };
            }
        }
    }

    /// RAII wrapper freeing a `LocalAlloc`-backed buffer on drop.
    struct LocalBuf(*mut c_void);
    impl Drop for LocalBuf {
        fn drop(&mut self) {
            if !self.0.is_null() {
                // SAFETY: `self.0` was allocated by a Win32 API via LocalAlloc.
                unsafe { LocalFree(self.0) };
            }
        }
    }

    /// Owned `SECURITY_ATTRIBUTES` plus its self-relative security descriptor.
    ///
    /// `descriptor` is a single `LocalAlloc`-backed, self-contained
    /// self-relative buffer produced by
    /// `ConvertStringSecurityDescriptorToSecurityDescriptorW`. The boxed
    /// `SecurityAttributes` keeps a stable address for the raw pointer
    /// handed to `create_with_security_attributes_raw`. Both stay alive
    /// until this guard drops — callers keep the guard until **after** the
    /// `create` call returns (the kernel copies the descriptor into the
    /// pipe object during the call, so freeing afterwards is sound).
    pub(crate) struct SecurityAttributesGuard {
        // Freed via `LocalFree` on drop. Also referenced by
        // `attrs.lp_security_descriptor` — that field is a borrow, not a
        // second owner, so the buffer is freed exactly once.
        descriptor: *mut c_void,
        attrs: Box<SecurityAttributes>,
    }

    impl SecurityAttributesGuard {
        /// Raw pointer to the `SECURITY_ATTRIBUTES`, valid while `self` is
        /// alive. Suitable for `create_with_security_attributes_raw`.
        fn as_ptr(&self) -> *mut c_void {
            std::ptr::from_ref(&*self.attrs).cast_mut().cast()
        }
    }

    impl Drop for SecurityAttributesGuard {
        fn drop(&mut self) {
            if !self.descriptor.is_null() {
                // SAFETY: `descriptor` was allocated by
                // `ConvertStringSecurityDescriptorToSecurityDescriptorW`
                // via LocalAlloc and is freed exactly once here.
                unsafe { LocalFree(self.descriptor) };
            }
        }
    }

    /// Read a null-terminated UTF-16 string starting at `ptr`.
    ///
    /// # Safety
    /// `ptr` must point at a valid, null-terminated wide string.
    unsafe fn wide_to_string(ptr: *const u16) -> String {
        let mut len = 0usize;
        // SAFETY: caller guarantees the buffer is null-terminated, so the
        // scan stops at or before the terminator.
        while unsafe { *ptr.add(len) } != 0 {
            len += 1;
        }
        // SAFETY: `len` scalars precede the terminator and are initialised.
        let slice = unsafe { std::slice::from_raw_parts(ptr, len) };
        String::from_utf16_lossy(slice)
    }

    /// Build a `SECURITY_ATTRIBUTES` whose DACL grants access only to the
    /// current process user's SID plus SYSTEM and the local Administrators
    /// group. The returned guard owns the descriptor buffer and must be
    /// kept alive for the duration of the `create` call that consumes it.
    pub(crate) fn current_user_security_attributes() -> io::Result<SecurityAttributesGuard> {
        // 1. Open the current process token for query access.
        let mut token: Handle = std::ptr::null_mut();
        // SAFETY: `GetCurrentProcess` returns a pseudo-handle; on success
        // `OpenProcessToken` writes the opened token handle into `token`.
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let _token = TokenHandle(token);

        // 2. Probe the required TokenUser buffer size. The first call is
        //    expected to fail with ERROR_INSUFFICIENT_BUFFER and set `needed`.
        let mut needed: u32 = 0;
        // SAFETY: the null-buffer / zero-length form is the documented
        // size-probe; only `needed` is written.
        unsafe {
            GetTokenInformation(
                token,
                TOKEN_USER_CLASS,
                std::ptr::null_mut(),
                0,
                &mut needed,
            );
        }
        if needed == 0 {
            return Err(io::Error::last_os_error());
        }

        // 3. Fetch the TokenUser payload into a pointer-aligned buffer.
        //    `Vec<u64>` guarantees 8-byte alignment for the embedded SID
        //    pointer; a `Vec<u8>` would only be byte-aligned.
        let cap = usize::try_from(needed).unwrap_or(0).div_ceil(8).max(1);
        let mut buf: Vec<u64> = vec![0u64; cap];
        // SAFETY: `buf` is `cap * 8 >= needed` bytes; GetTokenInformation
        // fills at most `needed` bytes and writes the actual size back.
        if unsafe {
            GetTokenInformation(
                token,
                TOKEN_USER_CLASS,
                buf.as_mut_ptr().cast::<c_void>(),
                needed,
                &mut needed,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }

        // 4. Read the user SID pointer (points inside `buf`).
        // SAFETY: `buf` now holds a TOKEN_USER laid out by the kernel and is
        // 8-aligned; `User.Sid` points into the same buffer.
        let sid = unsafe { (*buf.as_ptr().cast::<TokenUser>()).user.sid };
        if sid.is_null() {
            return Err(io::Error::other("token user SID is null"));
        }

        // 5. Convert the SID to its string form (LocalAlloc'd wide string).
        let mut sid_str: *mut u16 = std::ptr::null_mut();
        // SAFETY: `sid` is valid for the lifetime of `buf`; on success the
        // API LocalAlloc's the wide string into `sid_str`.
        if unsafe { ConvertSidToStringSidW(sid, &mut sid_str) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let _sid_str = LocalBuf(sid_str.cast::<c_void>());
        // SAFETY: on success `sid_str` is a valid, null-terminated wide string.
        let sid_string = unsafe { wide_to_string(sid_str) };

        // 6. Build the SDDL string and convert it to a self-relative
        //    descriptor:
        //      D:P            protected DACL (no inherited ACEs)
        //      (A;;GA;;;SID)  allow GENERIC_ALL to the current user
        //      (A;;GA;;;SY)   allow GENERIC_ALL to SYSTEM
        //      (A;;GA;;;BA)   allow GENERIC_ALL to the local Administrators
        let sddl = format!("D:P(A;;GA;;;{sid_string})(A;;GA;;;SY)(A;;GA;;;BA)");
        let sddl_wide: Vec<u16> = sddl.encode_utf16().chain(std::iter::once(0)).collect();

        let mut descriptor: *mut c_void = std::ptr::null_mut();
        // SAFETY: `sddl_wide` is a valid null-terminated wide string; on
        // success the API LocalAlloc's a self-relative descriptor into
        // `descriptor`. The size out-param is unused (null).
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl_wide.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }

        // 7. Wrap the descriptor in a boxed SECURITY_ATTRIBUTES.
        let attrs = Box::new(SecurityAttributes {
            n_length: u32::try_from(std::mem::size_of::<SecurityAttributes>()).unwrap_or(0),
            lp_security_descriptor: descriptor,
            b_inherit_handle: 0,
        });

        Ok(SecurityAttributesGuard { descriptor, attrs })
    }

    /// Create a named-pipe server instance secured to the current user.
    ///
    /// `first_instance` mirrors `ServerOptions::first_pipe_instance`: `true`
    /// for the initial bind (which also acts as the double-launch / squat
    /// lock) and `false` for every successor instance the accept loop spins
    /// up. Both paths use the per-user security descriptor from
    /// [`current_user_security_attributes`].
    pub(crate) fn create_secured_pipe_instance(
        pipe_path: &str,
        first_instance: bool,
    ) -> io::Result<tokio::net::windows::named_pipe::NamedPipeServer> {
        use tokio::net::windows::named_pipe::ServerOptions;

        let sa = current_user_security_attributes()?;
        // SAFETY: `sa.as_ptr()` points at a `SECURITY_ATTRIBUTES` whose
        // `lp_security_descriptor` is a valid self-relative descriptor. Both
        // remain alive until `sa` drops at the end of this function — after
        // `create_with_security_attributes_raw` returns, by which point the
        // kernel has copied the descriptor into the new pipe object.
        unsafe {
            ServerOptions::new()
                .first_pipe_instance(first_instance)
                .create_with_security_attributes_raw(pipe_path, sa.as_ptr())
        }
    }
}

#[cfg(windows)]
pub async fn bind_socket(pipe_path: &Path) -> Result<SocketKind, AppError> {
    let pipe_str = pipe_path.to_str().ok_or_else(|| {
        AppError::InvalidOperation(format!(
            "MCP pipe path is not valid UTF-8: {}",
            pipe_path.display()
        ))
    })?;

    // #2720: create the FIRST instance with an explicit per-user DACL (the
    // default named-pipe DACL grants read to Everyone + Anonymous) and with
    // `first_pipe_instance(true)`, which also acts as the double-launch /
    // squat lock.
    let server = win_security::create_secured_pipe_instance(pipe_str, true).map_err(|e| {
        // #2720: on the FIRST instance, ERROR_ACCESS_DENIED (5) /
        // ERROR_ALREADY_EXISTS (183) mean the fixed pipe name is already
        // held by another local process — i.e. a squatter (a second Agaric
        // is prevented by the single-instance plugin, so this is not a
        // legitimate idempotent restart). The previous code mapped this to a
        // warn-level "already bound" swallow that silently yielded the name.
        // Return a loud error instead so the surface refuses to attach to a
        // potentially foreign pipe.
        if matches!(e.raw_os_error(), Some(5) | Some(183)) {
            AppError::Io(std::io::Error::new(
                e.kind(),
                format!(
                    "MCP named pipe {} is already held by another \
                     process (os error {:?}); refusing to attach to a \
                     potentially squatted pipe name",
                    pipe_path.display(),
                    e.raw_os_error(),
                ),
            ))
        } else {
            AppError::Io(e)
        }
    })?;

    tracing::info!(
        target: "mcp",
        path = %pipe_path.display(),
        "MCP named pipe created with per-user security descriptor",
    );

    Ok(SocketKind::Pipe {
        server,
        path: pipe_str.to_string(),
    })
}

/// Spawn the MCP task onto the current Tokio runtime.
///
/// Checks the `mcp-enabled` marker-file gate and, when enabled, binds the
/// default socket for `app_data_dir` and spawns the serve loop. When
/// disabled, logs at info level and returns. When the socket is already
/// bound by another instance, logs at warn level and returns — the first
/// owner keeps the socket.
///
/// Each connection is served by the registry its agent's mode picks:
/// [`tools_ro::ReadOnlyTools`] or [`tools_rw::ReadWriteTools`]. Reads use
/// `read_pool`; writes, and `journal_for_date`'s create, use `write_pool`,
/// because the read pool sets `PRAGMA query_only = ON`. Agents are looked up
/// on `read_pool` and their last use stamped on `write_pool`.
///
/// `activity_ring` (#695) is the **shared, managed** ring backing the
/// `get_mcp_recent_activity` command, so the feed survives enable/disable
/// cycles. `lifecycle` surfaces connection counts and the disconnect signal
/// to Settings; `None` for headless / test callers.
#[expect(clippy::too_many_arguments)]
pub fn spawn_mcp_task<R: tauri::Runtime>(
    app_data_dir: &Path,
    app_handle: tauri::AppHandle<R>,
    read_pool: SqlitePool,
    write_pool: SqlitePool,
    materializer: Materializer,
    device_id: String,
    activity_ring: Arc<std::sync::Mutex<activity::ActivityRing>>,
    lifecycle: Option<McpLifecycle>,
) {
    if !mcp_enabled(app_data_dir) {
        tracing::info!(
            target: "mcp",
            "MCP disabled ({} marker absent)", MCP_ENABLED_MARKER,
        );
        return;
    }

    let socket_path = default_mcp_socket_path(app_data_dir);
    // #2505 / #5314: a write, or `journal_for_date`'s create, emits
    // `blocks:changed` on the same bus the activity feed uses, so open views
    // reload. Built before the handle moves into the activity context.
    let view_emitter: Arc<dyn view_notify::ViewChangeEmitter> =
        Arc::new(view_notify::TauriViewChangeEmitter::new(app_handle.clone()));
    let activity_ctx =
        activity::ActivityContext::from_app_handle_with_ring(app_handle, activity_ring);
    let read_only = tools_ro::ReadOnlyTools::new(
        read_pool.clone(),
        write_pool.clone(),
        materializer.clone(),
        device_id.clone(),
    )
    .with_view_emitter(view_emitter.clone());
    let read_write = tools_rw::ReadWriteTools::new(
        write_pool.clone(),
        read_pool.clone(),
        materializer,
        device_id,
    )
    .with_view_emitter(view_emitter);
    let server = server::McpServer {
        read_only: Arc::new(read_only),
        read_write: Arc::new(read_write),
        agents: agents::AgentStore::new(read_pool, write_pool),
        activity_ctx: Some(activity_ctx),
    };
    spawn_mcp_task_with_server(socket_path, server, lifecycle);
}

/// Spawn the MCP task against a caller-supplied server and socket path, so
/// integration tests can drive bind + accept + dispatch on a tempdir socket.
///
/// When `lifecycle` is `Some`, the serve loop sets `task_running = true` on
/// entry and back to `false` on exit so `get_mcp_status` reflects the accept
/// loop's state; each per-connection task increments / decrements
/// `active_connections` and `select!`s on the disconnect signal.
pub fn spawn_mcp_task_with_server<RO, RW>(
    socket_path: PathBuf,
    server: server::McpServer<RO, RW>,
    lifecycle: Option<McpLifecycle>,
) where
    RO: server::ToolRegistry,
    RW: server::ToolRegistry,
{
    let server = Arc::new(server);
    tauri::async_runtime::spawn(async move {
        // H-2: a previous disable cleared `enabled` to `false` and left
        // it that way (so the prior accept loop observed the gate and
        // exited). Reset before binding so the fresh accept loop is
        // not torn down on its first iteration. Done before bind so a
        // bind failure does not leave the gate stuck at `false`.
        if let Some(ref lc) = lifecycle {
            lc.enabled.store(true, std::sync::atomic::Ordering::Release);
            // #2824 — reset the level-triggered shutdown gate too, so a
            // prior shutdown's stored `true` does not immediately tear
            // down the freshly-spawned accept loop.
            lc.shutdown_signal.send_replace(false);
        }
        match bind_socket(&socket_path).await {
            Ok(socket) => {
                if let Some(ref lc) = lifecycle {
                    lc.task_running
                        .store(true, std::sync::atomic::Ordering::Release);
                }
                if let Err(e) = server::serve(socket, server, lifecycle.clone()).await {
                    tracing::error!(
                        target: "mcp",
                        error = %e,
                        "MCP serve loop exited with error",
                    );
                }
                if let Some(ref lc) = lifecycle {
                    lc.task_running
                        .store(false, std::sync::atomic::Ordering::Release);
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
pub(crate) mod test_support {
    //! Fixtures the MCP tests share: a vault with an agent in it, and a
    //! server over a pair of registries.

    use std::sync::Arc;

    use sqlx::SqlitePool;
    use tempfile::TempDir;

    use super::agents::{AgentStore, ConnectedAgent, McpAgent, McpAgentMode, insert_agent};
    use super::server::{McpServer, ToolRegistry};

    /// A fresh vault holding one agent named `name`.
    pub(crate) async fn vault_with_agent(
        name: &str,
        mode: McpAgentMode,
        space_ids: Option<Vec<String>>,
    ) -> (SqlitePool, McpAgent, TempDir) {
        let dir = TempDir::new().unwrap();
        let pool = crate::db::init_pool(&dir.path().join("mcp.db"))
            .await
            .unwrap();
        let agent = insert_agent(&pool, name, mode, space_ids)
            .await
            .unwrap()
            .expect("the name is free");
        (pool, agent, dir)
    }

    /// `agent`'s connection, as `handle_connection` makes it from its token.
    pub(crate) async fn connected(pool: &SqlitePool, agent: &McpAgent) -> ConnectedAgent {
        AgentStore::new(pool.clone(), pool.clone())
            .connect(&agent.token)
            .await
            .unwrap()
            .expect("the token is live")
    }

    /// A server whose read-only agents get `read_only` and read-write agents
    /// `read_write`, finding agents in `pool`.
    pub(crate) fn server<RO: ToolRegistry, RW: ToolRegistry>(
        read_only: RO,
        read_write: RW,
        pool: SqlitePool,
    ) -> Arc<McpServer<RO, RW>> {
        Arc::new(McpServer {
            read_only: Arc::new(read_only),
            read_write: Arc::new(read_write),
            agents: AgentStore::new(pool.clone(), pool),
            activity_ctx: None,
        })
    }

    /// A pool that never opens, for a server no connection gets a token to.
    pub(crate) fn unused_pool() -> SqlitePool {
        SqlitePool::connect_lazy("sqlite::memory:").unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn mcp_enabled_returns_false_when_marker_absent() {
        let dir = TempDir::new().unwrap();
        assert!(
            !mcp_enabled(dir.path()),
            "expected gate off when marker absent",
        );
    }

    #[test]
    fn mcp_enabled_returns_true_when_marker_present() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join(MCP_ENABLED_MARKER), b"").unwrap();
        assert!(
            mcp_enabled(dir.path()),
            "expected gate on when marker present",
        );
    }

    #[test]
    fn mcp_enabled_ignores_directory_with_marker_name() {
        // A directory at the marker path must not be mistaken for the gate.
        let dir = TempDir::new().unwrap();
        std::fs::create_dir(dir.path().join(MCP_ENABLED_MARKER)).unwrap();
        assert!(
            !mcp_enabled(dir.path()),
            "directory at marker path must not flip the gate",
        );
    }

    #[cfg(unix)]
    #[test]
    fn default_mcp_socket_path_under_app_data_dir_on_unix() {
        let dir = TempDir::new().unwrap();
        let path = default_mcp_socket_path(dir.path());
        assert_eq!(path, dir.path().join(MCP_SOCKET_FILENAME));
    }

    #[cfg(windows)]
    #[test]
    fn default_mcp_socket_path_is_named_pipe_on_windows() {
        let dir = TempDir::new().unwrap();
        let path = default_mcp_socket_path(dir.path());
        assert_eq!(path, std::path::PathBuf::from(MCP_PIPE_PATH));
    }

    /// Access that was on through the read-write socket alone stays on.
    #[test]
    fn legacy_markers_become_mcp_enabled_5667() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("mcp-rw-enabled"), b"").unwrap();

        adopt_legacy_markers(dir.path()).unwrap();

        assert!(
            mcp_enabled(dir.path()),
            "the RW marker alone turns access on"
        );
        assert!(
            !dir.path().join("mcp-rw-enabled").exists(),
            "the RW marker is removed",
        );
    }

    #[test]
    fn both_legacy_markers_become_one_and_both_go_5667() {
        let dir = TempDir::new().unwrap();
        for marker in ["mcp-ro-enabled", "mcp-rw-enabled"] {
            std::fs::write(dir.path().join(marker), b"").unwrap();
        }

        adopt_legacy_markers(dir.path()).unwrap();

        assert!(mcp_enabled(dir.path()), "access stays on");
        for marker in ["mcp-ro-enabled", "mcp-rw-enabled"] {
            assert!(!dir.path().join(marker).exists(), "{marker} is removed");
        }
    }

    #[test]
    fn no_legacy_marker_leaves_access_off_5667() {
        let dir = TempDir::new().unwrap();
        adopt_legacy_markers(dir.path()).unwrap();
        assert!(
            !mcp_enabled(dir.path()),
            "access off before the upgrade stays off"
        );
    }

    /// #693: agents weight the instructions heavily, and a read-write agent
    /// told it is read-only stops using its write tools.
    #[test]
    fn instructions_match_the_agents_mode() {
        let read_only = agents::McpAgentMode::ReadOnly.instructions();
        assert!(
            read_only.contains("read-only"),
            "a read-only agent is told so: {read_only:?}",
        );
        let read_write = agents::McpAgentMode::ReadWrite.instructions();
        assert!(
            read_write.contains("read-write"),
            "a read-write agent is told so: {read_write:?}",
        );
        assert!(
            !read_write.contains("read-only"),
            "a read-write agent is never told it is read-only: {read_write:?}",
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn bind_socket_enforces_mode_0600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TempDir::new().unwrap();
        let path = dir.path().join(MCP_SOCKET_FILENAME);
        let _socket = bind_socket(&path).await.expect("bind succeeds");
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(
            mode & 0o777,
            0o600,
            "MCP socket must be user-only (0600), got {:o}",
            mode & 0o777,
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn bind_socket_removes_stale_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join(MCP_SOCKET_FILENAME);
        // Prior-run stale file — not a live listener.
        std::fs::write(&path, b"stale").unwrap();
        let _socket = bind_socket(&path).await.expect("bind succeeds over stale");
        assert!(path.exists(), "socket file exists after re-bind");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn bind_socket_rejects_second_live_instance() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join(MCP_SOCKET_FILENAME);
        let _first = bind_socket(&path).await.expect("first bind succeeds");
        let second = bind_socket(&path).await;
        assert!(
            matches!(second, Err(AppError::InvalidOperation(_))),
            "second bind must return InvalidOperation, got {second:?}",
        );
    }

    /// The `agaric-mcp` binary built by `cargo build --bin agaric-mcp`.
    #[cfg(all(unix, feature = "ci-smoke"))]
    fn bridge_binary() -> std::path::PathBuf {
        let manifest_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        ["debug", "release"]
            .iter()
            .map(|p| manifest_dir.join("target").join(p).join("agaric-mcp"))
            .find(|p| p.exists())
            .expect("run `cargo build --bin agaric-mcp` before this test")
    }

    /// Serves one connection on `socket_path` as the production server does,
    /// then runs the real bridge with `bridge_args` and sends it one
    /// `initialize`, returning its first reply line.
    #[cfg(all(unix, feature = "ci-smoke"))]
    async fn bridge_reply(
        socket_path: &std::path::Path,
        server: Arc<server::McpServer<server::PlaceholderRegistry, server::PlaceholderRegistry>>,
        bridge_args: &[&str],
    ) -> serde_json::Value {
        use std::io::BufRead;
        use std::io::Write as _;
        use std::process::{Command, Stdio};

        let listener = tokio::net::UnixListener::bind(socket_path).unwrap();
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let _ = server::handle_connection(stream, server).await;
        });

        let mut child = Command::new(bridge_binary())
            .arg("--socket")
            .arg(socket_path)
            .args(bridge_args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn agaric-mcp");
        let mut stdin = child.stdin.take().expect("stdin");
        // rmcp rejects an `initialize` without `capabilities`.
        stdin
            .write_all(
                b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\
                  \"params\":{\"protocolVersion\":\"2024-11-05\",\
                  \"clientInfo\":{\"name\":\"integration\",\"version\":\"0\"},\
                  \"capabilities\":{}}}\n",
            )
            .unwrap();
        stdin.flush().unwrap();
        drop(stdin);

        let mut line = String::new();
        std::io::BufReader::new(child.stdout.take().expect("stdout"))
            .read_line(&mut line)
            .expect("read the reply");
        let _ = child.kill();
        let _ = child.wait();
        serde_json::from_str(line.trim()).expect("the reply is JSON-RPC")
    }

    // The mcp-tests CI lane runs these after `cargo build --bin agaric-mcp`:
    //   cargo nextest run --features ci-smoke -E 'test(stub_binary_)'
    #[cfg(all(unix, feature = "ci-smoke"))]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn stub_binary_roundtrips_initialize_over_uds() {
        let (pool, agent, dir) =
            test_support::vault_with_agent("Smoke", agents::McpAgentMode::ReadOnly, None).await;
        let server = test_support::server(
            server::PlaceholderRegistry,
            server::PlaceholderRegistry,
            pool,
        );
        let socket_path = dir.path().join("bin-test.sock");

        let response = bridge_reply(&socket_path, server, &["--token", &agent.token]).await;

        assert_eq!(response["id"], 1);
        assert_eq!(
            response["result"]["serverInfo"]["name"], "agaric",
            "the bridge's token reaches an agent, so the server answers initialize: {response}",
        );
    }

    #[cfg(all(unix, feature = "ci-smoke"))]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn stub_binary_with_a_revoked_token_is_refused_5667() {
        let (pool, agent, dir) =
            test_support::vault_with_agent("Smoke", agents::McpAgentMode::ReadOnly, None).await;
        // A live agent a lookup could wrongly fall back to.
        agents::insert_agent(&pool, "Live", agents::McpAgentMode::ReadOnly, None)
            .await
            .unwrap()
            .unwrap();
        agents::delete_agent(&pool, &agent.id).await.unwrap();
        let server = test_support::server(
            server::PlaceholderRegistry,
            server::PlaceholderRegistry,
            pool,
        );
        let socket_path = dir.path().join("bin-test.sock");

        let response = bridge_reply(&socket_path, server, &["--token", &agent.token]).await;

        assert_eq!(response["id"], 1, "the refusal answers the initialize");
        assert_eq!(response["error"]["code"], -32001);
        let message = response["error"]["message"].as_str().unwrap_or_default();
        assert!(
            message.contains("Settings → Agent access"),
            "the refusal names where to get a token: {message}",
        );
    }

    #[cfg(all(unix, feature = "ci-smoke"))]
    #[test]
    fn stub_binary_without_a_token_exits_2_naming_settings_5667() {
        let output = std::process::Command::new(bridge_binary())
            .args(["--socket", "/nonexistent/mcp.sock"])
            .output()
            .expect("run agaric-mcp");
        assert_eq!(
            output.status.code(),
            Some(2),
            "a missing --token is a usage error"
        );
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            stderr.contains("Settings → Agent access"),
            "the error names where to get a token: {stderr}",
        );
    }
}
