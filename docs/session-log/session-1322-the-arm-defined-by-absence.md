# Session 1322

## The arm defined by absence, for the third time

#3878 fixed a ratchet that keyed on the command, so an uncovered branch of a covered command
read as covered, and claimed its command was the only one shaped that way. #3892 existed
because that was wrong. #3930 fixed the second instance and, in its own review, was found to
contain the same defect one level down. This is the third pass, over `search_blocks`,
`run_advanced_query` and `list_pages_with_metadata`.

The issue predicted four arms in `search_blocks`. There are five. `has_filters` splits the
blank-query early return into two: the genuinely empty page, and an FTS-free `FROM blocks b`
scan ordered `b.id DESC`. Session 1318 named this trap — the arm you miss is the one defined
by *nothing being present* — and it caught us again on the very next command. Worth stating
without hedging: naming a failure mode does not stop you making it.

### The gap was hiding four divergences, not one

`search_blocks`' single existing step left every toggle at its `serde(default) = false` and
supplied no filter, so it drove the one arm the mock happened to implement. The handler was
`if (!query) return empty` plus a folded-substring scan, ignoring `filter` entirely. Adding
the missing steps turned up, in one pass:

- blank query with a filter returned `[]` where the backend returns three blocks
- `isRegex` matched the pattern as a literal substring
- `caseSensitive` was ignored
- `wholeWord` was ignored

Four live cross-stack divergences, behind a ratchet that read green. #3930 found one this way;
this found four. The pattern is now well enough evidenced to state as a rule: an uncovered
branch is not a documentation gap with a divergence occasionally behind it. It is where the
divergences are.

### A divergence a conformance step cannot express

The mock's `sortDiscriminator` returned `5` for `alphabetical`, justified in a comment as
"frontend-only" and "rides the `default` wire keyset". Both halves are false —
`PageSort::Alphabetical` is the `#[default]` wire variant, with its own `StringAsc` keyset and
discriminator `1`. So the mock minted cursors tagged `default` for alphabetical queries, and
accepted a cross-sort cursor the backend answers `RequiresRefresh` to.

No step can catch this, because a conformance step records a *successful* response and this is
a divergence in what gets rejected. It was found by reading the Rust to author the manifest —
which is the argument for authoring branch entries by reading the source rather than by
reading the mock. Three hand-written expectations in `sort-cursor-conformance.test.ts` had
repeated the same wrong belief and were corrected.

### What a sort branch has to prove

The five `PageSort` arms are pinned by data chosen so the five orders are pairwise distinct:
`[B2,B3,B1]`, `[B1,B2,B3]`, `[B1,B3,B2]`, `[B3,B2,B1]`, `[B3,B1,B2]`. Each step therefore
falsifies the other four, and every step is `ordered: true` — a set comparison over a sort arm
is not evidence of anything.

`sort-default` is one honest exception. Its `b.id ASC` is byte-identical to the tiebreaker, so
deleting the arm is a no-op and the delete-the-line test cannot redden it. What the branch pins
is the *routing*; misrouting it to a sibling reddens. Recorded rather than papered over,
because a branch whose deletion changes nothing is exactly the shape this whole line of work
exists to catch, and the distinction between "no behaviour" and "no observable difference from
the fallback" is the one that matters.

### The exception this session claimed not to have

Review re-ran the delete-the-line test independently, per branch, and found a **second**
un-reddenable branch that had been shipped as plainly covered: `search_blocks::fts-match`.
Deleting the `if !toggles.any()` fast path — so an all-toggles-off query falls through to the
post-filter instead of short-circuiting to `search_fts` — leaves every conformance fixture
green. It is worse than `sort-default`, not equal to it: `sort-default` still reddens when
misrouted to a sibling, whereas for this arm the deletion *is* the misrouting, because the
fallthrough is the sibling.

