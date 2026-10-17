//! #5667 — `list_mcp_agents`, `create_mcp_agent` and `revoke_mcp_agent` over
//! the device-local `mcp_agents` table.

use crate::prelude::*;
use agaric_core::error::ValidationCode;
use agaric_lib::commands::mcp_agents::{
    create_mcp_agent_inner, list_mcp_agents_inner, revoke_mcp_agent_inner,
};
use agaric_lib::mcp::agents::{MAX_AGENT_NAME_LEN, McpAgent, McpAgentMode};
use agaric_store::space::SpaceId;

fn spaces(ids: &[&str]) -> Option<Vec<SpaceId>> {
    Some(ids.iter().map(|id| SpaceId::from_trusted(id)).collect())
}

async fn create(
    pool: &SqlitePool,
    name: &str,
    space_ids: Option<Vec<SpaceId>>,
) -> Result<McpAgent, AppError> {
    create_mcp_agent_inner(pool, name.to_owned(), McpAgentMode::ReadOnly, space_ids).await
}

#[tokio::test]
async fn create_then_list_returns_the_agent_with_its_token_5667() {
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;

    let planner = create_mcp_agent_inner(
        &pool,
        "  Planner ".to_owned(),
        McpAgentMode::ReadWrite,
        spaces(&[TEST_SPACE_ID]),
    )
    .await
    .expect("create a one-space agent");
    let reader = create(&pool, "agenda", None)
        .await
        .expect("create an every-space agent");

    assert_eq!(
        (
            planner.name.as_str(),
            planner.mode,
            planner.space_ids.clone()
        ),
        (
            "Planner",
            McpAgentMode::ReadWrite,
            Some(vec![TEST_SPACE_ID.to_owned()])
        ),
        "the name is trimmed"
    );
    assert_eq!(reader.space_ids, None, "no list means every space");
    for token in [&planner.token, &reader.token] {
        let hex = token.strip_prefix("agt_").expect("agt_ prefix");
        assert_eq!(
            (hex.len(), hex.chars().all(|c| c.is_ascii_hexdigit())),
            (32, true),
            "{token} is agt_ and 32 hex digits"
        );
    }
    assert_ne!(planner.token, reader.token, "each agent has its own token");
    assert_eq!(
        list_mcp_agents_inner(&pool).await.unwrap(),
        vec![reader, planner],
        "the list re-reads both agents, by name in any letter case"
    );
}

#[tokio::test]
async fn create_refuses_a_blank_control_or_overlong_name_5667() {
    let (pool, _dir) = test_pool().await;

    let overlong = "x".repeat(MAX_AGENT_NAME_LEN + 1);
    for name in ["   ", "Plan\u{7}ner", overlong.as_str()] {
        let err = create(&pool, name, None).await.expect_err(name);
        assert_eq!(
            err.validation_code(),
            Some(ValidationCode::InvalidAgentName),
            "{name:?} is refused as a name"
        );
    }
    let longest = "é".repeat(MAX_AGENT_NAME_LEN);
    create(&pool, &longest, None)
        .await
        .expect("the limit counts chars, not bytes");
    assert_eq!(list_mcp_agents_inner(&pool).await.unwrap().len(), 1);
}

#[tokio::test]
async fn create_refuses_a_name_another_agent_holds_in_any_case_5667() {
    let (pool, _dir) = test_pool().await;

    create(&pool, "Planner", None).await.expect("first agent");
    let err = create(&pool, "PLANNER", None)
        .await
        .expect_err("a case variant of a held name");
    assert_eq!(
        err.validation_code(),
        Some(ValidationCode::DuplicateAgentName)
    );
    assert_eq!(list_mcp_agents_inner(&pool).await.unwrap().len(), 1);
}

#[tokio::test]
async fn create_refuses_an_empty_unknown_or_trashed_space_list_5667() {
    let (pool, _dir) = test_pool().await;
    ensure_test_space(&pool).await;
    ensure_test_space_b(&pool).await;
    sqlx::query("UPDATE blocks SET deleted_at = 1 WHERE id = ?")
        .bind(TEST_SPACE_B_ID)
        .execute(&pool)
        .await
        .unwrap();

    let unknown = "01J0000000000000000000NOPE";
    for (space_ids, what) in [
        (spaces(&[]), "an empty list"),
        (spaces(&[TEST_SPACE_ID, unknown]), "an unknown space"),
        (spaces(&[TEST_SPACE_B_ID]), "a space in the Trash"),
    ] {
        let err = create(&pool, "Planner", space_ids).await.expect_err(what);
        assert_eq!(
            err.validation_code(),
            Some(ValidationCode::InvalidAgentSpaces),
            "{what} is refused"
        );
    }
    assert_eq!(list_mcp_agents_inner(&pool).await.unwrap(), Vec::new());
}

#[tokio::test]
async fn revoke_deletes_the_agent_and_refuses_an_unknown_id_5667() {
    let (pool, _dir) = test_pool().await;
    let planner = create(&pool, "Planner", None).await.unwrap();
    let reader = create(&pool, "Reader", None).await.unwrap();

    revoke_mcp_agent_inner(&pool, planner.id.clone())
        .await
        .expect("revoke");
    assert_eq!(
        list_mcp_agents_inner(&pool).await.unwrap(),
        vec![reader],
        "only the other agent is left"
    );
    let err = revoke_mcp_agent_inner(&pool, planner.id)
        .await
        .expect_err("a revoked id is gone");
    assert!(matches!(err, AppError::NotFound(_)), "{err:?}");
}
