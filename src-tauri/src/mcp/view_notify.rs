//! #2505 — the change-notification seam for MCP read-write tools.
//!
//! An MCP RW tool commits a write in SQL + the Loro engine and (pre-#2505)
//! emitted only `mcp:activity` — nothing told an open page to reload. This
//! module supplies the trait-object seam the RW handlers use to emit the two
//! events that DO drive open views, without pulling Tauri's runtime generics
//! into [`super::tools_rw`]:
//!
//! - [`EVENT_BLOCKS_CHANGED`] (`blocks:changed`) — a page-keyed content-change
//!   signal whose `changed_page_ids` payload is byte-identical to
//!   [`SyncEvent::Complete`](agaric_sync::sync_events::SyncEvent::Complete)'s #1071 field, so the frontend reuses the same
//!   `forEachPageStore` targeted-reload path with no new vocabulary.
//! - [`EVENT_PROPERTY_CHANGED`] (`block:properties-changed`) — the SAME event
//!   local `set_property` already emits (`emit_property_changed_event`,
//!   `commands/properties.rs`), with the SAME `{ block_id, changed_keys }`
//!   payload, so the property-change dispatcher needs no changes.
//!
//! The abstraction mirrors [`super::activity::ActivityEmitter`]: production
//! wraps a [`tauri::AppHandle`] in [`TauriViewChangeEmitter`]; the headless /
//! stub path uses [`NoopViewChangeEmitter`]; tests use
//! `RecordingViewChangeEmitter` (`#[cfg(test)]`, so not linkable). Emission is infallible from the caller's
//! perspective — a transient bus failure is logged via `tracing::warn!` but
//! never propagated, so a missing frontend never blocks tool dispatch.

use std::sync::Arc;

use agaric_sync::sync_events::{
    BlocksChangedEvent, EVENT_BLOCKS_CHANGED, EVENT_PROPERTY_CHANGED, PropertyChangedEvent,
};

/// Trait-object seam between the MCP RW tool handlers and the Tauri event bus.
///
/// Implementations MUST be infallible from the caller's perspective (log,
/// never propagate). Both methods take owned `Vec`/`String`s because the
/// caller has just resolved them and has no further use for the values.
pub trait ViewChangeEmitter: Send + Sync {
    /// Emit [`EVENT_BLOCKS_CHANGED`] with the resolved owning-page id set.
    fn emit_blocks_changed(&self, changed_page_ids: Vec<String>);

    /// Emit [`EVENT_PROPERTY_CHANGED`] with the same `{ block_id, changed_keys }`
    /// payload local property writes emit.
    fn emit_property_changed(&self, block_id: String, changed_keys: Vec<String>);
}

/// Blanket impl so `Arc<T>` / `Arc<dyn ViewChangeEmitter>` both satisfy the
/// trait — keeps `ReadWriteTools`'s call sites ergonomic.
impl<T: ViewChangeEmitter + ?Sized> ViewChangeEmitter for Arc<T> {
    fn emit_blocks_changed(&self, changed_page_ids: Vec<String>) {
        (**self).emit_blocks_changed(changed_page_ids);
    }
    fn emit_property_changed(&self, block_id: String, changed_keys: Vec<String>) {
        (**self).emit_property_changed(block_id, changed_keys);
    }
}

/// Drop-in emitter that discards every event. Used by the headless
/// `agaric-mcp` stub binary and any test / diagnostic path that constructs a
/// `ReadWriteTools` without a Tauri runtime.
#[derive(Debug, Default, Clone, Copy)]
pub struct NoopViewChangeEmitter;

impl ViewChangeEmitter for NoopViewChangeEmitter {
    fn emit_blocks_changed(&self, _changed_page_ids: Vec<String>) {}
    fn emit_property_changed(&self, _block_id: String, _changed_keys: Vec<String>) {}
}

