# Session 1347 — the fixes that were already in the tree

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-18 |
| **Subagents** | 3 build + 2 review + 1 discovery |
| **Items closed** | `#3282`, `#3975`, `#3246`, `#4056`, `#4057`, `#4115`, `#3974`, `#3961` (merged), `#4059` (already satisfied) |
| **Items shipped, PR open** | `#4131`, `#4104`, `#4110`, `#4126`, `#4129`, `#3507` (docs half) |
| **Items filed** | `#4133`, `#4135` |

**Summary:** A merge sweep that turned into a bookkeeping session. Three PRs from the
previous batch merged and closed eight issues; a fourth spent the session absorbing two
rounds of review notes. The more useful half is what the batch found about its own
backlog: two of the six issues picked up were already fixed in the tree, and one was
blocking six others behind a stale label.

### The claims nobody released

Seven open issues carried an `in-progress` label with no branch, no open PR, and no
session still working them. The label is meant to cover only the window before a PR
exists — after that the PR is the claim — but nothing removes it when a session ends
without shipping. Every one of the seven was invisible to the backlog sweep that
started this session, including two that were then picked up and shipped within the
hour once cleared.

### Two issues that were already fixed

**#4059** asked for a fixed seed on two fast-check property suites so an unlucky seed
could not redden an unrelated PR. Both suites already had one: `PROPERTY_SEED = 4059`
landed in #4074 and #4077, neither of which cited the issue. The sibling file's
*unseeded* state turned out to be documented too, and backed by a measured 10 × 20 000-run
sweep rather than left implicit — so both halves of the acceptance criterion were met
before anyone opened the file.

It was closed on evidence rather than on reading, because reading the source is how you
conclude a thing is fixed and then find out the tests never ran. With the seeds
temporarily removed, two runs of the same commit reported four distinct fast-check
seeds; with them restored, two runs are byte-identical.

### #4131 — one comparator, two independent divergences

`comparePageRows` mirrors `ORDER BY ... COLLATE NOCASE ASC, b.id ASC` client-side, and
disagreed with it in two ways that are easy to mistake for one. It folded with
`toLowerCase()` (Unicode-aware, where NOCASE folds ASCII `A`–`Z` only) and then compared
with `<` (UTF-16 code units, where SQLite compares UTF-8 bytes). #4057 fixed the byte
order on the sibling comparator and left this one alone.

The tests isolate one cause each, and each pair was checked to actually diverge before
its assertion was written — because #4057's own worked example (`🎯x` vs `豆`) does not
diverge under either ordering, so a test built on it would have passed against the
unfixed code. That correction is now the reason the tests look the way they do.

### Process notes

**A process exit killed three agents mid-run.** Their edits were intact on disk in their
worktrees, so the recovery was to resume each from its transcript rather than relaunch —
which also meant re-stating the verification each still owed, since a resumed agent
remembers what it did and not what it had not yet proved.

**A docs PR absorbed six review notes, then six more.** Two rounds, twelve notes, one
blocking. The blocking one was the same defect the PR existed to fix, one paragraph
lower: a sentence corrected in `threat-model.md` while the clause two lines down still
asserted the retired claim. Correcting a stale statement in one place and leaving it in
another happened four separate times across this PR's life, which is a strong argument
for sweeping the whole document rather than the cited line.

### #4126 — the baseline that would have hidden thirteen one-line fixes

Widening the doc-citation guard to scan `.ts`/`.tsx` comments surfaced 18 stale
citations. The builder, given an explicit threshold ("≤ 15, fix them; more than that,
baseline them"), measured 18 and baselined all 18. That is the letter of the
instruction and the wrong outcome: of the 18, **13 were one-line directory repoints**
left behind by the #882 crate split (`src-tauri/src/sync_events.rs` →
`src-tauri/agaric-sync/src/sync_events.rs`, and so on) and two component moves. Only
three were genuinely hard.

Two more were not stale at all. The guard's line-suffix stripper handled `:220` and
`:220-351` but not the comma-separated `:220,349-351` form, so it resolved a path that
never existed and reported a live file as a dead citation. Baselining them would have
recorded a scanner bug as tree debt, permanently — the entry would have looked like
evidence that the citation was broken.

So the final shape is 13 citations fixed, one scanner bug fixed, and a 3-entry baseline
whose `reason` fields say what is actually hard about each: a file that no longer exists
anywhere, prose deliberately describing a removed file, and a citation whose target both
moved *and* had the cited function retired.

The general lesson is about the threshold, not the count. A numeric bar on "how many
violations before you baseline" measures the wrong thing — what matters is whether the
violations are mechanical. Thirteen trivial repoints should never have been weighed
against a budget of fifteen.
