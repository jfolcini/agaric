# Session 4416 — three specs wait for the signal the real backend sends late

**Ask.** Root-cause the specs #6529's stage-3 measurement saw fail on the bridge. Repeated ×3 there, three causes in four specs failed; phone-block-lists, block-editing-text, background-tabs and editor-keyboard-6537 did not.

**One-shot reads of the rows.** `block-dnd-mouse.spec.ts` read its rows with `evaluateAll` and `toolbar-and-blocks.spec.ts`'s delete test with `count()`, each once, right after `openPage`, which waits only for the title. A page whose blocks arrived later read as empty: the drag test's `before` was `[]`, the delete test counted 0. Both now wait for the five seeded rows first. With `load_page_subtree` delayed 800 ms in the page, "Escape aborts the drag", "dragging a block onto itself" and the delete test fail on main's specs on the mock too, and pass with the change; both files pass ×3 on the mock and on the bridge.

**A second seed the vault keeps.** Each `diagram-reduced-motion.spec.ts` test boots and seeds a flowchart twice. The mock's seed comes back on a boot; a real backend's vault keeps the first flowchart, so the unscoped locator found two. It now reads the diagram inside the block it seeded. On the bridge main's spec failed 8 of 10 on strict mode, the change passes 10 of 10, and 10 of 10 on the mock.

**A poll that threw before the create landed.** Page mode's Enter names the new block before the backend has created it. `block-syntax-reveal.spec.ts` polled its content with `get_block`, which rejects with `not_found` while the create is on its way, and `expect.poll` fails on a thrown error instead of retrying. The poll now reads `null` for `not_found` and rethrows anything else. With every create, split and insert delayed 1 s in the page, main's failed 3 of 3 on the mock and the change passes 3 of 3; unstretched on the bridge main's failed 1 of 5 and the change passes 5 of 5.

**Ran:** each changed spec on the mock and the bridge, with and without its stretch; `tsc -p tsconfig.e2e.json` and oxlint on the changed files.
