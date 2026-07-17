//! App-side shim for the Logseq/Markdown import parser.
//!
//! #2621 (wave E4-import) — the query-free parser plus its outcome types
//! (`ParsedBlock`, `ImportResult`, `ImportProgressUpdate`, `VaultFile`) moved
//! into [`agaric_engine::import`]. This module re-exports that engine module so
//! every existing `crate::import::…` path resolves unchanged, and additionally
//! hosts the Tauri-integration seam: the [`ImportProgressSink`] trait and its
//! production `tauri::ipc::Channel<ImportProgressUpdate>` impl.
//!
//! The seam stays app-side deliberately. The parser never consumes the sink
//! (progress events are emitted by the apply/command path in
//! `commands::pages::markdown`, not by parsing), so keeping the trait +
//! `impl … for tauri::ipc::Channel` here avoids giving the framework-free
//! `agaric-engine` crate a `tauri` dependency — and satisfies the orphan rule
//! (the trait is local to this crate, so the impl on the foreign
//! `tauri::ipc::Channel` type is legal).

pub use agaric_engine::import::*;

/// Sink for [`ImportProgressUpdate`] events, decoupling the import command
/// from Tauri so tests can capture the emitted stream without an
/// `AppHandle` (mirrors `sync_events::SyncEventSink`).
///
/// Implemented for `tauri::ipc::Channel<ImportProgressUpdate>` (the
/// production path) and for a test recorder. Sends are best-effort: a
/// failed send (e.g. the frontend dropped the channel) is swallowed — a
/// dead progress channel must never abort an otherwise-valid import.
pub trait ImportProgressSink: Send + Sync {
    fn emit(&self, update: ImportProgressUpdate);
}

impl ImportProgressSink for tauri::ipc::Channel<ImportProgressUpdate> {
    fn emit(&self, update: ImportProgressUpdate) {
        // Best-effort: a dropped channel must not fail the import. #1932 —
        // but record the failure at debug so a frozen progress bar can be
        // distinguished from a hung import ("progress channel dead" vs
        // "import stuck") when triaging from the log.
        if let Err(e) = self.send(update) {
            tracing::debug!(
                error = %e,
                "import: progress channel send failed (frontend likely dropped it)"
            );
        }
    }
}
