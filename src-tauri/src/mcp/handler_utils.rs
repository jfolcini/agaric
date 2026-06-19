//! Shared MCP tool-handler ceremony.
//!
//! Both [`crate::mcp::tools_ro`] and [`crate::mcp::tools_rw`] open every
//! handler with the same two-step pattern:
//!
//! 1. Decode the JSON-RPC `params` blob into a typed `*Args` struct,
//!    converting `serde_json` decode failures into a JSON-RPC
//!    `-32602 invalid params` (i.e., [`AppError::Validation`] with the
//!    tool name embedded).
//! 2. After the inner business logic returns, re-encode the typed
//!    response struct into a [`serde_json::Value`] for the wire.
//!
//! Centralising both helpers here keeps the RO and RW surfaces in
//! lock-step — there is no risk of drift between two byte-identical
//! `parse_args` copies (the previous setup), and every handler ends
//! with a uniform `to_tool_result(&resp)` call instead of an ad-hoc
//! `Ok(serde_json::to_value(resp)?)` line.
//!
//! Both helpers are `pub(crate)` so only the MCP module tree can import
//! them — they have no meaning outside the JSON-RPC dispatch path.
//!
//! Resolves MAINT-135.

use serde_json::Value;
use sqlx::SqlitePool;

use crate::error::AppError;

/// Convert a serde-json deserialization error into an
/// [`AppError::Validation`] with the tool name embedded. Used for every
/// handler's arg parse so bad input maps to `-32602 invalid params` at
/// the JSON-RPC layer.
///
/// L-123: the user-facing message is a short structured category derived
/// from [`serde_json::error::Category`] (e.g. "data shape mismatch") rather
/// than the verbatim `serde_json::Error::Display`. The latter embeds
/// line/column hints that point into the MCP wire JSON — meaningless to
/// the agent / human reading the activity feed. The verbose serde output
/// is still preserved on a `tracing::debug!` line for daily-log debugging.
pub(crate) fn parse_args<T: serde::de::DeserializeOwned>(
    tool: &str,
    args: Value,
) -> Result<T, AppError> {
    serde_json::from_value::<T>(args).map_err(|e| {
        // `serde_json::error::Category` has exactly four variants in
        // serde_json 1.0 — the match below is exhaustive without a
        // fallback arm so any future variant is a compile error.
        let category = match e.classify() {
            serde_json::error::Category::Data => "data shape mismatch",
            serde_json::error::Category::Syntax => "json syntax",
            serde_json::error::Category::Eof => "json truncated",
            serde_json::error::Category::Io => "json io",
        };
        tracing::debug!(tool, error = %e, "MCP parse_args failed");
        AppError::Validation(format!("tool `{tool}`: invalid arguments ({category})"))
    })
}

/// L-121: normalise a ULID-shaped argument string to uppercase Crockford
/// base32 at the MCP boundary.
///
/// AGENTS.md invariant #8 says ULIDs are uppercase Crockford base32 for
/// blake3-hash determinism. The MCP tool argument structs accept
/// `block_id` / `parent_id` / `tag_id` / `value_ref` / `page_id` as
/// plain `String` and forward them verbatim to the `*_inner` helpers;
/// SQLite's default `=` is case-sensitive, so a lowercase ULID returns
/// `NotFound`. Today every Agaric tool returns uppercase ULIDs so a
/// round-trip "from-our-output, into-our-input" never trips this — the
/// hazard is an agent that copies a ULID from a third-party log or
/// manipulates case.
///
/// Behaviour:
///
/// - Length-26 ASCII-base32 inputs are uppercased (mirrors
///   [`crate::ulid::BlockId::from_trusted`]'s `to_ascii_uppercase()`).
/// - Anything else (wrong length, non-base32 charset, empty) passes
///   through unchanged so the downstream `*_inner` validation still
///   produces the right error message.
///
/// Apply to every `*_id` field in the typed-arg structs of
/// [`tools_ro`](super::tools_ro) and [`tools_rw`](super::tools_rw)
/// AFTER `parse_args` and BEFORE the inner call.
pub(crate) fn normalize_ulid_arg(s: &str) -> String {
    // Crockford base32 alphabet (no I/L/O/U) — but accepting all base32
    // ASCII-alpha+digit here is fine: any stricter check would just
    // pass non-ULID strings through anyway, and the inner functions
    // already reject malformed IDs with `AppError::Validation`.
    if s.len() == 26 && s.chars().all(|c| c.is_ascii_alphanumeric()) {
        s.to_ascii_uppercase()
    } else {
        s.to_owned()
    }
}

