# Session 1861 — a repeat rule ending in a multi-byte character panicked (#5110)

The weekly fuzz lane's one open finding (#5110): `import_parse` crashed on the input `crash-1f41e750…` (run 36412056246). The reproducer, taken from that run's `fuzz-artifacts`, still crashed `parse_logseq_markdown` on current main. A unit test ran it on stable, without cargo-fuzz.

**Cause.** The input holds an Org planning line, `SCHEDULED: <2126-09-08 .+…¶ …>`, whose repeater token ends in `¶`. `parse_org_timestamp` asks `validate_repeat_rule_shape` whether the token is a rule. That validator runs the production parser, `try_shift_date_once`, which split the count from the unit with `split_at(len - 1)`. A last character wider than one byte put that index inside it, and `str::split_at` panicked. `classify_rejected_interval` did the same split.

It wasn't only an importer problem. `validate_repeat_rule_shape` is also the write-time check on a block's `repeat` property, so a rule typed as `1é` panicked there too, and release builds abort on a panic.

**Fix.** Both now go through `split_count_unit`, which splits before the last character at its boundary and gives `None` below two characters. A rule like `1é` is now an unknown unit, `é` alone is unparseable, and the planning line stays text.

**Tests, each red with the old split and green with the new:**
- `probe_verdict_is_base_independent` and `rejected_rules_are_classified_for_the_message` (`agaric-store`), over corpus entries `é`, `1é`, `+1é`, `.+1¶` and the case `5é` → `UnknownUnit`.
- `validator_accepts_exactly_what_recurrence_honours_3647` (`agaric-engine`), with `1é` and `.+1¶` added to its corpus.
- `a_planning_line_with_a_multibyte_repeater_stays_text`, the importer's own pin.

With the old `recurrence_math.rs` put back on a copy (tests kept), those 4 failed; restored and `cmp`'d. `cargo nextest run --workspace` over the repeat-rule, recurrence, planning and `import::` tests: 251 passed.

The finding's line comes out of #5110's tracking block once this merges. The lane closes the issue on its next clean run.
