# Session 1243 — deep-review backlog: sync auth bypass + frontend correctness clusters

Autonomous `/loop /batch-issues` run (2026-07-31). Opened the session against the
90-item deep-review backlog filed by the `agaric-deep-review` workflow, taking the
highest-severity item in each of three disjoint domains so the heavy Rust gate and the
light frontend gates could run in parallel worktrees.

## Merged on entry

- **#3250** — sync inbox slot quarantine. Reviewed clean (`agaric-reviewer` APPROVED with
  no findings), squash-merged. Its migration 0106 then made the main checkout's `dev.db`
  stale; re-ran `scripts/setup-dev-db.sh` so online-sqlx clippy would not abort later
  pushes.

## Shipped this session

- **#3324** (`fix(sync)`, severity:high, security) — the entire peer-authorization block
  was the *body* of `if let SyncMessage::HeadExchange { .. } = first_msg`, so any other
  first message took the `else { None }` branch and was still dispatched. `ResetRequired`
  is accepted unconditionally by the state table and counts as terminal, so the message
  loop was skipped and `try_offer_loro_snapshot_catchup` exported every registered space's
  full LoroDoc. With `AllowAnyCert` accepting anonymous TLS clients, the exploit was one
  text frame from any LAN host. Fixed with an early-return guard placed before
  `cancel_guard.owns = true`, leaving the existing gate byte-identical.
- **#3313** (`fix(backlinks)`, severity:high) — unlinked-reference rows come from a trigram
  (substring) FTS match, but "Link it" rewrote with an unanchored regex and committed via
  `editBlock`, then optimistically stripped the row so nothing refetched to reveal the
  damage. A page titled `Note` turned `Notebook shopping list` into
  `[[01J…]]book shopping list`. Now requires Unicode word boundaries and falls through to
  the existing visible-failure branch.
- **#3314** (`fix(search)`) — three places where frontend logic meant to mirror the Rust
  backend had drifted: the tauri-mock `exclude`+`is_null` OR-join tautology (the exact bug
  Rust fixed in #2019) and half-open `Between` bounds; the TS brace expander breaking one
  iteration earlier than Rust at the expansion cap; and graph backlink counts derived from
  a weakest-first-truncated edge list, which mislabelled weakly-linked pages as orphans.
- **#3320** (`fix(stores)`) — `reconcileBatchMove` dense-renumbered only the destination and
  vacated-source sibling sets; everything else kept stale positions and was then sorted by
  `buildFlatTree`. The doc comment argued sort *stability* rescued untouched groups, but
  stability only preserves order among *equal* keys. Three stacked reorders plus a batch
  move in a disjoint parent scrambled a group the user never touched.
- **#3323** (`fix(stores)`) — three small store defects: the paste reducer captured its
  sibling slot before an `await` that can run hundreds of ms and create pages; coalesced
  undo entries accumulated refs with no bound (the 100-entry cap applies only to the push
  branch) until the backend's `MAX_REVERT_OPS` rejected the batch and wedged Ctrl+Z; and
  `pageBrowserFilters` persisted a non-scalar shape with neither `migrate` nor `merge`.

## Filed as follow-ups

Out-of-scope findings were filed rather than deferred in comments:

- **#3352** — CI guard asserting every non-scalar `persist()` in `src/stores/` declares both
  `migrate` and `merge`. The project has paid for this class five times (#753, #823, #1578,
  #1609, #3323) and nothing in `scripts/` or `prek.toml` enforces the convention.
- **#3353** — `undoByRefs` drops a wedged entry only on `AppError::Validation`; `NotFound`
  and `NonReversible` are equally permanent and still wedge the stack.

## Method notes

- Five build subagents across three worktrees (one Rust, two frontend), each followed by a
  *different* adversarial reviewer that re-ran the suites itself and owned the single
  full-suite run per PR. Model tier was scored per item on cost × risk, with the reviewer
  never below the builder's tier.
- Every builder was required to demonstrate its regression test **fails against the pre-fix
  code**, and every reviewer independently re-reproduced that failure rather than trusting
  the report. This paid off on #3324, where neutering the guard showed an anonymous client
  receiving a frame emitted by `try_offer_loro_snapshot_catchup` itself — confirming the
  export path was genuinely reachable, not merely that an assert tripped.
- Reviewers found real gaps: a `undoByRefs` docstring left asserting "no local state is
  mutated" directly contradicted by the new drop-branch, and a missing test for the
  highest-risk judgement call in #3323 (recomputing `parentId`, not just the slot, when the
  paste anchor changes parents mid-await).
- The #3314 builder discovered that `PAGES_ALLOWED_KEYS` rejects `state`/`due-date` on the
  Pages surface, so the shared conformance fixture architecturally cannot exercise those
  keys on the Rust side. It disclosed the limitation and covered them with paired unit
  tests instead of silently narrowing the claim.
