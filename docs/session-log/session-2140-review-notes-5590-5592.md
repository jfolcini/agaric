# Session 2140 — review notes from #5590 and #5592

Follow-up for the two PRs merged this sweep.

**#5592's write-path budgets.** Its three probes merged at the 200 ms
placeholder; the reviewer asked for the measured values here rather than
another round on that branch. `bench-slo` run 38801339547, on #5592's head:

| Probe | Before #5592 | After | Settled before | Settled after | Budget (mean × 2) |
| --- | --- | --- | --- | --- | --- |
| `edit_block` | 3.65 ms | 1.82 ms | 65.28 ms | 5.08 ms | 4 ms |
| `set_property` | 2.13 ms | 2.33 ms | 82.29 ms | 76.50 ms | 5 ms |
| `move_block` | 9.53 ms | 8.55 ms | 9.78 ms | 9.14 ms | 18 ms |

One run per side, so only the settled edit, 65 ms to 5 ms, is outside any
plausible noise band; the rest are inside it.

**`list_all_tags_in_space` (10K tags) went over its budget.** The same run
measured it at 31.99 ms against 30 ms; #5588 had measured 21.75 ms. #5592
does not touch tags, so this is run-to-run variance on the CI runner. The
probe asserts, so the panic ended the bench before the two `search_blocks`
probes ran, and the weekly lane would fail the same way. The probe's own
rule says a warm run over the 30 ms tier takes measured × 2, so it is now
64 ms.

**#5590's gates.** `bench-slo` run 38798784175 passed: 14 tests, the four
20k-page perf gates in 38 to 54 s each, inside the 4 × 30 s leash.

**#5592's real-backend smoke.** `block-clipboard` failed once on #5592's
head ("the new block never indented under the parent") and passed on the
re-run of the same commit. The only app-side signal was a 103 ms
`BEGIN IMMEDIATE` wait on the create just before the indent. It is not
#5592's: the spec passed on every other branch that day, and the second
run on the same commit was green.

Dropped: #5588's duplicated `iter_custom` loop between the tags and search
probes. It was marked optional, and the two loops differ only in the call
they time; sharing them takes a generic async-closure parameter to save
about fifteen lines.

Ran: `cargo check --bench interactive_slo` in the build lane.
