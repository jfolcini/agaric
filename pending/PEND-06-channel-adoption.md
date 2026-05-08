# PEND-06 — Tauri 2 `Channel<T>` adoption for streaming progress

> **Status (Tier 1, sync progress):** Phase 1 shipped in 0.1.18
> (`Channel<SyncProgressUpdate>` wired through `start_sync` →
> `SyncScheduler` → `try_sync_with_peer` → `ChannelEventSink`, with
> `app.emit('sync:progress')` kept in lockstep as a migration runway).
> Phase 2 landed on main in commit `0da059a7` (drops the
> `sync:progress` dual-emission and the matching `useSyncEvents`
> listener; ships in 0.1.19+). `Complete` and `Error` events still
> dual-emit because the inner sink's listeners carry post-sync side
> effects the channel-stream callback does not duplicate.
>
> **Tier 2 (file transfer streaming) — not started.** Independent of
> Tier 1; tracked in this same plan file.

## What `Channel<T>` is

Tauri 2's `tauri::ipc::Channel<T>` enables **bidirectional streaming** from backend to frontend within a single IPC invocation. Unlike `app.emit("event-name", payload)` (fire-and-forget, requires a separate listener registration on the frontend), a `Channel` is passed as a command parameter, held open for the duration of the operation, and lets the backend send multiple typed messages through it. The frontend awaits the command's completion while receiving progress updates on the same logical connection. Two upsides over `app.emit`:

1. **Type safety end-to-end** via specta — the message type is part of the command signature.
2. **Lifetime-scoped** — no manual listener cleanup; the channel dies with the command.

Today the codebase has **zero `Channel<T>` uses** (grep-confirmed in `src-tauri/`). All progress is reported via `app.emit()` + `useTauriEventListener` on the frontend (see `sync_events.rs` `SyncEventSink` trait, `src/hooks/useSyncEvents.ts`).

## Candidate flows ranked by user value

### Tier 1 — Sync progress (highest value)

Sync is the most user-visible long-running operation and the one with the worst current UX: a spinner, no idea if you're at 5% or 95%. The `SyncOrchestrator` (`src-tauri/src/sync_protocol/orchestrator.rs`) already emits fine-grained state transitions (HeadExchange → OpBatch → Merge → SyncComplete); the `SyncEventSink` trait already abstracts emission. Channel adoption is mechanical: redirect emissions through the channel parameter instead of (or in addition to) the existing event sink. Expect a real "Received 142/542 ops (26%)" UI as the user-visible win.

### Tier 2 — File transfer progress (high value)

`sync_files/` already chunks attachments into 5 MB binary frames. Currently `FileTransferStats` is returned only at the end; users see nothing during a 100 MB push. Per-frame `Channel.send(FileProgressUpdate { bytes_done, bytes_total })` gives a real progress bar. Especially valuable on Android over slow networks.

### Tier 3 — Import progress (medium value)

`import_markdown` is currently transactional (all-or-nothing within a single SQL transaction). Streaming progress mid-transaction is non-trivial — it would require restructuring (per-block savepoints, or progress emission outside the transactional boundary). Lower user value (imports are rare), higher implementation cost. Defer.

## Top candidate plan: Sync progress

### Backend

**1. Define `SyncProgressUpdate` type** in `src-tauri/src/sync_events.rs`:

```rust
use specta::Type;
use serde::Serialize;

#[derive(Debug, Clone, Serialize, Type)]
pub struct SyncProgressUpdate {
    pub state: String,                  // "exchanging_heads" | "streaming_ops" | "applying_ops" | "merging" | "complete" | "error"
    pub remote_device_id: String,
    pub ops_received: u64,
    pub ops_sent: u64,
}
```

**Reviewer correction:** the original draft listed `"files"` as one of the emitted states, citing a `SyncState::TransferringFiles` variant. That variant is *defined* in `sync_protocol/types.rs` but **never emitted** — file transfer happens in a separate daemon sub-flow *after* the orchestrator exits to `Complete`. The accurate Tier 1 state set is the 5 above. File-transfer progress is genuinely Tier 2 work (see below) and requires daemon-layer plumbing, not just orchestrator instrumentation.

