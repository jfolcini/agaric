//! App-side shim for the Logseq/Markdown import parser.
//!
//! #2621 (wave E4-import) — the query-free parser plus its outcome types
//! (`ParsedBlock`, `ImportResult`, `ImportProgressUpdate`, `VaultFile`) moved
//! into [`agaric_engine::import`]. This module re-exports that engine module so
//! every existing `crate::import::…` path resolves unchanged, and additionally
//! hosts the Tauri-integration seam: the [`ImportProgressSink`] trait and its
//! production `UiChannel<R, ImportProgressUpdate>` impl.
//!
//! The seam stays app-side deliberately. The parser never consumes the sink
//! (progress events are emitted by the apply/command path in
//! `commands::pages::markdown`, not by parsing), so keeping the trait +
//! `impl … for UiChannel` here avoids giving the framework-free
//! `agaric-engine` crate a `tauri` dependency.

use agaric_engine::import::ImportProgressUpdate;

/// Sink for [`ImportProgressUpdate`] events, decoupling the import command
/// from Tauri so tests can capture the emitted stream without an
/// `AppHandle` (mirrors `sync_events::SyncEventSink`).
///
/// Implemented for `UiChannel<R, ImportProgressUpdate>` (the
/// production path) and for a test recorder. Sends are best-effort: a
/// failed send (e.g. the frontend dropped the channel) is swallowed — a
/// dead progress channel must never abort an otherwise-valid import.
pub trait ImportProgressSink: Send + Sync {
    fn emit(&self, update: ImportProgressUpdate);
}

impl<R: tauri::Runtime> ImportProgressSink
    for crate::main_thread::UiChannel<R, ImportProgressUpdate>
{
    fn emit(&self, update: ImportProgressUpdate) {
        self.send(update);
    }
}
