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
//! Resolves.

use serde_json::Value;
use sqlx::SqlitePool;

use agaric_core::error::AppError;
use agaric_core::ulid::BlockId;
use agaric_store::space::SpaceId;

/// Decode a tool's arguments, mapping a bad shape to
/// [`AppError::Validation`] (`-32602 invalid params`) with serde's message,
/// which names the unknown or missing field. Decoding from a `Value` leaves
/// serde_json no input position, so the message carries no line or column.
pub(crate) fn parse_args<T: serde::de::DeserializeOwned>(
    tool: &str,
    args: Value,
) -> Result<T, AppError> {
    serde_json::from_value::<T>(args)
        .map_err(|e| AppError::validation(format!("tool `{tool}`: invalid arguments: {e}")))
}

/// Normalise a ULID-shaped argument string to uppercase Crockford
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
///   [`agaric_core::ulid::BlockId::from_trusted`]'s `to_ascii_uppercase()`).
/// - Anything else (wrong length, non-base32 charset, empty) passes
///   through unchanged so the downstream `*_inner` validation still
///   produces the right error message.
///
/// Prefer a strict parse for a new `*_id` argument — `BlockId::from_string`
/// or `SpaceId::from_string`, which uppercase the same way and then reject
/// what this helper waves through. A waved-through id binds a string that
/// matches nothing; where the query answers with an empty list instead of
/// `NotFound`, an agent reads that as an answer and does not retry (#3301).
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

/// What an id-or-name argument names when it is a name (#5397).
#[derive(Debug, Clone, Copy)]
pub(crate) enum Named {
    /// A page, by title or alias.
    Page,
    /// A tag, by name.
    Tag,
}

/// Each of `args` as an id (#5397): one that parses as a ULID is that id, as it
/// always was; any other names a page or tag in `space_id`, matched as a
/// pasted `[[Name]]` or `#name` is. A name that ties or matches nothing is a
/// Validation error naming `field` and the candidates.
pub(crate) async fn resolve_id_args(
    pool: &SqlitePool,
    tool: &str,
    field: &str,
    args: &[String],
    named: Named,
    space_id: &str,
) -> Result<Vec<String>, AppError> {
    use crate::commands::pages::markdown::{NameMatch, match_page_names, match_tag_names};
    let names: Vec<String> = args
        .iter()
        .filter(|arg| BlockId::from_string(arg.as_str()).is_err())
        .cloned()
        .collect();
    let mut matches = Vec::new();
    if !names.is_empty() {
        let space_id = SpaceId::from_string(space_id)?;
        let mut conn = pool.acquire().await?;
        matches = match named {
            Named::Page => match_page_names(&mut conn, space_id.as_str(), &names).await?,
            Named::Tag => match_tag_names(&mut conn, space_id.as_str(), &names).await?,
        };
    }
    let mut matches = names.iter().zip(matches);
    args.iter()
        .map(|arg| {
            if let Ok(id) = BlockId::from_string(arg.as_str()) {
                return Ok(id.into_string());
            }
            let (name, found) = matches.next().expect("one match per name");
            match found {
                NameMatch::Id(id) => Ok(id),
                NameMatch::Tie(pages) => {
                    let listed: Vec<String> = pages
                        .iter()
                        .map(|(id, title)| format!("{id} ({title})"))
                        .collect();
                    Err(AppError::validation(format!(
                        "tool `{tool}`: `{field}` '{name}' matches more than one page in space \
                         '{space_id}': {}; pass the id",
                        listed.join(", "),
                    )))
                }
                NameMatch::Unknown => {
                    let what = match named {
                        Named::Page => "page has that title or alias",
                        Named::Tag => "tag has that name",
                    };
                    Err(AppError::validation(format!(
                        "tool `{tool}`: `{field}` '{name}' is not a ULID, and no {what} in \
                         space '{space_id}'"
                    )))
                }
            }
        })
        .collect()
}

/// [`resolve_id_args`] for one argument.
pub(crate) async fn resolve_id_arg(
    pool: &SqlitePool,
    tool: &str,
    field: &str,
    arg: &str,
    named: Named,
    space_id: &str,
) -> Result<String, AppError> {
    let mut ids = resolve_id_args(pool, tool, field, &[arg.to_owned()], named, space_id).await?;
    Ok(ids.remove(0))
}

