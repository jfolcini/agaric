//! #6545 — the task that turns the materializer's
//! [`ChangeFeed`](crate::materializer::ChangeFeed) into `blocks:changed`
//! events: one for the local commits recorded since the last, sent once the
//! background queue has settled, so a view that refetches on it reads caches
//! those commits have already rebuilt.
//!
//! A commit recorded while the queue settles joins the same event, after one
//! more settle for its own rebuilds. No test holds a commit inside a settle,
//! so that second settle is pinned only at
//! [`ChangeFeed::take_if_quiet`](crate::materializer::ChangeFeed::take_if_quiet).

use agaric_core::ulid::BlockId;
use agaric_sync::sync_events::{BlocksChangedEvent, EVENT_BLOCKS_CHANGED};
use agaric_sync::sync_protocol::loro_sync::resolve_changed_page_ids;
use sqlx::SqlitePool;

use crate::materializer::{Materializer, PendingChanges};

/// [`run`] on the app's runtime, emitting each event to `app`'s listeners.
pub fn spawn<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    pool: SqlitePool,
    materializer: Materializer,
) -> tauri::async_runtime::JoinHandle<()> {
    let app = app.clone();
    tauri::async_runtime::spawn(run(pool, materializer, move |event| {
        crate::main_thread::emit(&app, EVENT_BLOCKS_CHANGED, event);
    }))
}

/// Hand `emit` one event per burst of local commits, for the life of the app.
pub async fn run(
    pool: SqlitePool,
    materializer: Materializer,
    emit: impl Fn(BlocksChangedEvent) + Send,
) {
    loop {
        materializer.change_feed().changed().await;
        let Some(pending) = take_settled(&materializer).await else {
            continue;
        };
        // The wake a commit left behind when an earlier event already took it.
        if pending.is_empty() {
            continue;
        }
        let block_ids: Vec<BlockId> = pending
            .block_ids
            .iter()
            .map(|id| BlockId::from_trusted(id.as_str()))
            .collect();
        // Without the pages the domains still say what to refetch.
        let changed_page_ids = resolve_changed_page_ids(&pool, &block_ids)
            .await
            .unwrap_or_else(|error| {
                tracing::warn!(%error, "change feed could not resolve the changed pages");
                Vec::new()
            });
        emit(BlocksChangedEvent {
            changed_page_ids,
            local_ops_appended: true,
            domains: Some(pending.domains.into_iter().collect()),
            local_command: true,
        });
    }
}

/// What is pending once the background queue has run every pending commit's
/// rebuilds, tasks a full queue shed included.
///
/// `None` while a lifecycle rebuild waits in its debounce, whose fire wakes
/// the feed again (a settle would force it). `None` also when the queue
/// cannot settle: at shutdown, or when the retry queue cannot be read. No
/// rebuild can be vouched for then, so nothing is taken, and what is pending
/// goes out with the next commit's event.
async fn take_settled(materializer: &Materializer) -> Option<PendingChanges> {
    let feed = materializer.change_feed();
    loop {
        if materializer.lifecycle_rebuild_armed() {
            return None;
        }
        let seen = feed.writes();
        if let Err(error) = materializer.settle_background().await {
            tracing::warn!(%error, "change feed could not settle the background queue");
            return None;
        }
        if let Some(pending) = feed.take_if_quiet(seen) {
            return Some(pending);
        }
    }
}
