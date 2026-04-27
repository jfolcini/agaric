//! Shared dispatch helpers for [`ToolRegistry::call_tool`] impls.
//!
//! Both [`super::tools_ro`] and [`super::tools_rw`] share the same
//! call_tool shape:
//!
//! ```text
//! 1. Clone any state the dispatch needs (pool, materializer, …).
//! 2. Wrap the dispatch closure in `ACTOR.scope(...)` so downstream
//!    handlers see the per-request `ActorContext` via the task-local.
//! 3. Match on the tool name; unknown names fall through to
//!    `AppError::NotFound`.
//! ```
//!
//! This module factors out (2) and (3) so each registry impl focuses on
//! (1) + the per-tool match arms — eliminating the
//! `let scoped = ctx.clone();` / `let name = name.to_string();` /
//! `ACTOR.scope(...)` boilerplate that was duplicated between the RO
//! and RW impls.
//!
//! [`ToolRegistry::call_tool`]: super::registry::ToolRegistry::call_tool

use std::future::Future;

use serde_json::Value;

use super::actor::{ActorContext, ACTOR};
use crate::error::AppError;

/// Wrap an async dispatch closure in `ACTOR.scope(...)` so downstream
/// command handlers see the per-request actor via the
/// [`super::actor::ACTOR`] task-local without receiving it as a
/// parameter. Used by every `ToolRegistry::call_tool` impl.
///
/// The closure receives an owned `String` produced by the helper,
/// removing the per-impl `name.to_string()` boilerplate. Returning a
/// `+ 'static` future is forced by the [`super::registry::ToolRegistry`]
/// trait contract — the registry is held behind an `Arc` and the
/// returned future may be driven across a `tokio::spawn` boundary, so
/// the closure (and any state it captures) must own its data.
///
/// MAINT-150 (h).
pub(crate) fn scoped_dispatch<F, Fut>(
    ctx: &ActorContext,
    name: &str,
    handler: F,
) -> impl Future<Output = Result<Value, AppError>> + Send + 'static
where
    F: FnOnce(String) -> Fut + Send + 'static,
    Fut: Future<Output = Result<Value, AppError>> + Send + 'static,
{
    let scoped = ctx.clone();
    let owned_name = name.to_string();
    async move { ACTOR.scope(scoped, handler(owned_name)).await }
}

/// Standard "unknown tool name" error returned by every registry's
/// match-arm fallthrough. Routed by the server to JSON-RPC `-32001`
/// (resource-not-found) via [`super::server::app_error_to_jsonrpc`] so
/// agents can distinguish "unknown tool" from "unknown JSON-RPC method
/// endpoint" (which is `-32601`).
pub(crate) fn unknown_tool_error(name: &str) -> AppError {
    AppError::NotFound(format!("unknown tool `{name}`"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::actor::{current_actor, Actor};
    use serde_json::json;

    fn test_ctx() -> ActorContext {
        ActorContext {
            actor: Actor::Agent {
                name: "test-agent".to_string(),
            },
            request_id: "req-dispatch".to_string(),
        }
    }

    #[tokio::test]
    async fn scoped_dispatch_runs_handler_inside_actor_scope() {
        let ctx = test_ctx();
        let result = scoped_dispatch(&ctx, "any_tool", |name| async move {
            // Inside the helper's scope: the actor is observable via
            // the task-local, exactly as a `*_inner` handler would see
            // it.
            let actor = current_actor();
            let agent = match actor {
                Actor::Agent { name } => name,
                Actor::User => "<user>".to_string(),
            };
            Ok(json!({ "tool": name, "agent": agent }))
        })
        .await
        .unwrap();
        assert_eq!(result["tool"], "any_tool");
        assert_eq!(result["agent"], "test-agent");
    }

    #[tokio::test]
    async fn scoped_dispatch_owns_the_tool_name() {
        // The handler receives an owned `String` — confirms the
        // helper's `name.to_string()` is what the callee binds, not a
        // borrow into the caller's local.
        let ctx = test_ctx();
        let observed = scoped_dispatch(&ctx, "list_pages", |name: String| async move {
            // This `move` captures `name: String` by value — would not
            // compile if the helper handed out a `&str`.
            Ok(Value::String(name))
        })
        .await
        .unwrap();
        assert_eq!(observed, Value::String("list_pages".to_string()));
    }

    #[tokio::test]
    async fn scoped_dispatch_propagates_handler_error() {
        let ctx = test_ctx();
        let err = scoped_dispatch(&ctx, "boom", |_| async move {
            Err(AppError::Validation("nope".into()))
        })
        .await
        .expect_err("handler error must surface");
        assert!(matches!(err, AppError::Validation(msg) if msg == "nope"));
    }

    #[test]
    fn unknown_tool_error_carries_the_requested_name() {
        let err = unknown_tool_error("does_not_exist");
        match err {
            AppError::NotFound(msg) => {
                assert!(
                    msg.contains("does_not_exist"),
                    "error must echo the requested tool name; got {msg:?}",
                );
            }
            other => panic!("expected NotFound, got {other:?}"),
        }
    }
}
