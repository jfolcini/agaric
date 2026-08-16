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

## Review round two: the one residual that pointed the wrong way

PR #3980 came back APPROVED with seven notes. The guard's doc comment enumerates its own
residual limits honestly and at length, and every single one of them OVER-flags: a receiver
on the non-span exclusion list, a non-literal `.record` key, a macro whose name merely ends
in `span!`. Under-flagging is the only direction that costs privacy, and the doc did not
name a single case of it — because the author had not found one. Note 2 found it.

`src[idx..].find('(')` hard-assumed a paren-delimited invocation. `info_span!{"n", page_title
= t}` and `info_span!["n", search_query = t]` are both legal Rust, and against either one
`find` walks straight past the invocation to some unrelated `(` further down the file, hands
`balanced` an argument list belonging to something else, and the macro's real fields are
never looked at. Both arms were confirmed unscanned before the fix: two probe macros
carrying `page_title` and `search_query` — the exact field name this whole guard was written
for, after `import_markdown_with_progress` shipped it — sat in `commands/bug_report.rs` and
the guard passed. Not "would in principle"; it passed, twice, once per delimiter.

The fix is an anchor rather than a wider search: the marker must be followed (modulo
whitespace) by one of `(`, `[`, `{`, and the group that opens there is the only thing read.
That also closes note 1, which is why the reviewer's suggested `!(` anchor was not taken —
it would have fixed note 1 while re-cementing note 2.

Note 1 needed correcting on its way in. The claim was that the scan matches its own
`let marker = "span!";` and fabricates an offender pointing at itself; it cannot, because
the scan skips `rel == file!()`. But the class is real one file over, and that is where it
was reproduced: a bare `"span!"` string literal in `bug_report.rs`, followed by a paren call
carrying `key = value`, produced

    "src/commands/bug_report.rs: span! field `page_title`"

for a macro that does not exist there. A guard that invents offenders in other people's
files is a guard people learn to route around. The delimiter anchor rejects it, since a
marker inside a string is followed by the closing quote and never by a delimiter.

## Binding a table to its writers, one layer up

Note 3: `SKELETON_SEQUENCES`'s own doc calls editing it "the review point", and nothing made
an edit to a line-format writer *require* one. `stable_messages_pin_real_call_sites` has
pinned exactly this shape of promise for `STABLE_MESSAGES` since #700, so the new guard is
its sibling: scan `agaric-observability` for a `"end={end}` format literal, read the `<key>=`
heads of its `\t`-separated segments, and assert set equality against the table. Both
directions, because the property is symmetric — a writer with no entry was demonstrated by
appending one field to `format_span`, and an entry with no writer by adding a fabricated
`["end","gauge","value"]` row. The failure this prevents is fail-safe and therefore silent:
adding a field to `format_span` does not leak anything, it collapses `dur_ms`, `status` and
the entire attribute tail of every bundled trace line to `[REDACTED]`, and the bundle still
ships looking fine.

## A mirrored pair that was not mirrored

Note 6 was the interesting one of the four judgement calls. `duplicate_step_names` skipped a
step with an absent or non-string `name` via `filter_map`; the TS twin read `step.name`
unconditionally, accumulated `undefined` into its `Set`, and reported

    fixture has duplicate query step name(s) [null] — every `queries[].name` in a fixture
    must be unique, or a failure cannot be attributed to the right step.

— a duplicate of a name no step has, telling the author to de-duplicate something that is
not there, while the Rust twin said nothing at all about the same input. Both sides parse
their fixture into a shape they merely assert (`Value` here, `JSON.parse(...) as Fixture`
there), so neither type is a check and the case is reachable in both. Made to agree by
rejecting a nameless step by INDEX, up front, in both twins. The reproduction needed two
nameless steps: one alone collides with nothing, which is why this survived — the
degenerate-looking input was not degenerate enough.

Note 4 keeps its asymmetry and says so: `rawIdHits` scans attribute values where
`rowSentinelHits` went heads-only, because a raw id genuinely does reach an attribute value
whereas the four sentinels are minted at heads and nowhere else. The price is a false
positive on a `value_text` that happens to be 26 Crockford characters, and the message now
names both fixes and says which is which, instead of sending every hit to the label map.
Note 5 collapsed a ten-line rationale that existed twice. Note 7 needed no code, but the
documentation now states what it is actually load-bearing for: nothing asserts `child_count`
still has no production emitter, and nothing asserts `kind` still has one site — the entry a
future `kind = user_input` would need already exists.

