//! agaric-sync — the peer-to-peer sync layer of the layered `agaric` workspace
//! (#2621).
//!
//! Sits above `agaric-engine` and below the `agaric` app crate. This crate owns
//! the LAN pairing / device-sync stack. Sync-B seeds it with the three
//! dependency-free leaf modules peeled off the app crate; the mutually-recursive
//! net / protocol / daemon / files cluster and `snapshot` land in a later wave.
//!
//! The app crate re-exports each module (`pub use agaric_sync::{device,
//! foreground, sync_constants};`) so existing `crate::device::…` /
//! `crate::foreground::…` / `crate::sync_constants::…` paths resolve unchanged.

/// Stable per-install device identity — the persisted `DeviceId` UUID that
/// pairs and op-log origin attribution key off. Query-free; depends only on
/// `agaric-core` (`error::AppError`).
pub mod device;

/// Foreground/background gating primitive (`LifecycleHooks`) shared across the
/// sync / materializer / app layers. Query-free; depends only on `tokio`'s
/// `Notify`.
pub mod foreground;

/// Wire-protocol tunables (frame sizes, batch payload caps, handshake / connect
/// timeouts) shared across the sync stack. Pure constants; no dependencies.
pub mod sync_constants;

// ---------------------------------------------------------------------------
// Sync-D (#2621): the mutually-recursive net / protocol / daemon / files
// cluster + `snapshot`, `apply_host`, and the pure `sync_events` types. The app
// crate re-exports each (`pub use agaric_sync::X;`, or a test-hosting shim for
// the directory modules with app-coupled tests) so every `crate::sync_*::…` /
// `crate::snapshot::…` / `crate::apply_host::…` path resolves unchanged.
// ---------------------------------------------------------------------------

/// The narrow apply/materialize surface the sync layer needs from the app-side
/// `Materializer`, expressed as a trait so the sync modules depend DOWN on this
/// abstraction. The app's `impl ApplyHost for Materializer` stays app-side.
pub mod apply_host;

/// Pure `SyncEvent` / `SyncProgressUpdate` types + the `SyncEventSink` trait.
/// Tauri-backed sinks live app-side (`src/sync_event_sinks.rs`).
pub mod sync_events;

/// QUIC transport built on iroh (#78, plan #3464). Replaces the WebSocket +
/// mTLS stack in [`sync_net`], which is retired as the port lands. Carries the
/// LAN-only endpoint configuration and the offline guard that keeps it that way.
pub mod transport;

/// LAN peer discovery over mDNS (#3488). Lifted out of [`sync_net`], whose other
/// half the cutover deletes: iroh's own address lookup is cleared by
/// [`transport::endpoint::lan_only`], so this is the only discovery left.
pub mod mdns;

/// Networking primitives: TLS cert gen, WebSocket server/client, the unified
/// `SyncConnection`.
///
/// Superseded by [`transport`] and slated for deletion — see plan #3464.
pub mod sync_net;

/// Sync protocol orchestrator: head exchange, Loro-CRDT engine sync, peer-ref
/// bookkeeping.
pub mod sync_protocol;

/// Auto-sync daemon: background peer discovery, connection, and sync sessions.
pub mod sync_daemon;

/// Attachment file transfer over the sync connection.
pub mod sync_files;

/// Per-peer sync locks, exponential backoff, debounced change notifications.
pub mod sync_scheduler;

/// Persistent self-signed TLS certificate load/generation for the mTLS sync
/// handshake.
pub mod sync_cert;

/// LAN device pairing (passphrase + QR handshake).
pub mod pairing;

/// Snapshot encoding, crash-safe write, RESET apply, and 90-day compaction.
pub mod snapshot;

