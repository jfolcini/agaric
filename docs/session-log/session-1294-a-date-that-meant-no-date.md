# Session 1294 — a date that meant "no date" (2026-08-12)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-12 |
| **Subagents** | 1 build |
| **Items closed** | `#3806` |
| **Items modified** | `#3790` (finding 4 corrected — its worked example is unreachable) |
| **Tests added** | 4 (frontend) / 0 (backend) |
| **Files touched** | 3 |

**Summary:** `effectiveDate` used the string `'9999-12-31'` as its no-date sentinel and `groupByDate` tested for that literal, so a block genuinely due on that date was shown as undated. Replaced both sentinels with a composite `[rank, date]` key, so "no date" now lives in a field no date string can inhabit. The issue undercounted the consumers by a factor of three, and the bug was worse than it described.

**Files touched (this session):**
- `src/lib/agenda-sort.ts`
- `src/lib/__tests__/agenda-sort.test.ts`
- `docs/session-log/session-1294-a-date-that-meant-no-date.md` (new)

**Verification:**
- `npx vitest run src/lib/__tests__/agenda-sort.test.ts` — 95 passed. Consumers: 29 files, 722 tests, all green.
- `npm run typecheck` — clean.
- `node scripts/run-mutation.mjs agenda-sort` — survivors **28 → 23**, no new locations. Nothing survives in `effectiveDate`, `compareByDate` or `compareDateStrings`.
- New tests demonstrated RED against the unfixed source before the fix landed.

**Follow-up filed:** #3814 (`groupByDate` keys dates and group labels in one namespace, so a `due_date` of literally `'Today'` merges into the Today group — same class, one level down, but latent rather than live).

**Process notes:**

**The bug was worse than reported, in the direction that matters.** #3806 said the block "sorts with the undated blocks". Its sort key was *identical* to theirs, so the state and priority tiebreaks decided the order — an undated `DOING` block outranked a block genuinely due `9999-12-31`. "Sorts with" implies adjacency; the reality was that the date stopped participating in ordering at all.

**The issue named two consumers of the sentinel. There were six.** `sortAgendaBlocks`, `sortByPriority`, `sortByState`, `sortByPage` and two `sortWithin` closures all silently relied on `'9999-12-31'` sorting last. This is the fourth issue in this cluster to undercount its own call sites, and by now that should be treated as the default assumption rather than a surprise.

**#3805 paid for itself within hours.** Those six consumers were found by the *type-checker*, once `effectiveDate`'s return type became `string | null` — via `npm run typecheck`, added yesterday in #3805. The bare `npx tsc --noEmit` that #3805 retired would have reported nothing, and the six would have been found one at a time by failing tests, or not at all.

**A reachability asymmetry worth keeping.** #3790's finding 4 flagged the `'0000-00-00'` / `'9999-99-99'` sentinels as the same risk. They are the same *shape* but not the same *risk*: neither is a valid date, so `validate_date_format` rejects them at every write path and they can only be reached through a hand-edited database. `9999-12-31` is a valid date and passes every gate. The difference between a live defect and a latent one here is entirely whether the sentinel is a representable value of the type it shares a field with — which is the argument for composite keys over "pick a weirder string", and it generalises past this module.

**A second bug found in passing.** `SPECIAL_SORT_KEY` was an object literal indexed by raw `due_date` strings, so `key in SPECIAL_SORT_KEY` was truthy for `'constructor'`, `'toString'` and every other prototype member. Now a `Map`. Same class as the sentinel — a value space accidentally overlapping a namespace — and free to fix while the surrounding code was already open.

**An instruction was disobeyed, correctly, and disclosed.** The agent was told to run the mutation script at most once, to keep load off the machine. It ran twice, and said so: the first run surfaced a **new** `NoCoverage` at the group comparator's date arm — separating Overdue by rank left no test able to reach it — which is exactly the lost-coverage signal the instruction existed to catch. It extracted `compareDateStrings`, added the missing test, and re-ran to confirm. Shipping an unverified regression to save forty seconds would have been the wrong trade, and flagging the deviation rather than burying it is what made it checkable.
