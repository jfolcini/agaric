//! #4669 — differential fuzzing of the tauri mock against the real backend.
//!
//! The committed `conformance/fixtures/*.json` corpus is an excellent
//! *specification* mechanism and a poor *regression net*: every divergence it
//! has ever caught was caught when someone authored a new fixture, never by the
//! existing ~44 sequences turning red on an unrelated change. This lane closes
//! that gap by generating the sequences instead of hand-writing them:
//!
//! 1. `op_chain_strategy` (the materializer proptests' generator) produces a
//!    structurally valid op chain, and [`invalid_strategy`] a few commands the
//!    backend refuses to splice into it;
//! 2. [`chain_to_fixture`] renders both in the conformance fixture vocabulary,
//!    every op a `via: "command"` op;
//! 3. [`replay_fixture`] drives it through the REAL backend's commands, records
//!    what each returned or refused, snapshots, and runs the [`read_steps`];
//! 4. [`MockBridge`] drives the SAME fixture, each op declaring the refusal the
//!    backend recorded, through the TS mock;
//! 5. the snapshots, the per-command records and the read results must be
//!    equal, and proptest shrinks any mismatch to a minimal chain, which is
//!    written out as a ready-to-commit fixture.
//!
//! ## Why a child process
//!
//! The mock is TypeScript. A long-lived `node` process reading newline-
//! delimited JSON is what makes the comparison affordable inside a proptest
//! loop, where shrinking replays a chain dozens of times: one esbuild bundle
//! and one process start, then one line per candidate chain. The bundle entry
//! point is `src/lib/tauri-mock/__tests__/conformance-fuzz-bridge.ts`, and it
//! calls the SAME replay (`replayFixtureWithRecords`, which `replayFixture`
//! wraps) that `conformance.test.ts` runs over the committed corpus under
//! vitest — so the two module pipelines are cross-checked on every PR by the
//! corpus, and only the driver is new here.
//!
//! ## Why `#[ignore]`
//!
//! A fuzz lane's runtime is open-ended and it must not gate a PR on a
//! newly-discovered PRE-EXISTING divergence. It runs in
//! `scheduled-deep-checks.yml` alongside the benches and the mutation sweep:
//!
//! ```text
//! cargo nextest run --workspace --run-ignored all -E 'test(conformance_fuzz)'
//! ```
//!
//! ## Known blind spots
//!
//! Whatever the generator cannot emit, this lane cannot compare. Today that is
//! the attachment ops (no mock handler and no fixture vocabulary), a
//! `DeleteProperty(space)`, a `todo_state` (so `list_unfinished_tasks` answers
//! nothing), and the columns the snapshot omits: the timestamps and
//! `blocks.space_id`. The texts carry `[[…]]`, `((…))` and `#[…]` tokens
//! ([`weave_tokens`], #6054) naming the seed page, the seed tag or an earlier
//! block, live, trashed, purged, in no space or, in an edit, in another space,
//! so `page_links` and the backlink, tag-ref and inherited-tag reads compare,
//! the links the backend declines included. The write gate refuses a text that
//! names a block of another space unless its page already holds the token
//! (#5272), so a seed-tag move first puts a block naming the tag on the seed
//! page ([`Invalid::SpaceMove`]); a later edit may then name the tag from its
//! new space. No `#[…]` names the seed tag before it moves (see
//! [`chain_to_fixture`]). The space moves are the seed tag's and
//! [`MOVED_PAGE`]'s, each into a new space ([`Invalid::SpaceMove`]), and the
//! generator's `SetProperty(space)`, which names a content block. No text
//! names [`MOVED_PAGE`] and the chain writes no page title, so
//! `list_page_links` and `list_unlinked_references` still answer nothing. The
//! reads are the fixed [`read_steps`] of the harness space, so a read outside
//! them, a read of a space the chain made, and the wall-clock
//! `list_projected_agenda`, go uncompared. Of the refusals, it reaches the
//! ones [`Invalid`] lists, the repeated `add_tag` and the unattached
//! `remove_tag` that the generator's own tag ops draw, a cross-space token in
//! an edit, a space write to a content block, and an out-of-range `limit` on
//! each read in [`LIMIT_CAPS`]. The reached-command, refusal and read tallies
//! the lane prints are the honest statement of what it did cover.

use std::cell::RefCell;

use super::conformance::replay_fixture;
use super::conformance_command::{Declarations, relabel_records};
use super::conformance_query::run_query_steps;
use super::conformance_snapshot::canonical_label_map;
use agaric_engine::proptest_db_harness::{HARNESS_SPACE_IDS, op_chain_strategy, resolve_chain};
use agaric_store::op::{OpPayload, SPACE_PROPERTY_KEY};
use proptest::prelude::{Just, Strategy, any, prop_oneof};
use proptest::sample::Index;
use proptest::test_runner::{Config, TestCaseError, TestError, TestRunner};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

/// Cases per run. Low by default (each case migrates a fresh SQLite DB and
/// round-trips a child process); the lane bumps it via `PROPTEST_CASES`.
/// 256, measured rather than picked: 64 left part of the commands the renderer
/// can emit unreached, so the lane was comparing less than it claimed. See the
/// nextest `slow-timeout` override that goes with it: a run does not fit the
/// default 2x30s window.
const DEFAULT_CASES: u32 = 256;

/// The name every generated fixture carries.
const FUZZ_FIXTURE: &str = "conformance_fuzz_generated";

/// Chain length. Long enough for create/move/delete/restore interleavings,
/// short enough that a shrunk counter-example is readable as a fixture.
const CHAIN_LEN: std::ops::RangeInclusive<usize> = 1..=12;

/// The seeded page every generated chain hangs off. A ROOT `CreateBlock` is
/// re-anchored under it (as `prepare_chain` does for the apply-path proptests)
/// so `resolve_block_space` resolves and the ops stay on the engine path.
const SEED_PAGE: &str = "S1";

/// The seeded block every generated tag edge points at. The generator draws
/// `tag_id` from the same ULID pool as block ids, so an un-remapped edge would
/// name a block that was never created — the same remap `prepare_chain_b5`
/// applies. A `tag` block, because the `add_tag` command refuses any other.
const SEED_TAG: &str = "S2";

