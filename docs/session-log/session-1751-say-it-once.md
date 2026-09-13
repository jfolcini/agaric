# Session 1751 — the same reason, twice, three times over

Non-blocking review notes from #5018 and #5019, batched per AGENTS.md. All
comment text; no code changed.

## One habit, not three findings

Two reviews on two PRs flagged the same shape independently:

| where | the duplication |
|---|---|
| `fts/search/sanitizer.rs` | `prepare_match_expression`'s doc and its inline comment both explain why the blank-query guard is not redundant |
| `recurrence_math.rs` | `catch_up_past_today`'s doc and the `REPEAT_MODE_PLUS_PLUS` arm both explain the #680 stale-date rule |

Both came from the same move: extracting a helper, writing a doc comment for
it, and *also* leaving an explanation at the call site — because at the moment
of extracting, both places feel like they need one. They do not. The rule is
already in AGENTS.md ("Say it once. A rule and its one reason, in the same
breath"), and the useful refinement is knowing *which* copy to keep:

- **`prepare_match_expression`** — keep the **inline** comment. The guard-order
  subtlety (the length cap sits between the two empty checks, so deleting the
  blank guard turns an over-long blank query from an empty page into a
  validation error) has to sit where a "prefer deleting" pass will land, which
  is on the guard, not in the doc header.
- **`catch_up_past_today`** — keep the **call site**. Its three lines are what a
  reader hits first when following `project_block_dates`, and the decision the
  comment justifies (`None => continue`) is made there, not in the helper.

The doc comment keeps the mechanism in both cases; the reason lives once, at
whichever point a future reader is standing when they need it. Net −4 lines.

## Stale deixis, again

`list_single_page_history`'s doc said the attachment ops are the ones "the two
probes in the doc above attribute back to it". After session 1750 split
`list_page_history` into two branch helpers, "above" is `list_global_history`'s
doc block — the probes are documented on `list_page_history`. Now an explicit
intra-doc link to it.

Third instance of this class in three sessions (#5014 fixed two in
`post_filter.rs`). Positional references — "above", "below", "the loop that
follows" — survive the edit that invalidates them, because nothing checks them.
A `[`name`]` link does not: `-D rustdoc::broken_intra_doc_links` fails the build
if the target moves or is renamed. When a comment must point somewhere, point
with a link, not a direction.

## Verification

Comment-only, so the only thing that can break is the new intra-doc link:

- `cargo doc --workspace --no-deps` with `-D rustdoc::broken_intra_doc_links`: clean
- `cargo clippy -p agaric-store --all-targets`: clean
- the pre-push verify (vitest, nextest, doc-tests, the four sqlx lanes)

## Also recorded: two environment traps hit in session 1750

- **GitHub's "Update branch" button fails `dco` here.** It writes a merge commit
  authored by the repo owner with no `Signed-off-by`, and this repo's gate wants
  a trailer whose email matches the commit author — so `git commit --amend -s`
  with a different local identity only trades "missing sign-off" for "email
  mismatch". Merge the base in locally instead; the commit-msg hook signs it.
- **`git push` for a Rust change must go through `scripts/push.sh`.** Raw push
  opens the connection before the pre-push hook runs, so GitHub drops the
  now-idle socket during the multi-minute verify. The script exists for exactly
  this and forwards every flag, `--force-with-lease` included. Its header
  documents the failure; I hit it anyway by reaching for `git push` directly.
