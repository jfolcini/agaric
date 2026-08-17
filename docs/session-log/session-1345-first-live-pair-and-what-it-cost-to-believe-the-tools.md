# Session 1345 — the first live pair, and what it cost to believe the tools (2026-08-18)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-18 |
| **Subagents** | 3 build + 4 review + 1 discovery |
| **Items closed** | `#4083`, `#4084`, `#4085`, `#3869`, `#4095` (PRs open, not yet merged) |
| **Items modified** | `#4037` (surfaced open questions), `#4099` (added TOCTOU note) |
| **Tests added** | +8 (frontend) / +19 (backend) |
| **Files touched** | 14 |

**Summary:** Diagnosed why a desktop and an Android phone would not sync on a real LAN, then
fixed the three defects that first live pair exposed. The network cause turned out to be
external (a VPN swallowing the LAN), but getting there produced the first two-device
evidence this project has had, and that evidence disproved several things the code and
docs asserted.

### The diagnosis

Both devices were on `192.160.160.0/24`. mDNS discovery worked throughout — the phone
logged `discovered new peer via mDNS` and the desktop announced fine — while every
unicast dial failed. `adb shell ip route get 192.160.160.80` resolved to `dev tun0`:
a Zscaler VPN with `bypassable=false` and `Uids: {0-99999}` had captured the whole
subnet. Probing its exclusions, the only unicast IPv4 range that escaped was
`192.168.43.0/24`, plus multicast `224.0.0.251` — which is exactly why discovery
worked and connection did not.

The root cause is that the LAN is numbered out of **public** address space, so the VPN
treats it as internet-bound. Agaric already warns about this at bind time ("the sync
endpoint is bound to a GLOBALLY-ROUTABLE address"), and that line was the most useful
one in the log.

A second, latent blocker: `ufw` allowed inbound on `zcctun0`/`docker0`/`lxdbr0`/`pix-*`
but not `wlp2s0`, and was actively dropping LAN UDP. Docker was **not** implicated —
the daemon logged that it had passed over `docker0`, `lxdbr0` and `zcctun0` and
correctly chose `wlp2s0`.

With both cleared, pairing succeeded on the first attempt.

### What the first pair exposed

- **#4083** — the initiator's inbound apply aborted with `(code: 787) FOREIGN KEY
  constraint failed`. `blocks.parent_id` was the last unguarded `REFERENCES blocks(id)`
  write on that path; every sibling was already guarded (#377, #2266, #708). Only the
  initiator applies remote data, so only one direction of sync ever worked.
- **#4084** — a device that only ever succeeds as responder records no progress at all,
  so it reads as "never synced" and `peers_due_for_resync` marks it due every tick.
- **#4085** — the initiator emitted every `SyncEvent` with an empty `remote_device_id`,
  and WARNed once per healthy session about it.

**Files touched (this session):**

- `src-tauri/agaric-sync/src/sync_protocol/loro_sync.rs` (+193)
- `src-tauri/agaric-engine/src/loro/engine/snapshot.rs` (+~90)
- `src-tauri/agaric-engine/src/loro/projection.rs` (+159)
- `src-tauri/agaric-sync/src/sync_protocol/session_state_machine.rs`
- `src-tauri/agaric-sync/src/sync_daemon/lan_interface.rs` (+~400)
- `src-tauri/agaric-sync/src/transport/{endpoint,service,test_support}.rs`
- `src-tauri/agaric-store/src/peer_refs.rs`
- `src-tauri/migrations/0111_peer_refs_streamed_at.sql` (new)
- `src/lib/peer-sync-activity.ts` (new)
- `.github/workflows/release.yml`
- `.claude/skills/batch-issues/references/codegen-and-sql.md`
- `.github/PULL_REQUEST_TEMPLATE.md`

**Verification:**

- `cd src-tauri && cargo nextest run --workspace` — 5889 tests run, 5889 passed.
- `npx vitest run` — 17509 passed across 772 files.
- pre-commit hook — all staged-file checks pass.
- pre-push hook — full clippy + push-staged checks pass.

### Process notes

**Three commits aborted without HEAD moving**, each reporting what looked like success:
a `dynamic-sql` baseline needing re-anchoring, a new file importing the retiring
`@/lib/tauri` layer, and a `cargo fmt` auto-fix. Checking `git log -1` after every
commit is what caught them.

**A guard passing is not the same as the thing being correct.** A builder followed this
repo's own `codegen-and-sql.md` and ran the bare `cargo sqlx prepare -- --tests`, pruning
86 of 615 `.sqlx` entries — the #3901 trap, on its fourth recorded occurrence. Worse, the
first fix was verified too narrowly: the drift guard inspects the **staged** diff, so
staging one cache while three stayed dirty read as green. Three stale crate caches nearly
shipped. The instruction that caused it is fixed here.

**The reviews found false statements more often than broken code.** Across five PRs they
caught: a doc claiming the FSM rejects a mismatched `HeadExchange` (it does not, it
merely prefers), an error branch matching exit 101 when `panic = "abort"` means a release
build can only emit 134, an audit line naming a tiebreak rule that never ran, a builder's
claim that a pragma was unfalsifiable when it was load-bearing, and — three separate
times — this session's own explanations of the sqlx failure mode. The code was mostly
right; the claims about it were not.

**Two things were deliberately not built.** #4037 (put `endpoint_id` in the pairing QR)
has five explicit "things to settle" and zero comments answering them, in a path where
the QR is an authenticated channel carrying a live passphrase — so it was surfaced rather
than guessed. And #3869's `ap0` promotion was implemented, reviewed, then **reverted**:
it made a soft-AP the same class as the joined LAN, so with no default route the tiebreak
fell to enumeration order and the device left its own LAN. It was also a no-op on the
actual hardware (a Pixel 8 has no `ap0`; its soft-AP is `wlan1`, and `rmnet*` addresses
are `/32` host routes rejected before ranking). Filed as #4108 with the measurements.

**Issues filed:** #4095, #4096, #4097, #4099, #4100, #4102, #4104, #4105, #4106, #4107,
#4108 — each from a finding verified against the source rather than relayed.