/// The seeded page an [`Invalid::SpaceMove`] can move out of the harness
/// space. No text names it: a link between two pages of the space makes
/// `list_page_links` answer, and the mock's roll-up there is a later item of
/// #6054.
const MOVED_PAGE: &str = "S3";

/// The most refused commands one chain splices in: enough to interleave them
/// with the valid ops, few enough that the chain stays mostly valid.
const MAX_INVALID: usize = 3;

/// The commands a generated chain is expected to reach. Asserted as a floor on
/// the reached tally so the lane cannot quietly degrade to "create + edit" when
/// the generator or the renderer narrows — the failure mode #4669 names as
/// "coverage that is assumed rather than visible".
///
/// MEASURED, not assumed: over [`DEFAULT_CASES`] the generator reaches these
/// many times each, and `restore_block` and `delete_property` only a handful.
/// The seed is random per run (that is the point of a fuzz lane), so asserting
/// on the tail would make this flaky rather than strict, and a weekly lane that
/// reddens on its own RNG teaches people to re-run it without reading it.
///
/// So the floor covers the robust ones and the tail is REPORTED instead —
/// every run prints the full tally, which is what makes a narrowing visible
/// whether or not it crosses this list.
const EXPECTED_COMMANDS: &[&str] = &[
    "add_tag",
    "create_block",
    "delete_block",
    "edit_block",
    "move_block",
    "move_blocks_to_space",
    "remove_tag",
    "set_property",
    "set_property(space)",
];

// ---------------------------------------------------------------------------
// Chain → fixture
// ---------------------------------------------------------------------------

/// The fixture seed every generated chain starts from: a page to hang the tree
/// off, a tag to use as a tag target and a page to move. The two that can
/// move rank first, so a departure shifts the roots behind it.
fn seed() -> Value {
    json!({
        "blocks": [
            { "id": SEED_PAGE, "block_type": "page", "content": "Home", "parent_id": null, "position": 3 },
            { "id": SEED_TAG, "block_type": "tag", "content": "tag", "parent_id": null, "position": 1 },
            { "id": MOVED_PAGE, "block_type": "page", "content": "Near", "parent_id": null, "position": 2 },
        ],
        "properties": [],
        "tags": [],
    })
}

