use std::sync::Arc;

use async_trait::async_trait;

use crate::error::AppError;
use crate::loro::shared::LoroState;
use crate::ulid::BlockId;

/// #2621 (agaric-sync inversion): the narrow apply/materialize surface the sync
/// layer needs from the app-side `Materializer` coordinator, expressed as a
/// trait so the sync modules depend DOWN on this abstraction instead of UP on
/// the concrete `Materializer` (which itself depends down on sync).
#[async_trait]
pub trait ApplyHost: Send + Sync + std::fmt::Debug {
    /// The per-space Loro registry the session syncs against.
    fn loro_state(&self) -> Arc<LoroState>;
    /// Fan out the debounced inbound-sync cache rebuilds for the changed /
    /// purged blocks of an inbound import.
    async fn enqueue_inbound_sync_rebuilds(
        &self,
        changed_blocks: &[BlockId],
        purged_blocks: &[BlockId],
    ) -> Result<(), AppError>;
    /// Enqueue the fixed full-vault cache-rebuild task set after a snapshot
    /// restore replaces vault state wholesale.
    async fn enqueue_post_snapshot_rebuilds(&self) -> Result<(), AppError>;
    /// Await both foreground and background materialize queues draining.
    async fn flush(&self) -> Result<(), AppError>;
}
