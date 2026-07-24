//! App-crate tests for `peer_refs` that couple to app-only modules (#2621,
//! wave S4a).
//!
//! `peer_refs` itself moved down into `agaric-store`, and its unit tests moved
//! with it. The one test below exercises the pending-pairing marker round-trip
//! using `agaric_sync::pairing::pairing_proof` — an app-only helper that cannot move
//! into the store — so it stays here, driving the re-exported
//! `agaric_store::peer_refs::…` API against the app's test pool.

use agaric_store::peer_refs::{
    clear_pending_pairing, get_pending_pairing_proof, is_pending_pairing, set_pending_pairing,
};

#[tokio::test]
async fn pending_pairing_set_check_clear_roundtrip() {
    let (pool, _dir) = crate::commands::tests::common::test_pool().await;
    let proof = agaric_sync::pairing::pairing_proof("correct horse battery staple");

    assert!(
        !is_pending_pairing(&pool).await.unwrap(),
        "pending-pairing must be false on a fresh DB"
    );
    assert!(
        get_pending_pairing_proof(&pool).await.unwrap().is_none(),
        "no stored proof on a fresh DB"
    );

    set_pending_pairing(&pool, &proof).await.unwrap();
    assert!(
        is_pending_pairing(&pool).await.unwrap(),
        "pending-pairing must be true after set"
    );
    // #855: the stored proof round-trips so the responder can compare it.
    assert_eq!(
        get_pending_pairing_proof(&pool).await.unwrap().as_deref(),
        Some(proof.as_str()),
        "the expected pairing proof round-trips"
    );

    // Idempotent: a second set stays true (and updates the proof).
    set_pending_pairing(&pool, &proof).await.unwrap();
    assert!(is_pending_pairing(&pool).await.unwrap());

    clear_pending_pairing(&pool).await.unwrap();
    assert!(
        !is_pending_pairing(&pool).await.unwrap(),
        "pending-pairing must be false after clear"
    );
    assert!(
        get_pending_pairing_proof(&pool).await.unwrap().is_none(),
        "no stored proof after clear"
    );

    // Clearing an already-clear marker is a no-op (no error).
    clear_pending_pairing(&pool).await.unwrap();
}
