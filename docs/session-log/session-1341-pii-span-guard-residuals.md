# Session 1341 — a lexer written not to be fooled by literals, fooled by a literal

Four residuals on the PII span guard (#3988), filed rather than fixed out of #3980's last
review round. Three premises held exactly as written; one held, but not for the reason the
acceptance criterion stated, and finding that out changed what the fix had to be.

## 1. `opaque_prefix_len` stopped at the quote it was told to skip

The escaped-char arm searched for the closing quote from `at + 2` — just past the
backslash. On `'\''` the escaped char *is* a quote, so the search found it immediately and
reported 3 bytes: `'`, `\`, `'`. The literal's real closing quote was handed back to
`balanced` and `top_level_parts` as ordinary code.

RED, before anything was touched:

```
assertion `left == right` failed: all four bytes of `'\''` are the literal
  left: Some(3)
 right: Some(4)
```

The issue calls this harmless in today's sources, and it is — a stray `'` in code position
only re-opens a literal when the next-but-one byte is also a quote. But the mechanism is
reachable and it lands on the under-flag side. A stray quote followed by `,` followed by
`'` is lexed by the arm one layer up ("one char, then a close") as the char literal `','`,
which swallows the byte between them. When that byte is a delimiter the group truncates:

```rust
info_span!("n", k = f('\'',')'), page_title = t)
```

`balanced` returned `"n", k = f('\'',')'` — ending mid-expression — and `page_title`, the
exact field this guard exists for, went unscanned. That is #3980 round-three note 1 again,
reached through the fix for it. The shape needs `'\''` immediately followed by `,` and then
`'`, which rustfmt spaces apart in an argument list it formats, but not inside a macro body
it declines to enter and not under `#[rustfmt::skip]`; the scan reads the bytes on disk
either way.

The fix skips one char past the backslash before searching, which also carries `'\x41'` and
`'\u{1F600}'` since no escape body can contain a `'`. The lifetime-versus-char-literal
hazard pinned next door is untouched — the arm only fires when the byte after the quote is
a backslash, and no lifetime starts that way. `a_lifetime_is_ordinary_code_but_a_char_literal_is_not`
still passes.

## 2. The marker required the quote against the paren

`.record("` matched only when the key literal sat immediately after the paren, so rustfmt
breaking a long call across lines dropped it out of the guard — meaning a span field could
leave the scan by being renamed long enough to wrap.

Demonstrated end-to-end rather than by unit test, in a file the scan actually reads
(`src/commands/pages/markdown.rs`; note the scan skips its own file via `rel == file!()`,
which has mis-sited a finding before). A wrapped `span.record(` carrying
`"probe_wrapped_key_3988"` was passed over in silence — the guard was **green** with a
disallowed key on a live `Span::current()`. After the fix, same probe:

```
Offenders: [
    "src/commands/pages/markdown.rs: .record key `probe_wrapped_key_3988`",
]
```

The marker is now `.record(` plus a whitespace skip to the literal. `.record_all(` still
does not match, since `(` must follow `record` immediately; that under-flag is real and
stays on the list, and is now pinned rather than asserted.

## 3. The exclusion was name-keyed — but not the way the acceptance said

The acceptance asked for "a `Span` bound to a name ending in `recorder`". That probe was
**caught before the fix**, which is the finding: `ident_start` returns the whole trailing
identifier, so `query_recorder` never equalled `recorder` and was already scanned. The hole
was narrower and more precise than stated — the *exact* identifier `recorder`, in any file,
plus any field access whose last segment is `recorder`. Re-probed with the exact name, the
guard was green on `recorder.record("probe_receiver_name_3988", …)`.

`NON_SPAN_RECORD_RECEIVERS` is now `(file, receiver)` pairs, keyed on the relative path the
scan already computes (`file!()`-shaped, same string the self-skip compares). The one entry
became `("agaric-sync/src/transport/endpoint.rs", "recorder")`. A `recorder` in a second
file is a new review, not an inherited pass.

Path-keying introduces its own failure mode — an entry that stops matching anything after a
rename is an excuse nobody is looking at — so the test now tracks which exclusions were
exercised and fails on one that matched no call site. Verified live rather than assumed:
repointing the entry at a `moved.rs` that does not exist gives

```
NON_SPAN_RECORD_RECEIVERS entry (`agaric-sync/src/transport/moved.rs`, `recorder`)
matched no `.record("literal"` call site. The file moved or the call went away:
re-point the entry, or delete it.
```

The `.record(` scan was split out into `record_keys(rel, src)` so both properties are pinned
by unit tests instead of by probes left behind in a production file. Both probes were removed;
`git status` shows `markdown.rs` unmodified.

## 4. The two residual lists now say the same thing

`SECURITY.md` named two under-flags; `observability.rs` named three. Closing note 2 removes
the third honestly rather than on paper — but the prose was short in a second place the issue
did not name, and that one mattered more. It carried no mention of the allowlist being keyed
on the field NAME, so a shape-generic entry (`kind`, `size`) inherits its allowance at any
second site that adopts the name. That is a review question no test can catch, it is called
out at length in the code, and it was absent from the security-facing copy — the copy most
likely to be read on its own.

`SECURITY.md` now carries the code's full structure: under-flags (non-literal key,
`.record_all`), the single reviewed `(file, receiver)` skip and the staleness assertion
behind it, both review questions, and the safe-direction over-flag. Nothing was shortened.

## Verification

`cargo nextest run --workspace -E 'test(pii) + test(span) + test(bug_report) + test(observability)'`
— 94 passed before, 97 passed after (three new pins). `cargo clippy --workspace --all-targets`
clean; `cargo fmt --check` clean.
