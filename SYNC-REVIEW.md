# Sync Feature — Deep Code Review

> **Date:** 2026-04-01
> **Scope:** Full backend + frontend sync feature review targeting Linux desktop and Android
> **Method:** 6 parallel discovery subagents (core, infrastructure, frontend, tests, schema, cross-platform) followed by 3 independent verification subagents cross-checking every finding against actual code. Only verified findings are included.

---

## Executive Summary

The sync feature is **Phase 4** — designed in ADR-09 but not yet implemented as a live feature. The building blocks (merge, DAG, op log, hash chain, conflict resolution, snapshots, device management) are solid and well-tested. The codebase is production-quality with extensive documentation and intentional Phase 4 TODOs.

**Key findings:**

| Category | Count | Verdict |
|----------|-------|---------|
| Confirmed bugs in existing code | 1 | MEDIUM severity |
| Documented limitations to harden before Phase 4 | 2 | LOW severity |
| Phase 4 implementation gaps (planned, not bugs) | 10 | Expected |
| Test coverage gaps | 6 | Important |
| Cross-platform risks to investigate | 5 | Phase 4 |
| False alarms debunked by verification | 12 | No action needed |

**Bottom line:** The existing code is correct. One real bug was found (`merge_text` fallback ancestor validation). The sync feature cannot work yet because the entire networking/pairing/protocol layer is unimplemented (Phase 4). Before shipping sync, the implementation gaps and test coverage gaps below must be addressed.

---

## 1. Confirmed Bug in Existing Code

### BUG-01: merge_text Fallback Path Does Not Validate create_block Found

| Field | Value |
|-------|-------|
| **Severity** | MEDIUM |
| **File** | `src-tauri/src/merge.rs` lines 96-138 |
| **Verified by** | Verification subagent 1 (CONFIRMED) |

**Description:**
When `find_lca()` returns `None` (no common ancestor found), the fallback walks the `prev_edit` chain from `op_ours` looking for the `create_block` root. If the chain is broken (e.g., after op log compaction), the loop exits without finding `create_block` and silently uses an empty string as the merge ancestor.

```rust
// merge.rs lines 96-138
None => {
    let mut current: Option<(String, i64)> = Some(op_ours.clone());
    let mut root_text = String::new();  // initialized to empty
    // ...
    while let Some(key) = current.take() {
        // ... walks prev_edit chain
        match record.op_type.as_str() {
            "create_block" => {
                root_text = payload.content;
                break;
            }
            "edit_block" => {
                current = payload.prev_edit;
            }
            // ...
        }
    }
    root_text  // returns empty string if create_block was never found
}
```

**Impact:** If the edit chain is broken, the merge uses empty string as the base ancestor, producing incorrect three-way merge results. Both sides' edits could be lost or garbled.

**Likelihood:** LOW (requires broken edit chain, which should not occur with proper compaction/snapshot workflow).

**Fix:** Add a `found_create` flag and return an error if the loop exits without finding `create_block`:

```rust
let mut found_create = false;
while let Some(key) = current.take() {
    // ... existing code ...
    "create_block" => {
        root_text = payload.content;
        found_create = true;
        break;
    }
}
if !found_create {
    return Err(AppError::InvalidOperation(format!(
        "no create_block found in edit chain for block '{}'; chain may be corrupted",
        block_id
    )));
}
```

---

## 2. Documented Limitations to Harden Before Phase 4

These are **not bugs** — the code is correct for Phase 1 (single-device). They are documented limitations that need attention when Phase 4 sync is implemented.

### HARDEN-01: Timestamp Comparison Assumes Consistent UTC Suffix

| Field | Value |
|-------|-------|
| **Severity** | LOW (mitigated by design) |
| **File** | `src-tauri/src/merge.rs` lines 235-240, 265 |
| **Code comment** | F05 |
| **Verified by** | Verification subagent 1 (CONFIRMED with caveats) |

`resolve_property_conflict()` compares RFC 3339 timestamps lexicographically. This is correct only when all timestamps use the same UTC suffix. The `now_rfc3339()` helper always emits `Z`, and all devices run the same code, so in practice all timestamps will use `Z`.

**Risk:** If a future code path or external import introduces `+00:00` format timestamps, LWW resolution would pick the wrong winner.

**Recommendation:** When implementing the sync protocol, add a normalization step that parses timestamps via `chrono::DateTime::parse_from_rfc3339` before comparison, or add a `debug_assert!` that all incoming timestamps end with `Z`.

