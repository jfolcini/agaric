# Session 1367 — Two residuals: an empty-serializing inline atom, and the `((` picker's blank row (2026-08-21)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-21 |
| **Subagents** | one builder, one adversarial reviewer (no self-review) |
| **Items closed** | `#4195`, `#4190` |
| **Items modified** | — |
| **Tests added** | +9 (frontend) / +0 (backend) |
| **Files touched** | see PR #4222's file list |

**Summary:** Two independent residuals, each left open by the PR that fixed its sibling
case. #4195: `defuseLeadingItalicMarker`'s prefix-skip loop recognised a leading run of
plain spaces (#4189) but not an inline **atom that serializes to the empty string**, so a
vulnerable italic sitting after one was never defused and the #4156 bullet-list collision
stayed reachable. #4190: `searchBlockRefs` — the `((` block-ref picker — was deliberately
left on an exact-`null` test when #4153 fixed the `[[` page picker's equivalent, so
whitespace-only or newline-leading content still rendered a blank, unlabelled row.

**The review changed the #4195 fix, and that is the interesting part of this session.**
The builder implemented the empty-atom skip as a `math_inline` type check, because
`math_inline` is the case the issue names. The issue states the defect one level more
generally — "an inline ATOM that serializes to the empty string" — and the reviewer took
that seriously enough to enumerate `InlineNode`'s union against `serializeInlineChild`'s
branches. `math_inline` is indeed the only *known* type that can emit `''`, but there is a
seventh path: the `onUnknownNode` fallback, which drops an unrecognised node silently and
is already exercised as a first-class shape by `markdown-serializer.test.ts`.

That gap was not hypothetical. `paragraph({type:'video_embed'}, italic(' y'))` serialized
to `'* y*'` and reparsed as a `bulletList` — the exact #4156 collision, still live against
the diff as submitted. The predicate now asks the serializer what it would emit for the
node in isolation rather than hardcoding a type name, which covers the unknown-node
fallback and any future empty-serializing atom without a third patch.

**What changed**

*#4195 — ask the serializer, don't name the type*

- `isEmptyAtom` calls `serializeInlineChild(n, new Set())` and skips the node when the
  result is `''`. Type-name-free by construction.
- Regression tests: the issue's own repro, a mixed plain-space/empty-atom prefix, an
  unrecognised-node-type case (the gap the review found), and a control proving a
  *non-empty* math atom is correctly left alone — it already occupies column 0, so there
  is no vulnerability to defuse.

*#4190 — trimmed-empty, at the right granularity on each surface*

- `blockFirstLineOr` for the picker **row**, which shows only the first line, and
  `blockContentOr` for the resolve-store **title seed**, which stores full content and
  feeds consumers like the block-ref chip. The split is not new: it preserves the
  pre-existing label-vs-seed asymmetry and only adds the trimmed-empty test to both.
- Kept separate from `untitledOr` per #4150's review boundary — block content is a
  different surface with its own truncation rule.

**Verification**

Every new test was shown RED against the unfixed production code and restored, including
the reviewer's own reproduction of the builder's claimed failures. Full frontend suite:
17701 passed, 1 expected fail; `tsc -b` clean.

**Review pass 2 (on the PR) tightened two things**

The mixed-prefix fidelity test asserted only round-trip stability and the block type. A
defuse that dropped the italic mark entirely emits `    y`, which is *also* stable and
*also* a paragraph — so neither assertion could tell a working defuse from a broken one.
The expected markdown (`    *y*`) is now pinned; the delimiters are the property.

`blockContentOr` was byte-for-byte identical to `untitledOr`, and `blockFirstLineOr` was
expressible through it. #4150's boundary is about which call site gets the placeholder,
not about needing three near-identical implementations — both now delegate.

**Filed, not fixed**

`#4221` — an empty text node carrying the italic mark alone still defeats
`isVulnerableItalicOpen`'s single-node assumption. It emits a real `*` byte, so no
widening of the empty-atom predicate reaches it; the fix belongs in the vulnerability
check, not the skip loop. Reproduced live during review. Reachable only from imported or
hand-built JSON, same class as #4195's own residual.

`#4228` — the resolve-store block title is seeded three ways (full content, and two
`slice(0, 60)` paths) and rendered two ways (`renderBlockRef` splits and caps; the TipTap
NodeView does neither, despite its docblock). So the newline-leading case this session
fixed on the picker *row* still renders a blank chip, and the store version churns
depending on which seeder ran last. All pre-existing; the fix belongs at the seed, not in
a third renderer-side `split`.

**Commit plan:** single commit on `claude/fe-picker-math-bugs`, shipped as PR #4222.
