# Session 1353 — a leading italic that opens onto a space, and the #4076 half that is a product call (2026-08-19)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-19 |
| **Subagents** | orchestrator-only (adversarial review of an inherited working-tree diff) |
| **Items closed** | `#4156` |
| **Items modified** | `#4076` (verified NOT resolvable here — see below) |
| **Tests added** | +35 (frontend) / +0 (backend) |
| **Files touched** | 4 |

**Summary:** Reviewed and reworked an inherited uncommitted diff for #4156 (an emphasis
span wrapping only whitespace serialized to a bullet list). The root fix — moving the
italic mark's opening boundary past the leading whitespace so the serializer never emits
a bare `* ` at a dispatched line start — is correct and is kept. Two review findings were
fixed: the transform fired in four contexts where the bullet collision provably cannot
happen and silently destroyed a mark that used to round-trip exactly, and its trigger did
not exclude the `code` and `link` marks that `markSetFromMarks` cannot see. The diff's
`#4076` conclusion was independently checked and does **not** hold as a closure: half of
that issue is a product decision jfolcini explicitly left open, so #4076 is not closed and
its decorative pinned test was deleted.

**Files touched (this session):**
- `src/editor/markdown-serialize.ts` (+142/−7)
- `src/editor/__tests__/markdown-roundtrip-fidelity.test.ts` (+274)
- `src/editor/__tests__/markdown-serializer.property.test.ts` (+56/−5)
- `src/editor/__tests__/markdown-roundtrip.property.test.ts` (+26/−16)

## #4156 — what the fix is, and what review changed

`emitMarkTransition` opens italic with a bare `*`. When italic is a paragraph's leading
mark and its text starts with a space, the emitted `* ` **is** `BULLET_ITEM_RE`'s bullet
marker (0–3 spaces of indent tolerance included), so block dispatch — which runs before
any inline scan — reads the paragraph back as a bullet list. Escaping the opening
delimiter after the fact is not available: it leaves the matching close dangling, which
just relocates the non-convergence to pass two. `defuseLeadingItalicMarker` therefore
moves the mark's OPEN boundary past the leading whitespace (`italic(' y')` → plain `' '` +
`italic('y')`), dropping the mark only when the run is whitespace all the way through.

Worth recording, because the issue text says otherwise: `scanItalic` applies CommonMark
flanking to `_` only — the `*` toggle here is **naive**. `* *` is perfectly good emphasis
anywhere a block production cannot claim the line. The collision is with the bullet
marker and nothing else, which is exactly why the gate below is both possible and correct.

Two defects found and fixed in the inherited diff:

1. **The transform was unconditional, and it is LOSSY.** Measured before/after on 37 doc
   shapes: it turned `parse(serialize(d)) === d` from true to false for a bullet item's own
   leading paragraph, an ordered item's, a heading's inline content, a task paragraph, and
   a link span — all of which emit a prefix (`- `, `1. `, `# `, `- [ ] `, `[`) that consumes
   the line start, so `* ` there was never a marker. Every *other* defense in
   `serializeParagraph` is an escape the parser reverses, so applying one needlessly costs
   nothing; this one costs a mark. Added `serializeParagraph(node, cb, atLineStart)`,
   passed `false` from `serializeHeading`, `serializeTable`'s cell map, and (via the
   `onMarkerLine` fact `serializeBlockSequence` already computes) a list item's marker-line
   paragraph; the task case is decided inside `serializeParagraph` from its own
   `taskPrefix`. Same notion of "this text owns the start of its line" that `skipFirst`
   already encodes, now shared by both defenses.
2. **The trigger could not see `code` or `link`.** `markSetFromMarks` reports only the five
   emphasis marks, so `[italic, code]` and `[italic, link]` both passed a `size === 1 &&
   has('italic')` test — but code is exclusive (backticks, no star at all) and a link wraps
   the span in `[`…`](url)`. Firing there pulled a character out of a code span and moved a
   boundary inside a link label for no reason. `isVulnerableItalicOpen` now rejects both by
   name.

Renamed `dropUnspellableLeadingItalic` → `defuseLeadingItalicMarker`: it moves a boundary
far more often than it drops a mark.

Kept as-is after checking: the `≥4`-space plain prefix still gets defused even though at
top level such an indent is past the marker tolerance. That is the same dedent-invariance
widening `serializeParagraph`'s `- `/`1. ` escapes already use — a paragraph nested in a
list item is emitted indented and re-parsed dedented, so marker-ness has to hold under the
dedent. Also unchanged, and pinned: a leading TAB or non-breaking space is left alone,
because `BULLET_ITEM_RE` accepts only an ASCII space after the marker.

