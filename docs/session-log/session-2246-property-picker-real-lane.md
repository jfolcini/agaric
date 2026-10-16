# Session 2246 — A `::`-picked property line on the real backend (#5365)

#5365's last open properties scenario: a `key:: value` line picked through
the `::` picker (#2675) and blurred. Committing it takes two calls,
`setProperty` and then an edit that strips the line
(`src/stores/inline-property-commit.ts`). The mock lane cannot show one landing
without the other. The maintainer ruled that `escape-property-line`'s typed
line does not count, so this scenario drives the picker itself.

**The scenario** is a third arm of `e2e-tauri/escape-property-line.e2e.ts`,
the real-lane spec for typed `key:: value` lines. It shares that file's chip
and line-absent checks and its vault boot.
- `/location` seeds the key, because the picker offers only keys that some
  block already has.
- On a new block, `::loc` opens the picker, Enter picks `location`, a value
  is typed, and a click elsewhere blurs.
- After a Pages → Journal round trip, the chip shows the value and no block
  holds the line as text.

`typeVerified` gained an optional `clear`, so a retry deletes only the value
and never the picked key.

**Red,** run locally on the real backend under Xvfb, with each break applied
to `inline-property-commit.ts` and the tree restored afterwards. The
unbroken run passed all three arms.
- Without `setProperty`: "the picked location was never stored on the
  block".
- Without the strip: "the picked key:: value line kept as text is still
  present after the round-trip".

The file's other key:: value arm failed under both breaks as well, and the
Escape control stayed green. Vitest's `use-block-flush.test.ts` also catches
both.

WebdriverIO's `*=` text match accepts one attribute selector, not two, so the
picker's selected item is read by its text.
