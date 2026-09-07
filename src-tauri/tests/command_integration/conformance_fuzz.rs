//! #4669 — differential fuzzing of the tauri mock against the real backend.
//!
//! The committed `conformance/fixtures/*.json` corpus is an excellent
//! *specification* mechanism and a poor *regression net*: every divergence it
//! has ever caught was caught when someone authored a new fixture, never by the
//! existing ~44 sequences turning red on an unrelated change. This lane closes
//! that gap by generating the sequences instead of hand-writing them:
//!
//! 1. `op_chain_strategy` (the materializer proptests' generator) produces a
//!    structurally valid op chain;
//! 2. [`chain_to_fixture`] renders it in the conformance fixture vocabulary;
//! 3. [`replay_fixture`] drives it through the REAL backend and snapshots;
//! 4. [`MockBridge`] drives the SAME fixture through the TS mock and snapshots;
//! 5. the two snapshots must be equal, and proptest shrinks any mismatch to a
//!    minimal chain, which is written out as a ready-to-commit fixture.
//!
//! ## Why a child process
//!
//! The mock is TypeScript. A long-lived `node` process reading newline-
//! delimited JSON is what makes the comparison affordable inside a proptest
//! loop, where shrinking replays a chain dozens of times: one esbuild bundle
//! and one process start, then one line per candidate chain. The bundle entry
//! point is `src/lib/tauri-mock/__tests__/conformance-fuzz-bridge.ts`, and it
//! calls the SAME `replayFixture` that `conformance.test.ts` runs over the
//! committed corpus under vitest — so the two module pipelines are
//! cross-checked on every PR by the corpus, and only the driver is new here.
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
//! the attachment ops (no mock handler and no fixture vocabulary),
//! `SetProperty(space)` (see [`chain_to_fixture`]), `[[…]]` link tokens (the
//! generator's content alphabet has no brackets, so `page_links` is always
//! empty here — it is pinned by the `edit_then_move_link_survives` and
//! `page_links_stats` fixtures instead), and everything the snapshot itself
//! omits (return values, error paths, timestamps, caches). The reached-command
//! tally the lane prints is the honest statement of what it did cover.

use std::cell::RefCell;

use super::conformance::replay_fixture;
use agaric_engine::proptest_db_harness::{OpKind, op_chain_strategy, resolve_chain};
use agaric_store::op::{OpPayload, SPACE_PROPERTY_KEY};
use proptest::test_runner::{Config, TestCaseError, TestError, TestRunner};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

/// Cases per run. Low by default (each case migrates a fresh SQLite DB and
/// round-trips a child process); the lane bumps it via `PROPTEST_CASES`.
/// 256, measured rather than picked: 64 reached only seven of the ten commands
/// the renderer can emit, so the lane was comparing less than it claimed. At
/// 256 all ten appear and the run takes ~48s (11s of that is the property
/// itself; the rest is proptest generating and the backend replaying). See the
/// nextest `slow-timeout` override that goes with it — 48s against the default
/// 2x30s window is not enough headroom.
const DEFAULT_CASES: u32 = 256;

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
/// applies.
const SEED_TAG: &str = "S2";

/// The commands a generated chain is expected to reach. Asserted as a floor on
/// the reached tally so the lane cannot quietly degrade to "create + edit" when
/// the generator or the renderer narrows — the failure mode #4669 names as
/// "coverage that is assumed rather than visible".
///
/// MEASURED, not assumed. Over [`DEFAULT_CASES`] the tally came out
/// `create_block` 287, `edit_block` 93, `set_property` 78, `move_block` 70,
/// `delete_block` 44, `add_tag` 40, `remove_tag` 35 — and then a long tail:
/// `restore_block` 7, `delete_property` 4, `purge_block` 4. The seed is random
/// per run (that is the point of a fuzz lane), so asserting on the tail would
/// make this flaky rather than strict: at ~4 expected hits, a run that draws
/// zero is a couple of percent, and a weekly lane that reddens on its own RNG
/// teaches people to re-run it without reading it.
///
/// So the floor covers the seven robust ones and the tail is REPORTED instead —
/// every run prints the full tally, which is what makes a narrowing visible
/// whether or not it crosses this list.
const EXPECTED_COMMANDS: &[&str] = &[
    "add_tag",
    "create_block",
    "delete_block",
    "edit_block",
    "move_block",
    "remove_tag",
    "set_property",
];

// ---------------------------------------------------------------------------
// Chain → fixture
// ---------------------------------------------------------------------------

