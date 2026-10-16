# Session 2172 — Boot replays only the ops after the last snapshot

#5418 step 2. Measured on a copy of the maintainer's vault with a 789-op
backlog (the issue's number): after #5482's chunking, replay still took
428 ms median and about 40% of log start → frontend `boot resolved`. The
issue's condition for step 2 ("if replay is still visible") held.

The issue said `save_all_engines` "already stamps `applied_through_seq`".
It did, but as `cursor − 1`, and the apply cursor does not move during a
session: only boot replay, draft recovery and the retry sweeper advance it
(`advance_apply_cursor`, MAX semantics); local commands pass `false`. So
every boot re-applied the whole previous session.

Now the snapshot watermark is the op-log head (local ops, `is_replicated =
0`) read before any engine is collected, minus one. `save_all_engines`
returns that as `persisted_through`. `save_engines_and_advance_cursor` runs
one pass and, only when every dirty space was written, drains the
background queue and advances the cursor to the head. The drain matters:
replay re-sends each op's FTS/link/tag fan-out, which lives only in memory
until the background queue runs it. Passes are serialized by a mutex, so a
stale row is never marked clean behind a higher watermark; there is no test
for that race, and the doc comment says so. The periodic task, the
background job and the exit handler all call it. The `− 1` stays, so a
clean boot still replays one op and #4018's routine one-op rewind holds.

Crash safety: rows are written first and the cursor last, so a crash at
any point leaves the old cursor and means more replay, never less. The heal
still rewinds to the lowest watermark when a row lags. Trade-offs: quitting
waits for the background queue to drain, and an engine change lost
mid-session is repaired at boot only if no pass ran after it.

Tests, each red against a mutated copy: the pass advances the cursor to the
head; a failed write leaves it; an undrained queue leaves it; and a crash
test on #5482's oracle workload (live ops, a pass, more ops, a crash with no
exit save, a real rehydrate and boot) ends with engine and SQL equal to the
pre-crash session and replay covering the tail plus one op.

Found, not fixed here (pre-existing, same with the old cursor): a delete
in the post-snapshot tail never reaches the engine on replay, because the
space lookup skips deleted blocks and sends the op down the SQL-only path.
The crash test leaves out its workload's final delete for that reason; it
is #5630.