---

### HARDEN-02: find_prev_edit Uses Clock-Based Ordering (Phase 4 Rework Required)

| Field | Value |
|-------|-------|
| **Severity** | LOW (Phase 1 correct, documented TODO) |
| **File** | `src-tauri/src/recovery.rs` lines 276-336 |
| **Code comment** | Lines 278-302 |
| **Verified by** | Verification subagent 2 (CONFIRMED, limited scope) |

The crash recovery function `find_prev_edit()` uses `ORDER BY created_at DESC` to find the most recent edit for a block. This is correct for Phase 1 (single device — timestamps are monotonic), but will produce incorrect results with multi-device clock skew.

**Scope:** Only called during crash recovery (`recover_single_draft`), not during normal sync. The extensive code comment (24 lines) already documents the exact Phase 4 rework plan: use `get_block_edit_heads()` from `dag.rs` instead.

**Recommendation:** Implement the documented rework when Phase 4 begins. No action needed now.

---

## 3. Phase 4 Implementation Gaps

These are **not bugs** — they are the expected Phase 4 work. Listed for completeness and planning.

### 3.1 Backend — Sync Protocol (Not Started)

| Component | Status | Details |
|-----------|--------|---------|
| **mDNS peer discovery** | Not started | No `mdns-sd` or `zeroconf` crate in Cargo.toml |
| **WebSocket transport** | Not started | No `tokio-tungstenite` or `rustls` in Cargo.toml |
| **Pairing (passphrase + QR)** | Not started | No `eff-wordlist`, `qrcode`, `sha2`, `hmac`, `rand` crates |
| **Head exchange protocol** | Not started | No networking code |
| **Op streaming** | Not started | No sender/receiver logic |
| **RESET_REQUIRED detection** | Not started | Snapshot infrastructure exists; protocol does not |
| **peer_refs management** | Not started | Table exists in schema with all ADR-09 columns; zero Rust code reads/writes it |
| **Sync Tauri commands** | Not started | Zero sync commands registered in `lib.rs` |

**Estimated implementation:** ~15% complete (schema + building blocks). Protocol, networking, and pairing are the remaining ~85%.

### 3.2 Backend — Remote Op Application

| Component | Status | Details |
|-----------|--------|---------|
| **Materializer ApplyOp** | Documented no-op | `materializer.rs` lines 827-858: explicit "Phase 4 TODO" comment. Local ops are applied by command handlers; remote ops will need this handler |
| **Property conflict integration** | Dead code | `resolve_property_conflict()` is implemented and tested (7 unit tests) but never called from `merge_block()`. Documented as TODO F04 in `merge.rs` lines 304-308 |

### 3.3 Frontend — Sync UI

| Component | Status | Details |
|-----------|--------|---------|
| **Sync state store** | Missing | No `stores/sync.ts`. Boot store only handles `booting -> recovering -> ready \| error` |
| **Pairing UI** | Missing | No QR code display, no passphrase entry, no device management panel |
| **QR code scanning (Android)** | Missing | No QR/camera library in `package.json` |
| **Sync progress indicator** | Missing | StatusPanel shows materializer metrics only, not sync progress |
| **Sync IPC wrappers** | Missing | `lib/tauri.ts` has no sync command wrappers |
| **Sync operation types in HistoryView** | Missing | HistoryView only shows edit/create/delete/move/tag/property/attachment/restore/purge |

### 3.4 Frontend — Existing Components Ready for Sync

These components exist and are functional, but need enhancements for Phase 4:

| Component | Current State | Phase 4 Enhancement Needed |
|-----------|--------------|---------------------------|
| **ConflictList** | Handles text conflicts with Keep/Discard buttons | Add property/move/delete+edit conflict types; show timestamps and device_id |
| **StatusPanel** | Shows materializer queue metrics (5s polling) | Add sync progress, last sync timestamp, connected devices |
| **HistoryView** | Shows local op history with device_id badge | Add sync_merge, sync_receive operation types; device_id filter |
| **App.tsx sidebar** | Red dot for unresolved conflicts | Add sync status indicator (green/yellow/red/gray) |

### 3.5 Dependencies to Add (Cargo.toml)