## Review round three: the residual list asserted a property the code did not have

Round two ended by sorting the guard's residual limits by direction and closing with a
sentence I wrote myself:

> Every one of these OVER-flags or is a review question; none of them lets a field through
> unscanned, which is the only direction that costs privacy

That sentence was false at the moment it was committed. `balanced` was not literal-aware, so
a closing delimiter inside the span NAME truncated the group before the fields were reached:

```rust
tracing::info_span!("n)", page_title = t)
```

`balanced` returns `"n`, `span_macro_field_keys` finds no fields in it, and `page_title` —
the exact attribute this guard was written after `import_markdown_with_progress` shipped it
— goes unscanned. Confirmed end to end before touching anything: that probe sat in
`commands/bug_report.rs` and the guard passed, `1 test run: 1 passed`.

This is the third round in a row where the same shape has surfaced one layer further in. The
guard scanned `#[instrument]` but not `span!` (#3712). It scanned `span!(…)` but not `!{…}`
or `![…]` (round two). It balanced delimiters but not the literals containing them (this
round). Each time the residual list was rewritten to be more careful, and each time the new
list was more confident than the code underneath it. The failure mode is not the missing
feature; it is that a *list of admitted weaknesses* is the artefact a reviewer trusts when
deciding how hard to look at a new span, and this one promised a property nobody had checked.

I fixed both halves rather than choosing. The reviewer offered "track string literals, or
amend the sentence", and preferred amending — accurate prose beating an inaccurate claim plus
a partial fix. That framing is right, but it is not actually a dilemma here: `opaque_prefix_len`
is one self-contained function that recognises strings, raw and byte strings, char literals
and (nesting) block and line comments, and both `balanced` and `top_level_parts` walk through
it. So the sentence got deleted AND the case it was wrong about got closed — with the deletion
kept visible in the doc rather than quietly swallowed, because "we once claimed this and it
was not true" is the part a future reader needs.

The residual list is now sorted by direction with the under-flags FIRST and stated as
maintained-by-review rather than proved exhaustive, which is the distinction the old sentence
blurred. Three known under-flags remain, all in the `.record("` marker: `.record_all`, a
non-literal key, and — new to the list — a call rustfmt has wrapped so the quote no longer
follows the paren.

## The lifetime trap

`'a'` is a char literal and `'a` is a lifetime, and a scanner that gets this backwards opens
a literal that never closes and swallows every argument list containing a generic bound —
an under-flag, produced by the fix for an under-flag. The rule is one char then a closing
quote; `f::<'a>(x)` stays ordinary code and `j = ')'` does not truncate. Pinned, not assumed.

Note 5 came in as "add it to the residual list" and got fixed instead, since the same helper
covers it: `info_span!("n", k = "a,b")` used to split inside the value literal and invent a
`b"` key. Safe polarity — but it reddens CI at an innocent site, which is how a guard earns
the reputation that gets it disabled.

## A panic that would have told nobody anything

Note 3: `rfind(pred).map_or(0, |n| n + 1)` assumed the char before an identifier was one byte
wide. Both arms reproduced before fixing, with a multibyte char immediately before the marker:

```
panicked at src/commands/observability.rs:450:42:
start byte index 70632 is not a char boundary; it is inside '…' (bytes 70631..70634)
```

and at `:488:33` for the `.record("` receiver. Unreachable in today's sources, but the
failure mode is what makes it worth fixing: a PII guard that dies with a byte-index panic
tells its reader nothing about spans, and the natural response to an opaque failure in a
test nobody understands is to delete the test. Note that the round-two `delimiter_after`
anchor does not shield this — the `span!` arm slices the macro name before the anchor runs.

Notes 4, 7 and 8 needed no code and I checked each rather than accepting the summary. The
`recorder` exclusion does match a trailing identifier, so `holder.recorder.record(…)` is
skipped too — consistent with the doc, wider than it reads, now stated at the skip itself.
`child_count`'s carve-out is held by a comment and nothing else, as the doc already says.
The twins' duplicate-name messages differ cosmetically (`["a", "b"]` vs `["a","b"]`) and each
side asserts its own spelling — semantically mirrored, which is what the pairing is for.
