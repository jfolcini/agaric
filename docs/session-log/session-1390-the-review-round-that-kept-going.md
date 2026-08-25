# Session 1390 — the review round that kept going

An overnight `/batch-issues` run. It opened as a routine PR-board sweep and
turned into something more useful: of the four PRs waiting to merge, **two
carried blocking defects and both approvals carried real findings**. Merging on
"APPROVED + green" would have shipped a security regression and a fix that made
its own bug worse.

Nothing here is a story about a clever fix. It is a story about how many rounds
it took, and what each round was that the previous one missed.

## The two blocking findings

**#4314 — a refused bind could still rename the device it claimed to be.** The
device-name write sat outside the bind branches, with a comment arguing that a
peer whose bind was refused "still gets its name refreshed if we already hold a
row for it — a device that changed keys is still the device whose name we
display". That reasoning inverts the guard it steps around:
`peer_is_bound_to_another_key` exists *precisely* because "a device that changed
keys" and "an impostor claiming that device's id" are indistinguishable at that
point. A passphrase holder dialling with its own key during an open pairing
window was correctly refused the bind — and then relabelled the victim's real
row anyway.

The important half is why it was invisible: `assert_victim_untouched_4230`
listed three columns in its damage vector, and the new one was not among them.
The guard passed green against the vulnerable write. Extending that vector was
the fix; the gate was the easy part.

**#4312 — the freeze fix was half a fix.** The plain DOM view refused an update
that turned a block into mermaid, so prosemirror rebuilt it. The mirror was
missing, so mermaid → javascript *kept* the React node view and re-rendered it
into the non-mermaid branch — the exact freeze configuration the PR existed to
remove. The PR body's claim that the update "refuses a switch to or from
mermaid" was half true, and the half that was false was the reachable one.

The suggested guard also needed correcting, which only running it revealed:
supplying `update` to `ReactNodeViewRenderer` *replaces* tiptap's body including
its `node === this.node` short-circuit, so calling `updateProps()`
unconditionally reproduces the same never-terminating cycle, confined to
mermaid. It surfaced as a React #185 storm on the first run.

## Being right about one thing made me wrong about the next

