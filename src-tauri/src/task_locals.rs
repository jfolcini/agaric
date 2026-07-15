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
//!   slice 3 (per-entry Undo).
//!
//! ## Why a `Vec`, not an `Option`?
//!
//! every RW tool today emits exactly one op, but a future
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
    /// Attach `OpRef`s to the emitted `mcp:activity` entry for
    /// slice 3 (per-entry Undo).
    pub static LAST_APPEND: RefCell<Vec<OpRef>>;
}

/// Record the `(device_id, seq)` of a just-appended op if a capture
/// scope is active. Silent no-op when called outside any scope — this
/// is the intended behaviour for frontend user writes that have no
/// activity emission surface.
///
/// Appends accumulate in order; multi-op tools therefore retain
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

    /// Every recorded `OpRef` must be retained, in append
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

// ---------------------------------------------------------------------------
// Actor identity (#2621): moved down from `mcp::actor` so `op_log` reads the
// request actor from this neutral task-local home instead of reaching up into
// the `mcp` integration layer. `mcp::actor` now re-exports these. See this
// module's header for the dependency-direction rationale.
// ---------------------------------------------------------------------------

use std::fmt;

/// Who initiated the current request.
///
/// `Actor::User` is the default returned by [`current_actor`] when no
/// task-local scope is active — this preserves backward compatibility for
/// frontend-invoked commands, which never enter the MCP task.
///
/// `Actor::Agent` carries the self-reported `clientInfo.name` from the MCP
/// handshake. The name is treated as PII-adjacent and kept out of `Debug`
/// output (see the manual `Debug` impl on this enum).
#[derive(Clone)]
pub enum Actor {
    /// Frontend-invoked commands (the implicit default). No additional
    /// information is carried.
    User,
    /// MCP request from an external agent identified by the handshake
    /// `clientInfo.name`. The name is structured-log-only and must not be
    /// embedded in `Debug` output (see module docs).
    Agent {
        /// Self-reported `clientInfo.name` from the MCP handshake. Never
        /// printed via `{:?}`.
        name: String,
    },
}

impl fmt::Debug for Actor {
    /// Log the discriminant only — the `name` field is deliberately
    /// suppressed so `tracing::debug!(actor = ?actor)` cannot accidentally
    /// leak agent names into span attributes. Structured log sites that
    /// need the name must read it explicitly.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Actor::User => f.write_str("User"),
            Actor::Agent { .. } => f.write_str("Agent"),
        }
    }
}

impl Actor {
    /// Render this actor as the string written into `op_log.origin`
    /// (v2). `Actor::User` → `"user"`, `Actor::Agent { name }`
    /// → `"agent:<name>"`.
    ///
    /// Consumed by [`crate::op_log::append_local_op_in_tx`] via
    /// [`current_actor`] + the `ACTOR` task-local. Outside an
    /// [`ACTOR::scope`] the default `current_actor()` returns
    /// `Actor::User`, which yields `"user"` — matching the column
    /// default in migration 0033 so un-wrapped call sites (frontend
    /// commands, sync merges, snapshot/compaction) are observationally
    /// identical whether or not they go through this helper.
    ///
    /// The `"agent:"` prefix is deliberate: it keeps the column
    /// filterable by a simple `LIKE 'agent:%'` query in the activity
    /// feed and reserves the un-prefixed namespace for future
    /// non-agent origins (e.g., `"import"`, `"migration"`) without a
    /// schema change.
    pub fn origin_tag(&self) -> String {
        match self {
            Actor::User => "user".to_string(),
            Actor::Agent { name } => format!("agent:{name}"),
        }
    }
}

/// Per-request context carried through [`ACTOR`] for the lifetime of a
/// single MCP tool call. Constructed at `tools/call` dispatch time in
/// `server.rs` and dropped when the request completes.
///
/// `request_id` is a free-form identifier (ULID, UUID, or any other unique
/// string) used only for structured logging correlation between the
/// `tools/call` entry point and downstream command invocations.
#[derive(Clone)]
pub struct ActorContext {
    /// Who initiated this request.
    pub actor: Actor,
    /// Opaque per-request correlation id for structured logging.
    pub request_id: String,
}

impl fmt::Debug for ActorContext {
    /// Log only the actor discriminant and the (non-PII) request id.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ActorContext")
            .field("actor", &self.actor)
            .field("request_id", &self.request_id)
            .finish()
    }
}

tokio::task_local! {
    /// Task-local holder for the [`ActorContext`] of the currently-running
    /// MCP tool call. Readers use [`current_actor`] (or
    /// `ACTOR.try_with(...)` directly) to discover who initiated the
    /// request. Absent outside the MCP tool-call scope — that absence is
    /// the signal that the caller is the frontend user.
    pub static ACTOR: ActorContext;
}

