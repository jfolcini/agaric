use super::super::*;
use super::common::*;
use crate::space::{SpaceId, SpaceScope};

// ======================================================================
// page_aliases (#598)
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_page_aliases_creates_and_returns_aliases() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "PAGE-1", "page", "My Page", None, Some(0)).await;

    let inserted = set_page_aliases_inner(&pool, "PAGE-1", vec!["Alpha".into(), "Beta".into()])
        .await
        .unwrap();

    assert_eq!(inserted.len(), 2, "should insert 2 aliases");
    assert!(
        inserted.contains(&"Alpha".to_string()),
        "should contain Alpha"
    );
    assert!(
        inserted.contains(&"Beta".to_string()),
        "should contain Beta"
    );

    // Verify persistence
    let aliases = get_page_aliases_inner(&pool, "PAGE-1").await.unwrap();
    assert_eq!(
        aliases,
        vec!["Alpha", "Beta"],
        "persisted aliases should match"
    );
}
