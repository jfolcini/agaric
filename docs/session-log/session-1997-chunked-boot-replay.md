# Session 1997 — boot replay applies ops in chunked transactions

Set out to stop boot replay opening one `BEGIN IMMEDIATE` transaction per op
of the previous session (#5418). A builder died mid-work; a continuation agent
reviewed its diff, fixed it and verified it.

Shipped: replay enqueues `ReplayApplyOps` chunks of at most
`REPLAY_CHUNK_SIZE`. Each applies in one transaction with the replay sink and
advances the cursor once; the engine rewinds if the apply or commit fails. A
failed chunk falls back to per-op processing, so a bad op gets its own retry
and retry-queue row and its siblings still apply. The per-op path stays as a
test-only reference the chunked replay is compared against.

Trap: a restore's descendants become live in the Loro engine only after its
transaction commits, so a later op in the same chunk saw them as deleted and
placed a new sibling in the wrong slot; a delete then purge miscounted the
purged children. `split_after_cascades` ends a chunk at every delete and
restore so each op sees the engine state it saw under per-op replay. Local
moves have empty cascade sets and need no cut.

Not done: the before/after boot timing from a real vault, and advancing the
cursor at snapshot save, which the issue gives its own PR. Debug-build timing
here was noisy, so no speedup is claimed. Suites run: nextest over the
materializer, recovery, replay and apply filters and both touched crates,
clippy, offline check, fmt.
