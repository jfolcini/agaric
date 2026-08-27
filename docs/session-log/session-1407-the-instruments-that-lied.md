# Session 1407 — the instruments that lied

A continuation of 1406's overnight loop, working issues #4380 and above. Ten PRs merged or
readied, ten issues filed. Every reviewer found something real again, and three separate
findings were the same shape: **a test or a guard that agreed with a bug instead of
catching it.**

But the through-line this session is not in the repo. It is that my own tooling reported a
state the world was not in — five times, and every one read as good news.

## What merged

| | |
|---|---|
| **#4437** | Android alignment: an assertion that asserted the *opposite* of its intent and passed because the string was imaginary |
| **#4438** | Sync: the pairing refusal leaves no *permanent* state, not no state |
| **#4431** | CI: a rename is not a new claim, and a stacked child owns its parent's collision |
| **#4424** | Release: the ratchet skipped the four files its own comment claimed to cover |
| **#4434** | prek: a tokeniser throw and a trailing comment could each red every commit |
| **#4440** | Watchdog: 112 assertions over a comparison that could never be true |
| **#4442** | Lint: six rules promoted to `error`, and the violations they were hiding |
| **#4449** | e2e: a rescue that ran only on the path where there was nothing to rescue |

In flight with review fixes: **#4441**, **#4448**, **#4453**.

Filed: **#4439**, **#4443**, **#4444**, **#4445**, **#4446**, **#4447**, **#4450**,
**#4451**, **#4452**, **#4454**, **#4455**, **#4456**, **#4457**.

## Three tests that sided with the bug

**#4441 is the worst of them, and it was mine.** The space-scoping fix returned early on a
mismatch *before* bumping `nameChangeGenerationRef`, so a cross-space rename stopped
invalidating in-flight fills — reopening #4007, where the `[[` picker serves a stale title
for the rest of the session.

The PR did not merely miss it. It shipped a test titled *"does NOT bump the generation for
an 'added' event whose captured space differs from the live active space"*, asserting the
stale snapshot persists, with a comment arguing that a mismatch must cost the hook nothing.
A second test had been quietly retargeted from the origin space to the live-at-emit space,
so it matched, passed, and stopped exercising its own name.

Two green tests, both pointing away from a reopened bug, one of them arguing for it.

The design error underneath: the two guards measure **different spaces**. The subscriber
compares against the space live at emit; an in-flight fill is pinned to the space it
captured at dispatch. Those agree except across an A→B→A round trip — exactly the window.
So "a mismatch costs this hook nothing" was never purchasable. It was bought with #4007.

**#4437**: an assertion checked that output does *not* contain a string the guard never
emits. Vacuously true. It could not simply be corrected, because the real text **is**
emitted for the case the fixture exercises — negating it would fail. The clause had to
invert. It was not a typo in a sound assertion; it asserted the opposite of the intended
property and passed only because the string was imaginary.

**#4440**: 112 assertions and two negative controls passed over a comparison that could
never be true — `runId === prior.runId` compared a JSON number against a marker-text string.
Every fixture used strings, which round-trip to themselves. The fixtures are numbers now,
not one numeric case added beside the strings, because a suite whose fixtures differ in type
from production is the thing that failed.

A later round found the sibling: fixing the over-count at the *parser* let it re-enter
through the *renderer*, because `buildIssueBody` had no `migrated` case. The existing test
could not catch it — its migrated lane was the only lane, so nothing forced the intermediate
rewrite.

## Five times my own instruments lied

Each of these reported success or progress for something that had not happened.

1. **A `pgrep -f` waiter matched its own command line.** `until ! pgrep -f "prek run
   --all-files"` never exits, because the waiter's own `-c` argument contains that string.
   The watched job had finished cleanly 43 minutes earlier. I wrote this bug **twice** in
   one session — once in the push queue, then again in a prek waiter after fixing the first.
2. **A third instance, in the same turn I recorded the second.** `pgrep -f "drain.sh"`
   reported a script "running" that had never been written, because a blocked `sleep` had
   killed the heredoc that would have created it.
3. **A jq precedence bug read a failing check as SUCCESS.** `select(.name//.context=="x")`
   parses as `.name // (.context=="x")`; `.name` is truthy, so `select` keeps *every*
   element and `.[-1].conclusion` reports an unrelated check. It nearly cancelled a needed
   rebase. `|test(...)` is safe — `|` binds looser than `//`.