/// The cutover's own acceptance check: nothing on the production path still reaches
/// for the transport this port replaced (#3464, PR A).
///
/// # Why this is a test and not an eyeball
///
/// PR A is the *rewrite*; the PR after it is the *deletion*. That split is only honest
/// if PR A leaves `sync_net`, `sync_cert` and `sync_daemon::wire` genuinely unreferenced
/// — and "genuinely" is not something a diff review establishes, because the three
/// modules stay `pub mod` (`:58`, `:75`, and `sync_daemon`'s own list) and an
/// unreferenced-but-public item trips no `dead_code` lint. So the compiler will not say
/// it, and a reviewer reading a 4,000-line diff has no way to be sure.
///
/// A source scan is a blunt instrument, and it is the right one here: the question is
/// mechanical ("does the name appear"), the answer must be exhaustive, and the failure
/// mode of getting it wrong is that PR B deletes a module something still calls.
#[cfg(test)]
mod cutover_guard {
    use std::path::{Path, PathBuf};

    /// Files that are *allowed* to name the retired modules: the modules themselves,
    /// and anything under a `tests` path.
    ///
    /// `sync_daemon/wire.rs` is on this list for the same reason `sync_net` is — it is
    /// part of the set PR B deletes, so a reference *between* two doomed modules does
    /// not keep either alive.
    fn is_exempt(path: &Path) -> bool {
        let s = path.to_string_lossy().replace('\\', "/");
        s.contains("/sync_net/")
            || s.ends_with("/sync_cert.rs")
            || s.ends_with("/sync_daemon/wire.rs")
            || s.contains("/tests/")
            || s.ends_with("tests.rs")
            || s.ends_with("test_support.rs")
    }

    fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                rust_files(&path, out);
            } else if path.extension().is_some_and(|e| e == "rs") {
                out.push(path);
            }
        }
    }

    /// No production module names `sync_net`, `sync_cert`, or `sync_daemon::wire`.
    ///
    /// Forced red by restoring `use crate::sync_net::SyncConnection;` to `sync_files.rs`:
    /// the failure names the file and the line, which is the diagnosis a reviewer would
    /// otherwise have to produce by hand.
    ///
    /// # Comments are skipped, and that is not laziness
    ///
    /// The first version scanned them, and it failed on eleven lines of *deliberate*
    /// historical prose — "the old transport bounded this invisibly, which is why the
    /// bound is explicit here". That prose is the only record of what the port had to
    /// re-supply by hand, and a guard that pressured anyone into deleting it would cost
    /// more than it protects. The question this test asks is whether production *calls*
    /// the retired modules, and a comment does not call anything.
    /// The module paths PR B deletes. A `&str` array so this test's own line naming
    /// them is not itself a match.
    /// Spelled by concatenation so this array is not itself a match — a guard that
    /// flags its own definition is a guard nobody can make pass.
    const NEEDLES: [&str; 4] = [
        concat!("sync_", "net::"),
        concat!("sync_", "cert::"),
        concat!("super::", "wire::"),
        concat!("sync_daemon", "::wire"),
    ];

    #[test]
    fn no_production_module_references_the_retired_transport() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files = Vec::new();
        rust_files(&root, &mut files);
        assert!(
            files.len() > 20,
            "the scan found only {} files, so it is not looking where it thinks it is",
            files.len()
        );

        let mut offenders = Vec::new();
        for file in files {
            if is_exempt(&file) {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&file) else {
                continue;
            };
            for (i, line) in text.lines().enumerate() {
                let trimmed = line.trim_start();
                // `pub mod` declarations are how the modules stay in the tree at all,
                // which is the point of PR A. Comments are skipped — see the docs.
                if trimmed.starts_with("pub mod ")
                    || trimmed.starts_with("//")
                    || trimmed.starts_with("* ")
                {
                    continue;
                }
                for needle in NEEDLES {
                    if line.contains(needle) {
                        offenders.push(format!("{}:{}: {}", file.display(), i + 1, line.trim()));
                    }
                }
            }
        }

        assert!(
            offenders.is_empty(),
            "PR A must leave the retired transport unreferenced from production so PR B \
             can delete it mechanically; these still reach for it:\n{}",
            offenders.join("\n")
        );
    }
}
