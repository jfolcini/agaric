//! The `mcp_agents` table (#5667, migration 0125): the agents Settings →
//! Agent access manages. Each has a name, a mode, the spaces it may use and
//! the token its `agaric-mcp` bridge presents. Device-local: no op is
//! appended, so nothing syncs or exports a row.

use rand::RngExt;
use serde::{Deserialize, Serialize};
use specta::Type;
use sqlx::SqlitePool;

use agaric_core::error::AppError;

/// The longest agent name, in chars. The name is stamped into the
/// append-only `op_log.origin` as `agent:<name>`, so it stays short.
pub const MAX_AGENT_NAME_LEN: usize = 128;

/// What an agent may do: read, or read and write.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum McpAgentMode {
    ReadOnly,
    ReadWrite,
}

impl McpAgentMode {
    fn as_db(self) -> &'static str {
        match self {
            Self::ReadOnly => "read_only",
            Self::ReadWrite => "read_write",
        }
    }

    fn from_db(value: &str) -> Result<Self, AppError> {
        match value {
            "read_only" => Ok(Self::ReadOnly),
            "read_write" => Ok(Self::ReadWrite),
            other => Err(AppError::Internal(format!("mcp_agents.mode {other:?}"))),
        }
    }
}

/// One `mcp_agents` row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct McpAgent {
    pub id: String,
    pub name: String,
    pub mode: McpAgentMode,
    /// `None`: every space, including spaces created later.
    pub space_ids: Option<Vec<String>>,
    /// `agt_` and 32 hex digits, passed to the bridge as `--token`.
    pub token: String,
    pub created_at_ms: i64,
    /// `None` until the agent's first tool call.
    pub last_used_ms: Option<i64>,
}

/// Every agent, by name.
pub async fn list_agents(pool: &SqlitePool) -> Result<Vec<McpAgent>, AppError> {
    let rows = sqlx::query!(
        r#"SELECT id AS "id!: String", name AS "name!: String", mode AS "mode!: String",
                  space_ids, token AS "token!: String",
                  created_at_ms AS "created_at_ms!: i64", last_used_ms
             FROM mcp_agents
            ORDER BY name, id"#,
    )
    .fetch_all(pool)
    .await?;
    rows.into_iter()
        .map(|row| {
            Ok(McpAgent {
                id: row.id,
                name: row.name,
                mode: McpAgentMode::from_db(&row.mode)?,
                space_ids: row
                    .space_ids
                    .as_deref()
                    .map(serde_json::from_str)
                    .transpose()?,
                token: row.token,
                created_at_ms: row.created_at_ms,
                last_used_ms: row.last_used_ms,
            })
        })
        .collect()
}

/// The first of `space_ids` that is not a live space, if any.
pub async fn first_dead_space(
    pool: &SqlitePool,
    space_ids: &[String],
) -> Result<Option<String>, AppError> {
    let ids = serde_json::to_string(space_ids)?;
    let live: Vec<String> = sqlx::query_scalar!(
        r#"SELECT s.id AS "id!: String"
             FROM spaces s
             JOIN blocks b ON b.id = s.id AND b.deleted_at IS NULL
            WHERE s.id IN (SELECT value FROM json_each(?))"#,
        ids,
    )
    .fetch_all(pool)
    .await?;
    Ok(space_ids.iter().find(|id| !live.contains(id)).cloned())
}

/// Insert an agent with a fresh id and token. `None` when another agent
/// already holds the name in any letter case.
pub async fn insert_agent(
    pool: &SqlitePool,
    name: &str,
    mode: McpAgentMode,
    space_ids: Option<Vec<String>>,
) -> Result<Option<McpAgent>, AppError> {
    let agent = McpAgent {
        id: ulid::Ulid::generate().to_string(),
        name: name.to_owned(),
        mode,
        space_ids,
        token: format!("agt_{:032x}", rand::rng().random::<u128>()),
        created_at_ms: crate::db::now_ms(),
        last_used_ms: None,
    };
    let space_ids = agent
        .space_ids
        .as_ref()
        .map(serde_json::to_string)
        .transpose()?;
    let mode = agent.mode.as_db();
    let inserted = sqlx::query!(
        "INSERT INTO mcp_agents (id, name, mode, space_ids, token, created_at_ms) \
         VALUES (?, ?, ?, ?, ?, ?) \
         ON CONFLICT(name) DO NOTHING",
        agent.id,
        agent.name,
        mode,
        space_ids,
        agent.token,
        agent.created_at_ms,
    )
    .execute(pool)
    .await?
    .rows_affected();
    Ok((inserted == 1).then_some(agent))
}

/// Delete the agent `id`. `false` when there is none.
pub async fn delete_agent(pool: &SqlitePool, id: &str) -> Result<bool, AppError> {
    let deleted = sqlx::query!("DELETE FROM mcp_agents WHERE id = ?", id)
        .execute(pool)
        .await?
        .rows_affected();
    Ok(deleted == 1)
}