The arms genuinely differ, but every difference is invisible to this harness. With no toggle
on, `compose_literal_pattern` composes `(?i)<escaped query>`, which every FTS candidate already
satisfies — except where `fts_blocks.stripped` differs from raw `blocks.content` (markup
stripped, `[[ULID]]` references resolved, NFC applied). That is the one falsifier, and the
mock's FTS stand-in folds over raw `content`, so a fixture shaped to exercise it would redden
the mock leg for an unrelated reason. Lifting it needs the mock to model `strip_for_fts`, not
another step. The arms' remaining differences — `snippet` cleared vs kept, `match_offsets`
populated, survivor-derived `has_more` vs a `limit + 1` probe — are not fields the query runner
records at all.

Recorded in the manifest entry alongside the branch. The lesson is not that one arm was missed;
it is that the sentence "every branch was checked by deletion" was written without every branch
having been checked by deletion, in the change whose whole subject is claims outrunning
evidence.

### The denominator, including the part not done

`run_advanced_query` forced the manifest to grow from one chain per command to a list of
dimensions, because `group_by` and `has_fulltext` compose rather than exclude. Four branches
declared, three covered, `grouped` waived — it answers under `groups[].members` with `rows`
empty, the same projection-shape blocker `search_blocks_partitioned` is waived for.

The number that matters is the one that is easy not to print: **those four are roughly two of
its six dispatch surfaces.** `resolve_sort`'s six arms and its conditional tail,
`group_key_expr`'s **seven** arms behind the waived branch (`Tag` / `Page` / `State` /
`BlockType` / `Priority` / `Property` / `DateBucket`, the last sub-dispatching again on
`DateField`), the five aggregate ops, and the fifteen-leaf `FilterExpr` vocabulary this command
accepts (`QUERY_ALLOWED_KEYS`; `FilterPrimitive` has 23 variants, 15 reachable here) of which
two leaves are driven — all still uncovered. Modelling `resolve_sort` needs a per-element
dimension whose default arm is itself conditional, which `defaultBranch: string` cannot carry.

The seven was written as six on the first pass, counted from the match rather than from the
`GroupKey` enum. Understating the remainder inflates the coverage fraction exactly as
overstating the numerator does, which is the failure this section exists to avoid.

So `run_advanced_query` is 4/4 on what is declared and nowhere near covered. Saying only the
first number is how a ratchet earns unwarranted trust in the first place.

### Guarding the guard

Three new cross-checks parse the Rust rather than trusting the manifest: the three `PageSort`
match sites compared to each other as well as to the manifest, `search_with_toggles`' arm order
and its `has_filters` disjuncts, and the engine's two structural switches. Plus a
well-formedness guard — one shape per discriminator, branch names unique across dimensions.

The `search_blocks` cross-check immediately caught a real error in the entry that had just been
written: the wire field is `lastEdited`, not `lastEditedFilter`, wrong in both the manifest and
the mock. A guard that catches its own author on the first run is the only kind worth having.

Review then found a hole in that same guard and closed it. The `has_filters` parser scanned the
expression for identifiers followed by `.` or `)`, so a disjunct that is a BARE bool
(`|| some_flag;`) matched nothing and the guard stayed green while `has_filters` had grown an
arm — demonstrated by adding one and watching all 18 tests pass. It now splits on `||` first
and reads the base identifier of each TERM, so an unparseable disjunct fails the comparison
instead of vanishing from it. The guard's own failure message already named this exact
consequence ("a disjunct added there and missed here makes a filtered blank query credit
`blank-unfiltered`, the empty arm it never ran"); it just could not detect the case it
described.

Each of the four cross-checks was demonstrated RED by writing the drift it exists to catch:
hoisting `is_regex` above the blank test, dropping a `has_filters` disjunct, hiding two
`PageSort` variants behind a `_` wildcard in `sort_discriminator`, and renaming the engine's
`request.fulltext` read. The well-formedness guard was demonstrated RED by colliding a branch
name across two dimensions and by giving one discriminator both `field` and `when`.
