#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_page_aliases_skips_empty_and_duplicates() {
    let (pool, _dir) = test_pool().await;

    insert_block(&pool, "PAGE-3", "page", "Page Three", None, Some(0)).await;

    let inserted = set_page_aliases_inner(
        &pool,
        "PAGE-3",
        vec![
            "  ".into(),   // whitespace only — skipped
            String::new(), // empty — skipped
            "Valid".into(),
            "Valid".into(), // duplicate — second insert is ignored
            "  Trimmed  ".into(),
        ],
    )
    .await
    .unwrap();

    // "Valid" appears once, "Trimmed" appears once
    assert_eq!(inserted.len(), 2, "should insert 2 unique aliases");
    assert!(
        inserted.contains(&"Valid".to_string()),
        "should contain Valid"
    );
    assert!(
        inserted.contains(&"Trimmed".to_string()),
        "should contain Trimmed"
    );
}