The popover fix (#4313) is the sharpest lesson of the night.

The original bug was real: `100dvh` does not shrink for the Android IME, so a
popover capped at `calc(100dvh-4rem)` sized itself against a viewport a third of
which was keyboard. The codebase's own `computeKeyboardInset` proves it — it
derives the keyboard height as `innerHeight - (vv.height + vv.offsetTop)`, which
would be zero if `dvh` shrank.

So I fixed the cap, and *also* fed the keyboard height in as bottom
`collisionPadding`, on the premise that "to Radix the viewport is still full
height". That premise is false. Radix positions with a fixed strategy and an
empty collision boundary, so floating-ui's clipping rect is the viewport rect,
and `getViewportRect` reads `visualViewport` — the same keyboard-free band. The
padding subtracted the keyboard a second time. Measured at an iPhone-13
viewport with a 300px keyboard: **56px** of available height, one row of
padding, against 311px without it. Worse than the bug.

The trap is specific and worth naming: **the helper that proved `dvh` does not
track the keyboard is the same helper floating-ui effectively reimplements.**
The very evidence that convicted `dvh` should have exonerated Radix. Two
consumers of `visualViewport`, and I read one as proof the other was blind.

Two further rounds on the same file were also corrections of my own confident
claims:

- The comment explaining the double subtraction blamed `shift({mainAxis: true})`
  forcing `maximumClippingHeight` outright. For top/bottom placements the main
  shift axis is x, so that never happens; `size()`'s `min()` picks the term up
  instead. **The tell was in my own file**: the comment predicted 356px three
  lines above a test quoting the measured 311px. The `min()` reading predicts
  310px.
- `var(--x, fallback)` substitutes the fallback only when the property is
  *guaranteed-invalid*, not when it holds a negative length — so a negative
  available height dropped the cap entirely rather than falling back. A
  `max(…, 8rem)` wrapper closed that and the missing floor together.

## A bug that needed three rounds because each round fixed the path it was looking at

#4295's placeholder search. #4152 made a blank page findable by its "Untitled"
label; because the match was a folded substring, every blank page then matched
`unt`, `tit`, `led`, `title`, and since blank titles sort first they could
consume the whole result budget.

Round one narrowed the FTS path to a prefix test and argued the `matchSorter`
path was safe because it ranks before it truncates. **Wrong**: `getMatchRanking`
returns STARTS_WITH when the query is a prefix, before it ever reaches CONTAINS,
so every blank page outranks a genuine CONTAINS match for `un`.

Round two partitioned the cache path — and left the *FTS* supplement unpartitioned,
so the crowd-out stayed live for exactly the queries that are prefixes of the
placeholder. The reviewer predicted the test would be red; it was, verbatim.

The guard that should have caught round two queried `title`, which the new
prefix test excludes from matching blanks at all. It was a valid regression
guard against reverting to substring matching, and structurally unable to see
the prefix case. **A test can be genuinely non-vacuous and still be blind to the
neighbouring bug.**

## Guards that block the thing they exist to protect

#4266 asked for a preflight naming a stale `dev.db` instead of letting it
surface as `no such table` from an unrelated crate. Three rounds, all of them
the same shape — *the guard hard-blocking a healthy push*:

- `sqlite://dev.db` stripped to `//dev.db`, which `isabs` calls absolute → "does
  not exist" on a database that was fine. Same for `?mode=rwc`.
- `SQLX_OFFLINE` was not consulted, so a contributor building against the
  committed `.sqlx` caches — who needs no `dev.db` at all — was blocked for a
  condition that cannot affect them.
- Then the fix for *that* introduced its own: the fixture isolation unset
  `DATABASE_URL` but not the variable it had just added, so a developer with
  `SQLX_OFFLINE` exported would have had this file's own pre-commit hook go red,
  with every failure-asserting case failing and every success-asserting case
  passing **vacuously**. Invisible in CI, which exports neither.

The last one is the instructive one: it is the same class the previous round
fixed, one variable over, *introduced by that fix*. The response was to enumerate
what the resolver reads (exactly two variables) rather than patch the named one.

Also settled here: inability-to-inspect now **warns** rather than blocks. A
guard that cannot determine the state is not evidence that anything is wrong.

## A flaky test is a bug with a wide blast radius

The transition test added in #4312 went red on an unrelated PR — twice, initial
run and retry — and being on `main` by then, it reddened everything.

It does not reproduce unthrottled; CI's 17.6s against 2.8s locally was the tell.
Under 8× CPU throttling it reproduced 9 times in 10. `applyLanguage` dispatches
the transaction and *then* calls `onClose()`, so the popover stays mounted for
the ~75–100ms React takes to commit; the helper's `if (!visible) click()` open
therefore skipped the click inside that window and latched onto the dying
picker. CI's retry log resolved an input still holding `value="javascript"` from
the previous pick.

The fix waits on the real signal — "no picker on screen" — not a larger timeout.
A bigger number could not have helped: the wait was for an element that was
never coming back.

That investigation also **bounded #4315**. Sampling the DOM every 40ms across
~50 transitions, the mermaid node view goes 0 → 1 and stays 1 on desktop, with
no console output and no React #185. So the rebuild loop that makes mermaid
unusable under a mobile UA does not reach desktop, and the desktop test is
honest coverage rather than one passing by accident.

## Half-delivered fixes

Two changes shipped the mechanism and forgot the user.

**#4277** made attachment deletes and renames appear in the History view — and
they rendered a badge, a time, and a truncated device id. The filename never
reached the screen, because `getPayloadRawContent` looks for `to_text`/`content`
and neither payload has either. Visible but not identifiable is half of "what
happened to this page".

Fixing the stale attachment list after a revert turned up a nicer surprise: the
reason `resetQueries` could not reach it was not a wrong query key but the
absence of one — those components hold plain local state. So the fix is a
subscription bus, in the shape two others in the tree already use.

**#4277 again**, on the query itself: the History view always calls with
`pageId: '__all__'`, so the *display* consumer runs the space-scoped branch
while `undoDeleteOfImpl` runs the per-page one. Fixing only the per-page branch
would have closed the undo skew and left the view exactly as broken. That was
close.

## What is written down rather than fixed

Fourteen issues, most of them found by the reviewer and deliberately not folded
into the PR that surfaced them: #4315–#4321, #4328, #4334, #4336–#4338. The two
worth reading are **#4328** (`list_page_history` filters neither `is_undo` nor
`is_replicated` while all three undo queries filter both, so *every prior undo*
shifts the same index mapping — commoner than the attachment case it was found
under) and **#4338** (no create site anywhere publishes to the name-change bus,
so the class #4275 closed for two entry points is open for the rest).

## Operational notes

- **`pgrep -f "<pattern>"` matches its own shell**, the same way `pkill -f` does.
  A wait loop guarding a push queue deadlocked on itself. The bracket trick
  (`verify-ci-equiv[a]lent`) is the fix.
- **`set -e` plus `tail` on a not-yet-created log kills the script** before it
  reaches the work. Three chained push jobs died silently that way, leaving
  branches committed and unpushed with no error anywhere.
- **Background jobs do not survive turn boundaries reliably**; `setsid nohup`
  detached queues do. Long verify-then-push runs belong in one.
- **`typos` splits `VERSIONs` into `VERSIO` + `Ns`**, and reads `BRE` (basic
  regular expression) and `unti` as misspellings. Rewording beats suppressing.
- **A Rust change with no SQL still needs codegen.** Doc comments on a type that
  crosses the specta boundary are emitted into `bindings.ts`; improving one
  reddened CI. Separately, promoting a crate to a direct dependency of
  `agaric-sync` invalidates `src-tauri/fuzz/Cargo.lock`, which is its own
  workspace path-depending on it — regenerate with `cargo metadata`, never
  `generate-lockfile`.
