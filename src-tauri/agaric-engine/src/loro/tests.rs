//! Smoke tests for the Loro production scaffold. Prove that the
//! engine survives a create-then-read round-trip.

use super::engine::{BlockSnapshot, LoroEngine};

#[test]
fn create_block_round_trips_through_loro() {
    let mut engine = LoroEngine::new();
    let block_id = "page-01";

    engine
        .apply_create_block(block_id, "page", "Hello", None, 0)
        .expect("create block");

    let read = engine
        .read_block(block_id)
        .expect("read block")
        .expect("block exists");

    assert_eq!(
        read,
        BlockSnapshot {
            block_id: block_id.into(),
            block_type: "page".into(),
            content: "Hello".into(),
            parent_id: None,
            // #400: `position` is the dense 1-based rank among siblings, not the
            // legacy meta value — a sole root child is rank 1.
            position: 1,
        }
    );
}

/// The `(laptop, phone)` texts of block `B` after the #6525 boot-replay
/// sequence. Both engines start from `abc`; the phone appends `X`; the laptop
/// imports it, appends `Y` with the replayed edit's `to_text`, ships that to
/// the phone and dies. Its persisted blob is taken before the import when
/// `saved_after_import` is false, after it when true (the session-end save).
/// Boot imports that blob into a fresh engine under the same peer id and
/// replays the local edit; then each side imports what the other has.
fn texts_after_boot_replay_6525(saved_after_import: bool) -> (String, String, bool) {
    let content = |e: &LoroEngine| e.read_block("B").unwrap().unwrap().content;
    let mut phone = LoroEngine::with_peer_id("phone-6525").unwrap();
    phone
        .apply_create_block("B", "content", "abc", None, 0)
        .unwrap();
    let mut laptop = LoroEngine::with_peer_id("laptop-6525").unwrap();
    laptop.import(&phone.export_snapshot().unwrap()).unwrap();
    let mut persisted = laptop.export_snapshot().unwrap();

    phone.apply_edit_via_diff_splice("B", "abcX").unwrap();
    laptop
        .import(&phone.export_update_since(&laptop.version_vector()).unwrap())
        .unwrap();
    if saved_after_import {
        persisted = laptop.export_snapshot().unwrap();
    }
    laptop.apply_edit_via_diff_splice("B", "abcXY").unwrap();
    phone
        .import(&laptop.export_update_since(&phone.version_vector()).unwrap())
        .unwrap();
    assert_eq!(
        content(&phone),
        "abcXY",
        "the phone holds the laptop's edit"
    );

    let mut booted = LoroEngine::with_peer_id("laptop-6525").unwrap();
    booted.import(&persisted).unwrap();
    booted.apply_edit_via_diff_splice("B", "abcXY").unwrap();
    let to_booted = phone.export_update_since(&booted.version_vector()).unwrap();
    let to_phone = booted.export_update_since(&phone.version_vector()).unwrap();
    booted.import(&to_booted).unwrap();
    phone.import(&to_phone).unwrap();

    let same_vv = loro::VersionVector::decode(&booted.version_vector()).unwrap()
        == loro::VersionVector::decode(&phone.version_vector()).unwrap();
    (content(&booted), content(&phone), same_vv)
}

/// #6525 — pins the boot-replay divergence. A laptop that shipped an edit
/// built on the phone's edit, and died before a snapshot held that edit,
/// replays its local edit onto a doc without the phone's text: the diff
/// mints different ops under the op ids the phone already holds. The two
/// devices then hold different text under equal version vectors, and nothing
/// detects it.
#[test]
fn boot_replay_onto_a_snapshot_without_the_peers_edit_diverges_6525() {
    let (laptop, phone, same_vv) = texts_after_boot_replay_6525(false);
    assert!(same_vv, "the version vectors agree, so no sync sees a gap");
    assert_eq!(
        (laptop.as_str(), phone.as_str()),
        ("abcXXY", "abcXYY"),
        "the texts diverge"
    );
}

/// #6525 — with the peer's edit in the saved snapshot (the session-end save),
/// the replayed edit mints the op the phone already holds, and both converge.
#[test]
fn boot_replay_onto_a_snapshot_with_the_peers_edit_converges_6525() {
    let (laptop, phone, same_vv) = texts_after_boot_replay_6525(true);
    assert!(same_vv, "the version vectors agree");
    assert_eq!(
        (laptop.as_str(), phone.as_str()),
        ("abcXY", "abcXY"),
        "both hold the laptop's edit once"
    );
}
