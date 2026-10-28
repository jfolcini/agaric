# Session 2966 — Page-collapse mutation survivors

Set out to finish #6107: every Stryker survivor in `src/editor/page-mode/page-collapse.ts` killed, deleted or accepted with a reason.

Stryker, run in three slices because one whole run outlasts the time limit, reported 26 survivors and 12 no-coverage mutants. Eight new tests and one strengthened test kill most of them. Code that could not change behaviour was deleted, not accepted:
- a `fold` temporary;
- an `addOptions` block that its only consumer, `PageCollapse.configure` in `page-mode-extensions.ts`, overrides;
- a `look` shortcut;
- an early return equal to mapping through an empty mapping;
- an `appendTransaction` guard that `keepHidden` already makes.

The trap was `keepHidden`. The builder rewrote it to move what a collapsed block hides up in front of the new blocks, so that ProseMirror's mapping would carry the caret. Document, caret and hidden set came out identical in every scenario the review compared. History did not:
- The step then records the hidden blocks' content. A Ctrl+Z after a peer's edit to a hidden child reverts that edit, against `remote-patch.ts`'s rule that undo never takes back someone else's change.
- The step maps also span the hidden blocks, so `commitPageTyped` would run on children the user never touched.

The original move-the-new-blocks code is back, with a test that goes through `FakeBackend`, `savePage`, `applyRemote` and undo. It fails on the rewrite.

After the change, mutation testing leaves 5 survivors in the module, all accepted in `mutation-accepted.tsv`:
- the `PluginKey` text and the extension name. Only `page-mode-surface-parity.test.tsx`, which is outside the module's mutation scope, compares the name;
- three arms of `keepHidden`'s selection guard. A split leaves the cursor collapsed inside a block it made, so those arms cannot be reached.

The re-run over `keepHidden` killed 51 mutants and those 3 survived.

Suites:
- `npx vitest run src/editor/page-mode src/editor/__tests__`: 84 files, 3407 tests;
- typecheck, lint, and `prek run --hook-stage manual --all-files`;
- Playwright over the page-mode specs: 90 passed. `e2e-related` selects most of the Playwright and WebdriverIO lanes, so CI's runs cover the rest.