/// Render a resolved op chain in the conformance fixture vocabulary.
///
/// Block references become fixture labels: `Cn` is "the block the n-th
/// `create_block` op made", which is the only reference BOTH runners can
/// resolve — each mints its own ULID per create and reconciles through the
/// canonical `Bn` relabel (see `resolve_op_arg_id`).
///
/// `AddAttachment` / `DeleteAttachment` are dropped: attachment apply writes
/// the `attachments` table and touches the filesystem; there is no mock
/// handler and no snapshot column, so a rendered op would be uncomparable, not
/// covered.
///
/// The generator aims `SetProperty(space)` at a content block only, which
/// holds no space, so both stacks refuse it. Its first space id renders it as
/// `set_property`, its second as `move_blocks_to_space`, into the space the
/// chain made last, or a new one. The snapshot holds no `space_id`, so what a
/// space move does shows in the ranks, the op digest and the reads of the
/// harness space.
///
/// Each `(index, invalid)` in `invalid` is rendered by [`render_invalid`]
/// before the payload at `index` (past the end: after the last one). The n-th
/// `create_block` or `edit_block` text carries the link tokens of `weaves[n]`
/// ([`weave_tokens`]). Every op is a `via: "command"` op named `opN`, so its
/// return or refusal is recorded.
fn chain_to_fixture(
    payloads: &[OpPayload],
    invalid: &[(Index, Invalid)],
    weaves: &[Weave],
    name: &str,
) -> Value {
    let mut label_of: BTreeMap<String, String> = BTreeMap::new();
    let mut creates = 0usize;
    // What a created text may not name: a block of another space. A create
    // refused for a cross-space token makes no `Cn` and shifts every later
    // label. An edit may name one, and is refused unless its page already
    // holds the token (#5272), when the link is declined instead.
    let mut elsewhere: Vec<String> = Vec::new();
    // The space a generated `SetProperty(space)` moves its block into.
    let mut last_space: Option<String> = None;
    // No `#[…]` names the seed tag before it moves: the backend keeps an
    // inline tag ref to a tag that left the source's space until the next
    // delete, restore or purge rebuilds them all, which the mock does not
    // model.
    let mut no_tag_ref: Vec<String> = Vec::new();
    if invalid
        .iter()
        .any(|(_, kind)| matches!(kind, Invalid::SpaceMove(Mover::SeedTag, _)))
    {
        no_tag_ref.push(SEED_TAG.to_owned());
    }
    let mut weaves = weaves.iter();
    let mut weave = |text: &str, creates: usize, skip: &[String], no_tag_ref: &[String]| {
        weave_tokens(
            text,
            weaves.next().map_or(&[][..], Vec::as_slice),
            creates,
            skip,
            no_tag_ref,
        )
    };
    let mut ops: Vec<Value> = Vec::new();
    let mut splices: Vec<(usize, Invalid)> = invalid
        .iter()
        .map(|(at, kind)| (at.index(payloads.len() + 1), *kind))
        .collect();
    // Stable: two refusals at one index keep their generated order.
    splices.sort_by_key(|(at, _)| *at);
    let mut splices = splices.into_iter().peekable();

    // A reference to a block the chain created resolves to its `Cn` label; a
    // reference the renderer cannot resolve (only possible for a purged id,
    // which the model never re-targets) would be a renderer bug, so it panics
    // rather than silently emitting a seed label that names a different block.
    let label = |label_of: &BTreeMap<String, String>, id: &str| -> String {
        label_of
            .get(id)
            .unwrap_or_else(|| panic!("op references block {id}, which no create_block op made"))
            .clone()
    };

    for (at, payload) in payloads.iter().enumerate() {
        while let Some((_, kind)) = splices.next_if(|(splice_at, _)| *splice_at == at) {
            ops.extend(render_invalid(kind, &mut creates));
            match kind {
                Invalid::CrossSpace => {
                    last_space = Some(format!("C{}", creates - 1));
                    elsewhere.push(format!("C{creates}"));
                }
                Invalid::SpaceMove(mover, _) => {
                    last_space = Some(format!("C{creates}"));
                    if matches!(mover, Mover::SeedTag) {
                        elsewhere.push(SEED_TAG.to_owned());
                        no_tag_ref.clear();
                    }
                }
                _ => {}
            }
        }
        let op = match payload {
            OpPayload::CreateBlock(c) => {
                let content = weave(&c.content, creates, &elsewhere, &no_tag_ref);
                creates += 1;
                let parent = c
                    .parent_id
                    .as_ref()
                    .map_or_else(|| SEED_PAGE.to_owned(), |p| label(&label_of, p.as_str()));
                label_of.insert(c.block_id.as_str().to_owned(), format!("C{creates}"));
                json!({ "command": "create_block", "args": {
                    "parentId": parent,
                    "blockType": c.block_type,
                    "content": content,
                    // The generator's 1-based `position` read as the 0-based
                    // insert `index` the command takes. Values past the sibling
                    // count are kept, not clamped here: how each side clamps a
                    // tail index is exactly what this lane is comparing.
                    "index": c.position.unwrap_or(1) - 1,
                    "scope": { "kind": "active", "space_id": "$SPACE" },
                }})
            }
            OpPayload::EditBlock(e) => json!({ "command": "edit_block", "args": {
                "blockId": label(&label_of, e.block_id.as_str()),
                "toText": weave(&e.to_text, creates, &[], &no_tag_ref),
            }}),
            OpPayload::MoveBlock(m) => {
                let new_parent = m
                    .new_parent_id
                    .as_ref()
                    .map_or_else(|| SEED_PAGE.to_owned(), |p| label(&label_of, p.as_str()));
                json!({ "command": "move_block", "args": {
                    "blockId": label(&label_of, m.block_id.as_str()),
                    "newParentId": new_parent,
                    "newIndex": m.new_position - 1,
                }})
            }
            OpPayload::DeleteBlock(d) => json!({ "command": "delete_block", "args": {
                "blockId": label(&label_of, d.block_id.as_str()),
            }}),
            OpPayload::RestoreBlock(r) => json!({ "command": "restore_block", "args": {
                // The Rust runner passes the live tombstone as `deleted_at_ref`,
                // as the trash view does, so the fixture op carries no guard
                // (the mock takes none).
                "blockId": label(&label_of, r.block_id.as_str()),
            }}),
            OpPayload::PurgeBlock(p) => json!({ "command": "purge_block", "args": {
                "blockId": label(&label_of, p.block_id.as_str()),
            }}),
            OpPayload::SetProperty(s) if s.key == SPACE_PROPERTY_KEY => {
                let space = last_space.clone().unwrap_or_else(|| {
                    creates += 1;
                    ops.push(create_space(creates));
                    format!("C{creates}")
                });
                last_space = Some(space.clone());
                let via = if s
                    .value_ref
                    .as_ref()
                    .is_some_and(|r| r.as_str() == HARNESS_SPACE_IDS[0])
                {
                    Via::SetProperty
                } else {
                    Via::MoveBlocks
                };
                space_move(via, &label(&label_of, s.block_id.as_str()), &space)
            }
            OpPayload::SetProperty(s) => {
                let mut value = serde_json::Map::new();
                if let Some(text) = &s.value_text {
                    value.insert("value_text".into(), json!(text));
                }
                if let Some(date) = &s.value_date {
                    value.insert("value_date".into(), json!(date));
                }
                json!({ "command": "set_property", "args": {
                    "blockId": label(&label_of, s.block_id.as_str()),
                    "key": s.key,
                    "value": Value::Object(value),
                }})
            }
            OpPayload::DeleteProperty(d) => json!({ "command": "delete_property", "args": {
                "blockId": label(&label_of, d.block_id.as_str()),
                "key": d.key,
            }}),
            OpPayload::AddTag(t) => json!({ "command": "add_tag", "args": {
                "blockId": label(&label_of, t.block_id.as_str()),
                "tagId": SEED_TAG,
            }}),
            OpPayload::RemoveTag(t) => json!({ "command": "remove_tag", "args": {
                "blockId": label(&label_of, t.block_id.as_str()),
                "tagId": SEED_TAG,
            }}),
            _ => continue,
        };
        ops.push(op);
    }
    for (_, kind) in splices {
        ops.extend(render_invalid(kind, &mut creates));
    }
    for (n, op) in ops.iter_mut().enumerate() {
        op["via"] = json!("command");
        op["name"] = json!(format!("op{}", n + 1));
    }

    json!({ "name": name, "seed": seed(), "ops": ops, "expected": null })
}

/// The three link tokens a block's text can carry (#6054).
#[derive(Debug, Clone, Copy)]
enum TokenKind {
    /// `[[id]]`, a page link.
    Link,
    /// `((id))`, a block reference.
    Ref,
    /// `#[id]`, a tag reference.
    TagRef,
}

/// The tokens one generated text carries: each a kind and a pick among the
/// blocks that exist when its op runs.
type Weave = Vec<(TokenKind, Index)>;

/// One [`Weave`] per text op, in op order; a text past the last carries none.
fn weaves_strategy() -> impl Strategy<Value = Vec<Weave>> {
    let kind = prop_oneof![
        Just(TokenKind::Link),
        Just(TokenKind::Ref),
        Just(TokenKind::TagRef)
    ];
    let weave = proptest::collection::vec((kind, any::<Index>()), 0..=2);
    proptest::collection::vec(weave, 0..=*CHAIN_LEN.end())
}

