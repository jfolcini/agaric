# Session 1769 — #5057: the writers whose table the snapshot cannot see

Continues the #5057 burn-down. Sessions 1767–1768 closed the drafts, trash and
batch-ops clusters. This one takes five more and, more usefully, establishes the
route for most of what is left.

## The finding that matters

`peer_refs`, `app_settings`, `property_definitions`, `page_aliases` and
`link_metadata` writes were all waived with some variant of "outside the
conformance snapshot scope". That reads as a scope judgement. It is not — it is
a statement about arithmetic. The snapshot captures exactly five arrays:
`blocks`, `properties`, `block_tags`, `page_links`, `op_log_digest`. Any table
outside those is invisible to the snapshot **by construction**, no matter how
ordinary the write is.

But invisible to the *snapshot* is not invisible to the *harness*. Every one of
those tables has a reader that already carries a query step, over a seed section
that already exists, and `runQuerySteps` runs after the replay — so an
ops-then-query fixture pins the write by what the read answers afterwards.

Debt 29 → 12 across this session, starting with `delete_peer_ref`,
`update_peer_name`, `set_peer_address`, `set_reminder_settings` and
`delete_property_def`. The same route then carried the attachments pair and the
whole undo cluster, which is why it is worth stating once rather than
rediscovering per cluster.

The honest corollary: the snapshot leg of such a fixture is genuinely inert, and
the #3966 guard says so. Both new fixtures declare it in `SNAPSHOT_OPS_INERT`
with the reason, joining `property_def_writes`, which had been the only entry.

## One waiver's blocker was stale, removed by this very issue

