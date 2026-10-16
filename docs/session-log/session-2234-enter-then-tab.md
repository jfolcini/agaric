# Session 2234 — Enter then a fast Tab indents the new block

The real-backend spec "copies and pastes a TODO parent…" failed once
(run 38801474998) with `new block never indented under the parent`.

**Two races.**
- **The test.** After Enter it waited for an empty editor at level 1. The
  block Enter had just left matched at once, since it had gone blank in the
  editor and still sat at that level, so the indent chord went out before the
  new block existed.
- **The app.** While Enter's create is in flight, focus still names the
  block Enter left, because `handleEnterSave` moves focus only after
  `createBelow` resolves. A Tab, Shift+Tab or move chord in that window acted
  on the old block. On CI's debug build the window was about 110 ms, so a
  fast typist pressing Enter then Tab could indent the wrong block.

**What changed.**
- `use-block-action-orchestration.ts`: the Enter guard holds the in-flight
  Enter's promise instead of a flag. Indent, dedent, move up and move down
  pressed meanwhile wait for it, then act on the block focused afterwards,
  which is the one Enter created. A second Enter is still dropped. If the
  create fails, focus stays put and the chord acts there.
- `e2e-tauri/block-clipboard.e2e.ts` and the three `page-source-*` specs use
  `enterBlankSibling()`, which waits for the new block, instead of waiting for
  any empty editor.

**Tests.** Four vitest cases hold `createBelow` open, press Enter, then the
chord, then let the create land, and check the blocks' parents and order in
the mock. All four were red on the old code and again with the wait removed.

**Not changed:** arrow-key focus moves and Backspace merge in the same window
act on the old block too. They are a different shape and nobody has hit them.

**Suites:** the orchestration, keyboard and `BlockTree` vitest files, the
`block-keyboard-fundamentals` Playwright spec, typecheck and lint. The
e2e-tauri specs need a native build and run in this PR's CI.