```toml
# Phase 4 sync dependencies (not yet added)
tokio-tungstenite = "0.23"     # WebSocket transport
rustls = "0.23"                # TLS for WebSocket
mdns-sd = "0.7"                # mDNS peer discovery
qrcode = "0.14"                # QR code generation
rand = "0.8"                   # Passphrase randomness
sha2 = "0.10"                  # Session key derivation
hmac = "0.12"                  # Session key derivation
```

Frontend (package.json):
```json
"qrcode.react": "^3.x",       // QR code display
"html5-qrcode": "^2.x"        // QR code scanning (Android)
```

---

## 4. Test Coverage Gaps

### 4.1 What IS Tested (Strengths)

The sync building blocks have **strong unit test coverage**:

| Module | Tests | Highlights |
|--------|-------|------------|
| `hash.rs` | 20+ tests | Golden vectors, determinism, field sensitivity, null-byte separators |
| `dag.rs` | 31 tests | Remote op insertion, hash verification, LCA finding, multi-device heads, merge op creation |
| `merge.rs` | 20+ tests | Clean merge, conflict merge, conflict copy creation, property LWW (7 tests), identical edits, position conflicts |
| `op_log.rs` | 15+ tests | All 12 op types, parent chain, serialization, canonical JSON |
| `snapshot.rs` | 10+ tests | Round-trip, crash-safe writes, compaction, decompression |
| `device.rs` | 12 tests | UUID generation, idempotency, corruption, concurrent access |
| `ConflictList` | 15 tests | Render, keep, discard, confirmation, error handling, a11y |
| `StatusPanel` | 10 tests | Render, polling, error display |

**Key positive:** `merge.rs` and `dag.rs` tests DO simulate two-device scenarios using `insert_remote_op()` + `merge_text()` / `merge_block()`. This covers the core merge logic with multiple devices.

### 4.2 Critical Gaps

#### GAP-01: No Full Sync Pipeline Integration Test
**Severity:** HIGH
**Verified by:** Verification subagent 3 (PARTIALLY CONFIRMED)

Unit tests cover individual functions (insert_remote_op, merge_text, merge_block) well. But no test exercises the complete pipeline:

1. Device A creates block, edits it
2. Device B receives ops via `insert_remote_op()`
3. Both devices edit the same block concurrently
4. Ops are exchanged
5. `merge_block()` resolves the conflict
6. Materializer applies the result to blocks table
7. Both devices' views are verified consistent

**Recommendation:** Create `src-tauri/src/sync_integration_tests.rs` with end-to-end scenarios.

---

#### GAP-02: Property Conflict Resolution Never Invoked
**Severity:** HIGH
**Verified by:** Verification subagent 3 (CONFIRMED)

`resolve_property_conflict()` is implemented with full LWW logic and 7 comprehensive unit tests, but it is **dead code** — never called from `merge_block()` or any orchestrator. The TODO F04 comment in `merge.rs` lines 304-308 explicitly documents this.

**Recommendation:** When implementing the sync orchestrator, it must iterate concurrent `set_property` ops per block and call `resolve_property_conflict()` for each conflicting `(block_id, key)` pair.

---

#### GAP-03: No E2E Sync Tests
**Severity:** HIGH
**Verified by:** Verification subagent 3 (CONFIRMED)

All 12 E2E test files focus on editor features. The `conflict-resolution.spec.ts` tests the ConflictList UI with mocked data, not actual sync between devices. Zero tests for peer discovery, pairing, op streaming, or multi-device conflict resolution.

**Recommendation:** When Phase 4 ships, create:
- `e2e/sync-pairing.spec.ts` — Passphrase entry flow
- `e2e/sync-streaming.spec.ts` — Two Playwright contexts exchanging ops
- `e2e/sync-conflict.spec.ts` — Real conflicts from concurrent edits

---

#### GAP-04: No Snapshot + Sync Resume Test
**Severity:** MEDIUM

Snapshot creation and round-trip are tested. But no test verifies: compact op_log -> apply snapshot -> resume sync -> LCA finding still works.

---

#### GAP-05: No Network Failure / Idempotency Test
**Severity:** MEDIUM

`insert_remote_op` uses `INSERT OR IGNORE` for idempotency, but no test verifies: duplicate op delivery, out-of-order delivery, or delivery with gaps.

---

#### GAP-06: No Large Op Log Stress Test
**Severity:** MEDIUM

No test with 1000+ ops to verify pagination, hash chain verification performance, or LCA finding with deep chains.

---

### 4.3 Test Coverage Summary