`delete_property_def` was waived because *"the command leg's `RETURN_SHAPE`
assumes an id-bearing response on both stacks, so it needs a unit-return shape
first (#3830)"*. That shape is `HEADED_ID_KEY`, and #5064 added it two sessions
ago for the draft writers. All five commands pinned here return `()` and use it.

Worth generalising: a waiver's reason is a claim with a date on it. This one was
true when written and false by the time it was read, and nothing in the harness
notices a reason going stale — only a person re-reading it does.

## What the fixtures found

Five mock divergences, two of them severe:

- `update_peer_name` and `set_peer_address` were **pure stubs** —
  `returnUndefined` and `returnNull`. They accepted anything, wrote nothing and
  refused nothing. Any test that "verified" a peer rename against this mock
  verified the absence of a handler.
- `delete_peer_ref` silently succeeded on an unknown peer where all three peer
  writers answer `NotFound`.
- `delete_property_def` had none of its three guards (builtin key, still
  referenced by a live `block_properties` row, `NotFound`).
- the reminder time check was a zero-padded-only regex. The backend parses
  `%H:%M` with chrono, which takes one **or two** digits per field, so it
  accepts `7:30` and the mock refused it. The fixture pins that arm on purpose:
  it separates a real parse from a shape check, and `99:99` still refuses
  because the fields are range-checked rather than counted. This was authored as
  a *rejection* case first; the backend refused the declaration and corrected it.

And one harness gap, surfaced only because `property_def_writes` is the first
fixture in the corpus that ever seeded a property: the backend's seed loader
calls `set_property_inner` — the real command — which appends an op, while the
mock wrote the map directly. Every fixture that seeds a property started one op
behind on the mock side. Seeded *blocks* are inserted raw on both sides and
append nothing, which is why the two halves of that loader legitimately differ;
the mock's loader comment claimed it mirrored "the backend's raw insert", which
was true for blocks and wrong for properties.

## #5067's review notes, all three taken in the next PR rather than on the branch

Per AGENTS.md § How we work, non-blocking notes on an approved green PR do not
cause a push; they ride the next one. All three were in files this PR already
touches.

The substantive one: `restore_blocks_by_ids` re-read `deleted_at` in a second
pass, so a root that an **earlier** root's cohort had already revived was
skipped and appended no op — where the backend resolves every soft-deleted root
up front and asserts `roots.len() == restore_fanout.len()`, one op per root
regardless of overlap. Verified against `load_restore_roots_in_tx` before acting.
The mock now collects roots first, the shape `purge_blocks_by_ids` four lines
below already had, and `batch_trash_lifecycle` gains the overlapping-roots arm
that reddens it. It is visible only in the digest: the settled state is identical
either way, which is exactly why no existing fixture caught it.

The other two were a misnamed local (`scalar` was true precisely when the
response was *not* a scalar) and a waiver header that outlived its last entry.

## What was verified

Every fix below was falsified against a copy and restored byte-identically.
The first ten:

| Mutation | Result |
| --- | --- |
| `delete_peer_ref` drops `NotFound` | red |
| `update_peer_name` back to a no-op stub | red |
| `set_peer_address` drops host:port validation | red |
| `set_peer_address` back to a no-op stub | red |
| `delete_property_def` drops the builtin guard | red |
| `delete_property_def` drops the in-use guard | red |
| `delete_property_def` drops `NotFound` | red |
| reminder time back to the padded-only regex | red |
| seed loader drops the property op | red |
| `restore_blocks_by_ids` back to the second-pass skip | red |

```
npx vitest run src/lib/tauri-mock   45 files, 905 passed
cargo nextest run --workspace -E 'test(conformance) or test(structural_op_parent)'
                                    107 passed
cargo clippy --workspace --all-targets   clean
npm run typecheck / npx knip        clean
```

## Where #5057 stands

12 mutating + 3 read, down from 42 at the start of the sweep. Three of the 12
are not work at all: they are permanently blocked by their INPUT and now sit in
`PINNING_BLOCKED_MUTATING` rather than misrepresenting themselves in the debt
list — `fetch_link_metadata` (network, plus `now_ms` in the row and a wall-clock
freshness check), `quick_capture_block` (`chrono::Local::now()`, and the journal
page's content *is* the date, so it lands in `blocks[].content`), and
`cancel_pairing` (writes a key nothing reads on either stack). That bucket is
added here, and it needed no guard of its own: every name in it is also waived
in `NO_FIXTURE_ALLOWLIST`, which the #4667 orphan test enforces, so the
allowlist's existing `nowCovered` check reddens the moment a fixture drives one.

The rest:

- **pinnable the same way** — `set_page_aliases` (needs a scalar-list return
  shape), `confirm_pairing` (needs `PairingSession` + `SyncScheduler` wiring,
  both allocation-only), `add_attachment_with_bytes` (needs a narrower return
  shape), `compact_op_log_cmd` (a refusal arm);
- **genuinely expensive** — import/export. `export_page_markdown` cannot use the
  existing single-value token, because that token asserts the rendered text
  contains no `#` and a markdown export always opens `# Title`. New grammar plus
  a TypeScript reimplementation of `render_page_markdown`. Probably its own
  issue;
- **blocked** — the spaces cluster, on the per-space Loro registry, unchanged.

## The undo cluster, and what it cost the mock

All seven are pinned. The five ref-addressed ones were never expensive: they
were waiting on a convention. `On` names the n-th op the fixture has appended,
the `OpRef` analogue of the `Cn` that already names the n-th op-created block,
with each runner resolving it to its own `(device_id, seq)`. Both resolvers fail
closed, because a ref that silently resolved elsewhere would undo the wrong op
and still look like a pass.

Six fixtures turned up **nine** mock divergences, every one the same shape: two
paths doing the same job with different coverage, where the tested path is the
correct one.

| Divergence | Consequence |
| --- | --- |
| negative `undo_depth` → `NotFound`, not `Validation` | an out-of-contract arg read as an empty history |
| `undo_depth > 1000` unguarded | same, at the other bound |
| `reversed_op_type` missing on both positional handlers | every browser-mode undo toast fell back to a generic "Undone" |
| `undo_page_group` had no sign guards at all | success where the backend refuses |
| `reverseOpTypeFor` mapped `set_property` to itself | wrong type on a row the op-log digest compares |
| ...and read `from_value`, which reserved keys null deliberately | the other half of the same pair |
| `revert_ops` returned the raw op-log row | every field the contract declares was `undefined` |
| `restore_page_to_op` was a stub returning zeros | a page rewind did nothing at all in browser and e2e mode |
| `redo_page_op` named the op it re-applies | "Redid create" where the backend says "Redid delete" |

The last one was mine, introduced in this sweep and caught in review. Its first
test used `move_block` — the one self-inverse type where the two conventions
coincide — so it could not redden. That is the third shape in AGENTS.md's list
of tests that look like coverage and are not, written by someone who had spent
the session citing it. The replacement uses `create_block`, whose undo appends a
`delete_block`, and the conformance fixture was repointed from an `edit_block`
undo to a `set_property` one for the same reason.

The mock's own tests could not catch any of the nine, because the mock is what
they assert against. That is the argument for the conformance harness in one
paragraph, and it is worth remembering when the remaining clusters get costed as
"just coverage".

Page scoping is deliberately still not modelled in `restore_page_to_op`,
matching `undo_page_op`, which filters the op log without one either. Making it
faithful is a separate change that no fixture pins today; adding it on one path
and leaving the sibling as it was is the asymmetry that produced half the table
above.