**2. Add channel parameter to `start_sync`** in `src-tauri/src/commands/sync_cmds.rs`:

```rust
#[tauri::command]
#[specta::specta]
pub async fn start_sync(
    scheduler: State<'_, SyncScheduler>,
    device_id: State<'_, DeviceId>,
    peer_id: String,
    progress: tauri::ipc::Channel<SyncProgressUpdate>,
) -> Result<SyncSessionInfo, AppError> { … }
```

**3. Thread channel through daemon → orchestrator.** `try_sync_with_peer` (`sync_daemon/orchestrator.rs`) accepts the channel and passes it to `SyncOrchestrator::new`. Orchestrator holds it (likely as `Arc<Channel<…>>` if shared with sub-tasks; verify via Tauri docs) and calls `channel.send(SyncProgressUpdate { … })` at each state transition.

**4. Keep `SyncEventSink` for one release** as a fallback so existing `useSyncEvents` listeners still work during transition. Phase 2 removes them.

### Frontend

**1. Update wrapper** in `src/lib/tauri.ts`:

```typescript
import { Channel } from '@tauri-apps/api/core'

export async function startSync(
  peerId: string,
  onProgress?: (update: SyncProgressUpdate) => void,
): Promise<SyncSessionInfo> {
  const channel = new Channel<SyncProgressUpdate>()
  if (onProgress) channel.onmessage = onProgress
  return unwrap(await commands.startSync(peerId, channel))
}
```

**2. Update `useSyncTrigger`** to feed progress directly into `useSyncStore` via the callback, removing the separate `useSyncEvents` subscription on the same flow.

**3. Deprecate `useSyncEvents`** for sync progress. Other event types (peer discovery, conflict notifications) stay on `app.emit` — they're not progress streams.

### Migration phases

**Phase 1 (this release):** Channel param added; backend emits **on the channel AND via `app.emit` simultaneously** during the transition window. The double emission is intentional: it lets new components migrate at their own pace without breaking old `useSyncEvents` listeners. Cost is one extra serialization per state transition — negligible for the ~10 transitions per sync.

**Phase 2 (next release):** Drop the `app.emit` fallback for sync progress. Drop the sync-progress subscription in `useSyncEvents` (the rest of `useSyncEvents` — peer discovery, conflict notifications — is event-shaped and stays).

## Tier 2 plan: File transfer

**Important context (reviewer correction):** file transfer runs *after* the orchestrator's `Complete` state, in `sync_files::run_file_transfer_initiator` / `run_file_transfer_responder`, called by the daemon directly. It is **not** part of the sync_protocol/orchestrator state machine. To stream progress, the daemon must accept a `Channel` (or `Arc<Channel>`) and forward it into `run_file_transfer_*`.

Add `FileProgressUpdate` (similar shape: `phase`, `files_done/total`, `bytes_done/total`). The cleanest design: convert `SyncProgressUpdate` into a tagged enum so a single channel carries both phases:

```rust
#[derive(Debug, Clone, Serialize, Type)]
#[serde(tag = "kind")]
pub enum SyncProgressUpdate {
    Sync   { state: String, remote_device_id: String, ops_received: u64, ops_sent: u64 },
    Files  { phase: String, remote_device_id: String, files_done: u64, files_total: u64, bytes_done: u64, bytes_total: u64 },
}
```

Emit per 5 MB binary frame (`BINARY_FRAME_CHUNK_SIZE` in `sync_constants.rs`). Single-channel keeps the frontend simpler.

**Cost adjustment:** Tier 2 needs ~2-4h more than the original draft estimated, because the channel must be threaded through the daemon's session lifecycle, not just the orchestrator. New estimate: **M (~6-9h)** for Tier 2 standalone.

## Tier 3 plan: Import progress

Defer until import is restructured. The current single-transaction model is the right choice for atomicity; mixing in per-block progress requires splitting into a parse phase (fast, in-memory) + an apply phase (per-block savepoints) and is bigger scope than a Channel adoption.

## Specta integration