/// `text` with the tokens of `weave` appended, written with labels
/// (`expand_content_labels` resolves them on both stacks). A target is the seed
/// page, the seed tag or one of the `creates` blocks made so far, whatever
/// became of it: one the chain deleted or purged, a space block, which is in no
/// space, or a block of another space. Those are the skip, decline and refusal
/// paths of the link derivations. A label in `skip` is never a target, and one
/// in `no_tag_ref` never that of a `#[…]`.
///
/// The generator's own content alphabet has no brackets, so these are the only
/// tokens a generated text holds; the shared `content_strategy` stays as it is
/// for the other proptests that draw from it.
fn weave_tokens(
    text: &str,
    weave: &[(TokenKind, Index)],
    creates: usize,
    skip: &[String],
    no_tag_ref: &[String],
) -> String {
    let targets: Vec<String> = [SEED_PAGE.to_owned(), SEED_TAG.to_owned()]
        .into_iter()
        .chain((1..=creates).map(|n| format!("C{n}")))
        .filter(|label| !skip.contains(label))
        .collect();
    let mut out = text.to_owned();
    for (kind, pick) in weave {
        let target = pick.get(&targets);
        if matches!(kind, TokenKind::TagRef) && no_tag_ref.contains(target) {
            continue;
        }
        out.push_str(&match kind {
            TokenKind::Link => format!(" [[{target}]]"),
            TokenKind::Ref => format!(" (({target}))"),
            TokenKind::TagRef => format!(" #[{target}]"),
        });
    }
    out
}

/// A command the generator's model never emits (#6054), mostly one the
/// backend refuses. Spliced into a chain so the lane compares refusals as well
/// as successes. Each is rendered with the ops that put its target in that
/// state, so its outcome does not depend on the chain around it.
/// (`Deleted(Restore)`, `Deleted(Purge)` and `SpaceMove` are the accepted
/// cases.)
#[derive(Debug, Clone, Copy)]
enum Invalid {
    /// A command on a block that was created and purged: no row has its id.
    Missing(Target),
    /// A command on a block in the trash.
    Deleted(Target),
    /// A `create_block` whose client id the seed page already holds.
    CollidingId,
    /// A `due_date` that is not a calendar day.
    BadDate,
    /// A tag applied to a page of another space.
    CrossSpace,
    /// The seed tag or [`MOVED_PAGE`] moved into a space made for it. Always a
    /// new space, so the arrival order #5099 leaves unmodelled never comes up.
    /// The seed tag first gets a block on the seed page that links it.
    SpaceMove(Mover, Via),
}

/// What an [`Invalid::SpaceMove`] moves. Once the seed tag is away, every
/// later `add_tag` and every token naming it is cross-space.
#[derive(Debug, Clone, Copy)]
enum Mover {
    SeedTag,
    Page,
}

/// The two commands that write a block's `space`.
#[derive(Debug, Clone, Copy)]
enum Via {
    SetProperty,
    MoveBlocks,
}

/// The command an [`Invalid::Missing`] or [`Invalid::Deleted`] names its
/// block in.
#[derive(Debug, Clone, Copy)]
enum Target {
    Edit,
    SetProperty,
    DeleteProperty,
    AddTag,
    RemoveTag,
    Move,
    Delete,
    Restore,
    Purge,
    CreateChild,
}

fn invalid_strategy() -> impl Strategy<Value = Invalid> {
    let target = || {
        prop_oneof![
            Just(Target::Edit),
            Just(Target::SetProperty),
            Just(Target::DeleteProperty),
            Just(Target::AddTag),
            Just(Target::RemoveTag),
            Just(Target::Move),
            Just(Target::Delete),
            Just(Target::Restore),
            Just(Target::Purge),
            Just(Target::CreateChild),
        ]
    };
    prop_oneof![
        target().prop_map(Invalid::Missing),
        target().prop_map(Invalid::Deleted),
        Just(Invalid::CollidingId),
        Just(Invalid::BadDate),
        Just(Invalid::CrossSpace),
        (
            prop_oneof![Just(Mover::SeedTag), Just(Mover::Page)],
            prop_oneof![Just(Via::SetProperty), Just(Via::MoveBlocks)],
        )
            .prop_map(|(mover, via)| Invalid::SpaceMove(mover, via)),
    ]
}

/// The harness space, as a `create_block` scope.
fn harness_scope() -> Value {
    json!({ "kind": "active", "space_id": "$SPACE" })
}

/// A `create_space` making the chain's `n`-th block.
fn create_space(n: usize) -> Value {
    json!({ "command": "create_space", "args": {
        "name": format!("Away {n}"), "accentColor": null,
    }})
}

/// `block` moved into `space` through `via`.
fn space_move(via: Via, block: &str, space: &str) -> Value {
    match via {
        Via::SetProperty => json!({ "command": "set_property", "args": {
            "blockId": block, "key": SPACE_PROPERTY_KEY, "value": { "value_ref": space },
        }}),
        Via::MoveBlocks => json!({ "command": "move_blocks_to_space", "args": {
            "blockIds": [block], "spaceId": space,
        }}),
    }
}

/// `invalid` as fixture ops, counting every block they create into `creates`
/// so the chain's own `Cn` labels stay aligned.
fn render_invalid(invalid: Invalid, creates: &mut usize) -> Vec<Value> {
    let mut create = |ops: &mut Vec<Value>| -> String {
        *creates += 1;
        ops.push(json!({ "command": "create_block", "args": {
            "parentId": SEED_PAGE, "blockType": "content", "content": "doomed", "index": 0,
            "scope": harness_scope(),
        }}));
        format!("C{creates}")
    };
    let mut ops = Vec::new();
    match invalid {
        Invalid::Missing(target) | Invalid::Deleted(target) => {
            let label = create(&mut ops);
            ops.push(json!({ "command": "delete_block", "args": { "blockId": label } }));
            if matches!(invalid, Invalid::Missing(_)) {
                ops.push(json!({ "command": "purge_block", "args": { "blockId": label } }));
            }
            ops.push(target_op(target, &label));
        }
        Invalid::CollidingId => ops.push(json!({ "command": "create_block", "args": {
            "blockId": SEED_PAGE, "parentId": SEED_PAGE, "blockType": "content",
            "content": "usurper", "index": 0, "scope": harness_scope(),
        }})),
        Invalid::BadDate => ops.push(json!({ "command": "set_property", "args": {
            "blockId": SEED_PAGE, "key": "due_date", "value": { "value_date": "2026-02-30" },
        }})),
        Invalid::CrossSpace => {
            *creates += 2;
            let (space, page) = (*creates - 1, *creates);
            ops.push(create_space(space));
            ops.push(json!({ "command": "create_page_in_space", "args": {
                "content": "away", "parentId": null, "spaceId": format!("C{space}"),
            }}));
            ops.push(json!({ "command": "add_tag", "args": {
                "blockId": format!("C{page}"), "tagId": SEED_TAG,
            }}));
        }
        Invalid::SpaceMove(mover, via) => {
            if matches!(mover, Mover::SeedTag) {
                // The seed page holds the tag's token before the tag moves, so
                // a later edit may name it from another space (#5272) and the
                // link that edit writes is declined.
                *creates += 1;
                ops.push(json!({ "command": "create_block", "args": {
                    "parentId": SEED_PAGE, "blockType": "content",
                    "content": format!("[[{SEED_TAG}]]"), "index": 0, "scope": harness_scope(),
                }}));
            }
            *creates += 1;
            ops.push(create_space(*creates));
            let block = match mover {
                Mover::SeedTag => SEED_TAG,
                Mover::Page => MOVED_PAGE,
            };
            ops.push(space_move(via, block, &format!("C{creates}")));
        }
    }
    ops
}