**The two property-test exclusion changes are honest, and were measured, not asserted.**
`markdown-roundtrip.property.test.ts` dropped `startsWithDelimiterBulletMarker` from
`arbParagraph`/`arbPlainParagraph`; those properties assert only STRING invariants (byte
identity, one-pass convergence), never doc identity, so the shapes it used to hide are now
checked. Reachability confirmed: at `SWEEP_RUNS=20000` with the filter gone and the defuse
disabled, `the first serialize …` and `a depth-4 list …` redden on 3 of 3 random seeds;
at 2 000 runs the shape is never reached, so the run count is the evidence.
`markdown-serializer.property.test.ts` gained `leadingItalicStartsOnWhitespace` to its
doc-IDENTITY exclusion — genuinely needed (the defused output is a mark boundary move, and
the old `/^[-*] /` probe no longer sees it), and rewritten to mirror the production trigger
exactly, task exemption and `code`/`link` rejection included, so the exclusion cannot cover
more than the serializer actually changes.

## #4076 — verified independently, and it may NOT be closed

The inherited diff claimed #4076 needed no production change and added a pinned test for
it. Both halves were checked:

- **Item 1 (tab after a blockquote marker) is genuinely fixed.** `842353300` ("stop a
  serialized paragraph's indent from being reparsed as structure", #4149) is confirmed an
  ancestor of this branch, and the nested-in-a-list form the #4052 property actually
  generates is already pinned by that PR at
  `markdown-roundtrip-fidelity.test.ts` § `#4071/#4076`. Verified the reported top-level
  string `> > > \t\t- item` converges in one pass today.
- **Item 2 (ordered list in a blockquote loses its start number) is NOT fixed, and closing
  it is not ours to do.** The by-design status checks out — `docs/architecture/
  list-ergonomics.md` § Markdown round-trip says import "**discards** the literal and
  re-derives from position", and `src/lib/list-ordinals.ts` implements it — but jfolcini's
  own comment on the issue ends: *"the other half needs your call, so this stays open"*,
  and lays out two options, one of which is a product decision about what an ordered list's
  number means. Nothing in this diff makes that call. It is also already pinned, by #4149,
  at § `#4076.2`.

So #4076 stays open and gets **no** `Closes` keyword. **The diff's new
`#4076.1` describe block was deleted**: it pinned the literal reported string, which the
builder itself reported cannot be reddened by reverting any production change (it converged
before #4149 too), and the form that *did* need the fix was already pinned by #4149 two
hundred lines above it. A test that cannot fail, duplicating one that can, is not worth its
maintenance.

**Verification:**
- `npx vitest run` — 777 files, 17 670 passed, 1 expected fail. Green.
- `npx tsc -b --noEmit` — clean.
- `npx oxlint` + `npx oxfmt --check` on the four changed files — clean (one file needed
  `oxfmt`, applied).
- `SWEEP_RUNS=20000 npx vitest run …markdown-roundtrip.property.test.ts` — 6 independent
  unseeded sweeps, 42/42 each.
- `npx vitest run …markdown-serializer.property.test.ts` — 8 independent unseeded runs,
  58/58 each.
- Mutation-tested every new assertion: disabling `defuseLeadingItalicMarker` reddens 20
  tests; forcing it past the `atLineStart` gate reddens exactly the 5 keeps-the-mark
  contexts; removing the `code`/`link` rejection reddens exactly those 2. No new test is
  vacuous.
- Blast radius measured by before/after probe over 37 doc shapes and the issue's 6 reported
  strings (leading bold / strike / highlight / underline; italic after a `>` marker, at
  every nesting depth; tab and non-breaking-space leads; a whitespace-only italic;
  italic-inside-bold boundary reordering; the `1. ` ordered-marker collision). All converge
  on the FIRST pass.

**Process notes:** the fix's own cost was invisible in the test suite until the doc-identity
delta was measured explicitly — the property that would have caught it had been widened in
the same diff. Measuring `parse(serialize(d)) === d` before and after, per shape, is what
surfaced it; the exclusion diff alone read as reasonable.

**Lessons learned (for future sessions):** when a serializer defense is LOSSY rather than an
escape the parser reverses, scope it to the contexts where the hazard is real — the usual
"apply it everywhere, it costs nothing" reasoning silently stops holding. And an issue whose
author ends a status comment with "this stays open" is not closable by a diff that adds no
new information, however well the by-design argument reads.

**Commit plan:** single commit / not pushed.
