# Session 2452 — The block index from SQL: no TreeIDs to build it from

#5707 step 2: try building each engine's `block_id → TreeID` index from SQL
instead of walking the Loro tree, the part session 2424 found dominant at boot.
Nothing in the engine changed. The two rehydrate halves became `pub` for a new
Criterion group.

**Premise: SQL holds no TreeID.** No migration declares one, and no code
outside `agaric-engine/src/loro/engine/` names the type. A `TreeID` is the
Loro id of the node's create op. The block id it maps from lives only in the
node's meta map (`FIELD_BLOCK_ID`), so the index cannot exist without reading
every node's meta from Loro, and the option as stated cannot be built.

**Where the walk's time goes.** A release probe against loro 1.13.6 (no LTO)
on the synthetic vault's 30 MB snapshot (105,052 live nodes), median of 7:

- `doc.import`: 40 ms.
- The first `get_nodes(false)`: 206 ms. Almost all of it is the lazy decode
  of the tree container: `nodes()` costs the same, and a later `get_nodes`
  costs about 14 ms.
- `get_meta` for every node: 22 ms. Reading `block_id` and inserting it into
  the map: 177 ms. A second walk of the same doc costs 64 ms.
- The first read of one block on a fresh doc: 214 ms. That is the tree
  decode again, which any engine read pays.

**Q2: the boot reads the engine right after the rehydrate.**
`snapshot_watermark` (`agaric-engine/src/loro/snapshot.rs`) stamps one below
the head, so every healthy boot re-applies that one op. The path runs through
`replay_unmaterialized_ops`, then `apply_*_via_loro`, then `read_block`, then
`node_for`, and so needs the index and the tree.

**Deferral, measured.** This was a throwaway build: the index sat in a lazy
cell built on first use and logged its split. It ran with the session-2424
harness and isolation: 14 interleaved boots per binary, rewind 0, against
session 2424's `agaric-split` as the control, on copies of the same synthetic
and real-vault baselines. Medians in ms, [min–max]:

| Part | Synthetic control | Synthetic deferred | Real-vault control | Real-vault deferred |
|---|---|---|---|---|
| snapshot import | 156 [145–176] | 158 [153–173] | 9 [8–21] | 9 [7–10] |
| index rebuild | 459.5 [437–613] | 0 [0–1] | 4 [4–14] | 0 [0–0] |
| replay | 6 [5–7] | 504 [492–688] | 2 [1–4] | 7 [6–8] |
| log start → sync started | 777.5 [725–1,085] | 849.5 [777–1,156] | 120 [53–258] | 101.5 [41–201] |
| log start → `boot resolved` | 1,096.5 [1,010–1,522] | 1,137 [1,063–1,890] | 447 [361–1,075] | 413.5 [364–638] |

Every deferred 100K build fired inside the replay, so `boot resolved` does not
move. On the real vault the gap is noise: `logInit->poolsOpen`, which the
change does not touch, differs by 16 ms. In the app the build split into the
tree decode (`get_nodes`) at 265.5 ms [250–312] and the meta reads at
235.5 ms [220–382].

**What could still pay.** Only the meta half is specific to the index; the
replayed op pays the tree decode anyway. Persisting the index beside each
snapshot in `loro_doc_state` would replace the meta half with a 4 MB read
that decodes in about 13 ms. The ceiling is about 220 ms at 100K, roughly a
fifth of `boot resolved`. It needs a new column, which is a migration.
`save_all_engines` exports from a doc handle outside the engine lock, so the
stored index would also have to carry the frontiers it matches, with a walk as
the fallback. Not built: that is the maintainer's call.

**Bench.** `rehydrate` in `engine_bench` (`benches/groups/rehydrate_bench.rs`)
times `snapshot_import` and `index_rebuild` on a fresh engine per sample, at
10K and 100K blocks (a page per 100). The rebuild sample ends with one block
read, so deferring the walk cannot read as a win. Its shape probe asserts
that the rebuilt index resolves every seeded block. Under `release-test`, at
load 5–6: `snapshot_import` 2.2 ms and 25.0 ms, `index_rebuild` 40.5 ms and
500.9 ms. The group is registered right after `engine_checkpoint`.
`sync_import_bench`'s outer body asserts that it ran at least one iteration,
so any name-filtered run of `engine_bench` panics there, after the groups
before it have reported.

**Isolation.** Both baselines were copied, and their fingerprints and
`notes.db` md5s did not change. Every boot ran on a fresh copy under
`TMPDIR` in the scratch dir, through the harness's own
`unshare`/`xvfb-run`/`dbus-run-session` isolation. The lazy-index experiment
was restored from backups after its build.

**Gates.**
- The shape probe went red (`left: 0, right: 10000`) with
  `rebuild_index_after_import` skipping `rebuild_index`.
- The full `engine_bench --test` passed under `release-test`: 75 successes.
- `cargo nextest run --workspace -E 'test(/rehydrat|import|snapshot|reload_registry/)'`:
  501 passed. `-E 'package(agaric-engine)'`: 1,191 passed.
- `cargo clippy --workspace --all-targets -- -D warnings`,
  `SQLX_OFFLINE=true cargo check --workspace --all-targets` and
  `cargo fmt --all --check` are clean.