/// `target` aimed at `label`. A child create is not counted into the chain's
/// `Cn` labels: under a missing or trashed parent it is refused and mints no
/// block, and a stack that accepts it has already diverged.
fn target_op(target: Target, label: &str) -> Value {
    let block = json!({ "blockId": label });
    match target {
        Target::Edit => json!({ "command": "edit_block", "args": {
            "blockId": label, "toText": "edited",
        }}),
        Target::SetProperty => json!({ "command": "set_property", "args": {
            "blockId": label, "key": "reviewer", "value": { "value_text": "ada" },
        }}),
        Target::DeleteProperty => json!({ "command": "delete_property", "args": {
            "blockId": label, "key": "reviewer",
        }}),
        Target::AddTag => json!({ "command": "add_tag", "args": {
            "blockId": label, "tagId": SEED_TAG,
        }}),
        Target::RemoveTag => json!({ "command": "remove_tag", "args": {
            "blockId": label, "tagId": SEED_TAG,
        }}),
        Target::Move => json!({ "command": "move_block", "args": {
            "blockId": label, "newParentId": SEED_PAGE, "newIndex": 0,
        }}),
        Target::Delete => json!({ "command": "delete_block", "args": block }),
        Target::Restore => json!({ "command": "restore_block", "args": block }),
        Target::Purge => json!({ "command": "purge_block", "args": block }),
        Target::CreateChild => json!({ "command": "create_block", "args": {
            "parentId": label, "blockType": "content", "content": "child", "index": 0,
            "scope": harness_scope(),
        }}),
    }
}

// ---------------------------------------------------------------------------
// Reads after the chain
// ---------------------------------------------------------------------------

/// Why a read whose rows sort on the raw block id is compared as a set: the
/// backend mints a ULID per create and the mock a local id, so the two orders
/// of op-created rows are unrelated.
const RAW_ID_ORDER: &str = "sorted by raw block id, which op-created rows do not share between the \
                            stacks";

/// [`RAW_ID_ORDER`], for a read whose rows sort on a column that ties across
/// parents before they reach the id.
const POSITION_TIE_ORDER: &str = "sorted by position across the whole page, so children of \
                                  different parents tie and break on raw block id, which \
                                  op-created rows do not share between the stacks";

/// The reads that refuse a `limit` outside `[1, cap]` (invariant 10). Each is
/// also in [`read_steps`] with a valid limit, which is the step a refusal is
/// cloned from. `PageRequest::new` is the 200 of the five paginated listings.
const LIMIT_CAPS: &[(&str, i64)] = &[
    ("list_blocks", 100),
    ("list_trash", 100),
    ("list_pages_with_metadata", 100),
    ("search_blocks", 100),
    ("run_advanced_query", 200),
    ("list_tags_by_prefix", 200),
    ("get_backlinks", 200),
    ("list_backlinks_grouped", 200),
    ("list_unlinked_references", 200),
    ("query_by_tags", 200),
    ("list_unfinished_tasks", 200),
];

