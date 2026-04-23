//! Task-local capture of the most recent op appended inside a scoped block.
//!
//! Set by `op_log::append_local_op_in_tx` (via `try_with`, silent no-op
//! outside the scope). Read by the MCP dispatch layer in `server.rs` to
//! attach an `OpRef` to the emitted `mcp:activity` entry for FEAT-4h
//! slice 3 (per-entry Undo).
//!
//! Why not thread `OpRecord`/`OpRef` through every `*_inner` signature?
//! Those functions have 800+ call sites. The task-local is strictly
//! additive, scoped, and invisible outside the MCP dispatch path.

use std::cell::Cell;

use crate::op::OpRef;

tokio::task_local! {
    pub static LAST_APPEND: Cell<Option<OpRef>>;
}

/// Record the `(device_id, seq)` of a just-appended op if a capture scope
/// is active. Silent no-op when called outside any scope — this is the
/// intended behaviour for frontend user writes that have no activity
/// emission surface.
pub fn record_append(op_ref: OpRef) {
    let _ = LAST_APPEND.try_with(|c| c.set(Some(op_ref)));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[tokio::test]
    async fn record_append_outside_scope_is_silent_noop() {
        // No scope active — must not panic and must leave no observable
        // state behind.
        record_append(OpRef {
            device_id: "ignored".to_string(),
            seq: 1,
        });
        // Still no scope — and `try_with` outside the scope is the
        // "outside" path we rely on for frontend writes.
        assert!(LAST_APPEND.try_with(|_| ()).is_err());
    }

    #[tokio::test]
    async fn record_append_inside_scope_sets_cell() {
        let op_ref = OpRef {
            device_id: "dev-A".to_string(),
            seq: 7,
        };

        let got = LAST_APPEND
            .scope(Cell::new(None), async {
                record_append(op_ref.clone());
                LAST_APPEND.with(|c| c.take())
            })
            .await;

        assert_eq!(
            got.as_ref(),
            Some(&op_ref),
            "record_append must store the OpRef inside the scope"
        );
    }

    #[tokio::test]
    async fn record_append_only_retains_last() {
        let first = OpRef {
            device_id: "dev-A".to_string(),
            seq: 1,
        };
        let second = OpRef {
            device_id: "dev-A".to_string(),
            seq: 2,
        };

        let got = LAST_APPEND
            .scope(Cell::new(None), async {
                record_append(first.clone());
                record_append(second.clone());
                LAST_APPEND.with(|c| c.take())
            })
            .await;

        assert_eq!(
            got.as_ref(),
            Some(&second),
            "second record_append must overwrite the first",
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn scope_is_per_task() {
        // Two sibling tasks each with their own scope — one sets, one
        // reads — must not leak into each other.
        let writer = tokio::spawn(async {
            LAST_APPEND
                .scope(Cell::new(None), async {
                    record_append(OpRef {
                        device_id: "writer".to_string(),
                        seq: 99,
                    });
                    // Writer reads back its own value.
                    LAST_APPEND.with(|c| c.take())
                })
                .await
        });

        let reader = tokio::spawn(async {
            LAST_APPEND
                .scope(Cell::new(None), async {
                    // Reader never writes — must see None.
                    LAST_APPEND.with(|c| c.take())
                })
                .await
        });

        let writer_got = writer.await.unwrap();
        let reader_got = reader.await.unwrap();

        assert_eq!(
            writer_got,
            Some(OpRef {
                device_id: "writer".to_string(),
                seq: 99,
            }),
            "writer task must see its own recorded OpRef",
        );
        assert_eq!(
            reader_got, None,
            "reader task must not see the writer's OpRef — scopes are per-task",
        );
    }
}