/// Read the current [`Actor`] from the task-local [`ACTOR`].
///
/// Returns [`Actor::User`] when the task-local is unset — this happens for
/// every frontend-invoked command, as the frontend never enters the MCP
/// tool-call scope. Returning a non-`Option` keeps call sites trivial:
///
/// ```ignore
/// let actor = current_actor();
/// match actor {
///     Actor::User => /* fallthrough */,
///     Actor::Agent { name } => tracing::info!(agent = %name, "…"),
/// }
/// ```
pub fn current_actor() -> Actor {
    ACTOR
        .try_with(|ctx| ctx.actor.clone())
        .unwrap_or(Actor::User)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod actor_tests {
    use super::*;

    #[test]
    fn current_actor_returns_user_by_default() {
        // Outside any task-local scope — the frontend-invoked command path.
        match current_actor() {
            Actor::User => (),
            Actor::Agent { name } => {
                panic!("expected Actor::User outside any scope, got Agent({name:?})");
            }
        }
    }

    #[tokio::test]
    async fn current_actor_returns_agent_inside_scope() {
        let ctx = ActorContext {
            actor: Actor::Agent {
                name: "test-agent".to_string(),
            },
            request_id: "req-1".to_string(),
        };

        let observed = ACTOR
            .scope(ctx, async {
                // Inside the scope `current_actor` must report the Agent.
                current_actor()
            })
            .await;

        match observed {
            Actor::Agent { name } => {
                assert_eq!(name, "test-agent", "agent name round-trips through scope");
            }
            Actor::User => panic!("expected Actor::Agent inside scope, got User"),
        }
    }

    #[tokio::test]
    async fn current_actor_falls_back_to_user_after_scope_ends() {
        let ctx = ActorContext {
            actor: Actor::Agent {
                name: "scoped".to_string(),
            },
            request_id: "req-2".to_string(),
        };

        ACTOR
            .scope(ctx, async {
                // inside — Agent
                assert!(matches!(current_actor(), Actor::Agent { .. }));
            })
            .await;

        // outside — back to User default.
        assert!(matches!(current_actor(), Actor::User));
    }

    #[test]
    fn actor_debug_does_not_leak_name() {
        let leaky = Actor::Agent {
            name: "evil-agent-name-that-must-not-appear-in-logs".to_string(),
        };
        let rendered = format!("{leaky:?}");
        assert!(
            !rendered.contains("evil"),
            "Actor Debug must not embed the agent name; got {rendered:?}",
        );
        assert_eq!(
            rendered, "Agent",
            "Actor::Agent Debug must render exactly 'Agent' (discriminant only)",
        );
    }

    #[test]
    fn actor_user_debug_renders_discriminant_only() {
        assert_eq!(format!("{:?}", Actor::User), "User");
    }

    #[test]
    fn actor_context_debug_does_not_leak_agent_name() {
        let ctx = ActorContext {
            actor: Actor::Agent {
                name: "super-secret-client".to_string(),
            },
            request_id: "req-abc".to_string(),
        };
        let rendered = format!("{ctx:?}");
        assert!(
            !rendered.contains("super-secret-client"),
            "ActorContext Debug must not leak agent name; got {rendered:?}",
        );
        assert!(
            rendered.contains("req-abc"),
            "ActorContext Debug should still include the non-PII request_id; got {rendered:?}",
        );
    }

    #[test]
    fn actor_is_clone() {
        // Compile-time: Actor must be Clone so current_actor() can hand a
        // fresh owned value to each reader.
        let a = Actor::Agent {
            name: "c".to_string(),
        };
        let _b = a.clone();
        let _c = Actor::User.clone();
    }

    // -----------------------------------------------------------------------
    // Origin_tag — slice 1
    // -----------------------------------------------------------------------

    #[test]
    fn origin_tag_user_is_plain_user() {
        assert_eq!(Actor::User.origin_tag(), "user");
    }

    #[test]
    fn origin_tag_agent_has_agent_prefix() {
        let a = Actor::Agent {
            name: "claude-desktop".to_string(),
        };
        assert_eq!(a.origin_tag(), "agent:claude-desktop");
    }

    #[test]
    fn origin_tag_agent_prefix_separates_from_user_namespace() {
        // A pathological agent name matching the user tag must not collide —
        // the `agent:` prefix is the disambiguator.
        let a = Actor::Agent {
            name: "user".to_string(),
        };
        assert_eq!(a.origin_tag(), "agent:user");
        assert_ne!(a.origin_tag(), Actor::User.origin_tag());
    }

    #[test]
    fn origin_tag_preserves_arbitrary_agent_name_chars() {
        // Agent names are self-reported via MCP `clientInfo.name` — we do
        // NOT sanitise them here. Downstream consumers (activity feed
        // render, log scrubbing) are responsible for display escaping.
        let a = Actor::Agent {
            name: "weird:name with spaces/and:colons".to_string(),
        };
        assert_eq!(a.origin_tag(), "agent:weird:name with spaces/and:colons");
    }

    #[tokio::test]
    async fn nested_scopes_override_outer_actor() {
        // Compose two scopes — the inner must shadow the outer cleanly.
        let outer = ActorContext {
            actor: Actor::Agent {
                name: "outer".to_string(),
            },
            request_id: "outer-req".to_string(),
        };
        let inner = ActorContext {
            actor: Actor::Agent {
                name: "inner".to_string(),
            },
            request_id: "inner-req".to_string(),
        };

        let observed = ACTOR
            .scope(outer, async {
                ACTOR
                    .scope(inner, async {
                        match current_actor() {
                            Actor::Agent { name } => name,
                            Actor::User => String::new(),
                        }
                    })
                    .await
            })
            .await;

        assert_eq!(observed, "inner", "inner scope must shadow outer");
    }
}
