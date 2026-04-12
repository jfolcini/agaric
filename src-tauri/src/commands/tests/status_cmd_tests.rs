#![allow(unused_imports)]
use super::super::*;
use super::common::*;

// ======================================================================
// get_status
// ======================================================================

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn get_status_returns_initial_metrics() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());

    // Allow 10ms for consumer tokio tasks to be spawned and start their event
    // loops. This is minimal — just enough for the runtime to schedule the
    // spawned tasks before we query their status metrics.
    tokio::time::sleep(std::time::Duration::from_millis(10)).await;

    let status = get_status_inner(&mat);

    // Fresh materializer — all counters at zero
    assert_eq!(
        status.total_ops_dispatched, 0,
        "fresh materializer should have zero ops"
    );
    assert_eq!(
        status.total_background_dispatched, 0,
        "fresh materializer should have zero background ops"
    );
}