Specta 2.0.0-rc.24 (the pinned version) does not auto-derive bindings *for* `Channel<T>`, but it does pass the inner type through correctly. The generated TypeScript binding looks like `(peerId: string, progress: Channel<SyncProgressUpdate>) => Promise<…>`. Verify on the first PR by running `cargo test specta_tests --ignored` and inspecting `src/lib/bindings.ts`. If the binding is missing, the workaround is a manual type annotation in the wrapper — not expected to be needed.

## Files touched

**Tier 1 — sync progress:**

- `src-tauri/src/sync_events.rs` — add `SyncProgressUpdate`
- `src-tauri/src/commands/sync_cmds.rs` — `start_sync` signature
- `src-tauri/src/sync_daemon/orchestrator.rs` — thread channel
- `src-tauri/src/sync_protocol/orchestrator.rs` — emit at state transitions
- `src/lib/tauri.ts` — wrapper update
- `src/hooks/useSyncTrigger.ts` — switch to callback
- `src/hooks/useSyncEvents.ts` — deprecate sync-progress branch

**Tier 2 — file transfer:**

- `src-tauri/src/sync_files.rs` (or `sync_files/`) — add `FileProgressUpdate` variant + per-frame emit
- Daemon plumbing as above

## Testing

**Backend:**

- `start_sync_streams_progress_through_channel` — record channel sends via a `RecordingChannel` test double; assert the expected sequence of state transitions appears.
- `file_transfer_emits_per_frame_progress` — same shape for the file phase.

**Frontend:**

- `src/__tests__/hooks/useSyncTrigger.test.ts` — mock `commands.startSync` to invoke `channel.onmessage`; assert `useSyncStore` updates accordingly.

**E2E:**

- `tests/sync.spec.ts` (Playwright) — start a sync between two test instances; poll the sync store's `opsReceived` counter, assert it increments during the operation, not just at the end.

## Cost

| Tier | Effort | Notes |
| --- | --- | --- |
| Tier 1 (sync) | M (~6-10h) | Most plumbing, biggest UX win |
| Tier 2 (files) | M (~4-6h) | Reuses Tier 1 infrastructure |
| Tier 3 (import) | L | Deferred — needs restructuring first |
| **Total Tier 1+2** | M-L (~10-16h) | Single sprint |

## Impact

**User-visible:** real progress UI for sync and large-file transfers. Closes a recurring "is sync stuck?" UX paper-cut.

**Maintainability:** unified progress pattern (channel) instead of mixed `app.emit` + listener registration. Fewer moving parts on the frontend.

**Type safety:** specta-enforced contract for progress messages.

## Risk

**Low overall.** Channel is stable in Tauri 2.x. Specific risks:

1. **Specta binding generation** — verify channel parameters generate clean bindings on first PR. Mitigation: trivial to fall back to manual annotation if needed.
2. **Daemon lifetime threading** — if multiple sub-tasks need to write to the channel, may need `Arc<Channel<…>>`. Mitigation: confirm pattern from Tauri docs before starting; the `SyncEventSink` `Arc` shape is the template.
3. **Frontend regression** — Phase 1 keeps the `app.emit` fallback so a missed migration doesn't break a UI that still listens for the old events.

## Open questions

1. **Can `Channel<T>` be cloned / wrapped in `Arc`?** — verify via Tauri 2 docs before threading through daemon → orchestrator → sub-tasks. The current `SyncEventSink` shape (`Arc<dyn Trait>`) is the template if Channel needs to be shared.
2. **Frontend Channel API shape** — verify `channel.onmessage = fn` vs `channel.on('message', fn)` in `@tauri-apps/api/core`. The wrapper code in this plan assumes `onmessage`; correct on first PR if wrong.
3. **Single channel for sync+files vs separate channels?** — recommend single with the tagged enum above (one frontend listener, type-narrowed variants).
4. **Should other long-running flows (snapshot transfer, FTS index rebuild) also adopt Channel?** — yes, but ship sync + files first; treat the rest as additive.
5. **Specta auto-derive `Channel<T>`?** — verify on first PR by inspecting generated `bindings.ts`. If the generic parameter doesn't propagate, fall back to manual type annotation in the wrapper layer.