| Sync Layer | Estimated Coverage | Key Gap |
|------------|-------------------|---------|
| Op Log (read/write) | ~80% | Pagination edge cases |
| Hash Chain | ~90% | Cross-device chain interleaving |
| DAG (insert/merge/LCA) | ~85% | Full pipeline integration |
| Merge (text) | ~75% | Broken edit chain fallback |
| Merge (property) | ~40% | Never called from orchestrator |
| Merge (move/delete+edit) | 0% | Not implemented |
| Materializer (remote ops) | 0% | ApplyOp is a no-op |
| Snapshot + sync resume | ~70% | Not tested in sync context |
| Frontend (conflict UI) | ~80% | Only tests mocked conflicts |
| E2E (sync) | 0% | No sync E2E tests |

---

## 5. Cross-Platform Risks (To Investigate at Phase 4)

These are risks that need investigation and testing when the sync feature is implemented. They cannot be verified now because the sync code doesn't exist yet.

### RISK-01: mDNS on Android

| Field | Value |
|-------|-------|
| **Platform** | Android |
| **Risk** | Android restricts multicast by default. Standard `mdns-sd` Rust crate may not work on Android |
| **Mitigation** | Use Android's `NsdManager` via Tauri native bridge, or use `jmdns` (Java) |
| **Action** | Test mDNS discovery on real Android device with default WiFi settings at Phase 4 start |

### RISK-02: WebSocket Stability on Android WebView

| Field | Value |
|-------|-------|
| **Platform** | Android |
| **Risk** | WebSocket connections from Android WebView may be killed when app is backgrounded. Self-signed TLS certs need explicit trust |
| **Mitigation** | Use Tauri backend (tokio-tungstenite) for WebSocket, not frontend. Implement reconnection with exponential backoff |
| **Action** | Test WebSocket stability with app foregrounded/backgrounded at Phase 4 |

### RISK-03: Android Background Sync (Doze Mode)

| Field | Value |
|-------|-------|
| **Platform** | Android |
| **Risk** | Android Doze mode aggressively kills background processes. Sync may be interrupted |
| **Mitigation** | Use foreground service or WorkManager for periodic sync. Document that sync requires foreground app for now |
| **Action** | Decide sync model (foreground-only vs background service) at Phase 4 design |

### RISK-04: Linux Firewall Blocks Local Network WebSocket

| Field | Value |
|-------|-------|
| **Platform** | Linux |
| **Risk** | UFW/firewalld may block incoming WebSocket connections on arbitrary ports |
| **Mitigation** | Document firewall configuration. Implement automatic port suggestion. Use mDNS service advertisement |
| **Action** | Test on fresh Ubuntu/Fedora installs with default firewall at Phase 4 |

### RISK-05: Linux mDNS Requires Avahi

| Field | Value |
|-------|-------|
| **Platform** | Linux |
| **Risk** | mDNS peer discovery requires Avahi daemon running. Not installed by default on all distros |
| **Mitigation** | Document Avahi as dependency. Implement fallback: manual IP entry if mDNS fails |
| **Action** | Add Avahi check to app startup at Phase 4 |

---

## 6. False Alarms Debunked

The following findings from discovery subagents were **denied by verification subagents**. Included for transparency.