/// PEND-24 C2 — validate that `block_id`'s owning page lives in
/// `space_id`, rejecting cross-space writes at the MCP boundary.
///
/// The owning page is `b.id` if `b` is itself a page block (where
/// `page_id` is set to `id` by `create_block_in_tx`), else `b.page_id`
/// (an inherited reference to the page block at the top of the parent
/// chain). The page's space comes from the page block's own
/// `blocks.space_id` column (Phase 2, #533).
///
/// # Returns
///
/// - `Ok(())` if the block does not exist (lets the downstream
///   `*_inner` surface [`AppError::NotFound`] with a tool-specific
///   message — duplicating the error here would just add a second
///   variant to the agent-visible error chain), or if the owning
///   page's space matches `space_id`.
/// - [`AppError::Validation`] if the owning page exists in a different
///   space, or has a NULL `space_id` / no owning page at all (e.g. the
///   caller passed a tag block ID, or a corrupted page that escaped the
///   BUG-1 / H-3a IPC tightening).
pub(crate) async fn validate_block_in_space(
    pool: &SqlitePool,
    block_id: &str,
    space_id: &str,
) -> Result<(), AppError> {
    // #1666: the compile-time-checked `query_scalar!` macro is used so a
    // future `blocks.space_id` / `blocks.page_id` schema change breaks
    // the build here rather than silently altering this security guard.
    // The three-state distinction the LEFT JOIN needs — no row vs.
    // row-with-NULL vs. row-with-value — is preserved by combining the
    // explicit-nullable column annotation (`"space?"` → `Option<String>`
    // for the COALESCE) with `.fetch_optional` (→ `Option<_>` for the
    // missing-row case), yielding `Option<Option<String>>`. The bound is
    // one-row, indexed (the PK on `blocks.id` for both the input lookup
    // and the page self-join), no scan.
    let row: Option<Option<String>> = sqlx::query_scalar!(
        // #533: prefer the block's own `space_id`, falling back to its
        // (live) owning page — mirrors `resolve_block_space` exactly,
        // including the `pg.deleted_at IS NULL` guard so a soft-deleted
        // owning page doesn't authorize a write via its retained space.
        // The `"space?"` alias forces sqlx to type the COALESCE as
        // nullable, so a row-with-NULL stays distinguishable from a
        // row-with-value.
        r#"SELECT COALESCE(b.space_id, pg.space_id) AS "space?"
           FROM blocks b
           LEFT JOIN blocks pg
             ON pg.id = b.page_id AND pg.deleted_at IS NULL
           WHERE b.id = ?"#,
        block_id,
    )
    .fetch_optional(pool)
    .await?;

    match row {
        // Block doesn't exist — defer to the downstream `*_inner` to
        // surface NotFound with a tool-specific message.
        None => Ok(()),
        // Block exists but its owning page has a NULL `space_id` (or it
        // has no owning page) — either a tag block (global, no owning
        // page) or a corrupted page. Refuse: a space-scoped write cannot
        // be authorised against an unscoped target.
        Some(None) => Err(AppError::Validation(format!(
            "block '{block_id}' does not belong to any space; \
             cross-space writes are denied"
        ))),
        Some(Some(found)) if found == space_id => Ok(()),
        Some(Some(found)) => Err(AppError::Validation(format!(
            "block '{block_id}' belongs to space '{found}'; \
             cross-space write to space '{space_id}' is denied"
        ))),
    }
}

/// Serialise a typed handler response into the [`serde_json::Value`] that
/// the JSON-RPC dispatcher expects on the wire.
///
/// Preserves the original `?`-on-`serde_json::Error` semantics from the
/// pre-MAINT-135 handlers: a serialisation failure converts to
/// [`AppError::Json`] via the `#[from] serde_json::Error` impl, which the
/// dispatcher in `server.rs` then maps to a JSON-RPC internal error. In
/// practice this branch is unreachable for the typed `*Resp` structs the
/// handlers return — every field is a primitive, `String`, `Vec`, or a
/// nested `Serialize` struct with no custom `Serialize` impl that could
/// fail — but the conversion is kept honest so future response shapes
/// cannot regress silently.
pub(crate) fn to_tool_result<T: serde::Serialize>(value: &T) -> Result<Value, AppError> {
    Ok(serde_json::to_value(value)?)
}

