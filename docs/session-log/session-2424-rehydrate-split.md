# Session 2424 — The boot rehydrate split: the index rebuild dominates at 100K blocks

#5707 step 1: split the boot-time Loro rehydrate into its two parts, give each
its own `scripts/measure-boot.mjs` milestone, and measure which part dominates.
No optimisation in this step.

**The seam.** `LoroEngine::import` (`agaric-engine/src/loro/engine/snapshot.rs`)
ran the doc import and its format gates, then `rebuild_index` and the one-time
sibling-order migration. It is now `import_deferring_index` followed by
`rebuild_index_after_import`, and `import` calls both, so every other caller is
unchanged. `rehydrate_registry` (`agaric-engine/src/loro/snapshot.rs`) imports
every space first and logs `loro: imported per-space LoroDoc snapshots …` once,
then rebuilds every index. The existing `loro: rehydrated per-space …` line in
`lib.rs` stays as the end of the whole rehydrate. The harness reads the new
line as `snapshotsImported`, so its steps show
`identityLoaded->snapshotsImported` (the SQL read of the snapshots plus the doc
import) and `snapshotsImported->rehydrated` (the index rebuild).

**Trap.** Loro 1.13 decodes imported container state lazily
(`loro-internal`'s `ContainerWrapper`), so the import step is cheap and the
index walk pays the decode of the tree and of every live node's meta map. The
split times the code seam, not "parse" against "walk".

**Method.** The same harness and isolation as session 2324, with this branch's
release build (`npm run tauri -- build --no-bundle`), 14 boots per scenario,
rewind 0. The baselines are copies: the warmed synthetic vault from session
2324 (99,992 blocks, 140,305 ops, a 30 MB snapshot in one space) and a copy of
`vault-baseline` (1,586 live blocks). Each copy got one warm-up boot with a
clean close, which applied the pending migrations (through 0126) and re-saved the snapshots.
Load average was 4.7–7.7, lower than in session 2324, so these totals are not
comparable with that session's.

Medians in ms, [min–max]. Share is the part's median over the median of log
start → sync started (backend) and log start → `boot resolved` (boot).

| Part | Synthetic 100K | Share backend / boot | Real-vault copy | Share backend / boot |
|---|---|---|---|---|
| snapshot import | 167.5 [151–345] | 17% / 12% | 8 [7–12] | 11% / 2% |
| index rebuild | **588** [499–1,050] | **59%** / 43% | 5 [4–5] | 7% / 1% |
| log start → sync started | 996.5 [843–1,672] | | 71 [41–182] | |
| log start → `boot resolved` | 1,376 [1,144–2,930] | | 350.5 [305–498] | |

**Reading.** At 100K blocks the index rebuild is about 3.5 times the import.
Read on its own from a copy of the database, the 30 MB snapshot `SELECT` took
12–66 ms, so `doc.import` is roughly 100–150 ms of the import step. On the real
vault both parts are noise next to the webview.

**For step 2.**
- The trimmed or shallow snapshot shrinks only the import step, at most about
  170 ms here. It does not touch the state that the index walk decodes.
- Building the index from SQL removes the boot walk. The decode then moves to
  the first read of each node, so it pays only if nothing else at boot reads
  the whole tree. Check that first.
- Lazy per-space engines do not help this vault, whose 100K blocks sit in one
  space.
- No Criterion or `interactive_slo` bench covers the boot rehydrate.
  `engine_checkpoint`'s `promote_import` imports a one-op delta, and
  `sync_import_bench` covers the sync path. The issue's Criterion group is
  still to write.

**Isolation.** `vault-baseline` and the session-2324 synthetic vault were only
copied; their mtime fingerprints and `vault-baseline`'s `notes.db` md5 did not
change. The fingerprint of `~/.local/share/com.agaric.app` did change. The
maintainer's own Agaric instance is running and holds that `notes.db`. Its log
last changed at 16:02, before the first boot at 16:09, and its WAL changed at
16:13:09, after the last boot ended at 16:13:01.

**Gates.**
- `rehydrate_registry_logs_the_import_milestone_once_after_every_space_5707`
  was shown red by renaming the message (0 lines) and by logging a zero space
  count. Skipping the index pass turned
  `rehydrate_registry_seeds_engines_from_persisted_snapshots` red.
- `cargo nextest run --workspace -E 'test(/rehydrat|import|snapshot|reload_registry/)'`:
  501 passed.
- `cargo clippy --workspace --all-targets -- -D warnings`,
  `SQLX_OFFLINE=true cargo check --workspace --all-targets` and
  `cargo fmt --check` are clean.
- `node --check`, oxlint and oxfmt pass on the harness.
