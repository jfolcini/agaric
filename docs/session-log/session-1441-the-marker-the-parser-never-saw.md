# Session 1441 — the marker the parser never saw

#4526, and the tail of #4509 that #4528 merged without.

`check-mutation-harness-clones.mjs` recognised a pin marker only in a `//` line comment or a `*`
JSDoc continuation. Two shapes any human would read as an attempted pin were **invisible** — not
reported, not counted, not violations:

```js
/* mutation-harness-source-pin: ... */
// MUTATION-HARNESS-SOURCE-PIN: ...
```

Reproduced before touching anything, with a synthetic tree of one well-formed pin plus one of the
above. Both give `violations: []`, `pinCount: 1`, exit 0, and the guard prints OK. The clone that
marker was meant to protect is unpinned, and the guard says everything is fine.

## The same defect one step earlier than #4509's

#4509 closed the case where a marker is *recognised* but its hash is malformed — that now fails
loudly instead of being dropped. This is the identical failure one stage earlier: a marker never
recognised as a marker at all. Pre-existing rather than introduced there, confirmed by the prefix
substring being byte-identical to the old `PIN_RE`'s, so #4509 changed only what happens to a line
that already matched.

Worth stating the shape once: this guard's whole value is a **negative claim** — "all pins match".
Every way a marker can go unseen is a way that claim gets made over something nobody checked. The
count is not a side effect of the guard; it is the guard.

## Violation, not acceptance

A well-formed pin in a `/* */` envelope could equally have been *accepted*. It is rejected instead,
for two reasons. The author's intent is legible either way, so telling them costs nothing and
guessing costs a precedent. And accepting it means a second parsing path for the marker syntax,
which can drift from `PIN_BODY_RE` — the guard would then have two ideas of what a pin is, which is
how the original hole opened.

Case-insensitivity is deliberately **keyword-only**. It exists to *detect an attempt*, not to
loosen the hash: a wrong-case keyword is reported whether or not its body is valid, and the
`sha256=` body is never matched case-insensitively. Pinned by a test that gives a wrong-case
keyword a placeholder hash and asserts **one** diagnosis, not two.

## What is still invisible, said out loud

The issue named two shapes. Fixing exactly two shapes would leave the same class open, so the space
was enumerated instead. Three remain undetected, **deliberately**, and each has a test asserting
the non-detection so the next reader can see it was a choice rather than an oversight:

- a trailing marker after real code on the same line;
- a marker starting immediately after a same-line `*/`;
- a marker on an inner line of a multi-line *plain* `/* */` block with no leading `*`.

All three need to locate where a comment *begins* mid-line, which takes the real tokenizer
(`scripts/lib/js-scanner.mjs`, with its division-vs-regex resolution) rather than a line regex.
That is the same scope judgement #4509 made when it deferred this issue, applied one level in.

The template-string exclusion is untouched and now has negative controls for both new envelopes —
a detector widened without checking that is exactly how a deliberate exclusion becomes an
accidental one.

## Also here: the tail of #4528

Two changes from #4509's review were committed but unpushed when #4528 was squash-merged at the sha
before them, so they are in this PR instead:

- the guard's header now records that a **prose comment leading with the keyword** is a hard build
  failure. It is the correct trade — such a line is genuinely indistinguishable from a typo'd pin —
  but it is a new way to break the build, and it was documented nowhere;
- the malformed-marker diagnostic now names the **trailing-content** case. A pin that closes its
  JSDoc on the same line has a shape-correct hash with `*/` after it, and a reader will study the
  hash, because the hash is the part that looks like it could be wrong.

## Verification

Self-test **65 → 77** assertions, green. On the real tree the guard passes with every marker
well-formed, unchanged — deliberately not quoting the `OK: N source-pin(s) across M harness
file(s)` count here. Session 1434 quoted it and review caught that it had already gone stale one
merge later, as sibling PRs added harnesses; a log whose whole subject is a guard that must not
misreport a count is the wrong place to carry one that drifts.

Falsified against a copy, restore proven byte-identical with `cmp`: reverting the detection reddens
**7** assertions — the new detection cases and both end-to-end repros, the latter reproducing the
exact `violations: [], pinCount: 1` false-green this issue is about. Not all 77, which is the point:
the untouched cases were never testing this.

Closes #4526.