#[cfg(test)]
mod tests {
    //! L-123: pin the user-facing `parse_args` error message format so
    //! the activity feed stays short and structured. The verbose
    //! `serde_json::Error::Display` (with line/column hints into the MCP
    //! wire JSON) must NOT leak into `AppError::Validation`.
    use super::*;
    use serde::Deserialize;
    use serde_json::json;

    #[derive(Debug, Deserialize)]
    struct Probe {
        required: String,
    }

    #[test]
    fn parse_args_missing_required_field_emits_data_shape_message() {
        let err = parse_args::<Probe>("test_tool", json!({})).unwrap_err();
        match err {
            AppError::Validation(msg) => {
                assert!(
                    msg.contains("test_tool"),
                    "message must include tool name: {msg}"
                );
                assert!(
                    msg.contains("data shape mismatch"),
                    "missing-field is Category::Data: {msg}"
                );
                assert!(
                    !msg.contains("line"),
                    "L-123: must NOT include serde_json line/column: {msg}"
                );
                assert!(
                    !msg.contains("column"),
                    "L-123: must NOT include serde_json line/column: {msg}"
                );
            }
            _ => panic!("expected Validation, got {err:?}"),
        }
    }

    #[test]
    fn parse_args_type_mismatch_emits_data_shape_message() {
        // `42` is a number, but `Probe.required` is `String` —
        // serde_json classifies this as `Category::Data`.
        let err = parse_args::<Probe>("test_tool", json!({"required": 42})).unwrap_err();
        match err {
            AppError::Validation(msg) => {
                assert!(msg.contains("test_tool"));
                assert!(msg.contains("data shape mismatch"));
            }
            _ => panic!("expected Validation, got {err:?}"),
        }
    }

    #[test]
    fn parse_args_happy_path_returns_value() {
        let probe: Probe = parse_args::<Probe>("test_tool", json!({"required": "hello"})).unwrap();
        assert_eq!(probe.required, "hello");
    }

    // ---------------------------------------------------------------
    // L-121: normalize_ulid_arg
    // ---------------------------------------------------------------

    #[test]
    fn normalize_ulid_arg_uppercases_ulid_shaped() {
        // 26-char Crockford-base32-alpha ULID (lowercase): must uppercase.
        let lower = "01htest0000000000000000abc";
        let upper = "01HTEST0000000000000000ABC";
        assert_eq!(normalize_ulid_arg(lower), upper);
        // Already-uppercase round-trip: no change.
        assert_eq!(normalize_ulid_arg(upper), upper);
    }

    #[test]
    fn normalize_ulid_arg_passes_through_non_ulid() {
        // Wrong length — must pass through unchanged so downstream
        // inner-validation still fires with the right error.
        assert_eq!(normalize_ulid_arg("abc"), "abc");
        assert_eq!(normalize_ulid_arg(""), "");
        // 26 chars but contains non-alphanumeric (hyphen) — pass through.
        let with_hyphen = "01htest-0000000000000abc-x";
        assert_eq!(with_hyphen.len(), 26);
        assert_eq!(normalize_ulid_arg(with_hyphen), with_hyphen);
    }

    #[test]
    fn normalize_ulid_arg_handles_mixed_case() {
        let mixed = "01HtEsT0000000000000000aBc";
        let upper = "01HTEST0000000000000000ABC";
        assert_eq!(normalize_ulid_arg(mixed), upper);
    }

    // ---------------------------------------------------------------
    // #1666 / PEND-24 C2: validate_block_in_space three-state guard.
    //
    // The cross-space guard distinguishes three states off a single
    // LEFT JOIN: no row (defer to downstream NotFound), row with a
    // NULL resolved space (reject — unscoped target), and row with a
    // concrete space (allow iff it matches, else reject). The full
    // tool-level different-space coverage lives in
    // `crate::mcp::tools_rw::tests`; these unit tests pin the helper
    // directly, including the NULL-space rejection arm that the
    // compile-time-checked query must keep distinguishable from a
    // matching space.
    // ---------------------------------------------------------------