| Original Claim | Verdict | Reason |
|----------------|---------|--------|
| CORE-01: prev_edit should point to LCA, not our_head | **DENIED** | By design: `prev_edit` maintains linear edit chain; `parent_seqs` captures both merge parents separately. This is correct separation of concerns |
| CORE-02: f64 serialization non-deterministic across platforms | **DENIED** | serde_json uses the `ryu` crate which produces identical output on all IEEE 754 platforms (Linux, Android, macOS, Windows) |
| CORE-04: find_lca cycle detection causes infinite loops | **DENIED** | Cycle detection exists and works. Cycles cannot occur in practice due to append-only hash chain. Returning `Ok(None)` on cycle is a safe fallback |
| CORE-05: merge_block discards merge op result | **DENIED** | `_merge_record` with `?` operator is idiomatic Rust. The `?` propagates errors; underscore suppresses unused-variable warning |
| CORE-08: Parent entries not deduplicated | **DENIED** | Duplicates cannot occur: `merge_block` returns `AlreadyUpToDate` if our_head == their_head before reaching `append_merge_op` |
| INFRA-01: Snapshot doesn't restore op_log | **DENIED** | By design: snapshots capture materialized state (blocks, tags, properties). After RESET_REQUIRED, the old op_log is irrelevant; `up_to_seqs` records the frontier for sync resumption |
| INFRA-06: Snapshot atomicity issue | **DENIED** | Single-writer SQLite pool prevents concurrent writes between collection and insertion. No concurrency window exists |
| INFRA-10: Snapshot doesn't capture block_drafts | **DENIED** | By design: drafts are ephemeral (2s autosave). Preserving stale drafts across a full reset would cause confusion |
| ANDROID-01: No Android permissions declared | **DENIED** | Tauri 2.0 generates AndroidManifest.xml at build time with INTERNET permission. It's not committed to source control |
| CROSS-01: Device ID persistence path differs | **DENIED** | `device.rs` is a utility accepting any path. `lib.rs` calls it with Tauri's `app.path().app_data_dir()` — correct platform-aware path |
| UI-09: ConflictList Keep race condition | **DENIED** | JavaScript async/await: if `editBlock()` throws, `deleteBlock()` never executes. try/catch wraps both. Tested in test suite |
| UI-05: ConflictList fetch errors silently dropped | **PARTIALLY DENIED** | `Promise.allSettled()` is a reasonable design choice for parallel fetches. Fallback text shown. Main error path uses toast |

---

## 7. Recommendations

### Before Phase 4 Starts

1. **Fix BUG-01** — Add `found_create` validation in `merge_text` fallback path
2. **Write sync pipeline integration test** — Simulate two devices exchanging ops end-to-end (GAP-01)
3. **Add idempotency tests for insert_remote_op** — Duplicate delivery, out-of-order, gaps (GAP-05)

### Phase 4 Wave 1 (Networking + Protocol)

4. Add sync dependencies to Cargo.toml (tokio-tungstenite, rustls, mdns-sd, qrcode, rand, sha2, hmac)
5. Implement peer_refs CRUD module (`src-tauri/src/peer_refs.rs`)
6. Implement sync Tauri commands (exchange_heads, stream_ops, accept_remote_ops, complete_sync)
7. Implement materializer ApplyOp for remote ops
8. Wire `resolve_property_conflict()` into sync orchestrator
9. Implement `find_prev_edit` Phase 4 rework (use `get_block_edit_heads()`)

### Phase 4 Wave 2 (Pairing + UI)

10. Implement mDNS discovery (test on Android early — RISK-01)
11. Implement passphrase generation (EFF wordlist) + QR code generation
12. Create sync state store (`stores/sync.ts`)
13. Create pairing UI components (QR display, word entry, device management)
14. Add sync IPC wrappers to `lib/tauri.ts`
15. Enhance ConflictList for all conflict types
16. Add sync progress to StatusPanel

### Phase 4 Wave 3 (Testing + Hardening)

17. Create sync E2E tests (Playwright multi-context)
18. Test mDNS on real Android device
19. Test WebSocket stability with app backgrounding
20. Test Linux firewall scenarios
21. Document Avahi dependency for Linux
22. Add timestamp normalization assertion (HARDEN-01)
23. Stress test with 5000+ ops

---

## 8. Architecture Assessment

The existing sync building blocks are **well-designed and production-quality**:

- **Op log** — Append-only with composite PK, blake3 hash chain, canonical JSON serialization. Deterministic and correct.
- **DAG** — parent_seqs tracks causal dependencies. Remote op insertion with hash verification. LCA finding with cycle detection.
- **Merge** — Three-way text merge via diffy. Conflict copy creation. Property LWW with device_id tiebreaker. All tested.
- **Snapshot** — Crash-safe two-phase write. CBOR + zstd encoding. Round-trip tested.
- **Device** — UUID v4, file-based persistence, idempotent creation, corruption detection.
- **Schema** — All Phase 4 tables ready (peer_refs, op_log composite PK, parent_seqs, snapshot infrastructure).

The codebase demonstrates careful planning with extensive comments marking Phase 4 TODOs (F04, F05, F08, etc.) and a clear phase-based rollout strategy. The verification subagents found that the original discovery subagents **overestimated severity significantly** — 12 of 21 critical/high findings were false alarms or by-design behaviors.

**Confidence level for Phase 4 readiness:** The foundations are solid. The gap is entirely in the networking/protocol/UI layer, which is expected unimplemented work. With the implementation gaps addressed and the test coverage gaps filled, the sync feature has a strong architectural basis for reliable multi-device operation on both Linux and Android.