/// Production emitter — forwards each event to the Tauri event bus. Emission
/// failures are logged at `warn` level but never propagate.
pub struct TauriViewChangeEmitter<R: tauri::Runtime> {
    handle: tauri::AppHandle<R>,
}

impl<R: tauri::Runtime> TauriViewChangeEmitter<R> {
    /// Wrap a cloned `AppHandle` to emit `blocks:changed` /
    /// `block:properties-changed` events.
    pub fn new(handle: tauri::AppHandle<R>) -> Self {
        Self { handle }
    }
}

impl<R: tauri::Runtime> std::fmt::Debug for TauriViewChangeEmitter<R> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TauriViewChangeEmitter").finish()
    }
}

impl<R: tauri::Runtime> ViewChangeEmitter for TauriViewChangeEmitter<R> {
    fn emit_blocks_changed(&self, changed_page_ids: Vec<String>) {
        crate::main_thread::emit(
            &self.handle,
            EVENT_BLOCKS_CHANGED,
            BlocksChangedEvent { changed_page_ids },
        );
    }

    fn emit_property_changed(&self, block_id: String, changed_keys: Vec<String>) {
        crate::main_thread::emit(
            &self.handle,
            EVENT_PROPERTY_CHANGED,
            PropertyChangedEvent {
                block_id,
                changed_keys,
            },
        );
    }
}

/// Test-only recording emitter. Captures every emitted event so the RW tool
/// tests can assert payload parity with the local-write path.
#[cfg(test)]
#[derive(Debug, Default)]
pub struct RecordingViewChangeEmitter {
    /// Every `blocks:changed` emission, in order — one `Vec<String>` per call.
    pub blocks_changed: std::sync::Mutex<Vec<Vec<String>>>,
    /// Every `block:properties-changed` emission, in order — `(block_id, changed_keys)`.
    pub property_changed: std::sync::Mutex<Vec<(String, Vec<String>)>>,
}

#[cfg(test)]
impl RecordingViewChangeEmitter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Snapshot of every `blocks:changed` payload emitted so far.
    pub fn blocks_changed(&self) -> Vec<Vec<String>> {
        self.blocks_changed
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// Snapshot of every `block:properties-changed` payload emitted so far.
    pub fn property_changed(&self) -> Vec<(String, Vec<String>)> {
        self.property_changed
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }
}

#[cfg(test)]
impl ViewChangeEmitter for RecordingViewChangeEmitter {
    fn emit_blocks_changed(&self, changed_page_ids: Vec<String>) {
        self.blocks_changed
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(changed_page_ids);
    }
    fn emit_property_changed(&self, block_id: String, changed_keys: Vec<String>) {
        self.property_changed
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push((block_id, changed_keys));
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use agaric_sync::sync_events::EVENT_BLOCKS_CHANGED;
    use tauri::Listener;

    use super::{TauriViewChangeEmitter, ViewChangeEmitter};

    /// An MCP write emits from a tokio worker. Off the main thread, Tauri's
    /// `emit` holds its webview lock while waiting for the main thread to run
    /// the event's JS, and deadlocks against any IPC request the main thread
    /// is resolving.
    #[test]
    fn blocks_changed_from_a_worker_thread_is_emitted_on_the_main_thread() {
        let (app, main_thread) = crate::main_thread::test_support::running_mock_app();
        let (tx, rx) = std::sync::mpsc::channel();
        app.listen(EVENT_BLOCKS_CHANGED, move |_| {
            let _ = tx.send(std::thread::current().id());
        });
        let emitter = TauriViewChangeEmitter::new(app.clone());

        std::thread::spawn(move || emitter.emit_blocks_changed(vec!["PAGE".into()]))
            .join()
            .expect("emitting thread panicked");

        let emitted_on = rx
            .recv_timeout(Duration::from_secs(10))
            .expect("blocks:changed was never emitted");
        assert_eq!(emitted_on, main_thread);
    }
}
