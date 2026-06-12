# Session 1010 — #898: harden markdown round-trip property tests

Test-only (no serializer/parser change). Follow-up from #532.

- **Extended alphabet** in `markdown-serializer.property.test.ts`: `INTERESTING_CHARS`/
  `arbText` now splice `~~` (strike), `==` (highlight), `<u>`/`</u>` (underline), `\` runs
  (escape/hard-break), and a leading-block-marker branch (`#`/`N.`/`|`) — exercising the
  mark-delimiter collisions + block-production-on-reparse asymmetries behind the #710/#711
  corruption family.
- **Serializer idempotence firewall:** a 34-snippet golden corpus asserting
  `serialize(parse(x)) === serialize(parse(serialize(parse(x))))` byte-for-byte (plus the
  whole corpus concatenated), institutionalizing the #711 zero-edit-rewrite guard at the
  serializer boundary.
- The extended alphabet surfaced **two test-harness normalization gaps** (NOT serializer
  bugs): `normalizeDoc` didn't recurse into headings; `paragraphStartsWithAmbiguousSyntax`
  didn't flag leading `>`/`N.`/`|`. Both fixed in the test harness with documented comments;
  every corpus snippet is a true fixed point. **No real serializer bug found.**

Verification: property file run 8×+ (random seeds) green (55 tests); `tsc -b` clean.
Closes #898.
