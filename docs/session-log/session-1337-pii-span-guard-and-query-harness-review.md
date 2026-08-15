# Session 1337 — adversarial review of the #3712 span guard and the #3833 harness follow-ups

An uncommitted diff arrived claiming to close #3712 and six of the twelve items in #3833.
The job was to break it. Most of it held. The part that did not held in the most
instructive way possible: the guard was widened correctly and then described in a way that
made the remaining hole invisible, which is the exact failure #3712 was filed about.

## The span guard was widened in the wrong polarity

The diff replaced the old `span.record(…)` literal-name match with a match on any receiver
that is `span`, ends with `_span`, or is `Span::current()`, and called that "the codebase's
naming convention for a held span binding". SECURITY.md was updated to say the limit was a
`Span` "held in a binding outside it".

That framing sounds like a bounded residual. It is not — it is an allowlist of *names*
standing in for a type check, and an allowlist that is wrong by default is a guard that
fails open. A probe file dropped into `src-tauri/src/` (the scan walks the filesystem, so
it does not need to be `mod`-declared, and it is genuinely read — it fired) carried fifteen
`.record` / span-macro sites. Seven were caught. Eight sailed through: a span in `s`, in
`sp`, in `tracing_ctx`, one reached through `make_span().record(…)`, one through
`spans[0].record(…)`, one through a struct field named `sp`, one bound with an explicit
`let s: tracing::Span` annotation, and — the one nobody's documentation mentioned at all —
`tracing::span!(Level::INFO, "n", page_title = t)`, the generic macro that all five
`{info,debug,…}_span!` shorthands expand to. The diff enumerated the five shorthands and
stopped, so the base macro they desugar into was still unscanned. That is the same blind
spot one level down, in a change whose entire purpose was to close a blind spot one level
down.

So the polarity is inverted. Every `.record("literal", …)` in the workspace is now checked,
and exactly one receiver name is excluded: `recorder`, the DNS query helper in
`agaric_sync::transport::endpoint`, which takes a leading string literal exactly like
`Span::record` and therefore cannot be told apart by argument shape — the diff was right
about that much, and its own comment said so after correcting an earlier claim to the
contrary. The measurement that made this cheap: with deny-by-default turned on, the only
offenders in the entire workspace were the fifteen probe lines. One exclusion buys the whole
thing. The macro scan collapsed to a single `span!` marker, which is a substring of the
generic macro and of all five shorthands at once, with the leading positional arguments
(an optional `Level` / `parent:` / `target:`, then the mandatory literal name) dropped by
shape rather than by counting. All fifteen probe sites are now caught, and the workspace is
still green.

SECURITY.md and both module docs were rewritten to describe the mechanism that exists
rather than the one that was intended. What the guard cannot see is now stated as what it
actually cannot see — a non-literal key, `.record_all`, and a value that turns into user
content under an already-allowlisted name — and no longer includes the sentence about
binding names, because binding names no longer matter.

## The allowlist additions are fine, with one name worth watching

`kind`, `size` and `deduped` all come from `mat_batch` in the materializer: two string
literals `"fg"` / `"bg"`, and two counts. Opaque, correctly added. `child_count` turns out
to be emitted by nothing in production — its only site is `agaric-observability`'s own
in-crate leak-guard test, which builds a span with `child_count = 3_i64`. Harmless, but it
means the allowlist now carries an entry that no shipping span produces, which slightly
dilutes "adding a key here is the review point". The real hazard is `kind`: the allowlist is
keyed on the name, so a second site adopting that name inherits the allowance with no
review, and `kind` is exactly the sort of generic label that ends up holding a user-authored
value. Noted in the allowlist doc rather than removed.

## The truncation-marker exemption was the width of its two bookends

`is_truncation_marker_line` shipped as `starts_with("…[truncated ") && ends_with(" bytes of
older content]")`. Everything between those two literals was echoed verbatim out of a
deny-by-default redactor. `…[truncated Q3-Layoffs-Plan bytes of older content]` round-trips
untouched. Reaching it needs a newline inside a span attribute, and `exporter::format_span`
— unlike `format_log_record`, which sanitises every field and says in a comment that doing
so "guarantees no field can ever split a record" — does not `sanitize_inline` its name or
its attribute values. So the injection is not reachable today only because the layer above
happens to hold. The redactor is the layer that is supposed to hold when that one does not.
The middle is now constrained to ASCII digits, which makes the whole line a compile-time
literal plus a byte count derived from the file's own size.

