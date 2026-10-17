//! Settings → Agent access: list, create and revoke the MCP agents on this
//! device (#5667). The rows live in `mcp_agents` ([`crate::mcp::agents`]).

use sqlx::SqlitePool;
use tauri::State;
use tracing::instrument;

use super::sanitize_internal_error;
use crate::db::{ReadPool, WritePool};
use crate::mcp::agents::{self, MAX_AGENT_NAME_LEN, McpAgent, McpAgentMode};
use agaric_core::error::{AppError, ValidationCode};
use agaric_store::space::SpaceId;

/// Every agent on this device, by name. Not paginated: the user creates
/// agents one at a time, by hand.
#[instrument(skip(pool), err)]
pub async fn list_mcp_agents_inner(pool: &SqlitePool) -> Result<Vec<McpAgent>, AppError> {
    agents::list_agents(pool).await
}

/// Create an agent and return it with its token. `space_ids: None` grants
/// every space, including spaces created later.
///
/// # Errors
///
/// `Validation` coded [`ValidationCode::InvalidAgentName`] for a name that is
/// blank after trimming, holds a control character or is longer than
/// [`MAX_AGENT_NAME_LEN`]; [`ValidationCode::DuplicateAgentName`] for a name
/// another agent holds in any letter case; uncoded `Validation` for an empty
/// space list or one naming a space that is not live.
#[instrument(skip(pool), err)]
pub async fn create_mcp_agent_inner(
    pool: &SqlitePool,
    name: String,
    mode: McpAgentMode,
    space_ids: Option<Vec<SpaceId>>,
) -> Result<McpAgent, AppError> {
    let name = valid_agent_name(&name)?;
    let space_ids: Option<Vec<String>> =
        space_ids.map(|ids| ids.into_iter().map(SpaceId::into_string).collect());
    if let Some(ids) = &space_ids {
        if ids.is_empty() {
            return Err(AppError::validation(
                "an agent needs at least one space, or every space".into(),
            ));
        }
        // Checked before the insert, outside a transaction: a space deleted
        // in between leaves an id that matches nothing, which grants nothing.
        if let Some(dead) = agents::first_dead_space(pool, ids).await? {
            return Err(AppError::validation(format!("space {dead} does not exist")));
        }
    }
    agents::insert_agent(pool, name, mode, space_ids)
        .await?
        .ok_or_else(|| {
            AppError::validation_coded(
                ValidationCode::DuplicateAgentName,
                format!("an agent named '{name}' already exists"),
            )
        })
}

/// The name `raw` stands for once trimmed, unless it is blank, holds a
/// control character, or is longer than [`MAX_AGENT_NAME_LEN`] chars.
fn valid_agent_name(raw: &str) -> Result<&str, AppError> {
    let name = raw.trim();
    let reason = if name.is_empty() {
        "an agent needs a name".to_owned()
    } else if name.chars().any(char::is_control) {
        "an agent name cannot hold a control character".to_owned()
    } else if name.chars().count() > MAX_AGENT_NAME_LEN {
        format!("an agent name is at most {MAX_AGENT_NAME_LEN} characters")
    } else {
        return Ok(name);
    };
    Err(AppError::validation_coded(
        ValidationCode::InvalidAgentName,
        reason,
    ))
}

/// Revoke the agent `id` by deleting it. `NotFound` when there is none.
#[instrument(skip(pool), err)]
pub async fn revoke_mcp_agent_inner(pool: &SqlitePool, id: String) -> Result<(), AppError> {
    if agents::delete_agent(pool, &id).await? {
        Ok(())
    } else {
        Err(AppError::NotFound(format!("mcp agent {id}")))
    }
}

/// Tauri command: every MCP agent on this device. Delegates to
/// [`list_mcp_agents_inner`].
#[tauri::command]
#[specta::specta]
pub async fn list_mcp_agents(pool: State<'_, ReadPool>) -> Result<Vec<McpAgent>, AppError> {
    list_mcp_agents_inner(&pool.0)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: create an MCP agent. Delegates to
/// [`create_mcp_agent_inner`].
#[tauri::command]
#[specta::specta]
pub async fn create_mcp_agent(
    pool: State<'_, WritePool>,
    name: String,
    mode: McpAgentMode,
    space_ids: Option<Vec<SpaceId>>,
) -> Result<McpAgent, AppError> {
    create_mcp_agent_inner(&pool.0, name, mode, space_ids)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: revoke an MCP agent. Delegates to
/// [`revoke_mcp_agent_inner`].
#[tauri::command]
#[specta::specta]
pub async fn revoke_mcp_agent(pool: State<'_, WritePool>, id: String) -> Result<(), AppError> {
    revoke_mcp_agent_inner(&pool.0, id)
        .await
        .map_err(sanitize_internal_error)
}
