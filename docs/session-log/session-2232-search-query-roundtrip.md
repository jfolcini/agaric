# Session 2232 — Search queries survive a chip edit

The search-query property `parse(serialize(parse(s))) === parse(s)` failed on
a main push (run 36985456234, seed 2008733170) and passed on the next one
with the code unchanged. The counterexample `" A:"#` reproduces every time,
so this was a real bug that the random input reaches only sometimes.

**Causes:**
- **A chip with an unclosed quote.** A filter word whose mid-word `"` never
  closed still became a chip, and its extent depended on the text after it.
  `serialize` puts free text after the chips, so a `"` in that free text
  could close the chip's quote and swallow everything between.
- **Values holding quotes.** `quoteValueIfNeeded` checked only for
  whitespace and surrounding quotes. A value like `a" "` breaks when quoted,
  and `"` or `a"b` break when bare. The bare `#x` alias also kept quotes that
  `tag:#` strips.
- **Non-ASCII spaces.** The tokenizer split on ASCII whitespace while the
  free-text cleanup collapses all of `\s`, so `a<no-break space>#a` came back
  as a `#a` tag chip. macOS types a no-break space on Option+Space.

**What a user saw.** Typing `rock" prop:title="Hello` and then adding a tag
chip rewrote the query to `prop:title="Hello tag:#x rock"`: the tag vanished
into the property value and the free text was lost.

**What changed** (`src/lib/search-query/`):
- `tokenize` flags a word whose quote never closes, and splits on `\s`.
- `classify` keeps a flagged word as free text, and the bare `#x` alias goes
  through the `tag:` recogniser.
- `quoteValueIfNeeded(v, prefix)` emits a value bare only when the tokenizer
  reads `prefix + v` back as one closed word; `prop:` passes its key as the
  prefix.

Behaviour change: `prop:status="in progress` is free text until its quote
closes, and `#"my tag"` matches the tag `my tag`.

**Tests.** Ten counterexamples are fixed round-trip cases, among them
`" A:"#`, `"a" X:" q"z`, `rock" prop:title="Hello` and `a #a`, plus
tokenizer, classifier and autocomplete cases. Reverting the source turns
them red. The property passed 20,000 seeds of 200 runs, and two hunts of
2,000,000 samples over quotes, every prefix and non-ASCII whitespace found
nothing. `numRuns` stays at 200.
