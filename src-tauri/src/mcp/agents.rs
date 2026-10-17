//! The `mcp_agents` table (#5667, migration 0125): the agents Settings →
//! Agent access manages, and the gate every MCP connection and tool call
//! passes. Each agent has a name, a mode, the spaces it may use and the
//! token its `agaric-mcp` bridge presents. Device-local: no op is
//! appended, so nothing syncs or exports a row.

use rand::RngExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use sqlx::SqlitePool;

use super::handler_utils::normalize_ulid_arg;
use agaric_core::error::AppError;

/// The longest agent name, in chars. The name is stamped into the
/// append-only `op_log.origin` as `agent:<name>`, so it stays short.
pub const MAX_AGENT_NAME_LEN: usize = 128;

/// How old `last_used_ms` gets before a tool call stamps it again, so a
/// burst of calls costs one write, not one each.
pub const LAST_USED_RESOLUTION_MS: i64 = 60_000;

/// The tool arguments that name a space the call reads or writes. An
/// argument that names a space must join this list, or an agent reaches any
/// space through it.
pub const SPACE_ARGS: [&str; 2] = ["space_id", "target_space_id"];

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

impl McpAgent {
    /// Refuses a call whose [`SPACE_ARGS`] name a space this agent may not
    /// use. Ids compare as the tools read them, uppercased.
    pub fn check_spaces(&self, args: &Value) -> Result<(), AppError> {
        let Some(allowed) = &self.space_ids else {
            return Ok(());
        };
        for arg in SPACE_ARGS {
            if let Some(Value::String(raw)) = args.get(arg) {
                let id = normalize_ulid_arg(raw);
                if !allowed.contains(&id) {
                    return Err(AppError::validation(format!(
                        "agent '{}' may not use space {id}; list_spaces lists the spaces it may use",
                        self.name
                    )));
                }
            }
        }
        Ok(())
    }

    /// Drops the rows of a `list_spaces` result this agent may not use.
    pub fn retain_spaces(&self, spaces: &mut Value) {
        if let (Some(allowed), Value::Array(rows)) = (&self.space_ids, spaces) {
            rows.retain(|row| {
                row.get("id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| allowed.iter().any(|space| space == id))
            });
        }
    }
}

struct AgentRow {
    id: String,
    name: String,
    mode: String,
    space_ids: Option<String>,
    token: String,
    created_at_ms: i64,
    last_used_ms: Option<i64>,
}

impl TryFrom<AgentRow> for McpAgent {
    type Error = AppError;

    fn try_from(row: AgentRow) -> Result<Self, AppError> {
        Ok(Self {
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
    }
}

/// Every agent, by name.
pub async fn list_agents(pool: &SqlitePool) -> Result<Vec<McpAgent>, AppError> {
    sqlx::query_as!(
        AgentRow,
        r#"SELECT id AS "id!: String", name AS "name!: String", mode AS "mode!: String",
                  space_ids, token AS "token!: String",
                  created_at_ms AS "created_at_ms!: i64", last_used_ms
             FROM mcp_agents
            ORDER BY name, id"#,
    )
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(McpAgent::try_from)
    .collect()
}

async fn agent_by_token(pool: &SqlitePool, token: &str) -> Result<Option<McpAgent>, AppError> {
    sqlx::query_as!(
        AgentRow,
        r#"SELECT id AS "id!: String", name AS "name!: String", mode AS "mode!: String",
                  space_ids, token AS "token!: String",
                  created_at_ms AS "created_at_ms!: i64", last_used_ms
             FROM mcp_agents
            WHERE token = ?"#,
        token,
    )
    .fetch_optional(pool)
    .await?
    .map(McpAgent::try_from)
    .transpose()
}

async fn agent_by_id(pool: &SqlitePool, id: &str) -> Result<Option<McpAgent>, AppError> {
    sqlx::query_as!(
        AgentRow,
        r#"SELECT id AS "id!: String", name AS "name!: String", mode AS "mode!: String",
                  space_ids, token AS "token!: String",
                  created_at_ms AS "created_at_ms!: i64", last_used_ms
             FROM mcp_agents
            WHERE id = ?"#,
        id,
    )
    .fetch_optional(pool)
    .await?
    .map(McpAgent::try_from)
    .transpose()
}

/// Stamps `agent`'s `last_used_ms` with `now_ms` unless the stamp it
/// holds is younger than [`LAST_USED_RESOLUTION_MS`].
async fn stamp_last_used(pool: &SqlitePool, agent: &McpAgent, now_ms: i64) -> Result<(), AppError> {
    if agent
        .last_used_ms
        .is_some_and(|used| now_ms - used < LAST_USED_RESOLUTION_MS)
    {
        return Ok(());
    }
    sqlx::query!(
        "UPDATE mcp_agents SET last_used_ms = ? WHERE id = ?",
        now_ms,
        agent.id,
    )
    .execute(pool)
    .await?;
    Ok(())
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

/// Where the MCP server finds agents: tokens and ids are read on the reader
/// pool, `last_used_ms` is written on the writer pool.
#[derive(Clone)]
pub struct AgentStore {
    reads: SqlitePool,
    writes: SqlitePool,
}

impl AgentStore {
    pub fn new(reads: SqlitePool, writes: SqlitePool) -> Self {
        Self { reads, writes }
    }

    /// The agent holding `token`, for a connection to serve as. `None` when
    /// no agent holds it.
    pub async fn connect(&self, token: &str) -> Result<Option<ConnectedAgent>, AppError> {
        Ok(agent_by_token(&self.reads, token)
            .await?
            .map(|agent| ConnectedAgent {
                store: self.clone(),
                id: agent.id,
                name: agent.name,
                mode: agent.mode,
            }))
    }
}

/// The agent whose token a connection presented. The mode is fixed for the
/// connection; everything else is read again on every call.
#[derive(Clone)]
pub struct ConnectedAgent {
    store: AgentStore,
    id: String,
    /// The name at connect, for the refusal once the agent is revoked.
    pub name: String,
    pub mode: McpAgentMode,
}

impl ConnectedAgent {
    /// The agent as it stands now, when it may make a call with `args`.
    /// Read on every call, so a revoke takes effect on the next one; stamps
    /// `last_used_ms`.
    pub async fn authorize(&self, args: &Value) -> Result<McpAgent, AppError> {
        let agent = agent_by_id(&self.store.reads, &self.id)
            .await?
            .ok_or_else(|| {
                AppError::NotFound(format!(
                    "agent '{}' was revoked; add an agent in Settings → Agent access",
                    self.name
                ))
            })?;
        agent.check_spaces(args)?;
        if let Err(err) = stamp_last_used(&self.store.writes, &agent, crate::db::now_ms()).await {
            // The stamp only feeds Settings' "last used"; the call goes on.
            tracing::warn!(target: "mcp", agent_id = %agent.id, error = %err, "could not stamp the agent's last use");
        }
        Ok(agent)
    }
}

#[cfg(test)]
mod tests;
