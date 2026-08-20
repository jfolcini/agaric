# Session 1352 — the netmask the OS reported, and the reason the operator gets told

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-19 |
| **Subagents** | orchestrator-only (adversarial review of an existing uncommitted diff) |
| **Items closed** | `#4106`, `#4105`, `#4107` |
| **Items modified** | `#4116` (item 1 shipped; item 2 declined — see below, must be answered on the issue rather than auto-closed) |
| **Tests added** | +0 (frontend) / +7 (backend) |
| **Files touched** | 4 |

**Summary:** Reviewed a four-issue `agaric-sync` diff on the merits — reading each issue
including comments, re-deriving each claim against the source rather than trusting the
diff's own rustdoc — then fixed what the review found. Three of the four issues are
genuinely resolved; #4116's second item is a deliberate refusal by the builder that the
review agrees with, so the issue stays open to be answered. The review's own method
(mutate the production code, confirm the test reddens) found one real gap the diff's tests
did not cover and one factual error in a comment this session had itself just written.

**Files touched (this session):**

- `src-tauri/agaric-sync/src/sync_daemon/lan_interface.rs` (+349 / −6)
- `src-tauri/agaric-sync/src/sync_protocol/loro_sync.rs` (+175 / −22)
- `src-tauri/agaric-sync/src/transport/endpoint.rs` (+99 / −3)
- `src-tauri/agaric-sync/src/sync_daemon/session_supervisor.rs` (+11 / −0)

## What was verified, and how

Every load-bearing claim in the diff's rustdoc was checked against a primary source
rather than accepted:

- **The `if-addrs` behaviour the whole of #4105 rests on** was read out of the vendored
  crate, not the issue. POSIX: `prefixlen` is `count_ones(netmask)` with no contiguity
  check (`if-addrs-0.15.0/src/lib.rs:249-257`), and `Ipv4Addr::new(0,0,0,0)` is
  substituted both for a NULL `ifa_netmask` and for a non-`AF_INET` one (`lib.rs:237-239`).
  Windows: the netmask is *synthesised* bit-by-bit from
  `IP_ADAPTER_UNICAST_ADDRESS.OnLinkPrefixLength` (`lib.rs:353-376`), so it is contiguous
  by construction and the new gate is a no-op there. Both claims in the diff hold.
- **`link_metadata::is_blocked_ip` really does own the outbound question.** The diff's
  #4106 rustdoc argues the omitted reserved blocks are cheap to leave because the outbound
  decision lives elsewhere; `find_referencing_symbols` on `is_publicly_routable` returns
  two production consumers only (`bind_locality_ok` and `decide`'s `internet_facing`
  flag), and `is_blocked_ipv4` (`src/link_metadata/mod.rs:135`) carries the full table
  including both blocks #4106 adds. The claim is true, and the change moves the two
  predicates *towards* agreement.
- **The class-E test #4106 warned would redden had already been pre-empted.** The issue's
  "note for whoever fixes it" flags #3869's service-level wiring test as using `240.0.0.1`
  for "the address no machine can hold". That test now uses `8.8.8.8` and carries a
  docstring explaining the swap *by reference to #4106*. Nothing to do; recorded so the
  absence is not read as an oversight.

## The predicate is exact, and the ordering was the part nothing pinned

`is_contiguous_netmask` is `leading_ones() + trailing_zeros() == 32`. That is not merely
correct on the two ends the diff cites — it is exact over all 2³² values, and the proof is
short enough to state: if the leading ones number *a* and the trailing zeros *b* with
*a + b = 32*, then bits `[0, a)` are all ones and bits `[a, 32)` are all zeros, which is
the definition of contiguous. The builder's stated reason for preferring it over the
`!m + 1` power-of-two identity — that the latter wraps to zero on `0.0.0.0`, the one mask
most likely to be a *substituted* value rather than a reported one — was confirmed by
substituting the naive form and watching
`contiguity_accepts_well_formed_masks_and_refuses_gaps` go red.

The gap was elsewhere. The gate sits *before* both prefix gates, and the diff argues at
length for that placement — but **moving it below them left the entire suite green**. The
fixture is `255.0.255.0`, which counts to 16, and 16 clears both prefix gates either way,
so both orderings produced the same verdict and no test could tell them apart.

