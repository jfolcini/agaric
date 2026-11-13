# Session 4092 — the conformance command leg crosses the app's IPC surface (#6529 stage 1a)

The session was briefed to build stage 1b of #6529, the bridge binary, as "the next unticked stage". Stage 1a was unticked too and none of it was on `main`: no `HeadlessApp`, a `Wry`-only `build_invoke_handler`, no PR, no branch but the spike's. Stage 1b serves a `HeadlessApp`, so it cannot come first. This PR is stage 1a alone, on the branch the brief named (`claude/6529-headless-bridge-1b`).

## Shipped

- **The command surface is generic over the runtime.** `build_invoke_handler<R>` and the 21 wrappers that took a concrete `tauri::AppHandle` (the spike's 19 and the two `daily_snapshot` commands `main` gained since). `agaric_commands!` names them `cmd::<tauri::Wry>`: specta's export needs a concrete function, and `collect_commands!` strips the turbofish before `generate_handler!`, which infers `R`. `bindings.ts` is unchanged.
- **`headless::HeadlessApp`** (`test-util`): the production handler and `register_managed_state` on `tauri::test::MockRuntime`, with `invoke(cmd, args)`. `HeadlessDataDir` is the per-app data dir `resolve_app_data_dir` answers first.
- **`conformance_ipc.rs` is the only path for a `via: "command"` op**, for checking, for authoring under `CONFORMANCE_UPDATE=1` and for the fuzz. `apply_op_via_command`, its argument decoding and the source-scanning test that counted its arms are deleted: `conformance_command.rs` goes from 1,896 lines to 808, and the transport is 307.

## Decisions

- **Less of the spike than "as it stands".** `HeadlessApp::boot` and `shutdown`, the reset timing test and the `agaric-sync/test-util` edge they needed stay on the spike branch: nothing in this stage calls them, and stage 1b's bridge and its reset measurement do. The spike also managed `MirrorState` and the two mDNS status states; every fixture passes without them, so they are left out. A command that reads state `setup_app` registers elsewhere is refused by tauri as unmanaged, which stage 1b will meet.
- **No task-local.** The spike routed ops through a task-local so both transports could coexist. With one transport, `replay_fixture` owns an `IpcTransport` and builds it for the first command op.
- **Anything but an `AppError` panics.** An arg that does not decode, or an unmanaged state, comes back from tauri as a bare string. That is not a refusal to record, least of all by the fuzz, whose records are the mock's declarations.
- **`ROWS_KEY`.** The wire nests a list return under a key (`WithOps<{ blocks: T[] }>`); the `*_inner` returned it bare. The TS twin's `RETURN_SHAPE` already carried `rows` for that, so the Rust side gained the same five entries.
- **Only `block:properties-changed` is recorded,** as before. The harness now records what the wrapper emitted; it does not widen which events a fixture pins.
- **`main` grew two arms mid-session.** #6709 added `split_block` and `merge_blocks` to the dispatcher. They were ported in the merge: the labels inside their `request` object, and two `ROWS_KEY` entries for the one row each response nests (`created`, `block`).
- **`start_pairing`** waits five seconds for a local endpoint. The dispatcher published one on a scheduler it built; the transport publishes one on the app's.

## Traps

- **The session's disk allowance.** `target/debug/incremental` reached 15 GB and a whole-workspace test build failed with "No space left on device". Delete it and run the gates with `CARGO_INCREMENTAL=0`.
- **A TS test parses the Rust command headers.** `conformance-coverage.test.ts`'s `extractRustCommandSignatures` did not allow `fn name<R: …>(` and lost the 21 generic wrappers. The guard scripts (`check-tauri-command-instrumented`, `-sanitize`) already did. Only the full vitest run shows it.
- **A renamed optional arg decodes as absent.** Renaming `set_priority`'s `level` did not fail in the IPC layer: tauri read `None`, and the fixture reddened because a declared refusal succeeded. A renamed required arg (`block_id`) is the one that panics with "did not reach its command".
- **Falsifying the data-dir seam writes to the real directory.** With the seam off the fixtures stay green and five attachment blobs land in `~/.local/share/attachments`; delete them afterwards. That silence is why `the_app_resolves_the_fixtures_own_data_dir` exists.

## Shown red

- A wrapper that drops its first `block:properties-changed` event: the fixtures fail on `expected_ops` (`batch_writes` first). On `main` the same break leaves `conformance_fixtures_match_backend` green.
- A wrapper whose required arg is renamed: "conformance op 'set_priority' did not reach its command".
- `resolve_app_data_dir` without the `HeadlessDataDir` branch: the seam test reads `/root/.local/share/`.

## What ran

On the branch merged with `main` at `37bd056`: both halves of `cargo nextest run --workspace` (4046 and 4038 passed, none retried), the full vitest suite, `npm run typecheck`, `npm run lint`, `just gen-sqlx` with no diff, `prek run --all-files` and the manual stage, and the random-seed differential fuzz (`--run-ignored only`). Re-authoring every fixture through IPC (`CONFORMANCE_UPDATE=1`, then `oxfmt`) left no diff, before that merge.

`main` moved six commits further before the push, none in the harness. On that last merge: `just gen-bindings` with no diff, `SQLX_OFFLINE=true cargo check --workspace --all-targets`, `cargo clippy --workspace --all-targets -- -D warnings` and the `command_integration` binary. The whole suite on that head is CI's.

Timing of the two tests the change touches, three isolated runs each on a 4-vCPU debug build: `conformance_fixtures_match_backend` 18.0 to 19.0 s on `main` and 18.4 to 20.5 s here, which overlap; the fixed-seed fuzz 7.1 to 7.5 s and 7.5 to 8.3 s, about half a second slower.

No Playwright or WebdriverIO spec ran locally: the change is test harness and signatures, and CI's lanes are the check.