4. **A memory entry written from a mis-measurement.** I claimed `prek run <bogus-id>` exits
   0. It exits 1. The measurement was `prek … | tail -5; echo "RC=$?"` — which reads
   *`tail`'s* status. That is the "never read a piped exit code" rule already in my own
   memory. The wrong number then hardened into a memory entry and four subagent prompts
   before a subagent re-measured and corrected it.
5. **A waiter outliving its producer.** After killing the rebase pass so it would not race
   the fixer agents, its consumer kept polling for a completion marker that could never
   arrive.

The pattern is sharp enough to state: **I was rigorous about falsifying the code and casual
about falsifying the instruments I judge it with.** A wrong observation is more dangerous
than a wrong fix, because nothing downstream catches it — and every one of these five
presented as progress.

The generalisation worth keeping past the specific bugs: *a measurement that surprises you
deserves a second, differently-shaped run before it becomes a durable claim.* Surprise
signals a likely confound, not a discovery. I treated one as a finding and wrote it down.

## An ordering mistake with a repo-wide blast radius

#4431 added a `session-log-pr-collision` job that checks out the **base** commit to find its
own script. Merging it mid-batch turned every sibling PR red: their fork points predate the
guard, so the base checkout has no script and the job fails closed.

The guard is right — refusing beats guessing. The ordering was mine. Rebasing each branch
onto current `main` advances `base.sha` and clears it, confirmed empirically
(`bf0ef97d → c8f1988d`, guard green).

There is a second-order lesson: I then launched fixer agents into worktrees that still had
in-flight push gates, and `push.sh`'s prek phase auto-fixes files. One agent reported its
edits reverted mid-run, re-applied them, and verified stability across three consecutive
diffs. It caught my sequencing error; I did not.

## Corrections to issues, made before implementing them

- **#4385** proposed evicting by `endpoint_id IS NOT NULL`. That predicate punishes migrated
  pre-0107 pairs — genuinely paired devices that stay unbound until their first *successful*
  iroh session, i.e. exactly the peer the policy exists to protect. It is also near-vacuous
  on the initiator path, since the bind happens immediately after `record_success`, which
  *deletes* the backoff entry. The right predicate is `peer_refs` membership.
- **#4402** counted four sites; there are **eight** — the issue enumerated predicates and
  missed two `ORDER BY`s inside the #2212 ancestry CTE, where the disagreement changes the
  *set* the predicate runs over. It also framed the trigger as a rare clock collision:
  `created_at` is epoch **milliseconds**, so a tie is two ops in the same millisecond.
- **#4408**'s premise was that the React Compiler counts were lower bounds. They were exact —
  both rules are syntax-only and never needed tsgolint. What type-aware actually buys is 12
  rule names producing nothing without it, two of which were **already configured as
  `"error"` and inert the whole time.**
- **#4428** — which I filed to correct someone else's unmeasured guess — contained one of my
  own. I wrote that an AT-SPI warning costs "~30s". Measured: 30.1s in 32 of 36 boots, a
  flat constant that is a fixed timeout, with nothing tying it to AT-SPI. Filed as #4444
  with the measurement and an explicit refusal to name a suspect.

## Two guards that were checked rather than trusted

**#4453's canary.** It plants a floating-promise fixture and requires a `typescript(...)`
rule to trip, proving the type-aware backend is alive. The review found it proves the
*toolchain* works, not that *this run* used it — `runCanary` hardcodes `--type-aware` in its
own argv. Drop the flag from the workflow and every gate still passes. The replacement
compares the main run's own `number_of_rules` against a plain baseline measured at run time;
the alternative of echoing the step's argv and grepping it was rejected as **self-certifying
— it verifies what the step said it did.**

Keying that guard on the exit code was my suggestion and it was wrong, established by
measuring rather than reasoning: findings, missing tsgolint, an unknown flag, a rejected
config and a bad path **all exit 1**.

**#4447** was filed after falsifying it: neutering `check-space-filter-drift`'s findings exit
produces output byte-identical to the control — 7 cases green either way. A self-test that
exercises a guard's analysis but not its exit verifies the half that was never in doubt.