    use crate::commands::create_space_inner;
    use crate::db::init_pool;
    use crate::materializer::Materializer;

    /// Insert a bare content block via direct SQL with an explicit
    /// (possibly NULL) `space_id` and no owning page, so the guard's
    /// `COALESCE(b.space_id, pg.space_id)` resolves to exactly that
    /// value. Returns the block id.
    async fn insert_content_block(pool: &sqlx::SqlitePool, id: &str, space_id: Option<&str>) {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, space_id) \
             VALUES (?, 'content', 'x', ?)",
        )
        .bind(id)
        .bind(space_id)
        .execute(pool)
        .await
        .expect("seed block insert must succeed");
    }

    /// A target block whose resolved space is NULL (no own space, no
    /// owning page) must be REJECTED: a space-scoped write cannot be
    /// authorised against an unscoped target.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn null_space_block_is_rejected() {
        let dir = tempfile::TempDir::new().unwrap();
        let pool = init_pool(&dir.path().join("test.db")).await.unwrap();
        let space = create_space_inner(
            &pool,
            "test-handler-utils-dev",
            &Materializer::new(pool.clone()),
            "guard space".into(),
            None,
        )
        .await
        .unwrap()
        .into_string();

        // 26-char ULID-shaped id; space_id NULL, no page_id → COALESCE NULL.
        let block_id = "01HTEST00000000000000NULLAA";
        insert_content_block(&pool, block_id, None).await;

        let err = validate_block_in_space(&pool, block_id, &space)
            .await
            .expect_err("NULL-space target must be denied");
        match err {
            AppError::Validation(msg) => assert!(
                msg.contains("does not belong to any space"),
                "NULL-space rejection message: {msg}"
            ),
            _ => panic!("expected Validation for NULL-space block, got {err:?}"),
        }
    }

    /// A target block owned by a *different* space must be REJECTED.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn different_space_block_is_rejected() {
        let dir = tempfile::TempDir::new().unwrap();
        let pool = init_pool(&dir.path().join("test.db")).await.unwrap();
        let mat = Materializer::new(pool.clone());
        let space_a = create_space_inner(&pool, "d", &mat, "A".into(), None)
            .await
            .unwrap()
            .into_string();
        let space_b = create_space_inner(&pool, "d", &mat, "B".into(), None)
            .await
            .unwrap()
            .into_string();

        let block_id = "01HTEST0000000000000DIFFAA";
        insert_content_block(&pool, block_id, Some(&space_b)).await;

        let err = validate_block_in_space(&pool, block_id, &space_a)
            .await
            .expect_err("cross-space target must be denied");
        match err {
            AppError::Validation(msg) => assert!(
                msg.contains(&space_b) && msg.contains("denied"),
                "different-space rejection message: {msg}"
            ),
            _ => panic!("expected Validation for different-space block, got {err:?}"),
        }
    }

    /// A target block in the *same* space must be ALLOWED.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn same_space_block_is_allowed() {
        let dir = tempfile::TempDir::new().unwrap();
        let pool = init_pool(&dir.path().join("test.db")).await.unwrap();
        let space = create_space_inner(
            &pool,
            "d",
            &Materializer::new(pool.clone()),
            "S".into(),
            None,
        )
        .await
        .unwrap()
        .into_string();

        let block_id = "01HTEST0000000000000SAMEAA";
        insert_content_block(&pool, block_id, Some(&space)).await;

        validate_block_in_space(&pool, block_id, &space)
            .await
            .expect("same-space write must be allowed");
    }

    /// A non-existent block defers to the downstream `*_inner` (Ok),
    /// rather than producing a guard-level error.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn missing_block_is_allowed_to_defer() {
        let dir = tempfile::TempDir::new().unwrap();
        let pool = init_pool(&dir.path().join("test.db")).await.unwrap();
        let space = create_space_inner(
            &pool,
            "d",
            &Materializer::new(pool.clone()),
            "S".into(),
            None,
        )
        .await
        .unwrap()
        .into_string();

        validate_block_in_space(&pool, "01HTEST0000000000000MISSAA", &space)
            .await
            .expect("missing block must defer (Ok) to downstream NotFound");
    }
}