/// The read steps every generated chain ends with (#6054): the derived views
/// the snapshot does not hold, through the corpus's own query vocabulary.
///
/// `created` is how many blocks the backend's ops made (`C1..`), `dates` the
/// days the accepted ops wrote (what an agenda count can find), and `term` a
/// word of the chain's content (what a search can find); random content and
/// dates would never meet a fixed one. A wall-clock read
/// (`list_projected_agenda`) is not among them: no fixture can pin it.
fn read_steps(created: usize, dates: &[String], term: &str) -> Vec<Value> {
    let scope = harness_scope();
    let mut steps = vec![
        json!({ "name": "pages", "command": "list_pages_with_metadata", "args": {
            "filter": { "sort": "alphabetical", "spaceId": "$SPACE" }, "limit": 50,
        }}),
        json!({ "name": "tags", "command": "list_all_tags_in_space", "args": { "scope": scope } }),
        json!({ "name": "tags_by_prefix", "command": "list_tags_by_prefix", "args": {
            "prefix": "t", "limit": 50, "scope": scope,
        }}),
        json!({ "name": "children", "command": "list_blocks", "args": {
            "request": { "parentId": SEED_PAGE, "limit": 100 }, "scope": scope,
        }}),
        json!({ "name": "backlink_counts", "command": "count_backlinks_batch", "args": {
            "pageIds": [SEED_PAGE, SEED_TAG], "scope": scope,
        }}),
        json!({ "name": "tagged", "command": "query_by_tags", "unordered": RAW_ID_ORDER, "args": {
            "tagIds": [SEED_TAG], "prefixes": [], "mode": "or", "includeInherited": true,
            "limit": 100, "scope": scope,
        }}),
        json!({ "name": "agenda_counts", "command": "count_agenda_batch_by_source", "args": {
            "dates": dates, "scope": scope,
        }}),
        json!({ "name": "unfinished", "command": "list_unfinished_tasks",
            "unordered": "sorted by due or scheduled date, which several rows share, then by raw \
                          block id, which op-created rows do not share between the stacks",
            "args": {
                "beforeDate": "2031-01-01", "todoStates": ["TODO"], "limit": 100, "scope": scope,
            },
        }),
        json!({ "name": "search", "command": "search_blocks", "args": {
            "query": term, "limit": 50,
            "filter": { "scope": { "kind": "spaces", "space_ids": ["$SPACE"] } },
        }}),
        json!({ "name": "advanced", "command": "run_advanced_query", "unordered": RAW_ID_ORDER,
            "args": { "request": { "limit": 100, "spaceId": "$SPACE" } },
        }),
        json!({ "name": "page_links", "command": "list_page_links", "args": { "scope": scope } }),
        json!({ "name": "unlinked", "command": "list_unlinked_references",
            "unordered": RAW_ID_ORDER,
            "args": { "pageId": SEED_PAGE, "limit": 50, "scope": scope },
        }),
        json!({ "name": "trash", "command": "list_trash",
            "unordered": "sorted by deleted_at, which each stack stamps from its own clock, then \
                          by raw block id, which op-created rows do not share between the stacks",
            "args": { "limit": 100, "scope": scope },
        }),
        json!({ "name": "trash_count", "command": "count_trash", "args": { "scope": scope } }),
        json!({ "name": "subtree", "command": "load_page_subtree", "unordered": POSITION_TIE_ORDER,
            "args": { "rootBlockId": SEED_PAGE, "scope": scope },
        }),
    ];
    for seed in [SEED_PAGE, SEED_TAG] {
        steps.push(
            json!({ "name": format!("backlinks_{seed}"), "command": "get_backlinks",
                "unordered": RAW_ID_ORDER,
                "args": { "blockId": seed, "limit": 50, "scope": scope },
            }),
        );
        steps.push(json!({ "name": format!("backlink_groups_{seed}"),
            "command": "list_backlinks_grouped", "unordered": RAW_ID_ORDER,
            "args": { "blockId": seed, "limit": 50, "scope": scope },
        }));
    }
    for n in 1..=created {
        steps.push(
            json!({ "name": format!("backlinks_C{n}"), "command": "get_backlinks",
                "unordered": RAW_ID_ORDER,
                "args": { "blockId": format!("C{n}"), "limit": 50, "scope": scope },
            }),
        );
    }
    let created = (1..=created).map(|n| format!("C{n}"));
    for block in [SEED_PAGE.to_owned(), SEED_TAG.to_owned()]
        .into_iter()
        .chain(created)
    {
        for command in ["list_tags_for_block", "list_inherited_tags_for_block"] {
            steps.push(
                json!({ "name": format!("{command}_{block}"), "command": command,
                    "args": { "blockId": block },
                }),
            );
        }
    }
    let refusals: Vec<Value> = LIMIT_CAPS
        .iter()
        .flat_map(|&(command, cap)| {
            let valid = steps
                .iter()
                .find(|step| step["command"] == command)
                .unwrap_or_else(|| panic!("LIMIT_CAPS names {command}, which no read step runs"));
            [0, cap + 1].map(|limit| {
                let mut step = valid.clone();
                step["name"] = json!(format!("{}_limit_{limit}", valid["name"].as_str().unwrap()));
                let args = &mut step["args"];
                let holder = if args.get("request").is_some() {
                    &mut args["request"]
                } else {
                    args
                };
                holder["limit"] = json!(limit);
                step["expect_error"] = json!("validation");
                step["comment"] = json!(format!("a limit outside [1, {cap}] is refused"));
                step
            })
        })
        .collect();
    steps.extend(refusals);
    steps
}

/// The days the chain's accepted `set_property` ops wrote, sorted and once
/// each.
fn written_dates(fixture: &Value, records: &[Value]) -> Vec<String> {
    let ops = fixture["ops"].as_array().expect("rendered ops");
    let dates: std::collections::BTreeSet<String> = ops
        .iter()
        .zip(records)
        .filter(|(op, record)| op["command"] == "set_property" && record["error"].is_null())
        .filter_map(|(op, _)| {
            op["args"]["value"]["value_date"]
                .as_str()
                .map(str::to_owned)
        })
        .collect();
    dates.into_iter().collect()
}

/// The first word of three or more characters the chain wrote, the shortest
/// a trigram search matches; a word nothing holds when it wrote none.
fn search_term(fixture: &Value) -> String {
    let ops = fixture["ops"].as_array().expect("rendered ops");
    ops.iter()
        .filter_map(|op| {
            op["args"]["content"]
                .as_str()
                .or(op["args"]["toText"].as_str())
        })
        .flat_map(str::split_whitespace)
        // A woven token is a label, not the text either stack stored. A word
        // like `C12` is one too: the read steps expand it to a block id.
        .find(|word| {
            word.len() >= 3
                && word.chars().all(char::is_alphanumeric)
                && !(word.starts_with(['C', 'S']) && word[1..].bytes().all(|b| b.is_ascii_digit()))
        })
        .unwrap_or("absent")
        .to_owned()
}

// ---------------------------------------------------------------------------
// Mock bridge (long-lived node child process)
// ---------------------------------------------------------------------------

/// `<repo>` — `CARGO_MANIFEST_DIR` is `<repo>/src-tauri`.
fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri has a parent")
        .to_owned()
}

/// The TS mock, running as a long-lived NDJSON server.
struct MockBridge {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    _bundle_dir: tempfile::TempDir,
}