/// Validate that `block_id`'s owning page lives in
/// `space_id`, rejecting a target in another space at the MCP boundary.
///
/// The owning page is `b.id` if `b` is itself a page block (where
/// `page_id` is set to `id` by `create_block_in_tx`), else `b.page_id`
/// (an inherited reference to the page block at the top of the parent
/// chain). The page's space comes from the page block's own
/// `blocks.space_id` column (Phase 2, #533).
///
/// A read checks on the reader pool; a write checks inside its own
/// transaction (#5402): a single-op tool through [`with_space_guard`], and
/// `batch` per op on the batch's connection.
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
///   IPC tightening).
pub(crate) async fn validate_block_in_space<'e, E>(
    executor: E,
    block_id: &str,
    space_id: &str,
) -> Result<(), AppError>
where
    E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
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
    .fetch_optional(executor)
    .await?;

    match row {
        // Block doesn't exist — defer to the downstream `*_inner` to
        // surface NotFound with a tool-specific message.
        None => Ok(()),
        // Block exists but its owning page has a NULL `space_id` (or it
        // has no owning page) — either a tag block (global, no owning
        // page) or a corrupted page. Refuse: a space-scoped write cannot
        // be authorised against an unscoped target.
        Some(None) => Err(AppError::validation(format!(
            "block '{block_id}' does not belong to any space"
        ))),
        Some(Some(found)) if found == space_id => Ok(()),
        Some(Some(found)) => Err(AppError::validation(format!(
            "block '{block_id}' belongs to space '{found}', not '{space_id}'"
        ))),
    }
}

/// The blocks a write tool targets and the space they must be in (#5402).
struct SpaceGuard {
    space_id: String,
    block_ids: Vec<String>,
}

tokio::task_local! {
    /// Set by [`with_space_guard`]; read by [`check_space_guard`].
    static SPACE_GUARD: SpaceGuard;
}

/// Run `write` so that every `CommandTx` it opens refuses, inside that
/// transaction, a block of `block_ids` whose owning page is not in `space_id`
/// ([`validate_block_in_space`]). The check and the write then share one
/// `BEGIN IMMEDIATE`, so no other write lands between them (#5402).
pub(crate) fn with_space_guard<F: std::future::Future>(
    space_id: &str,
    block_ids: Vec<String>,
    write: F,
) -> impl std::future::Future<Output = F::Output> {
    let guard = SpaceGuard {
        space_id: space_id.to_owned(),
        block_ids,
    };
    // Boxed: the `*_inner` write futures are large (`clippy::large_futures`).
    Box::pin(SPACE_GUARD.scope(guard, write))
}

/// The [`with_space_guard`] check, on the connection of the transaction
/// `CommandTx::begin_immediate` just opened. Outside the guard it checks
/// nothing.
pub(crate) async fn check_space_guard(conn: &mut sqlx::SqliteConnection) -> Result<(), AppError> {
    let Ok((space_id, block_ids)) =
        SPACE_GUARD.try_with(|guard| (guard.space_id.clone(), guard.block_ids.clone()))
    else {
        return Ok(());
    };
    for block_id in &block_ids {
        validate_block_in_space(&mut *conn, block_id, &space_id).await?;
    }
    Ok(())
}

/// Who wrote one op, and the block it targets.
pub(crate) struct OpOrigin {
    pub device_id: String,
    pub seq: i64,
    pub origin: String,
    pub block_id: Option<String>,
}

