//! Actor identity + per-request context for the MCP server.
//!
//! The frontend invokes command handlers directly via Tauri IPC and runs as
//! the implicit [`Actor::User`]. MCP requests, by contrast, originate from an
//! external agent identified by `clientInfo.name` in the `initialize`
//! handshake. The dispatcher wraps each `tools/call` in
//! `ACTOR.scope(ctx, ...)` so downstream code (activity feeds in FEAT-4d,
//! op-log `origin` population in v2 via FEAT-4h) can discover who requested
//! the operation via [`current_actor`] without threading the context through
//! every function signature.
//!
//! # PII hygiene
//!
//! Agent names are self-reported and land in the activity feed (FEAT-4d).
//! The [`Actor`] type therefore uses a **manual** `Debug` impl that logs the
//! discriminant only (`"User"` / `"Agent"`) and suppresses the `name` field.
//! Structured logging callsites that want the name must read it explicitly,
//! not via `{:?}`. `ActorContext` is NOT exported over Tauri IPC and
//! deliberately omits `Serialize` / `Deserialize` / specta derives.

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
    /// (FEAT-4h v2). `Actor::User` → `"user"`, `Actor::Agent { name }`
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
mod tests {
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
    // origin_tag — FEAT-4h slice 1
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