The ordering is not cosmetic. It never changes accept-vs-reject — a non-contiguous mask is
refused under both orderings — but it decides *which reason the operator is handed*, and
that is the entire deliverable of #4105. `253.0.0.0` is the separating case: a gap in the
first octet, `count_ones` of 7, which is below `MIN_IPV4_PREFIX_LEN`. With the gate first
the audit line reads `eth0=10.1.2.3 netmask 253.0.0.0 (netmask is not contiguous …)`; with
the gate last, `PrefixTooBroad` fires first and the line reads `eth0=10.1.2.3/7` — a
confident prefix printed for an interface whose whole problem is that no prefix describes
it, which is precisely the misleading audit line the issue exists to prevent. Added
`a_mask_whose_bit_count_also_fails_the_prefix_gate_is_still_named_as_the_mask`, and
confirmed it goes red under the reordering that the previous tests waved through.

Two smaller holes closed the same way: `Verdict::NetmaskNotContiguous`'s `reason()` arm was
the one string in that match no test read (it could have been reworded into any other
verdict's reason, or into `"chosen"`, and stayed green), and #4107's `probe_error` tracing
field was named as though it were the set when it is documented as only the first — renamed
`first_probe_error`, because a bare `probe_error` sitting next to `probes_failed = 3` reads
as though all three failed that way.

## Does #4105 newly refuse a NIC that used to bind?

This is the question that decides whether the change is shippable, since a wrong refusal is
a broken sync. The answer is no, for three separate reasons that had to be checked
separately:

- **Linux** stores `ifa_prefixlen` and derives the netmask from it, so the mask is
  contiguous by construction.
- **Windows** synthesises the mask from `OnLinkPrefixLength`, same conclusion.
- **The unreadable-netmask path** — the one that actually occurs — substitutes `0.0.0.0`,
  which *is* contiguous, so the gate says nothing about it and it lands on `PrefixTooBroad`
  exactly as it did before. This is why the choice of predicate mattered: the naive
  `!m + 1` form would have converted every unreadable netmask into a brand-new rejection
  verdict, changing nothing about the outcome but everything about the diagnosis.

That leaves BSD-family hosts where `ifconfig` was used to set a genuinely non-contiguous
mask — the case the issue is about, where the new refusal is the point. There the gate
firing is not a no-op: a NIC that used to bind on its fictitious bit-count prefix now
falls through to the loopback fallback (sync unreachable) instead of a wrong-but-working
bind. That is the intended trade, and it is loud, but it is a real behaviour change on
exactly that one platform family, not a no-op everywhere. There is no IPv6 path to worry
about: `LanInterface` is IPv4-only and `host_candidates` filters `IfAddr::V4` before
constructing one.

## #4106 also loosens a gate, and the diff did not say so

`is_publicly_routable` has a second consumer with inverted polarity:
`bind_locality_ok` is `!is_publicly_routable(&bind) || is_locally_assigned(…)`, so a
`false` short-circuits the "is this one of *our* addresses" proof away entirely. Excluding
a range therefore does not only quieten a warning — it also stops requiring that a bind in
that range be vouched for by the host enumeration.

This is the right call for these two blocks (neither is routable; an address the host does
not hold still fails at the socket with `EADDRNOTAVAIL`, so the removed check was never
what stood in the way), and it is the same bargain every range already on that list takes.
But the rustdoc argued the change's safety entirely in terms of the warning, and
`transport::service` already documents this exact consequence from the test side. Added the
missing paragraph, with the corollary stated plainly: *adding* a range to this list is a
security-relevant edit, not a log-noise edit.

## A comment this session wrote, disproved by this session's own method

The diff added `1.0.0.1` and `223.255.255.255` to the public-address test as over-reach
guards. The review first rewrote the comment to claim `223.255.255.255` "catches a clause
widened to `>= 224` or lower" — and then, applying the same discipline to its own work,
mutated the class-E clause to `o[0] >= 224` and watched the test stay **green**. Of course
it did: 223 < 224. The address bounds a clause slipping to 223 or lower, and no further.

That gap is defensible and is now documented as measured rather than assumed: 224..=239 is
multicast, which this predicate deliberately leaves classified as public and which a later
fix may legitimately move, so pinning the exact `>= 240` boundary from the public side
would mean asserting in a test that multicast is internet-facing. Sweeping multicast in is
not the regression the guard is for; sweeping in real unicast space is, and that it does
catch.

The lesson is not about the address. It is that "verify by making the change" has to be
applied to review edits too, not only to the code under review — the reviewer's comment was
wrong in exactly the way the reviewer was hired to notice.

## #4116 item 2 — the issue is right about the comment, the builder is right about the code

The issue asks for a dead `host_addrs()` allocation to go: on the loopback-fallback branch
`bind_locality_ok` short-circuits on `!is_publicly_routable(bind)` and never reads the
list. The builder kept the allocation and rewrote the comment instead. The review sides
with the builder, on the merits rather than on deference:

- The short-circuit claim is true — traced `host_addrs` through `SyncService::bind` →
  `lan_only_with_host_addrs` → `bind_locality_ok`, and that is its only consumer.
- The only available "fix" is to build the list conditionally, which means **predicting a
  gate's short-circuit from the call site**. `bind_locality_ok` falls *closed* on an empty
  list for a publicly-routable bind, so the day that gate is widened to consult the list on
  a path the call site guessed it would not, the daemon refuses a bind it had itself just
  chosen — which is #3853/#3869 exactly, re-created to save one `Vec` of a handful of
  `IpAddr` per daemon start.
- The issue's own text says the value here is that "the comment above it reads as though
  the list is always load-bearing, which is the sort of thing that makes a later reader
  hesitate to touch it." The rewritten comment names precisely when the list is and is not
  read, which answers the stated concern.

**So #4116 is deliberately not listed as closed.** Item 1 (the `min_by_key` → materialised
key change) shipped and is covered — swapping `.min()` for `.max()` reddens two ranking
tests. Item 2 needs a reply on the issue so the author can accept or overrule the
reasoning; auto-closing it would bury a disagreement as though it were an oversight.

