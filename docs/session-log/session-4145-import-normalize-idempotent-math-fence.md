# Session 4145 — a math fence holding a quoted `$$` line stays a fence

`agaric-engine import::parse_proptest::normalizing_is_idempotent` drew a real counterexample in another session's pre-push run, on code that session had not touched. Any Rust PR's `cargo-tests` job could draw it too. The session set out to find the cause in `normalize_foreign_inline` and fix it there, without touching the property or its generator.

## Cause

`math_fences_as_blocks` writes a closed ```` ```math ```` fence as a `$$` block unless the fence holds a line that is `$$`, because that line would pair with the `$$` it writes. It compared the raw line, while `literal_block`, which does the pairing, reads a `$$` line past its `>` quote markers. So a fence holding `> $$` was rewritten, its new opening `$$` closed at the quoted line, and its new closing `$$` opened a block that ran to the next `$$` line further down. Everything from there on was read differently on the next pass: in the drawn input a `~~~math` fence that the first pass saw inside an unclosed fence stood in the open on the second, and became `$$`.

The check now reads the line through `unquoted`, as `literal_block` does. The fence-opener half of the same check was left alone: a quoted fence line inside a `$$` block opens nothing on either pass, so it has no failure to fix.

## What a user would have seen

A Logseq or Obsidian file with a `math` fence holding a quoted `$$` line imported with that fence turned into a broken `$$` block, and text between it and the next `$$` line kept as literal instead of having its `^^highlight^^` and `\[math\]` read. Exporting and importing again changed the text a second time.

## Tests

`a_math_fence_holding_a_quoted_dollar_line_is_left_as_written` pins the drawn input; it and the seeded proptest were red before the fix, on the predicted assertion. The seed is committed in `agaric-engine/proptest-regressions/import.txt`, the first such file in this crate, following `agaric-sync` and the app crate.

## What ran

The 194 `import::` tests of `agaric-engine`, corpus snapshots included, with no snapshot changed; the three `normalizing_*` properties at `PROPTEST_CASES=400000` three times with no further counterexample; `cargo clippy --workspace --all-targets -- -D warnings`; the pre-push verify.