The `SKELETON_SEQUENCES` rewrite, by contrast, is exactly right. All five sequences match
their writers character for character (`format_span`, `format_log_record`,
`write_frontend_span`, and the two metrics writers), and the position-bound check can only
ever be a subset of the old membership check: if a sequence matches every key at every
position, every one of those keys was in the old flattened union too. It narrows, it cannot
widen.

## Item 10 was half-right, and the half that was dropped was implementable

The diff declined to implement #3833's item 10 as literally written — "assert every recorded
row token matches `B\d+`" — on the grounds that property and tag tokens are user-authored
keys. That argument holds: `query_point_reads_properties` records `estimate#Num=3` and
`linked#Ref=B3`, and the literal assertion would redden on a fixture that is entirely
correct. Good call, and the issue should be told so.

But item 10's *property* is not that regex. It is that `relabel_head` falls back to the raw
id when an id is missing from the label map, and `conformance_query.rs` sells that fallback
as a safety feature — "a leak is visible rather than silently dropped" — when nothing fails
on it. That property is implementable without touching property tokens at all: no recorded
atom, head or attribute value, may still be a raw twenty-six-character Crockford-base32 id.
It is now checked, and it is green across every fixture. (The claim about `null` being a
legitimate id value, offered as further support for dropping the item, does not survive
contact with `attr_value`, which renders a null as the string `null` and never as a
sentinel.)

The sentinel check itself over-reached in the other direction. It scanned attribute values
as well as heads, and its comment asserted that none of the four sentinels "is producible by
any content the row-token guards allow through". That is false for `?`: `attr_value` forbids
only `#` and `->`, so a property whose `value_text` is a single question mark is legal
fixture content that the guard would have reported as a projector fault. All four sentinels
are minted at head positions and nowhere else, so the check is now heads-only — no coverage
lost, one false-positive class gone, and one more overclaim about a guard's reach removed.

## Both uniqueness guards were decoration

The step-name uniqueness check shipped on two stacks and neither had a test. No fixture can
trip either one, so both bodies never executed on any run. The TS half was a private
function, so it could not even be tested from outside. Both are now covered, and covered on
both halves of the pair: the predicate, and the fact that the runner actually calls it before
touching anything. Deleting the call from `runQuerySteps` reddens exactly one vitest case and
leaves the body tests green; deleting it from `run_query_steps` does the same on the Rust
side, and does it with a panic reading "query step is missing required arg 'scope'" —
incidental proof that item 4's `arg_req` switch really does fail loudly where `arg_or` used
to quietly widen the query to `Global`. The Rust duplicate finder also reported a
thrice-repeated name twice where the TS twin reported it once; the two messages agree now.

## The fixture regeneration baked in some formatting along with the fix

Item 6's third page is correct by reasoning, not just by regeneration: Aardvark, Alpha, Beta
is the alphabetical order under both byte comparison and case folding, the seed order is
B1, B2, B5, and the three pages give a `total_count` of 3 — so the step now distinguishes
`sort: alphabetical` from id order and from an outright reversal, which was the whole point.
What came along with it was three unrelated `rows` arrays exploded from one line to four by
`serde_json`'s pretty printer, in a repo where every other fixture keeps them inline. The
claim that incidental churn had been reverted did not hold. Running `oxfmt` on that one file
— which is what the prek hook does anyway — took the diff from forty-three changed lines to
twenty-six, all of them the actual change.

## On the deferrals

All five hold up. Item 11 is not merely latent — both `DRIFT_SKIP` and `QUERY_DRIFT_SKIP`
are empty, *and* #3826 already added the compensating guard that forces any command whose
steps are all skipped to be declared backend-only, so a skip cannot read as coverage today
even if someone filled the set. Item 5 is genuinely a wide mechanical refactor: fifty
accessor call sites across twenty match arms would each need a fixture name threaded
through, which is noise in an otherwise surgical diff rather than something being avoided
because it is hard. Items 1, 2 and 8 are new-fixture work, an acknowledged granularity
caveat, and an awareness note respectively.

The PR may say `Closes #3712`. It must not say `Closes #3833` — six of twelve, one partial,
five deferred, so that one gets a re-scope comment.

## One claim that did not reproduce

The reported nextest counts do not. `test(conformance) + test(pii) + test(span)` runs 72
tests on the diff as it arrived (76 with the four added here), not 80; adding
`test(bug_report)` gives 142, not 149. Worth noting that the notation as written —
`cargo nextest run 'test(conformance)'`, without `-E` — runs *zero* tests, because a bare
argument is a substring filter and not a filterset. The vitest and `tsc -b` claims
reproduced exactly.