/// Look up the `op_log.origin` of each ref, in one query: the history
/// readers' rows do not carry it, and `undo` must refuse an op that is not
/// the caller's. A ref with no op_log row is absent from the result.
pub(crate) async fn fetch_op_origins(
    pool: &SqlitePool,
    refs: &[agaric_store::op::OpRef],
) -> Result<Vec<OpOrigin>, AppError> {
    let refs_json = serde_json::to_string(refs)?;
    let rows = sqlx::query_as!(
        OpOrigin,
        r#"SELECT ol.device_id AS "device_id!", ol.seq AS "seq!", ol.origin AS "origin!",
                  ol.block_id
           FROM json_each(?) AS j
           JOIN op_log ol
             ON ol.device_id = json_extract(j.value, '$.device_id')
            AND ol.seq = json_extract(j.value, '$.seq')"#,
        refs_json,
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Serialise a typed handler response into the [`serde_json::Value`] that
/// the JSON-RPC dispatcher expects on the wire.
///
/// Preserves the original `?`-on-`serde_json::Error` semantics from the
/// Pre- handlers: a serialisation failure converts to
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

/// A journal tool's `date` (#5396): `"today"` (also when omitted),
/// `"yesterday"` or `YYYY-MM-DD`, read against `today`, the device's local
/// date, which the caller passes so a test can fix it.
pub(crate) fn resolve_journal_date(
    tool: &str,
    date: Option<&str>,
    today: chrono::NaiveDate,
) -> Result<chrono::NaiveDate, AppError> {
    match date.unwrap_or("today") {
        "today" => Ok(today),
        "yesterday" => today
            .pred_opt()
            .ok_or_else(|| AppError::validation(format!("tool `{tool}`: no day before {today}"))),
        other => chrono::NaiveDate::parse_from_str(other, "%Y-%m-%d").map_err(|e| {
            AppError::validation(format!(
                "tool `{tool}`: `date` must be `today`, `yesterday` or YYYY-MM-DD, got \
                 '{other}' — {e}"
            ))
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use serde_json::json;

    #[derive(Debug, Deserialize)]
    struct Probe {
        required: String,
    }

    #[test]
    fn journal_date_resolves_against_the_given_day_5396() {
        let day = |s: &str| chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap();
        // The clock's date before and after a midnight that is also a year
        // and a leap-day boundary.
        let before_midnight = day("2024-12-31");
        let after_midnight = day("2025-01-01");
        assert_eq!(
            resolve_journal_date("t", None, before_midnight).unwrap(),
            before_midnight
        );
        assert_eq!(
            resolve_journal_date("t", Some("today"), after_midnight).unwrap(),
            after_midnight
        );
        assert_eq!(
            resolve_journal_date("t", Some("yesterday"), after_midnight).unwrap(),
            before_midnight
        );
        assert_eq!(
            resolve_journal_date("t", Some("yesterday"), day("2024-03-01")).unwrap(),
            day("2024-02-29")
        );
        assert_eq!(
            resolve_journal_date("t", Some("2023-07-04"), after_midnight).unwrap(),
            day("2023-07-04")
        );
        for bad in ["Today", "2025-13-01", "tomorrow", ""] {
            let err = resolve_journal_date("t", Some(bad), after_midnight).unwrap_err();
            assert!(
                matches!(err, AppError::Validation { .. }),
                "{bad:?} must be refused as Validation, got {err:?}"
            );
        }
    }

    #[derive(Debug, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Strict {
        #[expect(dead_code, reason = "only the decode outcome is asserted")]
        space_id: String,
    }

    fn validation_message(err: AppError) -> String {
        match err {
            AppError::Validation { message, .. } => message,
            _ => panic!("expected Validation, got {err:?}"),
        }
    }

    #[test]
    fn parse_args_error_names_the_misspelt_field() {
        let msg = validation_message(
            parse_args::<Strict>("test_tool", json!({"spaceId": "X"})).unwrap_err(),
        );
        assert_eq!(
            msg,
            "tool `test_tool`: invalid arguments: unknown field `spaceId`, expected `space_id`"
        );
    }

    #[test]
    fn parse_args_error_names_the_missing_field() {
        let msg = validation_message(parse_args::<Probe>("test_tool", json!({})).unwrap_err());
        assert_eq!(
            msg,
            "tool `test_tool`: invalid arguments: missing field `required`"
        );
    }

    #[test]
    fn parse_args_type_mismatch_says_what_was_expected() {
        let msg = validation_message(
            parse_args::<Probe>("test_tool", json!({"required": 42})).unwrap_err(),
        );
        assert_eq!(
            msg,
            "tool `test_tool`: invalid arguments: invalid type: integer `42`, expected a string"
        );
    }

    #[test]
    fn parse_args_happy_path_returns_value() {
        let probe: Probe = parse_args::<Probe>("test_tool", json!({"required": "hello"})).unwrap();
        assert_eq!(probe.required, "hello");
    }

    // ---------------------------------------------------------------
    // Normalize_ulid_arg
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
    // #1666 / validate_block_in_space three-state guard.
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
            AppError::Validation { message: msg, .. } => assert!(
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
            AppError::Validation { message: msg, .. } => assert!(
                msg.contains(&space_b) && msg.contains(&space_a),
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

    /// #5402: a write's space check runs inside the transaction the write
    /// opens, and a refusal there releases the writer lock with it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn space_guard_refuses_inside_the_write_transaction_5402() {
        use crate::db::CommandTx;

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
        let block_id = "01HTEST0000000000000GVARDA";
        insert_content_block(&pool, block_id, Some(&space_b)).await;

        let refused = with_space_guard(
            &space_a,
            vec![block_id.to_owned()],
            CommandTx::begin_immediate(&pool, "test_space_guard"),
        )
        .await;
        let Err(err) = refused else {
            panic!("a block of another space must be refused when the transaction opens");
        };
        assert!(
            matches!(&err, AppError::Validation { message, .. } if message.contains(&space_b)),
            "got {err:?}"
        );

        let allowed = with_space_guard(
            &space_b,
            vec![block_id.to_owned()],
            CommandTx::begin_immediate(&pool, "test_space_guard"),
        )
        .await
        .expect("a block of the guard's space is allowed, and the refusal released the writer");
        allowed.rollback().await.unwrap();
    }
}
