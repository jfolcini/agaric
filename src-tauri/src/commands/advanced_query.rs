//! #1280 — the `run_advanced_query` Tauri command.
//!
//! Thin IPC wrapper over [`crate::query::compile_and_run`]: it takes an
//! [`AdvancedQueryRequest`] (a [`crate::filters::FilterExpr`] boolean tree +
//! sort + cursor + limit), runs it on the READ pool, and returns a
//! cursor-paginated [`AdvancedQueryResponse`].
//!
//! Structural-only: no full-text, grouping, or aggregation — those are
//! fast-follows (see `crate::query` module docs).

use tauri::State;

use crate::db::ReadPool;
use crate::error::AppError;
use crate::query::{AdvancedQueryRequest, AdvancedQueryResponse, compile_and_run};

use super::sanitize_internal_error;

/// Tauri command: run a composable advanced query over the structural filter
/// dimensions and return a cursor-paginated page of blocks.
#[tauri::command]
#[specta::specta]
pub async fn run_advanced_query(
    pool: State<'_, ReadPool>,
    request: AdvancedQueryRequest,
) -> Result<AdvancedQueryResponse, AppError> {
    compile_and_run(&pool.0, request)
        .await
        .map_err(sanitize_internal_error)
}
