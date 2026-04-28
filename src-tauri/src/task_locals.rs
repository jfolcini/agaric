//! Crate-wide tokio task-locals.
//!
//! This module is the neutral home for task-locals that are populated
//! by core modules (e.g. [`crate::op_log`]) and read by integration
//! modules (e.g. [`crate::mcp`]). Putting them here removes the
//! dependency-direction inversion that the previous home
//! (`crate::mcp::last_append`) introduced — `op_log` is a core
//! abstraction and `mcp` is an integration on top, so the task-local
//! it populates must not live inside `mcp`.
//!
//! ## Currently-defined task-locals
//!
//! - [`LAST_APPEND`] — populated by
//!   [`crate::op_log::append_local_op_in_tx`] with the freshly-inserted
//!   `(device_id, seq)` of every just-appended op, when a scope is
//!   active. Read by `crate::mcp::server::handle_tools_call` so the
//!   emitted `mcp:activity` entry can carry the produced `OpRef`s for
//!   FEAT-4h slice 3 (per-entry Undo).
//!
//! ## Why a `Vec`, not an `Option`?
//!
//! L-114: every RW tool today emits exactly one op, but a future
//! multi-op tool (e.g. `move_subtree`, `bulk_set_property`) will append
//! several ops in one call. Storing only the *last* `OpRef` would
//! silently drop the earlier appends and make Undo partial. The
//! task-local therefore retains *every* `OpRef` recorded inside the
//! scope, in append order. The dispatch layer surfaces the first one
//! on `ActivityEntry.op_ref` (preserving the existing wire shape) and
//! parks the remainder on `additional_op_refs`.
//!
//! ## Why a task-local, not a function parameter?
//!
//! `append_local_op_in_tx` has 800+ call sites. Threading an
//! `Option<&Cell<Option<OpRef>>>` through every `*_inner` signature
//! would be invasive churn for a feature that only the MCP dispatch
//! layer cares about. The task-local is strictly additive, scoped, and
//! invisible outside the MCP dispatch path — every call from outside
//! `mcp::server` is a silent no-op via `try_with`.

use std::cell::RefCell;

use crate::op::OpRef;

tokio::task_local! {
    /// Task-local capture of every op appended inside a scoped block,
    /// in append order.
    ///
    /// Set by [`crate::op_log::append_local_op_in_tx`] (via
    /// [`record_append`], silent no-op outside the scope). Read by the
    /// MCP dispatch layer in `mcp::server` (via [`take_appends`]) to
    /// attach `OpRef`s to the emitted `mcp:activity` entry for FEAT-4h
    /// slice 3 (per-entry Undo).
    pub static LAST_APPEND: RefCell<Vec<OpRef>>;
}

/// Record the `(device_id, seq)` of a just-appended op if a capture
/// scope is active. Silent no-op when called outside any scope — this
/// is the intended behaviour for frontend user writes that have no
/// activity emission surface.
///
/// L-114: appends accumulate in order; multi-op tools therefore retain
/// every `OpRef` they produced, not just the last.
pub fn record_append(op_ref: OpRef) {
    let _ = LAST_APPEND.try_with(|c| c.borrow_mut().push(op_ref));
}

/// Drain and return every `OpRef` recorded inside the active capture
/// scope, in append order. Returns an empty `Vec` when called outside
/// a scope or when no appends have been recorded — never panics, never
/// returns `None`.
///
/// Used by `crate::mcp::server::handle_tools_call` to harvest the
/// produced ops at the end of a tool call. Calling this inside a scope
/// leaves the storage empty, so a follow-up call returns `vec![]`.
pub fn take_appends() -> Vec<OpRef> {
    LAST_APPEND
        .try_with(|c| std::mem::take(&mut *c.borrow_mut()))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

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
        // The public helper must also be safe outside a scope and
        // surface "nothing recorded" as an empty Vec (not None / not
        // a panic) so multi-op consumers can branch on `.is_empty()`.
        assert!(take_appends().is_empty());
    }

    #[tokio::test]
    async fn record_append_inside_scope_pushes_to_vec() {
        let op_ref = OpRef {
            device_id: "dev-A".to_string(),
            seq: 7,
        };

        let got = LAST_APPEND
            .scope(RefCell::new(Vec::new()), async {
                record_append(op_ref.clone());
                take_appends()
            })
            .await;

        assert_eq!(
            got,
            vec![op_ref],
            "record_append must push the OpRef into the task-local Vec",
        );
    }

    /// L-114: every recorded `OpRef` must be retained, in append
    /// order — multi-op tools rely on this so a future
    /// `move_subtree` / `bulk_set_property` can surface every produced
    /// op for Undo. The previous behaviour (overwrite-last) silently
    /// dropped earlier appends.
    #[tokio::test]
    async fn record_append_retains_all_in_order() {
        let first = OpRef {
            device_id: "dev-A".to_string(),
            seq: 1,
        };
        let second = OpRef {
            device_id: "dev-A".to_string(),
            seq: 2,
        };
        let third = OpRef {
            device_id: "dev-A".to_string(),
            seq: 3,
        };

        let got = LAST_APPEND
            .scope(RefCell::new(Vec::new()), async {
                record_append(first.clone());
                record_append(second.clone());
                record_append(third.clone());
                take_appends()
            })
            .await;

        assert_eq!(
            got,
            vec![first, second, third],
            "all record_append calls must be retained in append order",
        );
    }

    /// `take_appends` must drain — a second call inside the same
    /// scope sees the storage empty. Pins the contract that the
    /// dispatch layer can rely on a single-take semantics.
    #[tokio::test]
    async fn take_appends_drains_storage() {
        let op_ref = OpRef {
            device_id: "dev-A".to_string(),
            seq: 1,
        };

        let (first_take, second_take) = LAST_APPEND
            .scope(RefCell::new(Vec::new()), async {
                record_append(op_ref.clone());
                let first = take_appends();
                let second = take_appends();
                (first, second)
            })
            .await;

        assert_eq!(first_take, vec![op_ref]);
        assert!(
            second_take.is_empty(),
            "second take inside the same scope must observe empty storage, got {second_take:?}",
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn scope_is_per_task() {
        // Two sibling tasks each with their own scope — one sets, one
        // reads — must not leak into each other.
        let writer = tokio::spawn(async {
            LAST_APPEND
                .scope(RefCell::new(Vec::new()), async {
                    record_append(OpRef {
                        device_id: "writer".to_string(),
                        seq: 99,
                    });
                    // Writer reads back its own value.
                    take_appends()
                })
                .await
        });

        let reader = tokio::spawn(async {
            LAST_APPEND
                .scope(RefCell::new(Vec::new()), async {
                    // Reader never writes — must see an empty Vec.
                    take_appends()
                })
                .await
        });

        let writer_got = writer.await.unwrap();
        let reader_got = reader.await.unwrap();

        assert_eq!(
            writer_got,
            vec![OpRef {
                device_id: "writer".to_string(),
                seq: 99,
            }],
            "writer task must see its own recorded OpRef",
        );
        assert!(
            reader_got.is_empty(),
            "reader task must not see the writer's OpRef — scopes are per-task",
        );
    }
}