impl MockBridge {
    /// Bundle the bridge entry point and start it. Panics with the tool's own
    /// stderr on any failure: a lane that cannot reach the mock has compared
    /// nothing, and must say so rather than pass.
    fn start() -> Self {
        let root = repo_root();
        let bundle_dir = tempfile::TempDir::new().expect("bundle temp dir");
        let bundle = bundle_dir.path().join("bridge.mjs");
        let esbuild = root.join("node_modules/.bin/esbuild");
        assert!(
            esbuild.exists(),
            "#4669 differential fuzz needs the frontend toolchain: {} is missing (run `npm ci`)",
            esbuild.display(),
        );
        let build = Command::new(&esbuild)
            .current_dir(&root)
            .arg("src/lib/tauri-mock/__tests__/conformance-fuzz-bridge.ts")
            .arg("--bundle")
            .arg("--format=esm")
            .arg("--platform=node")
            // The `@/*` path alias, and the one Vite-ism the mock's transitive
            // imports reach (`logger.ts` reads `import.meta.env.DEV`).
            .arg("--alias:@=./src")
            .arg(r#"--define:import.meta.env={"DEV":false,"MODE":"test"}"#)
            .arg(format!("--outfile={}", bundle.display()))
            .output()
            .expect("run esbuild");
        assert!(
            build.status.success(),
            "esbuild failed to bundle the mock bridge:\n{}",
            String::from_utf8_lossy(&build.stderr),
        );

        let mut child = Command::new("node")
            .arg(&bundle)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("spawn the mock bridge");
        let stdin = child.stdin.take().expect("bridge stdin");
        let stdout = BufReader::new(child.stdout.take().expect("bridge stdout"));
        Self {
            child,
            stdin,
            stdout,
            _bundle_dir: bundle_dir,
        }
    }

    /// Replay `fixture` through the mock and return its normalized snapshot,
    /// command records and read results, or the mock's own rejection message.
    fn replay(&mut self, fixture: &Value) -> Result<MockRun, String> {
        writeln!(self.stdin, "{fixture}").map_err(|e| format!("write to mock bridge: {e}"))?;
        self.stdin
            .flush()
            .map_err(|e| format!("flush mock bridge: {e}"))?;
        let mut line = String::new();
        let read = self
            .stdout
            .read_line(&mut line)
            .map_err(|e| format!("read from mock bridge: {e}"))?;
        assert!(
            read > 0,
            "the mock bridge closed its stdout — see its stderr above"
        );
        let response: Value = serde_json::from_str(&line)
            .map_err(|e| format!("parse mock response '{line}': {e}"))?;
        if response["ok"] == json!(true) {
            Ok(MockRun {
                snapshot: response["snapshot"].clone(),
                records: response["records"].clone(),
                queries: response["queries"].clone(),
            })
        } else {
            Err(response["error"]
                .as_str()
                .unwrap_or("<no error>")
                .to_owned())
        }
    }
}

impl Drop for MockBridge {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

// ---------------------------------------------------------------------------
// The property
// ---------------------------------------------------------------------------

/// What the backend made of a generated chain: its snapshot, the relabelled
/// record of every op, and the result of every read step, as a committed
/// fixture's `expected`, `expected_ops` and `expected_queries` hold them.
struct BackendRun {
    snapshot: Value,
    records: Vec<Value>,
    queries: Value,
}

/// The mock's answer to the same fixture, in the same three shapes.
struct MockRun {
    snapshot: Value,
    records: Value,
    queries: Value,
}

/// The indices of the read steps the mock answered differently.
fn diverging_reads(backend: &Value, mock: &Value) -> Vec<usize> {
    let backend = backend.as_array().map_or(&[][..], Vec::as_slice);
    (0..backend.len())
        .filter(|&i| mock.get(i) != Some(&backend[i]))
        .collect()
}

/// Each op declares the refusal the backend recorded for it, so the mock's own
/// declaration check fails on a refusal that differs (#6054), and a written
/// counter-example is a fixture the corpus accepts as it stands.
fn declare_refusals(fixture: &mut Value, records: &[Value]) {
    let ops = fixture["ops"].as_array_mut().expect("rendered ops");
    for (op, record) in ops.iter_mut().zip(records) {
        for (key, field) in [("expect_error", "error"), ("expect_code", "code")] {
            if !record[field].is_null() {
                op[key] = record[field].clone();
            }
        }
    }
}

/// Write a counter-example out as a ready-to-commit fixture: the generated
/// chain plus the backend's snapshot, records and read results as `expected`,
/// `expected_ops` and `expected_queries`, so dropping it into
/// `conformance/fixtures/` turns the shrunk divergence into a permanent
/// regression test on BOTH runners.
///
/// It keeps only the `reads` the mock answered differently, an empty one
/// declared empty as the corpus requires. A mock that threw has no read
/// results, so its counter-example keeps none and the ops carry it.
fn write_counterexample(fixture: &Value, backend: &BackendRun, reads: &[usize]) -> PathBuf {
    let mut out = fixture.clone();
    out["description"] = json!(
        "#4669 — minimized counter-example from the differential-fuzz lane. \
               Backend-authored `expected`; move into conformance/fixtures/ to pin it."
    );
    out["expected"] = backend.snapshot.clone();
    if !backend.records.is_empty() {
        out["expected_ops"] = json!(backend.records);
    }
    let obj = out.as_object_mut().expect("fixture object");
    obj.remove("queries");
    if !reads.is_empty() {
        let mut steps = Vec::new();
        let mut results = Vec::new();
        for &i in reads {
            let (mut step, result) = (fixture["queries"][i].clone(), backend.queries[i].clone());
            if result["error"].is_null() && result["rows"] == json!([]) {
                step["expect_empty"] = json!(true);
                step["comment"] = json!("the backend answers nothing here and the mock did not");
            }
            steps.push(step);
            results.push(result);
        }
        obj.insert("queries".into(), json!(steps));
        obj.insert("expected_queries".into(), json!(results));
    }
    // `CARGO_TARGET_TMPDIR`, not `<repo>/target`: the latter is NOT gitignored
    // (only `src-tauri/target` is), so writing there left the counter-example
    // as untracked noise at the repo root — one `git add -A` from being
    // committed. Cargo hands integration tests this directory for exactly this.
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("conformance-fuzz");
    std::fs::create_dir_all(&dir).expect("create counter-example dir");
    let path = dir.join("counterexample.json");
    let mut text = serde_json::to_string_pretty(&out).expect("serialize counter-example");
    text.push('\n');
    std::fs::write(&path, text).expect("write counter-example");
    path
}

/// The mock's snapshot, command records and reads of a generated op chain
/// equal the real backend's.
///
/// See the module docs for the pipeline, the child-process rationale, and why
/// this is `#[ignore]`d out of the per-PR lane.
#[test]
#[ignore = "#4669 differential-fuzz lane: weekly, needs node_modules (--run-ignored all)"]
fn mock_matches_backend_on_generated_op_chains_4669() {
    // `RefCell`: `TestRunner::run` takes an `Fn`, and shrinking re-enters the
    // closure, so both the child process and the tally have to be shared
    // rather than moved. Single-threaded — proptest runs cases sequentially
    // in this thread — so a `borrow_mut` here can never contend.
    let bridge = RefCell::new(MockBridge::start());
    let reached: RefCell<BTreeMap<String, usize>> = RefCell::new(BTreeMap::new());
    let refused: RefCell<BTreeMap<String, usize>> = RefCell::new(BTreeMap::new());
    let read: RefCell<BTreeMap<String, usize>> = RefCell::new(BTreeMap::new());
    let mut config = Config::default();
    if std::env::var_os("PROPTEST_CASES").is_none() {
        config.cases = DEFAULT_CASES;
    }
    // The counter-example file is this lane's artefact; proptest's own
    // regression file would pin an opaque seed instead of a readable fixture.
    config.failure_persistence = None;
    let mut runner = TestRunner::new(config);

    // One runtime for the whole run, not one per case: `runner.run` invokes this
    // closure 256+ times and again for every shrink re-entry, and each
    // `Runtime::new` spins up a fresh thread pool it then drops.
    let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");

    let strategy = (
        op_chain_strategy(CHAIN_LEN),
        proptest::collection::vec((any::<Index>(), invalid_strategy()), 0..=MAX_INVALID),
        weaves_strategy(),
    );
    let result = runner.run(&strategy, |(sketches, invalid, weaves)| {
        let mut fixture =
            chain_to_fixture(&resolve_chain(&sketches), &invalid, &weaves, FUZZ_FIXTURE);
        let backend = runtime.block_on(async {
            let replay = replay_fixture(&fixture, FUZZ_FIXTURE, Declarations::Recorded).await;
            let labels = canonical_label_map(&replay.canonical_order);
            let records = relabel_records(&replay.op_records, &labels);
            let records = records.as_array().cloned().unwrap_or_default();
            // The reads come after the ops have run, because which blocks they
            // name is what the backend's ops created.
            let created = replay.canonical_order.len() - seed()["blocks"].as_array().unwrap().len();
            let steps = read_steps(
                created,
                &written_dates(&fixture, &records),
                &search_term(&fixture),
            );
            fixture["queries"] = json!(steps);
            let queries = run_query_steps(&replay.pool, &fixture, &labels).await;
            BackendRun {
                snapshot: replay.snapshot,
                records,
                queries,
            }
        });
        declare_refusals(&mut fixture, &backend.records);
        let ops = fixture["ops"].as_array().expect("rendered ops");
        for (op, record) in ops.iter().zip(&backend.records) {
            // A space write is tallied apart, so the floor can hold it.
            let command = match op["command"].as_str().expect("rendered command") {
                "set_property" if op["args"]["key"] == SPACE_PROPERTY_KEY => "set_property(space)",
                command => command,
            };
            *reached.borrow_mut().entry(command.to_owned()).or_default() += 1;
            if let Some(kind) = record["error"].as_str() {
                *refused
                    .borrow_mut()
                    .entry(format!("{command} -> {kind}"))
                    .or_default() += 1;
            }
        }

        let mock = bridge.borrow_mut().replay(&fixture).map_err(|error| {
            let path = write_counterexample(&fixture, &backend, &[]);
            TestCaseError::fail(format!(
                "the mock diverged from the backend's record of a command: {error}\n\
                 counter-example written to {}",
                path.display()
            ))
        })?;
        for (step, result) in fixture["queries"]
            .as_array()
            .into_iter()
            .flatten()
            .zip(backend.queries.as_array().into_iter().flatten())
        {
            // A grouped read always carries its `filtered#count` trailer and
            // `count_trash` its count, so a zero one is no answer.
            if result["rows"].as_array().is_some_and(|rows| {
                rows.iter().any(|row| {
                    let row = row.as_str().unwrap_or_default();
                    !row.starts_with("filtered#count=0#") && row != "count_trash#value=0"
                })
            }) {
                let command = step["command"].as_str().expect("read command").to_owned();
                *read.borrow_mut().entry(command).or_default() += 1;
            }
        }

        let records = json!(backend.records);
        if mock.snapshot == backend.snapshot
            && mock.records == records
            && mock.queries == backend.queries
        {
            return Ok(());
        }
        let reads = diverging_reads(&backend.queries, &mock.queries);
        let path = write_counterexample(&fixture, &backend, &reads);
        let reads: Vec<String> = reads
            .iter()
            .map(|&i| {
                format!(
                    "{}\n    backend: {}\n    mock:    {}",
                    fixture["queries"][i]["name"], backend.queries[i], mock.queries[i]
                )
            })
            .collect();
        Err(TestCaseError::fail(format!(
            "mock ⇄ backend divergence\n  backend: {} {records}\n  mock:    {} {}\n  \
             diverging reads: {reads:#?}\ncounter-example written to {} — move it into \
             conformance/fixtures/ to pin it",
            backend.snapshot,
            mock.snapshot,
            mock.records,
            path.display()
        )))
    });

    // The coverage report (#4669 acceptance): what the generator ACTUALLY
    // reached, printed before the assertion so a failing run still shows it.
    let reached = reached.into_inner();
    eprintln!(
        "#4669 differential fuzz reached {} distinct commands:",
        reached.len()
    );
    for (command, count) in &reached {
        eprintln!("  {command}: {count}");
    }
    let refused = refused.into_inner();
    eprintln!("#6054 and the backend refused, by command and kind:");
    for (refusal, count) in &refused {
        eprintln!("  {refusal}: {count}");
    }
    eprintln!("#6054 and the reads that answered rows, by command and case count:");
    for (command, count) in &read.into_inner() {
        eprintln!("  {command}: {count}");
    }

    if let Err(error) = result {
        match error {
            TestError::Fail(reason, _) => panic!("{reason}"),
            TestError::Abort(reason) => panic!("proptest aborted: {reason}"),
        }
    }

    for command in EXPECTED_COMMANDS {
        assert!(
            reached.contains_key(*command),
            "the generator reached {:?}, which does not include '{command}' — the generator or \
             `chain_to_fixture` narrowed, so this lane is comparing less than it claims",
            reached.keys().collect::<Vec<_>>(),
        );
    }
}

/// The search term skips a word the read steps would expand as a label: a
/// generated `C02` once named a block the chain never made, and the replay
/// panicked.
#[test]
fn search_term_skips_a_label_shaped_word() {
    let fixture = json!({ "ops": [{ "args": { "content": "C02 S12 plain" } }] });
    assert_eq!(
        search_term(&fixture),
        "plain",
        "a label-shaped word is no search term"
    );
}