## Vacuity check — every new test, mutated

Each new assertion was validated by making the production change it claims to catch and
confirming the red, then restoring:

| Mutation | Result |
|---|---|
| drop the `0.0.0.0/8` clause | red (reserved-ranges test) |
| drop the class-E clause | red (reserved-ranges test) |
| widen `0.0.0.0/8` to `1.0.0.0/8` | red (public-addresses test) |
| widen class E to `>= 224` | **green** — gap documented above |
| remove the contiguity gate from `rejection` | red (2 tests) |
| swap in the wrapping `!m + 1` predicate | red (contiguity test) |
| move the gate below the prefix gates | **green before this session**, red after the new test |
| reword the `NetmaskNotContiguous` reason | **green before this session**, red after the new assertion |
| `.min()` → `.max()` in the winner search | red (2 ranking tests) |
| restore the pre-#4107 `.ok()` swallow (a failed probe collapses to `None` and is counted as dangling, same as a genuinely absent parent) | red (probe-failure test) |
| drop the `first_error` capture | red (probe-failure test) |
| report every probed edge as dangling | red (probe-shape test) |

## The inline test module in `loro_sync.rs`

The file states a convention that its tests live app-side, because `loro_sync_tests.rs`
reaches app-only `Materializer` / `recovery`. The new `#[cfg(test)] mod tests` is a genuine
exception — `probe_parent_edges` is a private fn with no app-side dependency, and a
`pub(crate)` fn is invisible from the app crate's test file, so the alternative is widening
the module's surface for a test. The exception is recorded in the file next to the existing
note. Checked that it breaks nothing: no prek hook polices Rust test placement, the sibling
`sync_protocol/loro_sync_types.rs` and `audit_ingest_metrics.rs` already carry inline test
modules, and `check-dynamic-sql` / `check-raw-tx` both skip `#[cfg(test)]` modules, so
`loro_sync.rs` holds its baselined 5 dynamic-SQL sites (the probe query moved between
functions but did not multiply).

**Verification:**

- `cd src-tauri && cargo nextest run --workspace` — 5928 tests run, 5928 passed, 7 skipped.
  (Bare form without `--workspace` is package-scoped to `agaric` only and silently skips
  every `agaric-engine`/`agaric-store`/`agaric-sync`/etc. test — #3212.)
- `cargo fmt --check` — clean.
- `cargo check --all-targets` — clean (`--tests` would skip benches).
- `cargo clippy --workspace --all-targets` — no errors, no warnings.
- Guards run directly against the changed files: `check-dynamic-sql.py`,
  `check-raw-tx.py`, `check-metric-provable.mjs`, `check-dead-symbol-citations.mjs
  --worktree`, `check-doc-code-paths.mjs --worktree` — all clean.

**Lessons learned (for future sessions):**

- A rejection ordering that never changes accept-vs-reject is invisible to any test written
  around the *outcome*, and is exactly the kind of thing a later refactor reorders without
  noticing. When a gate is placed deliberately relative to its neighbours, the fixture has
  to be one where the neighbours would also fire — otherwise the placement argument lives
  only in a comment.
- Run the mutation check on review edits, not just on the code under review. One comment
  written during this review made a falsifiable claim about which mutations a test catches,
  and the claim was wrong; the same one-line experiment that audits a builder audits a
  reviewer.

**Commit plan:** single commit; #4116 left open with a reply owed on item 2.