/// The fixture seed every generated chain starts from: a page to hang the tree
/// off and a page to use as a tag target.
fn seed() -> Value {
    json!({
        "blocks": [
            { "id": SEED_PAGE, "block_type": "page", "content": "Home", "parent_id": null, "position": 1 },
            { "id": SEED_TAG, "block_type": "page", "content": "tag", "parent_id": null, "position": 2 },
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
/// Dropped, because neither the fixture vocabulary nor the mock has them:
///
/// * `AddAttachment` / `DeleteAttachment` — attachment apply writes the
///   `attachments` table and touches the filesystem; there is no mock handler
///   and no snapshot column, so a rendered op would be uncomparable, not
///   covered.
/// * `SetProperty(space)` — a page-group space migration writes
///   `blocks.space_id`, which the snapshot deliberately excludes on BOTH sides
///   (`parity_property_key` here, the `key === 'space'` skip in
///   `conformance-snapshot.ts`). Rendering it would add op_log-digest noise for
///   an effect neither side can observe.
fn chain_to_fixture(payloads: &[OpPayload], name: &str) -> Value {
    let mut label_of: BTreeMap<String, String> = BTreeMap::new();
    let mut creates = 0usize;
    let mut ops: Vec<Value> = Vec::new();

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

    for payload in payloads {
        let op = match payload {
            OpPayload::CreateBlock(c) => {
                creates += 1;
                let parent = c
                    .parent_id
                    .as_ref()
                    .map_or_else(|| SEED_PAGE.to_owned(), |p| label(&label_of, p.as_str()));
                label_of.insert(c.block_id.as_str().to_owned(), format!("C{creates}"));
                json!({ "command": "create_block", "args": {
                    "parentId": parent,
                    "blockType": c.block_type,
                    "content": c.content,
                    // The generator's 1-based `position` read as the 0-based
                    // insert `index` the command takes. Values past the sibling
                    // count are kept, not clamped here: how each side clamps a
                    // tail index is exactly what this lane is comparing.
                    "index": c.position.unwrap_or(1) - 1,
                }})
            }
            OpPayload::EditBlock(e) => json!({ "command": "edit_block", "args": {
                "blockId": label(&label_of, e.block_id.as_str()),
                "toText": e.to_text,
            }}),
            OpPayload::MoveBlock(m) => {
                let new_parent = m
                    .new_parent_id
                    .as_ref()
                    .map_or_else(|| SEED_PAGE.to_owned(), |p| label(&label_of, p.as_str()));
                json!({ "command": "move_block", "args": {
                    "blockId": label(&label_of, m.block_id.as_str()),
                    "newParentId": new_parent,
                    "newIndex": m.new_index.unwrap_or(m.new_position) - 1,
                }})
            }
            OpPayload::DeleteBlock(d) => json!({ "command": "delete_block", "args": {
                "blockId": label(&label_of, d.block_id.as_str()),
            }}),
            OpPayload::RestoreBlock(r) => json!({ "command": "restore_block", "args": {
                // `deleted_at_ref` is sourced from the live tombstone by the
                // Rust runner, exactly as `restore_block_inner` does, so the
                // fixture op carries no guard (the mock has none either).
                "blockId": label(&label_of, r.block_id.as_str()),
            }}),
            OpPayload::PurgeBlock(p) => json!({ "command": "purge_block", "args": {
                "blockId": label(&label_of, p.block_id.as_str()),
            }}),
            OpPayload::SetProperty(s) if s.key != SPACE_PROPERTY_KEY => {
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
            OpPayload::DeleteProperty(d) if d.key != SPACE_PROPERTY_KEY => {
                json!({ "command": "delete_property", "args": {
                    "blockId": label(&label_of, d.block_id.as_str()),
                    "key": d.key,
                }})
            }
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

    json!({ "name": name, "seed": seed(), "ops": ops, "expected": null })
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

    /// Replay `fixture` through the mock and return its normalized snapshot, or
    /// the mock's own rejection message.
    fn snapshot(&mut self, fixture: &Value) -> Result<Value, String> {
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
            Ok(response["snapshot"].clone())
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

/// Write a counter-example out as a ready-to-commit fixture: the generated
/// chain plus the backend's snapshot as `expected`, so dropping it into
/// `conformance/fixtures/` turns the shrunk divergence into a permanent
/// regression test on BOTH runners.
fn write_counterexample(fixture: &Value, backend: &Value) -> PathBuf {
    let mut out = fixture.clone();
    out["description"] = json!(
        "#4669 — minimized counter-example from the differential-fuzz lane. \
               Backend-authored `expected`; move into conformance/fixtures/ to pin it."
    );
    out["expected"] = backend.clone();
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

/// The mock's snapshot of a generated op chain equals the real backend's.
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
    let mut config = Config::default();
    if std::env::var_os("PROPTEST_CASES").is_none() {
        config.cases = DEFAULT_CASES;
    }
    // The counter-example file is this lane's artefact; proptest's own
    // regression file would pin an opaque seed instead of a readable fixture.
    config.failure_persistence = None;
    let mut runner = TestRunner::new(config);

    let result = runner.run(&op_chain_strategy(CHAIN_LEN), |sketches: Vec<OpKind>| {
        let fixture = chain_to_fixture(&resolve_chain(&sketches), "conformance_fuzz_generated");
        for op in fixture["ops"].as_array().expect("rendered ops") {
            let command = op["command"].as_str().expect("rendered command");
            *reached.borrow_mut().entry(command.to_owned()).or_default() += 1;
        }

        let backend = tokio::runtime::Runtime::new()
            .expect("tokio runtime")
            .block_on(async {
                replay_fixture(&fixture, "conformance_fuzz_generated")
                    .await
                    .snapshot
            });
        let mock = bridge.borrow_mut().snapshot(&fixture).map_err(|error| {
            let path = write_counterexample(&fixture, &backend);
            TestCaseError::fail(format!(
                "the mock REJECTED a chain the backend applied: {error}\n\
                     counter-example written to {}",
                path.display()
            ))
        })?;

        if mock == backend {
            return Ok(());
        }
        let path = write_counterexample(&fixture, &backend);
        Err(TestCaseError::fail(format!(
            "mock ⇄ backend snapshot divergence\n  backend: {backend}\n  mock:    {mock}\n\
             counter-example written to {} — move it into conformance/fixtures/ to pin it",
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
