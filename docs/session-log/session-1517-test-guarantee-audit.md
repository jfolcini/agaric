# Session 1517 — what the frontend mocks and the crate boundaries actually guarantee

Two questions from the maintainer: are the Tauri mocks guaranteed accurate, given that frontend
tests depend on them; and are the crate boundaries tested well enough that a green `-p <crate>`
run means other crates are unaffected. Both were audited rather than answered from memory. The
answer to both is no, and the two gaps have different shapes.

## The mock estate

The premise needed correcting first: **almost all vitest suites do not use the tauri-mock.** Only
8 of 802 vitest files import it. The rest stub IPC per test — 145 files via `vi.mocked(invoke)`,
92 via `vi.mock('@/lib/bindings'|'@/lib/tauri')` — with return values written by whoever wrote the
test and checked by nothing. `src/test-setup.ts:382` rejects an *unstubbed* call, which catches a
forgotten stub but not a wrong one. The tauri-mock backs the 110 Playwright specs and browser dev.

Where conformance applies it is a real differential: `expected` blobs are backend-authored via
`CONFORMANCE_UPDATE=1`, never hand-written, and both sides assert in required lanes. It pins
**34 of 141 commands (24%)** — 14 of 66 mutating, 20 of 75 read. The other 107 are waived, and
`conformance-coverage.test.ts:2517` fails only when a command has neither a fixture *nor* an
allowlist entry: waiver-accepted, not fixture-required. Fourteen read commands are self-labelled
"fixture candidate: not written yet".

Even inside the 24%, three things are structurally out of reach: return values of mutating
commands are never compared, error paths on the mutating leg are unreachable because the Rust
runner replays payloads *below* the command layer, and 34 of 65 query steps are explicitly
weakened to unordered set comparisons.

The sharpest finding is historical. Every divergence conformance has caught was caught when
someone wrote a new fixture — never by the existing corpus reddening. Meanwhile #3081 reached a
user with e2e green. Worth stating precisely, because the first draft of this log and of rule 4
got it backwards: #3081's root cause was a real atomicity defect — a committed tag create
followed by a swallowed `SetProperty(space)` (session 1220) — and the mock's stale contract is
why the mock-backed estate never *showed* it, not what caused it. Migrations 0087/0088 retired
the `block_properties(key='space')` rows, not the table.

## The crate boundaries

`-p <crate>` does not compile the dependents, so at a `-p` run even signature drift is invisible.
The pre-push hook is stronger (`test-related-rust.sh` forces `--workspace` scope while running
only the named package's tests), and CI is stronger still: no per-crate gating, so any Rust change
runs the whole workspace. The real safety net is CI, not the local run.

The structural problem is placement. Boundary oracles live almost entirely in the app crate — the
reconciliation oracle, recovery↔kernel parity, bulk equivalence, engine parity, the conformance
integration tests — which is exactly where someone editing `agaric-store` would not run them.
#3299 states the symptom; #3443 is the open work item, with `op`/`op_log`/`loro` done so far.

Safe to trust under `-p` today: op-payload JSON shape, op-log append/hash/undo provenance
(partially), `loro::engine` reads/tree/snapshot/sync, space-filter SQL literal parity, and
sync→engine, because sync's own suites drive the real `Materializer`.

## Filed

- **#4667** — make conformance fixture-required rather than waiver-accepted; split the allowlist
  into a principled half and a shrink-only ratchet; the migration⇒mock guard covers 9 of 59 tables.
- **#4668** — retire hand-stubbed `invoke`; the cheap first step is typing the stub helper against
  the generated return types, which converts a class of silent drift into a `tsc` failure.
- **#4669** — drive conformance from the existing op-chain generator instead of only hand-written
  fixtures, so coverage stops depending on what someone thought to write.
- **#4670** — the runner's scope: replaying below the command layer is why return values and error
  paths cannot be pinned at all.
- **#4671** — widen `e2e-tauri/` and make it blocking. This is the one that changes the guarantee
  rather than the coverage number: a real-backend test needs no fixture, waiver or oracle, because
  there is no second implementation to diverge.
- Inventory of every crate boundary and where each is pinned added to **#3443** rather than filed
  as a duplicate.

## AGENTS.md

Two changes, with maintainer approval:

- The `--workspace` bullet now says what `-p <crate>` does *not* do — it compiles no dependents, so
  a green `-p` run says nothing about consumers, not even their signatures, and most boundary
  oracles do not run under it either.
- A fourth anti-drift rule: a bug that reached a user lands a spec in `e2e-tauri/`, the only
  frontend surface with no second implementation between the test and the truth.
