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

    /// Every crate `src/` root in the workspace, not just this crate's.
    ///
    /// `CARGO_MANIFEST_DIR` is `…/src-tauri/agaric-sync`, whose parent is the directory
    /// the app crate and every extracted member share. Members are discovered
    /// structurally — a subdirectory holding both a `Cargo.toml` and a `src/` — the same
    /// way `bug_report::stable_messages_pin_real_call_sites` does it, so the next
    /// extraction wave needs no edit here.
    ///
    /// Scanning only this crate's `src/` was a hole, not a simplification: `sync_net` is
    /// `pub`, the app crate re-exports it, and a caller left behind in `src-tauri/src` is
    /// exactly the caller PR B's deletion would break.
    fn scan_roots() -> Vec<PathBuf> {
        let workspace = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("the crate directory has a parent")
            .to_path_buf();
        let mut roots = vec![workspace.join("src")];
        if let Ok(entries) = std::fs::read_dir(&workspace) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.join("Cargo.toml").is_file() && path.join("src").is_dir() {
                    roots.push(path.join("src"));
                }
            }
        }
        roots.sort();
        roots.dedup();
        roots
    }

    /// The needles that apply to `path`.
    ///
    /// Scoping is the whole of the rule: see [`SYNC_DAEMON_NEEDLES`].
    fn needles_for(path: &Path) -> Vec<&'static str> {
        let s = path.to_string_lossy().replace('\\', "/");
        let mut needles = NEEDLES.to_vec();
        if s.contains("/sync_daemon/") {
            needles.extend_from_slice(&SYNC_DAEMON_NEEDLES);
        }
        needles
    }

    /// Every offending line in one file's text, as `line-number: line`.
    ///
    /// Split out from the walk so the needle set can be falsified against source text
    /// directly. The first version of this guard could only be falsified by editing a
    /// real production file and running the suite by hand, which is precisely why the
    /// `wire` third of it was never falsified at all.
    fn offending_lines(text: &str, needles: &[&str]) -> Vec<String> {
        let mut out = Vec::new();
        for (i, line) in text.lines().enumerate() {
            let trimmed = line.trim_start();
            // `mod` declarations are how the modules stay in the tree at all, which is
            // the point of PR A. Comments are skipped — see the docs.
            if trimmed.starts_with("pub mod ")
                || trimmed.starts_with("mod ")
                || trimmed.starts_with("//")
                || trimmed.starts_with("* ")
            {
                continue;
            }
            if needles.iter().any(|needle| line.contains(needle)) {
                out.push(format!("{}: {}", i + 1, line.trim()));
            }
        }
        out
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
    /// The module paths PR B deletes, in every spelling production ever used to reach
    /// them.
    ///
    /// Spelled by concatenation so this array is not itself a match — a guard that
    /// flags its own definition is a guard nobody can make pass.
    ///
    /// The `wire` entries beyond the first two are what the original set missed, and
    /// they were the *only* spelling the five retired call sites used: `use super::wire;`
    /// at the top of the file, then a bare `wire::send_sync_message(…)` below. Neither
    /// matches `super::wire::` or `sync_daemon::wire`, so planting the retired code back
    /// into production left this guard green — a guard claiming a completeness it did
    /// not have.
    /// The module paths PR B deletes, in every spelling production ever used to reach
    /// them.
    ///
    /// Spelled by concatenation so this array is not itself a match — a guard that
    /// flags its own definition is a guard nobody can make pass.
    ///
    /// The `wire` entries beyond the first two are what the original set missed, and
    /// they were the *only* spelling the five retired call sites used: `use super::wire;`
    /// at the top of the file, then a bare `wire::send_sync_message(…)` below. Neither
    /// matches `super::wire::` or `sync_daemon::wire`, so planting the retired code back
    /// into production left this guard green — a guard claiming a completeness it did
    /// not have.
    const NEEDLES: [&str; 7] = [
        concat!("sync_", "net::"),
        concat!("sync_", "cert::"),
        concat!("super::", "wire::"),
        concat!("sync_daemon", "::wire"),
        concat!("use ", "wire::"),
        concat!("pub use ", "wire::"),
        // `use super::wire;` / `use crate::sync_daemon::wire;` — the import that makes
        // the bare form below legal, caught by the trailing `;` rather than by a path.
        concat!("::", "wire;"),
    ];

    /// Applied only inside `sync_daemon/`, where `wire` is a sibling module and can be
    /// named with no path prefix at all.
    ///
    /// That bare form is what every retired call site used. It is too generic to apply
    /// repo-wide — any local binding called `wire` would trip it — and it does not need
    /// to be: from outside `sync_daemon/` the module cannot be reached without a path
    /// [`NEEDLES`] already carries.
    const SYNC_DAEMON_NEEDLES: [&str; 1] = [concat!("wire", "::")];

    #[test]
    fn no_production_module_references_the_retired_transport() {
        let roots = scan_roots();
        for expected in ["src-tauri/src", "agaric-sync/src", "agaric-store/src"] {
            assert!(
                roots
                    .iter()
                    .any(|r| r.to_string_lossy().replace('\\', "/").ends_with(expected)),
                "the scan must walk {expected} — a caller left behind in another crate \
                 is still a caller PR B would break; got {roots:?}"
            );
        }

        let mut files = Vec::new();
        for root in &roots {
            rust_files(root, &mut files);
        }
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
            for hit in offending_lines(&text, &needles_for(&file)) {
                offenders.push(format!("{}:{hit}", file.display()));
            }
        }

        assert!(
            offenders.is_empty(),
            "PR A must leave the retired transport unreferenced from production so PR B \
             can delete it mechanically; these still reach for it:\n{}",
            offenders.join("\n")
        );
    }

    /// The guard's own falsification, on the spelling that used to walk straight past it.
    ///
    /// These two lines are the retired code verbatim — the import and one of the five
    /// call sites. Asserted against text rather than by editing a production file so
    /// that falsifying this guard is a test run rather than a procedure a reviewer has
    /// to remember to perform; the `wire` needles were wrong precisely because nobody
    /// performed it.
    #[test]
    fn the_guard_catches_the_spelling_the_retired_call_sites_used() {
        let in_sync_daemon = Path::new("src-tauri/agaric-sync/src/sync_daemon/wire_caller.rs");
        let needles = needles_for(in_sync_daemon);

        for (label, line) in [
            ("the import", concat!("use super::", "wire;")),
            (
                "the call",
                concat!(
                    "    ",
                    "wire",
                    "::send_sync_message(&mut send, &msg).await?;"
                ),
            ),
        ] {
            let hits = offending_lines(line, &needles);
            assert_eq!(
                hits.len(),
                1,
                "{label} is how the retired transport was actually reached and must be \
                 flagged; got {hits:?}"
            );
        }

        // Not vacuous in the other direction: the needles must still be needles.
        let benign = concat!(
            "let ",
            "wire",
            " = 1;\n// ",
            "wire",
            "::send_sync_message(…) — historical prose\nlet x = 2;\n"
        );
        assert!(
            offending_lines(benign, &needles).is_empty(),
            "a local binding and a comment are not call sites; flagging them would \
             pressure someone into deleting the port's only historical record"
        );

        // And the bare form is scoped: outside `sync_daemon/` the module needs a path,
        // which the unscoped needles already carry.
        let elsewhere = needles_for(Path::new("src-tauri/agaric-sync/src/sync_files.rs"));
        assert!(
            offending_lines(concat!("    ", "wire", "::send(x);"), &elsewhere).is_empty(),
            "the bare spelling must not be applied outside sync_daemon/"
        );
        assert_eq!(
            offending_lines(
                concat!("use crate::sync_", "net::SyncConnection;"),
                &elsewhere
            )
            .len(),
            1,
            "the unscoped needles must still apply everywhere"
        );
    }
}
